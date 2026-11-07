-- ============================================================
-- 0031  What a card spend earns when no rule names its merchant.
--
-- A new merchant used to arrive at 2x whatever it was, so a 4x airline needed a
-- rule of its own to say so. Those rules were learned from hand-typed rows, and
-- many said only "IndiGo is called Indigo, and it is 4x". The category already
-- knows that. In the card's history travel mostly earns 4x, and fuel and tax earn
-- nothing. A rule still wins, and a row stays 'assumed' until someone confirms it.
--
-- Safe to re-run.
-- ============================================================

create or replace function public.cc_default_multiplier(p_category text)
returns integer language sql immutable
set search_path = public, pg_temp as $$
  select case
    when p_category = 'travel' then 4
    when p_category in ('fuel', 'tax') then 0
    else 2
  end;
$$;

grant execute on function public.cc_default_multiplier(text) to authenticated, service_role;

create or replace function public.cc_sync_from_events(p_user_id uuid default null)
returns jsonb language plpgsql
set search_path = public, pg_temp as $$
declare
  v_user    uuid := coalesce(p_user_id, auth.uid());
  v_from    date;
  v_created int;
begin
  if not public.ledger_can_act_as(v_user) then
    raise exception 'not authorized for user %', v_user using errcode = '42501';
  end if;

  select (s.value #>> '{}')::date into v_from
    from public.user_settings s where s.user_id = v_user and s.key = 'cc_auto_from';

  if v_from is null then
    select coalesce(max(c.date) + 1, current_date) into v_from
      from public.cc_transactions c where c.user_id = v_user and c.basis = 'manual';
    insert into public.user_settings (user_id, key, value)
    values (v_user, 'cc_auto_from', to_jsonb(v_from::text))
    on conflict (user_id, key) do nothing;
  end if;

  insert into public.cc_transactions (user_id, date, merchant, description, amount, multiplier, points, event_id, basis, raw_merchant, is_work)
  select v_user, ce.day, coalesce(r.label, ce.merchant, 'Unknown Merchant'), null, ce.amount,
         coalesce(r.multiplier, public.cc_default_multiplier(e.data ->> 'category')), null, ce.event_id, 'assumed', ce.merchant, coalesce(r.is_work, false)
    from public.cc_card_events(v_user) ce
    join public.events e on e.id = ce.event_id
    left join public.cc_merchant_rules r on r.user_id = v_user and r.merchant_key = ce.merchant_key
   where ce.day >= v_from
     and not exists (select 1 from public.cc_transactions x where x.event_id = ce.event_id)
     and not exists (select 1 from public.cc_ignored_events i where i.user_id = v_user and i.event_id = ce.event_id);

  get diagnostics v_created = row_count;
  return jsonb_build_object('created', v_created, 'auto_from', v_from,
    'assumed_waiting', (select count(*) from public.cc_transactions c where c.user_id = v_user and c.basis = 'assumed'));
end;
$$;


create or replace function public.cc_create_from_event(p_event_id uuid, p_user_id uuid default null)
returns jsonb language plpgsql
set search_path = public, pg_temp as $$
declare
  v_user uuid := coalesce(p_user_id, auth.uid());
  v_row  public.cc_transactions;
begin
  if not public.ledger_can_act_as(v_user) then
    raise exception 'not authorized for user %', v_user using errcode = '42501';
  end if;

  insert into public.cc_transactions (user_id, date, merchant, description, amount, multiplier, points, event_id, basis, raw_merchant, is_work)
  select v_user, ce.day, coalesce(r.label, ce.merchant, 'Unknown Merchant'), null, ce.amount,
         coalesce(r.multiplier, public.cc_default_multiplier(e.data ->> 'category')), null, ce.event_id, 'assumed', ce.merchant, coalesce(r.is_work, false)
    from public.cc_card_events(v_user) ce
    join public.events e on e.id = ce.event_id
    left join public.cc_merchant_rules r on r.user_id = v_user and r.merchant_key = ce.merchant_key
   where ce.event_id = p_event_id
     and not exists (select 1 from public.cc_transactions x where x.event_id = ce.event_id)
  returning * into v_row;

  if v_row.id is null then
    raise exception 'that event is not an unlinked spend on the points card' using errcode = 'P0002';
  end if;
  return to_jsonb(v_row);
end;
$$;
