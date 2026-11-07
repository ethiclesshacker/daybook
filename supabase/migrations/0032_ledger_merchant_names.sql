-- ============================================================
-- 0032  The ledger shows your name for a merchant.
--
-- Points knows that "Vedant Fashions Limite" is Manyavar. The ledger went on
-- saying Vedant Fashions Limite, because nothing read those names across.
--
-- ledger_event_json() now adds two fields when you have a name for the merchant:
--   merchant_label  your name: the Points row's first, as you chose it for that
--                   spend, else the merchant's rule
--   display_title   the title with the bank's spelling swapped for your name
-- `title` and data.merchant stay as they were. Rules match on data.merchant and an
-- edit form must not write a derived title back, so this only changes what is read.
--
-- A rule covers every card unless names_everywhere is off. It is off for two where
-- the points card's history does not describe the merchant elsewhere: Zomato is
-- District bookings on that card and food orders on the others, and Bundl is
-- Instamart there and Swiggy generally.
--
-- Search finds a row by the bank's name or yours.
--
-- Safe to re-run.
-- ============================================================

alter table public.cc_merchant_rules add column if not exists names_everywhere boolean not null default true;

update public.cc_merchant_rules set names_everywhere = false
 where merchant_key in ('zomato', public.ledger_normalize_name('Bundl Technologies P'));

create or replace function public.ledger_merchant_names(p_event public.events)
returns jsonb
language sql
stable
set search_path = public, pg_temp
as $$
  with bank as (
    select nullif(btrim(p_event.data ->> 'merchant'), '') as name
  ), pick as (
    select bank.name, coalesce(
      (select nullif(btrim(c.merchant), '') from public.cc_transactions c
        where c.event_id = p_event.id and c.merchant <> 'Unknown Merchant'),
      (select r.label from public.cc_merchant_rules r
        where r.user_id = p_event.user_id and r.names_everywhere
          and r.merchant_key = public.ledger_normalize_name(bank.name))
    ) as label
    from bank
  )
  select case
    when label is null or lower(label) = lower(name) then '{}'::jsonb
    else jsonb_build_object(
      'merchant_label', label,
      'display_title', case
        when name is not null and position(lower(name) in lower(p_event.title)) > 0
          then overlay(p_event.title placing label from position(lower(name) in lower(p_event.title)) for length(name))
        when name is null and p_event.title ~* '^card transaction'
          then overlay(p_event.title placing label from 1 for length('card transaction'))
        else p_event.title
      end)
  end
  from pick;
$$;

revoke all on function public.ledger_merchant_names(public.events) from public, anon;
grant execute on function public.ledger_merchant_names(public.events) to authenticated, service_role;

create or replace function public.ledger_event_json(p_event public.events, p_detail boolean default false)
returns jsonb
language sql
stable
set search_path = public, pg_temp
as $$
  select jsonb_build_object(
    'id',              p_event.id,
    'occurred_at',     p_event.occurred_at,
    'occurred_at_end', p_event.occurred_at_end,
    'type',            p_event.type,
    'subtype',         p_event.subtype,
    'title',           p_event.title,
    'description',     p_event.description,
    'data',            p_event.data,
    'inference',       p_event.inference,
    'source_type',     p_event.source_type,
    'source_id',       p_event.source_id,
    'confidence',      p_event.confidence,
    'status',          p_event.status,
    'dedupe_key',      p_event.dedupe_key,
    'created_at',      p_event.created_at,
    'updated_at',      p_event.updated_at,
    'amount_inr',      public.ledger_amount_inr(p_event.data, p_event.occurred_at),
    -- data.currency is already canonical (the trigger writes it); absent is rupees.
    'currency',        case when p_event.data ? 'amount' then coalesce(p_event.data ->> 'currency', 'INR') end,
    'category',        p_event.data ->> 'category',
    'budget_bucket',   public.ledger_budget_bucket(p_event.data ->> 'category'),
    'money_flow',      case when p_event.data ? 'amount'
                            then public.ledger_money_flow(p_event.type, p_event.subtype, p_event.data) end,
    'review_reason',   p_event.inference ->> 'review_reason',
    'entities', (
      select coalesce(jsonb_agg(jsonb_build_object(
               'id', en.id, 'type', en.type, 'name', en.name, 'relationship', ee.relationship
             ) order by en.name), '[]'::jsonb)
      from public.event_entities ee
      join public.entities en on en.id = ee.entity_id
      where ee.event_id = p_event.id
    ),
    'source_count', (select count(*) from public.event_sources es where es.event_id = p_event.id)
  )
  || public.ledger_merchant_names(p_event)
  || case when p_detail then jsonb_build_object(
    'sources', (
      select coalesce(jsonb_agg(jsonb_build_object(
               'id', s.id, 'source_type', s.source_type, 'external_id', s.external_id,
               'external_url', s.external_url, 'source_timestamp', s.source_timestamp,
               'account_key', s.account_key, 'metadata', s.metadata, 'raw_reference', s.raw_reference,
               'role', es.role, 'extracted_by', es.extracted_by, 'contributed', es.contributed
             ) order by es.created_at), '[]'::jsonb)
      from public.event_sources es
      join public.sources s on s.id = es.source_id
      where es.event_id = p_event.id
    ),
    'related_events', (
      select coalesce(jsonb_agg(jsonb_build_object(
               'id', e2.id, 'relationship', r.relationship, 'title', e2.title,
               'occurred_at', e2.occurred_at, 'type', e2.type)), '[]'::jsonb)
      from public.event_relations r
      join public.events e2 on e2.id = r.related_event_id
      where r.event_id = p_event.id
    ),
    'history', (
      select coalesce(jsonb_agg(jsonb_build_object(
               'action', a.action, 'actor', a.actor, 'at', a.at,
               'before', a.before, 'after', a.after) order by a.at desc), '[]'::jsonb)
      from public.ledger_audit_log a where a.record_id = p_event.id
    )
  ) else '{}'::jsonb end;
$$;

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
