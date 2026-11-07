-- ============================================================
-- The review queue stops collecting what nobody will review
--
-- Whatever the model reads is capped below the confirmed threshold, so with one
-- source it stayed `inferred` for good: 38 rows going back to September 2025,
-- mostly flights and reservations long past. Burying the few amounts that need a
-- decision. Inferred rows now confirm after 30 days. Flagged rows still wait.
--
-- Replaces: ledger_auto_confirm (0021).
-- ============================================================

create or replace function public.ledger_auto_confirm(p_user_id uuid default null)
returns jsonb
language plpgsql
set search_path = public, pg_temp
as $$
declare
  v_user    uuid := coalesce(p_user_id, auth.uid());
  r         record;
  v_counts  jsonb := '{}'::jsonb;
  v_learned integer;
begin
  if not public.ledger_can_act_as(v_user) then
    raise exception 'not authorized for user %', v_user using errcode = '42501';
  end if;

  for r in
    select e.id, e.status, e.inference ? 'review_reason' as flagged,
           case
             when exists (select 1 from public.cc_transactions c
                           where c.event_id = e.id and c.basis in ('manual', 'confirmed'))
               then 'corroborated_by_user'
             -- A flagged amount is waiting for a person; only a person vouches for it.
             when e.inference ? 'review_reason' then null
             when (select count(*) from public.event_sources s where s.event_id = e.id) >= 2
               then 'corroborated_by_sources'
             when exists (select 1 from public.event_sources s where s.event_id = e.id)
              and not exists (select 1 from public.event_sources s
                               where s.event_id = e.id and coalesce(s.extracted_by, '') not like 'rules:%')
               then 'read_by_rule'
             -- A month on, nobody is going to check it: only flagged amounts still wait.
             when e.status = 'inferred' and e.occurred_at < now() - interval '30 days'
               then 'aged'
           end as reason
      from public.events e
     where e.user_id = v_user
       and (e.status = 'inferred' or (e.status = 'needs_review' and e.inference ? 'review_reason'))
  loop
    continue when r.reason is null;
    continue when r.status = 'needs_review' and r.reason <> 'corroborated_by_user';
    update public.events
       set status = 'confirmed',
           inference = case when r.flagged
                            then inference || jsonb_build_object('review_cleared', inference ->> 'review_reason',
                                                                 'review_cleared_at', now(), 'review_cleared_by', r.reason)
                            else inference end
     where id = r.id;
    perform public.ledger_log(v_user, 'event_auto_confirmed', 'events', r.id,
      jsonb_build_object('status', r.status), jsonb_build_object('status', 'confirmed', 'reason', r.reason));
    v_counts := v_counts || jsonb_build_object(r.reason, coalesce((v_counts ->> r.reason)::int, 0) + 1);
  end loop;

  v_learned := public.ledger_learn_categories(v_user);

  return jsonb_build_object(
    'confirmed', v_counts,
    'categories_learned', v_learned,
    'still_in_queue', (select count(*) from public.events e where e.user_id = v_user and e.status in ('inferred', 'needs_review')));
end;
$$;
