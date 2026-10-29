-- Undo only the review's status and inference, and only while its result is current.
-- SECURITY INVOKER: RLS and the explicit owner guard both apply.
begin;
create or replace function public.ledger_restore_review(
  p_event_id uuid, p_expected_updated_at timestamptz, p_status text, p_inference jsonb
)
returns jsonb language plpgsql set search_path = public, pg_temp as $$
declare v_event public.events%rowtype;
begin
  if p_status is null or p_status not in ('inferred', 'needs_review')
     or p_inference is null or jsonb_typeof(p_inference) <> 'object' then
    raise exception 'Invalid review restore values';
  end if;
  select * into v_event from public.events where id = p_event_id for update;
  if not found then raise exception 'Event no longer exists'; end if;
  if not public.ledger_can_act_as(v_event.user_id) then raise exception 'not authorized' using errcode = '42501'; end if;
  if v_event.updated_at is distinct from p_expected_updated_at then
    raise exception 'This event changed after your review. Open it again before making another correction.';
  end if;
  perform set_config('ledger.user_edit', 'on', true);
  update public.events set status = p_status, inference = p_inference where id = p_event_id;
  perform set_config('ledger.user_edit', '', true);
  return public.ledger_get_event(p_event_id);
end;
$$;
revoke all on function public.ledger_restore_review(uuid, timestamptz, text, jsonb) from public, anon;
grant execute on function public.ledger_restore_review(uuid, timestamptz, text, jsonb) to authenticated, service_role;

-- Compare the version the reviewer saw before recording their decision.
create or replace function public.ledger_review_event(
  p_event_id uuid, p_status text, p_expected_updated_at timestamptz
)
returns jsonb language plpgsql set search_path = public, pg_temp as $$
declare v_event public.events%rowtype;
begin
  if p_status is null or p_status not in ('confirmed', 'dismissed') then raise exception 'Invalid review decision'; end if;
  select * into v_event from public.events where id = p_event_id for update;
  if not found then raise exception 'Event no longer exists'; end if;
  if not public.ledger_can_act_as(v_event.user_id) then raise exception 'not authorized' using errcode = '42501'; end if;
  if v_event.updated_at is distinct from p_expected_updated_at then
    raise exception 'This event changed. Open it again before reviewing it.';
  end if;
  if p_status = 'dismissed' then return public.ledger_dismiss_event(p_event_id, 'Dismissed in review'); end if;
  return public.ledger_update_event(p_event_id, jsonb_build_object('status', 'confirmed'));
end;
$$;
revoke all on function public.ledger_review_event(uuid, text, timestamptz) from public, anon;
grant execute on function public.ledger_review_event(uuid, text, timestamptz) to authenticated, service_role;

commit;
