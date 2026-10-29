-- Intake corrections preserve the receipt's items, amount and purchase date.
-- Grocery purchases are not intake; a separate meal can link to purchase_event_id.
-- No historical rows are rewritten. Replaces the 0006 nutrition read functions.
begin;

create or replace function public.food_eaten_at(p_occurred_at timestamptz, p_data jsonb)
returns timestamptz language plpgsql stable set search_path = '' as $$
begin
  return coalesce(nullif(p_data ->> 'eaten_at', '')::timestamptz, p_occurred_at);
exception when invalid_datetime_format or datetime_field_overflow then
  return p_occurred_at;
end;
$$;

create or replace function public.food_eaten_items(p_data jsonb)
returns jsonb language sql immutable set search_path = '' as $$
  select case
    when jsonb_typeof(p_data -> 'eaten_items') = 'array' then p_data -> 'eaten_items'
    when jsonb_typeof(p_data -> 'items') = 'array' then p_data -> 'items'
    else '[]'::jsonb end;
$$;

revoke all on function public.food_eaten_at(timestamptz, jsonb) from public, anon;
revoke all on function public.food_eaten_items(jsonb) from public, anon;
grant execute on function public.food_eaten_at(timestamptz, jsonb), public.food_eaten_items(jsonb) to authenticated, service_role;

create or replace function public.food_event_nutrition(
  p_from    timestamptz default null,
  p_to      timestamptz default null,
  p_limit   integer     default 2000,
  p_user_id uuid        default null
)
returns jsonb language plpgsql stable security definer
set search_path = public, extensions, pg_temp as $$
declare
  v_user uuid := coalesce(p_user_id, auth.uid());
  v_out  jsonb;
begin
  if not public.ledger_can_act_as(v_user) then
    raise exception 'not authorized for user %', v_user using errcode = '42501';
  end if;

  with ev as (
    select e.id, public.food_eaten_at(e.occurred_at, e.data) as occurred_at, e.subtype, e.title,
           public.ledger_num(e.data, 'amount')                         as amount,
           coalesce(e.data ->> 'ordered_via', e.data ->> 'merchant')   as via,
           coalesce(e.data ->> 'restaurant',  e.data ->> 'merchant')   as place,
           public.food_eaten_items(e.data)            as items
    from public.events e
    where e.user_id = v_user
      and e.type = 'food'
      and e.status <> 'dismissed'
      and e.subtype is distinct from 'groceries'
      and coalesce(e.data ->> 'not_eaten', 'false') <> 'true'
      and (p_from is null or public.food_eaten_at(e.occurred_at, e.data) >= p_from)
      and (p_to   is null or public.food_eaten_at(e.occurred_at, e.data) <= p_to)
    order by public.food_eaten_at(e.occurred_at, e.data) desc
    limit greatest(p_limit, 0)
  ),
  li as (
    select ev.id as event_id,
           coalesce(public.ledger_num(item, 'qty'), 1) as qty,
           -- The stated count, when the line item carries one.
           coalesce(public.ledger_num(item, 'kcal'),
                    public.ledger_num(item, 'calories'))               as stated_kcal,
           f.kcal as dict_kcal,
           f.protein_g, f.carbs_g, f.fat_g, f.source, f.confidence
    from ev
    cross join lateral jsonb_array_elements(ev.items) as item
    left join public.food_items f
      on f.user_id = v_user
     and f.normalized_name = public.ledger_normalize_name(nullif(btrim(item ->> 'name'), ''))
  ),
  agg as (
    select event_id,
           count(*)::int                                              as items_total,
           count(coalesce(stated_kcal, dict_kcal))::int               as items_resolved,
           sum(qty * coalesce(stated_kcal, dict_kcal))                as kcal,
           sum(qty * protein_g)                                       as protein_g,
           sum(qty * carbs_g)                                         as carbs_g,
           sum(qty * fat_g)                                           as fat_g,
           min(confidence)                                            as confidence,
           min(public.food_source_rank(source))                       as weakest_rank
    from li group by event_id
  )
  select coalesce(jsonb_agg(to_jsonb(r) order by r.occurred_at desc), '[]'::jsonb) into v_out
  from (
    select ev.id, ev.occurred_at, ev.subtype, ev.title, ev.amount, ev.via, ev.place,
           coalesce(a.items_total, 0)    as items_total,
           coalesce(a.items_resolved, 0) as items_resolved,
           round(a.kcal, 1)      as kcal,
           round(a.protein_g, 1) as protein_g,
           round(a.carbs_g, 1)   as carbs_g,
           round(a.fat_g, 1)     as fat_g,
           a.confidence,
           case
             when coalesce(a.items_total, 0) = 0                then 'none'
             when a.items_resolved = 0                          then 'none'
             when a.items_resolved < a.items_total              then 'partial'
             else 'itemized'
           end as basis
    from ev left join agg a on a.event_id = ev.id
  ) r;

  return v_out;
end;
$$;


create or replace function public.food_coverage(p_user_id uuid default null)
returns jsonb language plpgsql stable security definer
set search_path = public, extensions, pg_temp as $$
declare
  v_user uuid := coalesce(p_user_id, auth.uid());
  v_out  jsonb;
begin
  if not public.ledger_can_act_as(v_user) then
    raise exception 'not authorized for user %', v_user using errcode = '42501';
  end if;

  with ev as (
    select e.id,
           public.food_eaten_items(e.data) as items
    from public.events e
    where e.user_id = v_user and e.type = 'food' and e.status <> 'dismissed'
      and e.subtype is distinct from 'groceries'
      and coalesce(e.data ->> 'not_eaten', 'false') <> 'true'
  ),
  li as (
    select ev.id as event_id,
           (coalesce(public.ledger_num(item, 'kcal'),
                     public.ledger_num(item, 'calories')) is not null
            or f.kcal is not null) as resolved
    from ev
    cross join lateral jsonb_array_elements(ev.items) as item
    left join public.food_items f
      on f.user_id = v_user
     and f.normalized_name = public.ledger_normalize_name(nullif(btrim(item ->> 'name'), ''))
  ),
  per_event as (
    select event_id, count(*) as n, count(*) filter (where resolved) as ok
    from li group by event_id
  )
  select jsonb_build_object(
    'events_total',        (select count(*) from ev),
    'events_with_items',   (select count(*) from per_event),
    'events_itemized',     (select count(*) from per_event where ok = n),
    'events_partial',      (select count(*) from per_event where ok > 0 and ok < n),
    'events_no_items',     (select count(*) from ev) - (select count(*) from per_event),
    'line_items_total',    (select count(*) from li),
    'line_items_resolved', (select count(*) from li where resolved),
    'dictionary_size',     (select count(*) from public.food_items where user_id = v_user),
    'dictionary_resolved', (select count(*) from public.food_items
                             where user_id = v_user and kcal is not null),
    'by_source',           (select coalesce(jsonb_object_agg(source, n), '{}'::jsonb)
                              from (select source, count(*) as n from public.food_items
                                     where user_id = v_user and kcal is not null
                                     group by source) s)
  ) into v_out;

  return v_out;
end;
$$;

commit;
