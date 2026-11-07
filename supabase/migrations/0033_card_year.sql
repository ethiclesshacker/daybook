-- ============================================================
-- 0033  The card year, and asking about one card.
--
-- HSBC measures both spend milestones over an anniversary year that runs from
-- the account's open date: the annual fee is reversed above ₹8L, and 10,000 bonus
-- points come above ₹12L. The Points page measured lifetime spend instead, so the
-- bar would have stayed full for ever. cc_card_year() is the one definition, read
-- by the page and by Edith. The points balance stays lifetime.
--
-- Setting `cc_opened_on` (YYYY-MM-DD) holds the open date. Without it,
-- cc_card_year() answers configured = false rather than guess.
--
-- ledger_card_transactions() lists one card's spend in short rows, largest first
-- by default. The points card reads cc_points, because some of its rows have no
-- event, so its total matches the Points page. Any other card reads its events.
--
-- ledger_search_events() gains p_card and p_sort. They go after the existing
-- arguments so existing calls keep working.
--
-- Safe to re-run.
-- ============================================================

-- The anniversary year holding p_on: both ends inclusive. A day before the card
-- opened belongs to its first year, so a stray early row is not lost.
create or replace function public.cc_year_bounds(p_opened date, p_on date)
returns table (year_no integer, year_from date, year_to date)
language sql immutable
set search_path = public, pg_temp as $$
  with n as (
    select greatest(extract(year from age(p_on, p_opened))::integer, 0) as elapsed
  )
  select elapsed + 1,
         (p_opened + make_interval(years => elapsed))::date,
         (p_opened + make_interval(years => elapsed + 1))::date - 1
    from n;
$$;

-- The open date, or null when it is unset or not a date.
create or replace function public.cc_opened_on(p_user_id uuid)
returns date language plpgsql stable
set search_path = public, pg_temp as $$
declare
  v_text text := public.ledger_setting_text(p_user_id, 'cc_opened_on', '');
begin
  if v_text !~ '^\d{4}-\d{2}-\d{2}$' then return null; end if;
  return v_text::date;
exception when others then
  return null;
end;
$$;

create or replace function public.cc_card_year(p_on date default null, p_user_id uuid default null)
returns jsonb language plpgsql stable
set search_path = public, pg_temp as $$
declare
  v_user   uuid := coalesce(p_user_id, auth.uid());
  v_today  date;
  v_on     date;
  v_opened date;
  v_no     integer;
  v_from   date;
  v_to     date;
  v_out    jsonb;
begin
  if not public.ledger_can_act_as(v_user) then
    raise exception 'not authorized for user %', v_user using errcode = '42501';
  end if;

  v_today  := (now() at time zone public.ledger_setting_text(v_user, 'ledger_timezone', 'Asia/Kolkata'))::date;
  v_on     := coalesce(p_on, v_today);
  v_opened := public.cc_opened_on(v_user);
  if v_opened is null then
    return jsonb_build_object('configured', false, 'today', v_today);
  end if;

  select b.year_no, b.year_from, b.year_to into v_no, v_from, v_to
    from public.cc_year_bounds(v_opened, v_on) b;

  with tx as (
    select c.id, c.date, c.amount, c.is_work, c.basis,
           coalesce(c.points, c.amount * c.multiplier / 100.0) as pts,
           row_number() over (order by c.date, c.id) as seq
      from public.cc_points c
     where c.user_id = v_user and c.date between v_from and v_to
  ),
  run as (
    select t.*, sum(t.amount) over (order by t.seq) as total from tx t
  ),
  spend as (select coalesce(sum(amount), 0) as total from tx),
  goal as (
    select 'fee_waiver' as key, 'Annual fee reversed' as label, 1 as ord,
           public.ledger_setting(v_user, 'cc_fee_waiver_target', 800000) as target
    union all
    select 'bonus_points', '10,000 bonus points', 2,
           public.ledger_setting(v_user, 'cc_milestone_target', 1200000)
  )
  select jsonb_build_object(
    'configured',  true,
    'opened_on',   v_opened,
    'today',       v_today,
    'year_no',     v_no,
    'from',        v_from,
    'to',          v_to,
    'is_current',  v_today between v_from and v_to,
    'days_left',   case when v_today between v_from and v_to then v_to - v_today end,
    'spend',       round((select total from spend), 2),
    'work_spend',  round((select coalesce(sum(amount), 0) from tx where is_work), 2),
    'points',      round((select coalesce(sum(pts), 0) from tx)),
    'transactions', (select count(*) from tx),
    'assumed_rows', (select count(*) from tx where basis = 'assumed'),
    -- Both terms say "exceeds", so landing exactly on a target has not reached it.
    -- reached_on is when spend last went above it: a later refund can undo a crossing.
    'milestones', (
      select jsonb_agg(jsonb_build_object(
        'key', g.key, 'label', g.label, 'target', g.target,
        'reached', s.total > g.target,
        'remaining', round(greatest(g.target - s.total, 0), 2),
        'reached_on', case when s.total > g.target then (
          select min(r.date) from run r
           where r.seq > coalesce((select max(x.seq) from run x where x.total <= g.target), 0)
        ) end
      ) order by g.ord)
      from goal g cross join spend s
    ),
    -- Every year so far, newest first, for a picker. Includes the one asked about.
    'years', (
      select jsonb_agg(jsonb_build_object('year_no', y.year_no, 'from', y.year_from, 'to', y.year_to)
                       order by y.year_no desc)
        from generate_series(0, greatest(extract(year from age(greatest(v_today, v_on), v_opened))::integer, 0)) as i
       cross join lateral public.cc_year_bounds(v_opened, (v_opened + make_interval(years => i))::date) y
    )
  ) into v_out;

  return v_out;
end;
$$;

create or replace function public.ledger_card_transactions(
  p_card text default null, p_from date default null, p_to date default null,
  p_query text default null, p_min_amount numeric default null, p_is_work boolean default null,
  p_sort text default 'amount', p_ascending boolean default false,
  p_limit integer default 25, p_offset integer default 0, p_user_id uuid default null
)
returns jsonb language plpgsql stable
set search_path = public, pg_temp as $$
declare
  v_user   uuid    := coalesce(p_user_id, auth.uid());
  v_points text;
  v_card   text;
  v_is_pts boolean;
  v_from   date    := p_from;
  v_to     date    := p_to;
  v_limit  integer := least(greatest(coalesce(p_limit, 25), 1), 200);
  v_offset integer := greatest(coalesce(p_offset, 0), 0);
  v_query  text    := nullif(btrim(coalesce(p_query, '')), '');
  v_tz     text;
  v_out    jsonb;
begin
  if not public.ledger_can_act_as(v_user) then
    raise exception 'not authorized for user %', v_user using errcode = '42501';
  end if;
  if coalesce(p_sort, 'amount') not in ('amount', 'date') then
    raise exception 'p_sort must be amount or date' using errcode = '22023';
  end if;

  v_tz     := public.ledger_setting_text(v_user, 'ledger_timezone', 'Asia/Kolkata');
  v_points := public.ledger_setting_text(v_user, 'cc_points_account', '');
  v_card   := coalesce(nullif(btrim(p_card), ''), nullif(v_points, ''));
  v_is_pts := v_card is not distinct from nullif(v_points, '');

  -- No dates on the points card means this card year, the question it is usually.
  if v_is_pts and v_from is null and v_to is null and public.cc_opened_on(v_user) is not null then
    select b.year_from, b.year_to into v_from, v_to
      from public.cc_year_bounds(public.cc_opened_on(v_user), (now() at time zone v_tz)::date) b;
  end if;

  with card_rows as (
    select c.date, c.merchant, c.raw_merchant as bank_name, c.amount, c.description,
           c.is_work, c.multiplier, round(coalesce(c.points, c.amount * c.multiplier / 100.0), 2) as points,
           c.basis, c.event_id
      from public.cc_points c
     where v_is_pts and c.user_id = v_user
    union all
    select (e.occurred_at at time zone v_tz)::date,
           coalesce(public.ledger_merchant_names(e) ->> 'merchant_label', nullif(btrim(e.data ->> 'merchant'), ''), e.title),
           nullif(btrim(e.data ->> 'merchant'), ''),
           public.ledger_amount_inr(e.data, e.occurred_at),
           nullif(btrim(e.description), ''),
           null::boolean, null::numeric, null::numeric, null::text, e.id
      from public.events e
     where not v_is_pts and e.user_id = v_user
       and e.data ->> 'account' = v_card
       and (e.data ->> 'amount') ~ '^[0-9]+(\.[0-9]+)?$'
       and e.status <> 'dismissed'
       and e.type <> 'transfer'
       and coalesce(e.data ->> 'direction', 'debit') <> 'credit'
  ),
  hits as materialized (
    select r.* from card_rows r
     where (v_from is null or r.date >= v_from)
       and (v_to   is null or r.date <= v_to)
       and (p_min_amount is null or r.amount >= p_min_amount)
       and (p_is_work is null or r.is_work = p_is_work)
       and (v_query is null or r.merchant ilike '%' || v_query || '%'
            or r.bank_name ilike '%' || v_query || '%' or r.description ilike '%' || v_query || '%')
  ),
  ordered as (
    select h.*, row_number() over (
             order by case when coalesce(p_sort, 'amount') = 'amount' and p_ascending then h.amount end asc nulls last,
                      case when coalesce(p_sort, 'amount') = 'amount' and not p_ascending then h.amount end desc nulls last,
                      case when p_ascending then h.date end asc,
                      case when not p_ascending then h.date end desc,
                      h.merchant
           ) as rn
      from hits h
  )
  select jsonb_build_object(
    'card', v_card,
    'is_points_card', v_is_pts,
    'from', v_from,
    'to', v_to,
    'sort', coalesce(p_sort, 'amount'),
    'total', (select count(*) from hits),
    'net_spend', round((select coalesce(sum(amount), 0) from hits), 2),
    'work_spend', case when v_is_pts then round((select coalesce(sum(amount), 0) from hits where is_work), 2) end,
    'limit', v_limit,
    'offset', v_offset,
    'has_more', (select count(*) from hits) > v_offset + v_limit,
    'rows', coalesce((
      select jsonb_agg(jsonb_strip_nulls(jsonb_build_object(
               'date', o.date, 'merchant', o.merchant, 'bank_name', o.bank_name, 'amount', o.amount,
               'description', o.description, 'is_work', o.is_work, 'multiplier', o.multiplier,
               'points', o.points, 'basis', o.basis, 'event_id', o.event_id)) order by o.rn)
        from ordered o where o.rn > v_offset and o.rn <= v_offset + v_limit
    ), '[]'::jsonb)
  ) into v_out;

  return v_out;
end;
$$;

-- The old signature has to go, or two overloads would make every call ambiguous.
drop function if exists public.ledger_search_events(text, text[], text[], text[], text[], uuid, text, timestamptz, timestamptz, numeric, integer, integer, boolean, uuid);

create or replace function public.ledger_search_events(
  p_query text default null, p_types text[] default null, p_subtypes text[] default null,
  p_statuses text[] default null, p_source_types text[] default null, p_entity_id uuid default null,
  p_entity_name text default null, p_from timestamptz default null, p_to timestamptz default null,
  p_min_confidence numeric default null, p_limit integer default 50, p_offset integer default 0,
  p_ascending boolean default false, p_user_id uuid default null,
  p_card text default null, p_sort text default 'date'
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
  if coalesce(p_sort, 'date') not in ('date', 'amount') then
    raise exception 'p_sort must be date or amount' using errcode = '22023';
  end if;

  -- Text: each branch can use its own index; the union is the match set.
  if v_query is not null then
    v_tsq := websearch_to_tsquery('simple', v_query);
    select coalesce(array_agg(id), '{}') into v_text_ids from (
      select e.id from public.events e where e.user_id = v_uid and e.search_tsv @@ v_tsq
      union
      select e.id from public.events e where e.user_id = v_uid and e.title ilike '%' || v_query || '%'
      union
      -- The bank's name, which a title need not contain.
      select e.id from public.events e where e.user_id = v_uid and e.data ->> 'merchant' ilike '%' || v_query || '%'
      union
      -- Your name for it: on the Points row, or from a rule.
      select c.event_id from public.cc_transactions c
       where c.user_id = v_uid and c.event_id is not null and c.merchant ilike '%' || v_query || '%'
      union
      select e.id from public.events e
        join public.cc_merchant_rules r
          on r.user_id = e.user_id and r.merchant_key = public.ledger_normalize_name(e.data ->> 'merchant')
       where e.user_id = v_uid and r.names_everywhere and r.label ilike '%' || v_query || '%'
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
    select e.id, e.occurred_at,
           case when p_sort = 'amount' then public.ledger_amount_inr(e.data, e.occurred_at) end as amount_inr
    from public.events e
    where e.user_id = v_uid
      and (p_from is null or e.occurred_at >= p_from)
      and (p_to   is null or e.occurred_at <  p_to)
      and (p_card is null or e.data ->> 'account' = p_card)
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
             order by case when p_ascending then amount_inr end asc nulls last,
                      case when p_ascending then null else amount_inr end desc nulls last,
                      case when p_ascending then occurred_at end asc,
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

revoke all on function public.cc_year_bounds(date, date) from public, anon;
revoke all on function public.cc_opened_on(uuid) from public, anon;
revoke all on function public.cc_card_year(date, uuid) from public, anon;
revoke all on function public.ledger_card_transactions(text, date, date, text, numeric, boolean, text, boolean, integer, integer, uuid) from public, anon;
revoke all on function public.ledger_search_events(text, text[], text[], text[], text[], uuid, text, timestamptz, timestamptz, numeric, integer, integer, boolean, uuid, text, text) from public, anon;
grant execute on function public.cc_year_bounds(date, date) to authenticated, service_role;
grant execute on function public.cc_opened_on(uuid) to authenticated, service_role;
grant execute on function public.cc_card_year(date, uuid) to authenticated, service_role;
grant execute on function public.ledger_card_transactions(text, date, date, text, numeric, boolean, text, boolean, integer, integer, uuid) to authenticated, service_role;
grant execute on function public.ledger_search_events(text, text[], text[], text[], text[], uuid, text, timestamptz, timestamptz, numeric, integer, integer, boolean, uuid, text, text) to authenticated, service_role;
