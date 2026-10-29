-- food_pending_items reads what was eaten, not only what the receipt listed.
--
-- 0027 moved intake corrections to data.eaten_items so the receipt basket
-- stays intact, but the resolver's queue still read data.items. A dish added
-- to an existing order on the Food page therefore never reached the nutrition
-- pass and stayed "unpriced" forever. Read through food_eaten_items(), the
-- same function the rollup uses, so the queue and the totals agree on what
-- the line items are. Grocery purchases are skipped: they are not intake, and
-- a portion logged from one is its own meal event with its own items.
begin;

create or replace function public.food_pending_items(
  p_limit   integer default 500,
  p_user_id uuid    default null
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

  with line_items as (
    select
      nullif(btrim(item ->> 'name'), '')                             as display_name,
      public.ledger_normalize_name(nullif(btrim(item ->> 'name'), '')) as normalized_name,
      coalesce(public.ledger_num(item, 'qty'), 1)                    as qty
    from public.events e
    cross join lateral jsonb_array_elements(public.food_eaten_items(e.data)) as item
    where e.user_id = v_user
      and e.type = 'food'
      and e.status <> 'dismissed'
      and e.subtype is distinct from 'groceries'
  ),
  rolled as (
    select normalized_name,
           mode() within group (order by display_name) as display_name,
           count(*)::int                              as occurrences,
           sum(qty)::numeric                          as total_qty
    from line_items
    where normalized_name is not null
    group by normalized_name
  )
  select coalesce(jsonb_agg(to_jsonb(r) order by r.occurrences desc, r.normalized_name), '[]'::jsonb)
    into v_out
  from (
    select rolled.*
    from rolled
    left join public.food_items f
      on f.user_id = v_user and f.normalized_name = rolled.normalized_name
    where f.id is null or f.kcal is null
    order by rolled.occurrences desc, rolled.normalized_name
    limit greatest(p_limit, 0)
  ) r;

  return v_out;
end;
$$;

revoke all on function public.food_pending_items(integer, uuid) from public, anon;
grant execute on function public.food_pending_items(integer, uuid) to authenticated, service_role;

commit;
