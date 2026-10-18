-- ============================================================
-- Every write lands canonical, and a suspicious amount waits for a person.
--
-- The events table has one door everything walks through: the before-write
-- trigger. Email ingestion, the model, Hermes, the app and hand-written SQL all
-- reach it, so that is where normalisation lives rather than in four callers
-- that would drift. On every insert and update it now:
--
--   1. spells data.currency as ISO 4217 (ledger_normalize_currency, 0019);
--   2. maps the subtype to its canonical value for the type (0020);
--   3. stores a canonical data.category on every money event, derived by
--      ledger_derive_category() — your note's type word, the type/subtype,
--      what the source called it, the merchant, the type's default;
--   4. sends an implausible spend to the review queue (the outlier guard).
--
-- What a source originally said is never lost: the first non-canonical
-- subtype, category and currency are kept in inference.raw, and
-- inference.category_source says where the stored category came from
-- ('user' when you or Hermes set it — then it is never re-derived;
-- 'derived' otherwise, recomputed on every write so a card alert that a
-- receipt later turns into a food order also becomes food in its category).
--
-- The outlier guard. A ₹1,60,000 "subscription" read off a hotel loyalty
-- mailer was a third of a month's spend, and nothing questioned it. Now any
-- event not typed or told by you whose spend is above ₹25,000 (in rupees, via
-- ledger_amount_inr) outside the categories where that is normal (travel,
-- rent, vehicle, insurance, investments, tax, electronics, education), or a
-- subscription above ₹5,000, is set to `needs_review` with
-- inference.review_reason — unless you have already vouched for the same
-- charge (a confirmed event at the same merchant within 15%: one you typed,
-- confirmed in the queue, or confirmed on the Points page). Confirming it
-- (ledger_update_event with status confirmed) records inference.review_cleared,
-- after which it is never flagged again. ledger_auto_confirm() leaves a
-- flagged event alone unless a points row you confirmed describes it.
--
-- ledger_auto_confirm() also learns categories: an event still 'other' takes
-- the most common category of the other events at the same merchant entity
-- (inference.category_hint), which is what turns the 30th card alert at a
-- restaurant into dining once the first 29 were.
--
-- ledger_event_json() gains amount_inr, currency, category, budget_bucket,
-- money_flow and review_reason. Additive; nothing removed or renamed.
--
-- Safe to apply while ingestion runs: function bodies only. The signature of
-- ledger_ingest_event() is untouched.
-- ============================================================

-- Which way money went (0017), now also knowing the canonical transfer
-- subtypes from 0020: bank_transfer (an account-to-account move nobody has
-- placed yet) is neither; salary and interest are arrivals. The old spellings
-- stay listed, so an un-normalised value is never miscounted. JS twin:
-- moneyFlow() in src/ledger/summary.js.
-- No SET clause: a pure expression, so it inlines into the per-row callers.
create or replace function public.ledger_money_flow(p_type text, p_subtype text, p_data jsonb)
returns text
language sql
immutable
as $$
  select case
    when p_type = 'transfer' then case
      when p_subtype in ('self_transfer', 'card_bill_payment', 'bank_transfer',
                         'credit_card_bill_repayment', 'scheduled_bill_payment') then null
      when p_subtype in ('payment', 'insurance_premium')
        then case when p_data ->> 'direction' = 'credit' then 'inflow' else 'spend' end
      when p_data ->> 'direction' = 'credit'
        or p_subtype in ('credit', 'salary', 'refund', 'interest', 'interest_credit', 'dividend', 'cashback', 'reward') then 'inflow'
      else null end
    when p_data ->> 'direction' = 'credit' then 'inflow'
    else 'spend'
  end;
$$;

-- JS twin: reviewReason() in src/ledger/taxonomy.js.
create or replace function public.ledger_review_reason(
  p_source_type text, p_flow text, p_amount_inr numeric, p_category text, p_type text
)
returns text
language sql
immutable
set search_path = public, pg_temp
as $$
  select case
    when (r -> 'trusted_sources') ? coalesce(p_source_type, '') then null
    when p_flow is distinct from 'spend' or p_amount_inr is null then null
    when (p_category = 'subscriptions' or p_type = 'subscription')
         and p_amount_inr > (r ->> 'large_subscription_inr')::numeric then 'large_subscription'
    when p_amount_inr > (r ->> 'large_spend_inr')::numeric
         and not ((r -> 'large_ok_categories') ? coalesce(p_category, '')) then 'large_spend'
  end
  from (select public.ledger_taxonomy() -> 'review' as r) x;
$$;

grant execute on function public.ledger_review_reason(text, text, numeric, text, text) to authenticated, service_role;


create or replace function public.ledger_events_before_write()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_raw        jsonb := coalesce(new.inference -> 'raw', '{}'::jsonb);
  v_inf        jsonb := '{}'::jsonb;
  v_user_edit  boolean := coalesce(current_setting('ledger.user_edit', true), '') = 'on';
  v_user_write boolean;
  v_cur        text;
  v_sub        text;
  v_stated     text;
  v_cat        text;
  v_source     text;
  v_merchant   text;
  v_amount_inr numeric;
  v_reason     text;
begin
  v_user_write := v_user_edit or (tg_op = 'INSERT' and new.source_type in ('manual', 'hermes'));

  -- 1. Currency.
  if new.data ? 'currency' then
    v_cur := public.ledger_normalize_currency(new.data ->> 'currency');
    if v_cur is distinct from new.data ->> 'currency' then
      if not v_raw ? 'currency' then v_raw := v_raw || jsonb_build_object('currency', new.data -> 'currency'); end if;
      new.data := case when v_cur is null then new.data - 'currency'
                       else jsonb_set(new.data, '{currency}', to_jsonb(v_cur)) end;
    end if;
  end if;

  -- 2. Subtype.
  v_sub := public.ledger_canonical_subtype(new.type, new.subtype);
  if v_sub is distinct from new.subtype then
    if not v_raw ? 'subtype' then v_raw := v_raw || jsonb_build_object('subtype', new.subtype); end if;
    new.subtype := v_sub;
  end if;

  -- 3. Category. What did this write state, and who stated it?
  if tg_op = 'INSERT' then
    v_stated := nullif(btrim(new.data ->> 'category'), '');
  elsif (new.data -> 'category') is distinct from (old.data -> 'category') then
    v_stated := nullif(btrim(new.data ->> 'category'), '');
  elsif not (coalesce(old.inference, '{}'::jsonb) ? 'category_source') then
    -- A row from before this migration: its category was a statement.
    v_stated := nullif(btrim(old.data ->> 'category'), '');
    v_user_write := v_user_write or old.source_type in ('manual', 'hermes');
  end if;

  if v_stated is not null and not v_user_write and not v_raw ? 'category' then
    v_raw := v_raw || jsonb_build_object('category', v_stated);
  end if;

  if v_stated is not null and v_user_write then
    v_cat    := coalesce(public.ledger_canonical_category(v_stated), 'other');
    v_source := 'user';
    if v_cat is distinct from v_stated and not v_raw ? 'category' then
      v_raw := v_raw || jsonb_build_object('category', v_stated);
    end if;
  elsif v_stated is null and new.inference ->> 'category_source' = 'user' then
    v_cat    := coalesce(public.ledger_canonical_category(new.data ->> 'category'), 'other');
    v_source := 'user';
  else
    v_merchant := public.ledger_normalize_name(coalesce(new.data ->> 'merchant', new.data ->> 'restaurant', new.data ->> 'provider'));
    v_cat := public.ledger_derive_category(
      new.type, new.subtype, v_raw ->> 'subtype',
      coalesce(v_stated, v_raw ->> 'category', new.inference ->> 'category_hint'),
      new.description, v_merchant, new.data ? 'amount');
    v_source := 'derived';
  end if;

  if v_cat is not null then
    new.data := jsonb_set(new.data, '{category}', to_jsonb(v_cat));
    v_inf := v_inf || jsonb_build_object('category_source', v_source);
  elsif new.data ? 'category' then
    -- Not a money event, but a source named a category anyway: keep it, canonical.
    new.data := jsonb_set(new.data, '{category}',
                          to_jsonb(coalesce(public.ledger_canonical_category(new.data ->> 'category'), 'other')));
  end if;

  if v_raw <> '{}'::jsonb then v_inf := v_inf || jsonb_build_object('raw', v_raw); end if;
  new.inference := coalesce(new.inference, '{}'::jsonb) || v_inf;

  -- 4. The outlier guard.
  if v_user_edit and new.status = 'confirmed' and new.inference ? 'review_reason'
     and not new.inference ? 'review_cleared' then
    new.inference := new.inference || jsonb_build_object(
      'review_cleared', new.inference ->> 'review_reason', 'review_cleared_at', now());
  elsif v_user_write and new.inference ->> 'review_reason' in ('large_spend', 'large_subscription') then
    -- A person corrected the event (a card bill refiled as a transfer, a
    -- category fixed). If it is no longer an outlier, the flag goes and the
    -- status is what its confidence earns.
    if public.ledger_review_reason(new.source_type, public.ledger_money_flow(new.type, new.subtype, new.data),
         public.ledger_amount_inr(new.data, new.occurred_at), new.data ->> 'category', new.type) is null then
      new.inference := new.inference - 'review_reason';
      if new.status = 'needs_review' then new.status := public.ledger_status_for(new.user_id, new.confidence); end if;
    end if;
  elsif not v_user_write
     and new.status not in ('dismissed', 'scheduled')
     and new.source_type not in ('manual', 'hermes')
     and not new.inference ? 'review_cleared' then
    v_amount_inr := public.ledger_amount_inr(new.data, new.occurred_at);
    v_reason := public.ledger_review_reason(new.source_type, public.ledger_money_flow(new.type, new.subtype, new.data),
                                            v_amount_inr, new.data ->> 'category', new.type);
    if v_reason is not null then
      v_merchant := coalesce(v_merchant, public.ledger_normalize_name(
                      coalesce(new.data ->> 'merchant', new.data ->> 'restaurant', new.data ->> 'provider')));
      -- Vouched for already: a points row you confirmed for this very charge, or
      -- the same charge at the same merchant that you have confirmed before.
      if exists (select 1 from public.cc_transactions c
                  where c.event_id = new.id and c.basis in ('manual', 'confirmed'))
         or (v_merchant is not null and exists (
              select 1 from public.events p
               where p.user_id = new.user_id and p.id <> new.id and p.status = 'confirmed'
                 and public.ledger_normalize_name(coalesce(p.data ->> 'merchant', p.data ->> 'restaurant', p.data ->> 'provider')) = v_merchant
                 and abs(coalesce(public.ledger_amount_inr(p.data, p.occurred_at), 0) - v_amount_inr) <= 0.15 * v_amount_inr
                 and (p.source_type in ('manual', 'hermes') or p.inference ? 'review_cleared'
                      or exists (select 1 from public.cc_transactions c
                                  where c.event_id = p.id and c.basis in ('manual', 'confirmed'))))) then
        v_reason := null;
      end if;
    end if;

    if v_reason is not null then
      new.status := 'needs_review';
      new.inference := new.inference || jsonb_build_object('review_reason', v_reason)
                       || case when new.inference ? 'review_flagged_at' then '{}'::jsonb
                               else jsonb_build_object('review_flagged_at', now()) end;
    elsif new.inference ? 'review_reason' then
      -- Corrected out of outlier range (amount, type or category fixed): the flag goes,
      -- the event keeps whatever status the write gave it.
      new.inference := new.inference - 'review_reason';
      if new.status = 'needs_review' and tg_op = 'UPDATE' and old.status = 'needs_review' then
        new.status := public.ledger_status_for(new.user_id, new.confidence);
      end if;
    end if;
  end if;

  -- What the original function did, unchanged.
  new.search_tsv :=
    setweight(to_tsvector('simple', coalesce(new.title, '')), 'A') ||
    setweight(to_tsvector('simple', coalesce(new.description, '')), 'B') ||
    setweight(to_tsvector('simple', public.ledger_jsonb_text(new.data)), 'C') ||
    setweight(to_tsvector('simple', coalesce(new.type, '') || ' ' || coalesce(new.subtype, '')), 'D');

  if not exists (select 1 from public.ledger_event_types where type = new.type) then
    insert into public.ledger_event_types (type, label, icon, is_builtin)
    values (new.type, initcap(replace(new.type, '_', ' ')), 'fa-circle-dot', false)
    on conflict (type) do nothing;
  end if;

  new.updated_at := now();
  return new;
end;
$$;


-- A correction from a person. The flag tells the trigger that this write is
-- yours: a category you set is kept, and a confirmation clears the review.
create or replace function public.ledger_update_event(p_event_id uuid, p_changes jsonb, p_replace_data boolean default false)
returns jsonb
language plpgsql
set search_path = public, pg_temp
as $$
declare
  v_event public.events%rowtype;
begin
  select * into v_event from public.events where id = p_event_id;
  if not found then raise exception 'event % not found', p_event_id using errcode = 'P0002'; end if;
  if not public.ledger_can_act_as(v_event.user_id) then
    raise exception 'not authorized' using errcode = '42501';
  end if;

  perform set_config('ledger.user_edit', 'on', true);

  update public.events e set
    occurred_at     = coalesce(nullif(p_changes ->> 'occurred_at', '')::timestamptz, e.occurred_at),
    occurred_at_end = case when p_changes ? 'occurred_at_end'
                           then nullif(p_changes ->> 'occurred_at_end', '')::timestamptz
                           else e.occurred_at_end end,
    type            = coalesce(nullif(p_changes ->> 'type', ''), e.type),
    subtype         = case when p_changes ? 'subtype' then nullif(p_changes ->> 'subtype', '') else e.subtype end,
    title           = coalesce(left(nullif(p_changes ->> 'title', ''), 300), e.title),
    description     = case when p_changes ? 'description' then nullif(p_changes ->> 'description', '') else e.description end,
    data            = case when p_changes ? 'data'
                           then case when p_replace_data then p_changes -> 'data' else e.data || (p_changes -> 'data') end
                           else e.data end,
    inference       = case when p_changes ? 'inference' then e.inference || (p_changes -> 'inference') else e.inference end,
    status          = coalesce(nullif(p_changes ->> 'status', ''), e.status),
    confidence      = case when p_changes ? 'confidence' then public.ledger_num(p_changes, 'confidence') else e.confidence end
  where e.id = p_event_id;

  perform set_config('ledger.user_edit', '', true);

  return public.ledger_get_event(p_event_id);
end;
$$;


-- An event still 'other' borrows the category its merchant's other events
-- agree on. Returns how many it changed.
create or replace function public.ledger_learn_categories(p_user_id uuid default null)
returns integer
language plpgsql
set search_path = public, pg_temp
as $$
declare
  v_user uuid := coalesce(p_user_id, auth.uid());
  v_n    integer;
begin
  if not public.ledger_can_act_as(v_user) then
    raise exception 'not authorized for user %', v_user using errcode = '42501';
  end if;

  with todo as (
    select e.id, ee.entity_id
      from public.events e
      join public.event_entities ee on ee.event_id = e.id and ee.relationship <> 'issuer'
      join public.entities en on en.id = ee.entity_id and en.type in ('merchant', 'restaurant', 'company')
     where e.user_id = v_user and e.status <> 'dismissed'
       and e.data ->> 'category' = 'other'
       and coalesce(e.inference ->> 'category_source', 'derived') = 'derived'
  ), votes as (
    select t.id, t.entity_id, o.data ->> 'category' as category, count(*) as n, max(o.occurred_at) as latest
      from todo t
      join public.event_entities oe on oe.entity_id = t.entity_id and oe.event_id <> t.id
      join public.events o on o.id = oe.event_id and o.status <> 'dismissed'
     where o.data ->> 'category' not in ('other', 'income', 'transfer')
     group by 1, 2, 3
  ), best as (
    select distinct on (id) id, entity_id, category from votes order by id, n desc, latest desc
  )
  update public.events e
     set inference = e.inference || jsonb_build_object('category_hint', b.category, 'category_hint_from', b.entity_id)
    from best b
   where e.id = b.id and e.inference ->> 'category_hint' is distinct from b.category;

  get diagnostics v_n = row_count;
  return v_n;
end;
$$;

grant execute on function public.ledger_learn_categories(uuid) to authenticated, service_role;


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


-- One event as JSON. New: amount_inr (the one conversion, 0019), currency,
-- category and its budget bucket, money_flow, review_reason.
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
