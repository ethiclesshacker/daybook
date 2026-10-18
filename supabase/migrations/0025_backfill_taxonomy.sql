-- ============================================================
-- Bring the rows already in the ledger up to 0019–0022.
--
-- New writes have been canonical since 0021. This rewrites what was there:
--
--   1. Entities. Re-key every entity with the new ledger_normalize_name()
--      ("kapoor s cafe" → "kapoors cafe"), and merge each business that was
--      stored under several entity types or spellings into one — the one with
--      the most events (ties: restaurant, company, merchant; then oldest).
--      Merged entities are kept, marked `merged_into` (0020). A merged row that
--      would block its target's new key is given a suffixed key; its old key
--      lives on as an alias of the target.
--   2. food_items and cc_merchant_rules keys follow the new normalisation
--      where that does not collide with an existing row (a collision is left
--      for food_merge_items / a person, and reported by the NOTICE).
--   3. Events. Every row is touched once, month by month, so the before-write
--      trigger (0021) canonicalises currency, subtype and category, keeps the
--      originals in inference.raw, and applies the outlier guard. Rows are
--      locked one month at a time, so ingestion running alongside waits
--      milliseconds, not the whole backfill.
--   4. ledger_learn_categories() fills what is still 'other' from the
--      merchant's other events.
--
-- Idempotent: re-running it changes nothing that is already canonical.
-- Specific corrections to individual events (a mis-read amount, a card bill
-- filed as a purchase) are data, not schema, and are not in this repository.
-- ============================================================

-- 1. Entities -------------------------------------------------------------
do $$
declare
  g        record;
  d        record;
  v_target uuid;
  v_key    text;
  n_merged int := 0;
  n_rekeyed int := 0;
begin
  -- 1a. Merge duplicates within the merchant family, grouped by the new key.
  for g in
    select user_id, public.ledger_normalize_name(normalized_name) as k
      from public.entities
     where type in ('merchant', 'restaurant', 'company') and not (metadata ? 'merged_into')
     group by 1, 2
    having count(*) > 1
  loop
    select en.id into v_target
      from public.entities en
     where en.user_id = g.user_id and en.type in ('merchant', 'restaurant', 'company')
       and not (en.metadata ? 'merged_into') and public.ledger_normalize_name(en.normalized_name) = g.k
     order by (select count(*) from public.event_entities ee where ee.entity_id = en.id) desc,
              array_position(array['restaurant', 'company', 'merchant'], en.type), en.created_at
     limit 1;

    for d in
      select en.id from public.entities en
       where en.user_id = g.user_id and en.type in ('merchant', 'restaurant', 'company')
         and not (en.metadata ? 'merged_into') and public.ledger_normalize_name(en.normalized_name) = g.k
         and en.id <> v_target
    loop
      perform public.ledger_merge_entities(v_target, d.id);
      n_merged := n_merged + 1;
    end loop;
  end loop;

  -- 1b. Re-key what is left.
  for d in
    select en.id, en.user_id, en.type, en.normalized_name, public.ledger_normalize_name(en.normalized_name) as k
      from public.entities en
     where not (en.metadata ? 'merged_into')
       and public.ledger_normalize_name(en.normalized_name) is distinct from en.normalized_name
       and public.ledger_normalize_name(en.normalized_name) is not null
  loop
    -- A merged row sitting on the key steps aside.
    update public.entities m
       set normalized_name = left(d.k, 180) || ' merged ' || left(m.id::text, 8)
     where m.user_id = d.user_id and m.type = d.type and m.normalized_name = d.k and m.metadata ? 'merged_into';

    if exists (select 1 from public.entities x where x.user_id = d.user_id and x.type = d.type and x.normalized_name = d.k) then
      raise notice 'entity % (%): key % already taken by a live entity of the same type; left as is', d.id, d.normalized_name, d.k;
      continue;
    end if;

    update public.entities e
       set normalized_name = d.k,
           metadata = e.metadata || jsonb_build_object('aliases', (
             select coalesce(jsonb_agg(distinct a), '[]'::jsonb)
               from (select jsonb_array_elements_text(coalesce(e.metadata -> 'aliases', '[]'::jsonb)) a
                     union select d.normalized_name) s
              where a is not null and a <> d.k))
     where e.id = d.id;
    n_rekeyed := n_rekeyed + 1;
  end loop;

  raise notice 'entities: % merged, % re-keyed', n_merged, n_rekeyed;
end $$;

-- 2. Dish and card-rule keys ----------------------------------------------
do $$
declare
  r record;
  n int := 0;
begin
  for r in
    select f.id, f.user_id, f.normalized_name, public.ledger_normalize_name(f.display_name) as k
      from public.food_items f
     where public.ledger_normalize_name(f.display_name) is distinct from f.normalized_name
       and public.ledger_normalize_name(f.display_name) is not null
       -- Only rows whose old key was the old normalisation of their name.
       and replace(f.normalized_name, ' ', '') = replace(public.ledger_normalize_name(f.display_name), ' ', '')
  loop
    if exists (select 1 from public.food_items x where x.user_id = r.user_id and x.normalized_name = r.k) then
      raise notice 'food_items %: % collides with an existing %; merge with food_merge_items', r.id, r.normalized_name, r.k;
      continue;
    end if;
    update public.food_items set normalized_name = r.k where id = r.id;
    n := n + 1;
  end loop;
  raise notice 'food_items re-keyed: %', n;

  update public.cc_merchant_rules m
     set merchant_key = public.ledger_normalize_name(m.ledger_merchant)
   where public.ledger_normalize_name(m.ledger_merchant) is distinct from m.merchant_key
     and m.ledger_merchant is not null
     and not exists (select 1 from public.cc_merchant_rules x
                      where x.user_id = m.user_id and x.merchant_key = public.ledger_normalize_name(m.ledger_merchant));
end $$;

-- 3. Events, a month at a time --------------------------------------------
do $$
declare
  m date;
  n int;
  total int := 0;
begin
  for m in
    select distinct date_trunc('month', occurred_at)::date from public.events order by 1
  loop
    update public.events set title = title
     where occurred_at >= m and occurred_at < (m + interval '1 month')
       and (not (inference ? 'category_source') and data ? 'amount'
            or not (inference ? 'category_source') and type in ('purchase', 'food', 'travel', 'subscription', 'entertainment', 'health', 'gift', 'transfer')
            or subtype is distinct from public.ledger_canonical_subtype(type, subtype)
            or (data ? 'currency' and data ->> 'currency' is distinct from public.ledger_normalize_currency(data ->> 'currency'))
            or (data ? 'category' and not (public.ledger_taxonomy() -> 'categories' ? (data ->> 'category'))));
    get diagnostics n = row_count;
    total := total + n;
  end loop;
  raise notice 'events canonicalised: %', total;
end $$;

-- 4. Categories from the merchant's other events --------------------------
do $$
declare
  u uuid;
begin
  for u in select distinct user_id from public.events loop
    raise notice 'categories learned for %: %', u, public.ledger_learn_categories(u);
  end loop;
end $$;

-- 5. Grants for the functions 0019–0022 added. Created before 0024's default
--    privileges took effect, they inherited PUBLIC EXECUTE; anon gets nothing
--    (as 0024 decided for everything else), the app and the jobs keep theirs.
do $$
declare
  f regprocedure;
begin
  for f in
    select p.oid::regprocedure
      from pg_proc p join pg_namespace n on n.oid = p.pronamespace
     where n.nspname = 'public'
       and p.proname in ('ledger_normalize_currency', 'ledger_is_cash_currency', 'ledger_amount_inr', 'ledger_taxonomy',
                         'ledger_slug', 'ledger_canonical_category', 'ledger_canonical_subtype', 'ledger_merchant_category',
                         'ledger_note_category', 'ledger_spend_only', 'ledger_derive_category', 'ledger_budget_bucket',
                         'ledger_entity_family', 'ledger_review_reason', 'ledger_learn_categories')
  loop
    execute format('revoke execute on function %s from public, anon', f);
    execute format('grant execute on function %s to authenticated, service_role', f);
  end loop;
end $$;
