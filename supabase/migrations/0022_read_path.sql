-- ============================================================
-- Reads in rupees, and reads that do not scan what they need not.
--
-- Money. Every function that sums an amount now sums ledger_amount_inr()
-- (0019), so a dollar is converted and a NeuCoin is left out:
--   ledger_stats()      spend/inflow totals, by_type, by_category and
--                       top_entities. Adds spend.by_bucket (the six budget
--                       buckets) and `unconverted` (events whose amount could
--                       not become rupees, with their currencies). by_category
--                       reads the stored canonical category (0021).
--   life_days()         money.spend / inflow per day.
--   ledger_get_entity() total_amount. Adds merged_into.
--
-- Speed. Measured on 2026-10-18 (pg_stat_statements; EXPLAIN in the report):
--   * user_settings_pkey: 6.87M index scans. ledger_setting_text() was
--     called once per ROW inside cc_card_events() and in the cc_points view
--     (a SET search_path function is never inlined, so nothing caches it).
--     Both now read the setting once per query.
--   * Every RLS policy compared `auth.uid() = user_id`, which Postgres
--     re-evaluates for each row a signed-in caller touches. Written as
--     `(select auth.uid()) = user_id` it is an InitPlan, evaluated once per
--     statement. Same rule, same rows.
--   * ledger_search_events: the text filter OR'ed the tsvector match with a
--     title ILIKE inside one predicate, so neither index could be used and
--     every call scanned the user's whole ledger. The text match is now an
--     id set built from two index-friendly branches (GIN on search_tsv, a new
--     trigram GIN on title), the tsquery and the entity name are computed once,
--     and an entity filter resolves to entity ids (including merged and
--     aliased spellings) before the scan.
--   * cc_transactions and net_worth_entries had no (user_id, date) index.
--
-- Output shapes only gain fields. Safe to apply while ingestion runs: the two
-- new indexes are small (≤ a few thousand rows) and build in milliseconds.
-- ============================================================

-- Inlinable lookups: no SET clause, fully qualified, so the planner folds the
-- taxonomy constant into the calling query instead of calling per row.
create or replace function public.ledger_budget_bucket(p_category text)
returns text
language sql
immutable
as $$
  select public.ledger_taxonomy() -> 'categories' ->> p_category;
$$;


-- ────────────────────────────────────────────────────────────
-- Indexes
-- ────────────────────────────────────────────────────────────
create index if not exists cc_transactions_user_date_idx  on public.cc_transactions (user_id, date);
create index if not exists net_worth_entries_user_date_idx on public.net_worth_entries (user_id, date);
create index if not exists events_title_trgm_idx on public.events using gin (title extensions.gin_trgm_ops);


-- ────────────────────────────────────────────────────────────
-- RLS: one auth.uid() per statement, not per row.
-- ────────────────────────────────────────────────────────────
do $$
declare
  p record;
begin
  for p in
    select schemaname, tablename, policyname, cmd, qual, with_check
      from pg_policies
     where schemaname = 'public'
       and (qual = '(auth.uid() = user_id)' or with_check = '(auth.uid() = user_id)')
  loop
    execute format('alter policy %I on %I.%I %s %s', p.policyname, p.schemaname, p.tablename,
      case when p.qual = '(auth.uid() = user_id)' then 'using ((select auth.uid()) = user_id)' else '' end,
      case when p.with_check = '(auth.uid() = user_id)' then 'with check ((select auth.uid()) = user_id)' else '' end);
  end loop;
end $$;


-- ────────────────────────────────────────────────────────────
-- Card points: settings read once.
-- ────────────────────────────────────────────────────────────
create or replace function public.cc_card_events(p_user_id uuid)
returns table(event_id uuid, day date, amount numeric, merchant text, merchant_key text, title text, status text)
language sql
stable
set search_path = public, pg_temp
as $$
  with s as materialized (
    select public.ledger_setting_text(p_user_id, 'ledger_timezone', 'Asia/Kolkata') as tz,
           public.ledger_setting_text(p_user_id, 'cc_points_account', '') as account
  )
  select e.id,
         (e.occurred_at at time zone s.tz)::date,
         (e.data ->> 'amount')::numeric,
         nullif(btrim(e.data ->> 'merchant'), ''),
         public.ledger_normalize_name(nullif(btrim(e.data ->> 'merchant'), '')),
         e.title, e.status
    from s, public.events e
   where e.user_id = p_user_id
     and e.data ->> 'account' = s.account
     and (e.data ->> 'amount') ~ '^[0-9]+(\.[0-9]+)?$'
     and e.status <> 'dismissed'
     and e.type <> 'transfer'
     and coalesce(e.data ->> 'direction', 'debit') <> 'credit';
$$;

-- Same columns, same order, same security_invoker; the time zone is a join
-- instead of a function call per row.
create or replace view public.cc_points with (security_invoker = true) as
  select c.id,
         c.user_id,
         c.event_id,
         c.basis,
         c.merchant,
         c.raw_merchant,
         c.multiplier,
         c.points,
         coalesce((e.occurred_at at time zone coalesce(nullif(tz.value #>> '{}', ''), 'Asia/Kolkata'))::date, c.date) as date,
         coalesce(case when (e.data ->> 'amount') ~ '^[0-9]+(\.[0-9]+)?$' then (e.data ->> 'amount')::numeric end, c.amount) as amount,
         coalesce(nullif(btrim(e.description), ''), nullif(btrim(c.description), '')) as description,
         case when e.id is not null and (e.data ->> 'amount') ~ '^[0-9]+(\.[0-9]+)?$'
                   and abs((e.data ->> 'amount')::numeric - c.amount) >= 1
              then c.amount end as amount_typed,
         c.is_work
    from public.cc_transactions c
    left join public.events e on e.id = c.event_id
    left join public.user_settings tz on tz.user_id = c.user_id and tz.key = 'ledger_timezone';


-- ────────────────────────────────────────────────────────────
-- Search
-- ────────────────────────────────────────────────────────────
create or replace function public.ledger_search_events(
  p_query text default null, p_types text[] default null, p_subtypes text[] default null,
  p_statuses text[] default null, p_source_types text[] default null, p_entity_id uuid default null,
  p_entity_name text default null, p_from timestamptz default null, p_to timestamptz default null,
  p_min_confidence numeric default null, p_limit integer default 50, p_offset integer default 0,
  p_ascending boolean default false, p_user_id uuid default null
)
returns jsonb
language plpgsql
stable
set search_path = public, extensions, pg_temp
as $$
declare
  v_uid      uuid    := coalesce(p_user_id, auth.uid());
  v_limit    integer := least(greatest(coalesce(p_limit, 50), 1), 1000);
  v_offset   integer := greatest(coalesce(p_offset, 0), 0);
  v_query    text    := nullif(btrim(coalesce(p_query, '')), '');
  v_tsq      tsquery;
  v_text_ids uuid[];
  v_ent_ids  uuid[];
  v_norm     text;
  v_result   jsonb;
begin
  if not public.ledger_can_act_as(v_uid) then
    raise exception 'not authorized' using errcode = '42501';
  end if;

  -- Text: each branch can use its own index; the union is the match set.
  if v_query is not null then
    v_tsq := websearch_to_tsquery('simple', v_query);
    select coalesce(array_agg(id), '{}') into v_text_ids from (
      select e.id from public.events e where e.user_id = v_uid and e.search_tsv @@ v_tsq
      union
      select e.id from public.events e where e.user_id = v_uid and e.title ilike '%' || v_query || '%'
    ) t;
  end if;

  -- Entity: by id, or every entity that answers to the name — the merged-away
  -- spellings and the aliases included.
  if p_entity_id is not null then
    v_ent_ids := array[p_entity_id];
  end if;
  if p_entity_name is not null then
    v_norm := public.ledger_normalize_name(p_entity_name);
    select coalesce(array_agg(distinct x.id), '{}') into v_ent_ids from (
      select en.id from public.entities en
       where en.user_id = v_uid
         and (en.normalized_name = v_norm
              or (jsonb_typeof(en.metadata -> 'aliases') = 'array' and en.metadata -> 'aliases' ? v_norm))
      union
      select m.id from public.entities m
        join public.entities t on t.id::text = m.metadata ->> 'merged_into'
       where m.user_id = v_uid and m.normalized_name = v_norm
      union
      select t.id from public.entities m
        join public.entities t on t.id::text = m.metadata ->> 'merged_into'
       where m.user_id = v_uid and m.normalized_name = v_norm
    ) x
    where p_entity_id is null or x.id = p_entity_id;
  end if;

  with base as materialized (
    select e.id, e.occurred_at
    from public.events e
    where e.user_id = v_uid
      and (p_from is null or e.occurred_at >= p_from)
      and (p_to   is null or e.occurred_at <  p_to)
      and (p_types        is null or e.type        = any (p_types))
      and (p_subtypes     is null or e.subtype     = any (p_subtypes))
      and (p_source_types is null or e.source_type = any (p_source_types))
      and (case when p_statuses is null then e.status <> 'dismissed'
                else e.status = any (p_statuses) end)
      and (p_min_confidence is null or coalesce(e.confidence, 1) >= p_min_confidence)
      and (v_text_ids is null or e.id = any (v_text_ids))
      and (v_ent_ids is null or exists (
             select 1 from public.event_entities ee
             where ee.event_id = e.id and ee.entity_id = any (v_ent_ids)))
  ), page as (
    select id,
           row_number() over (
             order by case when p_ascending then occurred_at end asc,
                      case when p_ascending then null else occurred_at end desc,
                      id
           ) as rn
    from base
    order by rn
    limit v_limit offset v_offset
  )
  select jsonb_build_object(
    'total',  (select count(*) from base),
    'limit',  v_limit,
    'offset', v_offset,
    -- Ordered inside the aggregate, and joined back to `events` for a real
    -- composite. jsonb_agg makes no promise about a subquery's row order.
    'events', coalesce((
      select jsonb_agg(public.ledger_event_json(e, false) order by p.rn)
      from page p
      join public.events e on e.id = p.id
    ), '[]'::jsonb)
  ) into v_result;

  return v_result;
end;
$$;


-- ────────────────────────────────────────────────────────────
-- Aggregates in rupees
-- ────────────────────────────────────────────────────────────
create or replace function public.ledger_stats(
  p_from timestamptz default null, p_to timestamptz default null, p_user_id uuid default null
)
returns jsonb
language plpgsql
stable
set search_path = public, pg_temp
as $$
declare
  v_uid    uuid := coalesce(p_user_id, auth.uid());
  v_tz     text;
  v_result jsonb;
begin
  if not public.ledger_can_act_as(v_uid) then
    raise exception 'not authorized' using errcode = '42501';
  end if;
  v_tz := public.ledger_setting_text(v_uid, 'ledger_timezone', 'Asia/Kolkata');

  with ev as materialized (
    select e.*,
           public.ledger_amount_inr(e.data, e.occurred_at) as amount_inr,
           -- Which way the amount counts is decided once, by the one rule.
           public.ledger_money_flow(e.type, e.subtype, e.data) as flow,
           coalesce(e.data ->> 'category', public.ledger_spend_category(e.type, e.subtype, e.data, e.description)) as category
    from public.events e
    where e.user_id = v_uid
      and e.status <> 'dismissed'
      and (p_from is null or e.occurred_at >= p_from)
      and (p_to   is null or e.occurred_at <  p_to)
  ), base as (
    select ev.*,
           case when flow = 'spend'  then amount_inr end as spend_amount,
           case when flow = 'inflow' then amount_inr end as inflow_amount
      from ev
  )
  select jsonb_build_object(
    'from', p_from, 'to', p_to,
    'event_count',   (select count(*) from base),
    'first_event_at',(select min(occurred_at) from base),
    'last_event_at', (select max(occurred_at) from base),
    'active_days',   (select count(distinct (occurred_at at time zone v_tz)::date) from base),
    'by_type',       (select coalesce(jsonb_object_agg(type, n), '{}'::jsonb)   from (select type, count(*) n from base group by type) t),
    'by_subtype',    (select coalesce(jsonb_object_agg(subtype, n), '{}'::jsonb) from (select subtype, count(*) n from base where subtype is not null group by subtype) t),
    'by_status',     (select coalesce(jsonb_object_agg(status, n), '{}'::jsonb) from (select status, count(*) n from base group by status) t),
    'by_source',     (select coalesce(jsonb_object_agg(source_type, n), '{}'::jsonb) from (select source_type, count(*) n from base group by source_type) t),
    'currency', 'INR',
    'spend', jsonb_build_object(
      'total',       (select coalesce(sum(spend_amount), 0) from base where spend_amount is not null),
      'by_type',     (select coalesce(jsonb_object_agg(type, total), '{}'::jsonb)
                      from (select type, sum(spend_amount) total from base where spend_amount is not null group by type) t),
      'by_category', (select coalesce(jsonb_object_agg(category, total), '{}'::jsonb)
                      from (select coalesce(category, 'other') category, sum(spend_amount) total
                            from base where spend_amount is not null group by 1) t),
      'by_bucket',   (select coalesce(jsonb_object_agg(bucket, total), '{}'::jsonb)
                      from (select coalesce(public.ledger_budget_bucket(category), 'unbudgeted') bucket, sum(spend_amount) total
                            from base where spend_amount is not null group by 1) t),
      'transactions',(select count(*) from base where spend_amount is not null)
    ),
    'inflow', jsonb_build_object(
      'total',        (select coalesce(sum(inflow_amount), 0) from base where inflow_amount is not null),
      'transactions', (select count(*) from base where inflow_amount is not null)
    ),
    -- Amounts left out of every total above because they have no rupee value
    -- (reward points) or no rate yet.
    'unconverted', jsonb_build_object(
      'count',      (select count(*) from base where data ? 'amount' and public.ledger_num(data, 'amount') is not null and amount_inr is null),
      'currencies', (select coalesce(jsonb_agg(distinct coalesce(public.ledger_normalize_currency(data ->> 'currency'), 'INR')), '[]'::jsonb)
                       from base where data ? 'amount' and public.ledger_num(data, 'amount') is not null and amount_inr is null)
    ),
    'top_entities', coalesce((
      select jsonb_agg(x order by x -> 'count' desc)
      from (
        select jsonb_build_object('id', en.id, 'name', en.name, 'type', en.type,
                                  'count', count(*),
                                  -- An issuer is on the transaction, not on the
                                  -- receiving end of it.
                                  'amount', coalesce(sum(b.spend_amount)
                                    filter (where ee.relationship <> 'issuer'), 0)) as x
        from base b
        join public.event_entities ee on ee.event_id = b.id
        join public.entities en on en.id = ee.entity_id
        group by en.id, en.name, en.type
        order by count(*) desc
        limit 15
      ) t), '[]'::jsonb),
    'needs_review', (select count(*) from public.events
                      where user_id = v_uid and status in ('needs_review','inferred')
                        and (p_from is null or occurred_at >= p_from)
                        and (p_to   is null or occurred_at <  p_to))
  ) into v_result;

  return v_result;
end;
$$;


create or replace function public.ledger_get_entity(p_entity_id uuid)
returns jsonb
language plpgsql
stable
set search_path = public, pg_temp
as $$
declare
  v_entity public.entities%rowtype;
begin
  select * into v_entity from public.entities where id = p_entity_id;
  if not found then return null; end if;
  if not public.ledger_can_act_as(v_entity.user_id) then
    raise exception 'not authorized' using errcode = '42501';
  end if;

  return jsonb_build_object(
    'id', v_entity.id, 'type', v_entity.type, 'name', v_entity.name,
    'normalized_name', v_entity.normalized_name, 'metadata', v_entity.metadata,
    'created_at', v_entity.created_at,
    'merged_into', v_entity.metadata ->> 'merged_into',
    'event_count',  (select count(*) from public.event_entities where entity_id = p_entity_id),
    'first_seen_at',(select min(e.occurred_at) from public.event_entities ee join public.events e on e.id = ee.event_id where ee.entity_id = p_entity_id),
    'last_seen_at', (select max(e.occurred_at) from public.event_entities ee join public.events e on e.id = ee.event_id where ee.entity_id = p_entity_id),
    -- In rupees; an amount with no rupee value is left out.
    'total_amount', (select sum(public.ledger_amount_inr(e.data, e.occurred_at)) from public.event_entities ee join public.events e on e.id = ee.event_id
                      where ee.entity_id = p_entity_id and e.status <> 'dismissed')
  );
end;
$$;


-- life_days: the money block in rupees. Everything else as in 0011.
create or replace function public.life_days(p_from date, p_to date, p_user_id uuid default null)
returns jsonb
language plpgsql
stable security definer
set search_path = ''
as $$
declare
  v_user   uuid := health.reader(p_user_id);
  v_tz     text;
  v_target numeric;
  v_today  date;
  v_out    jsonb;
begin
  perform health.check_range(p_from, p_to, 120);
  v_tz     := public.ledger_setting_text(v_user, 'ledger_timezone', 'Asia/Kolkata');
  v_target := public.ledger_setting(v_user, 'food_kcal_target', 1800);
  v_today  := (now() at time zone v_tz)::date;

  with days as (
    select generate_series(p_from::timestamp, p_to::timestamp, interval '1 day')::date as day
  ),
  ev as (
    select (e.occurred_at at time zone v_tz)::date as day, e.type, e.subtype,
           public.ledger_amount_inr(e.data, e.occurred_at) as amount,
           public.ledger_money_flow(e.type, e.subtype, e.data) as flow
      from public.events e
     where e.user_id = v_user and e.status <> 'dismissed'
       and e.occurred_at >= (p_from::timestamp at time zone v_tz)
       and e.occurred_at <  ((p_to + 1)::timestamp at time zone v_tz)
  ),
  money as (
    select ev.day, count(*) as events,
           sum(ev.amount) filter (where ev.flow = 'spend')  as spend,
           sum(ev.amount) filter (where ev.flow = 'inflow') as inflow
      from ev group by ev.day
  ),
  work as (
    select w.day, w.amount from public.cc_work_spend(v_user, p_from, p_to) w
  ),
  meals as (
    select (m.occurred_at at time zone v_tz)::date as day, m.kcal, m.protein_g
      from jsonb_to_recordset(public.food_event_nutrition(
             (p_from::timestamp at time zone v_tz), ((p_to + 1)::timestamp at time zone v_tz), 5000, v_user))
           as m(occurred_at timestamptz, kcal numeric, protein_g numeric)
  ),
  food as (
    select m.day, round(sum(m.kcal))::int as eaten_kcal, round(sum(m.protein_g))::int as protein_g,
           count(m.kcal)::int as meals, (count(*) - count(m.kcal))::int as meals_unpriced
      from meals m where m.day between p_from and p_to group by m.day
  ),
  body as (
    select (b ->> 'day')::date as day, b - 'day' - 'workouts' - 'workout_min' - 'workout_types'
             - 'eaten_kcal' - 'protein_g' - 'carbs_g' - 'fat_g' as fields,
           (b ->> 'active_kcal')::numeric + (b ->> 'basal_kcal')::numeric as burned
      from jsonb_array_elements(public.health_overview(p_from, p_to, v_user)) b
  ),
  act as (
    select a.day, jsonb_agg(jsonb_strip_nulls(jsonb_build_object(
             'activity', a.activity, 'minutes', a.minutes, 'distance_km', a.distance_km,
             'active_kcal', a.active_kcal, 'source', a.source, 'note', a.note)) order by a.start_at) as items
      from health.activity_feed(v_user, p_from, p_to) a group by a.day
  )
  select jsonb_agg(jsonb_strip_nulls(jsonb_build_object(
    'day', d.day,
    'is_today', case when d.day = v_today then true end,
    'events', mo.events,
    -- `spend` is everything, in rupees. When some of it was work (a points row
    -- under the work label), it is also given split.
    'money', case when mo.spend is not null or mo.inflow is not null then jsonb_strip_nulls(jsonb_build_object(
               'spend', round(mo.spend), 'inflow', round(mo.inflow),
               'work_spend', round(wk.amount),
               'personal_spend', case when wk.amount is not null then round(greatest(mo.spend - wk.amount, 0)) end)) end,
    'food', case when f.day is not null then jsonb_build_object(
               'eaten_kcal', f.eaten_kcal, 'protein_g', f.protein_g, 'meals', f.meals, 'meals_unpriced', f.meals_unpriced) end,
    'body', case when b.fields <> '{}'::jsonb then b.fields end,
    'energy', case when f.eaten_kcal is not null or b.burned is not null then jsonb_strip_nulls(jsonb_build_object(
               'eaten_kcal', f.eaten_kcal,
               'burned_kcal', round(b.burned)::int,
               'balance_kcal', round(f.eaten_kcal - b.burned)::int,
               'target_kcal', round(v_target)::int,
               'eaten_vs_target', f.eaten_kcal - round(v_target)::int,
               'eaten_looks_partial', case when f.eaten_kcal < 0.6 * v_target then true end,
               'complete', (d.day <> v_today and coalesce(f.meals_unpriced, 0) = 0
                            and f.eaten_kcal is not null and b.burned is not null
                            and f.eaten_kcal >= 0.6 * v_target))) end,
    'activity', a.items
  )) order by d.day)
  into v_out
  from days d
  left join money mo on mo.day = d.day
  left join work  wk on wk.day = d.day
  left join food  f  on f.day  = d.day
  left join body  b  on b.day  = d.day
  left join act   a  on a.day  = d.day;

  return coalesce(v_out, '[]'::jsonb);
end;
$$;


-- ────────────────────────────────────────────────────────────
-- ledger_purge_snippets (0018 §5): snippet expiry and the stuck-run → failed
-- update stay; empty succeeded runs are no longer deleted. runs_deleted is
-- still returned (always 0) so `ledger/cli.js purge` output stays valid.
-- ────────────────────────────────────────────────────────────
create or replace function public.ledger_purge_snippets(p_days integer default null, p_user_id uuid default null)
returns jsonb
language plpgsql
set search_path = public, pg_temp
as $$
declare
  v_uid          uuid := coalesce(p_user_id, auth.uid());
  v_days         integer;
  v_snippets     integer;
  v_runs_failed  integer;
  v_runs_deleted integer := 0;
begin
  if not public.ledger_can_act_as(v_uid) then
    raise exception 'not authorized' using errcode = '42501';
  end if;

  v_days := coalesce(p_days, public.ledger_setting(v_uid, 'ledger_snippet_retention_days', 90)::int);

  -- The one key buildIngestPayload() stores (src/ledger/email.js).
  update public.sources
     set metadata = metadata - 'snippet'
   where user_id = v_uid
     and created_at < now() - make_interval(days => v_days)
     and metadata ? 'snippet';
  get diagnostics v_snippets = row_count;

  -- A run that is still "running" six hours on was never finished: the job
  -- died before finishRun(). Say so, so the row stops looking live.
  update public.ingestion_runs
     set status       = 'failed',
         completed_at = coalesce(completed_at, now()),
         errors       = errors || jsonb_build_array(jsonb_build_object(
                          'stage', 'purge',
                          'error', 'still running after 6 hours; marked failed by ledger_purge_snippets()'))
   where user_id = v_uid
     and status = 'running'
     and started_at < now() - interval '6 hours';
  get diagnostics v_runs_failed = row_count;

  -- kept: user wants no row deletion; empty runs stay as history
  -- delete from public.ingestion_runs
  --  where user_id = v_uid
  --    and status = 'succeeded'
  --    and items_seen = 0
  --    and started_at < now() - interval '30 days';
  -- get diagnostics v_runs_deleted = row_count;

  return jsonb_build_object(
    'snippets_cleared', v_snippets,
    'runs_failed',      v_runs_failed,
    'runs_deleted',     v_runs_deleted,
    'retention_days',   v_days);
end;
$$;
