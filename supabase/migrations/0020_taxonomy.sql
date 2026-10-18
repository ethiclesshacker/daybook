-- ============================================================
-- One taxonomy, shared by JS and SQL; one merchant per merchant.
--
-- An audit on 2026-10-18 found the money half of the ledger described in
-- several dialects at once:
--   * 89% of purchases had no data.category, so ledger_spend_category()
--     guessed at read time, and its last resort was the event's type — which
--     is how the dashboard came to show "Shopping" and "Purchase" side by side.
--   * ~85 type/subtype pairs, most coined by the model: card_transaction,
--     card_purchase, online_card_purchase, card_payment, credit_card, payment…
--     for the one thing "a card was charged".
--   * Categories in every spelling: food / meal / food_delivery / dining,
--     "software subscription" vs "subscription" vs "utilities", and
--     "purchase" used as a category.
--   * 14 merchants stored twice under different entity types (Domino's as a
--     merchant and as a restaurant, Jio as a company and as a merchant…), and
--     "Kapoor's Cafe" / "KAPOOR S CAFE" / "Kapoors Cafe" as three names.
--
-- This migration adds the vocabulary and the functions; 0021 makes every
-- write use them and 0025 rewrites the rows already there.
--
--   public.ledger_taxonomy()           the JSON in src/ledger/taxonomy.js (TAXONOMY),
--                                      verbatim. test/taxonomy.test.js fails if they differ.
--   public.ledger_canonical_subtype()  canonicalSubtype()
--   public.ledger_canonical_category() canonicalCategory()
--   public.ledger_derive_category()    deriveCategory()
--   public.ledger_budget_bucket()      budgetBucket()
--   public.ledger_normalize_name()     normalizeName() — now drops apostrophes and
--                                      re-joins a lone "s", so the three Kapoor's agree.
--   public.ledger_resolve_entity()     resolves within the merchant family
--                                      (merchant, restaurant, company), so a card
--                                      alert and a receipt meet at one entity,
--                                      and follows `merged_into`.
--   public.ledger_merge_entities()     no longer deletes the absorbed entity: it
--                                      is marked `merged_into` and kept, its name
--                                      becomes an alias of the target. Merchants
--                                      may now merge across the family's types.
--
-- Change the taxonomy in taxonomy.js, then paste JSON.stringify(TAXONOMY)
-- between the taxonomy dollar-quote markers below (node -e "import('./src/ledger/taxonomy.js')
-- .then(t => console.log(JSON.stringify(t.TAXONOMY)))") and re-apply.
--
-- Safe to apply while ingestion runs: function bodies only, no table rewrite.
-- ============================================================

-- No SET clause (it references nothing), so it inlines: callers get the
-- constant folded into their plan instead of a function call per row.
create or replace function public.ledger_taxonomy()
returns jsonb
language sql
immutable
as $fn$
  select $taxonomy${"version":1,"subtypes":{"purchase":["card_transaction","upi_payment","payment","order","bill","gift_card"],"food":["food_delivery","restaurant","meal","groceries","card_transaction","upi_payment"],"travel":["flight","train","bus","cab","hotel","trip","toll","insurance"],"subscription":["renewal","bill","invoice","signup","trial","cancellation"],"transfer":["self_transfer","card_bill_payment","bank_transfer","payment","insurance_premium","credit","salary","refund","interest","dividend","cashback","reward"],"entertainment":["movie","event","concert","streaming","game","book"],"delivery":["package","order_shipped","order_delivered"],"health":["measurement","workout","sleep","symptom","medication","appointment","lab_test","insurance"],"activity":["workout","errand","visit"],"appointment":["medical","personal","service","restaurant_reservation"],"meeting":["calendar_event","call","one_on_one","interview"],"work":["meeting","school_visit","visit","project_activity","work_email","work_task","deadline"],"communication":["email","message","call"],"note":["observation","idea","reminder"],"milestone":["personal","work","financial"],"location":["visit","checkin"],"gift":["received","given"],"other":["insurance","reward"]},"subtype_aliases":{"purchase":{"card_payment":"card_transaction","card_purchase":"card_transaction","online_card_purchase":"card_transaction","credit_card":"card_transaction","debit_card":"card_transaction","pos":"card_transaction","upi":"upi_payment","wallet_payment":"upi_payment","amazon_order":"order","online_order":"order","online_purchase":"order","restaurant_payment":"payment","grocery_purchase":"order","groceries":"order","clothing":"order","electronics":"order","gift":"order","subscription_payment":"payment","fuel":"payment","pharmacy":"order","retail":"payment","observation":"payment","insurance_premium":"bill","bill_payment":"bill","invoice":"bill","gift_voucher":"gift_card","voucher":"gift_card"},"food":{"restaurant_payment":"restaurant","restaurant_bill":"restaurant","dine_in":"restaurant","dineout":"restaurant","grocery_purchase":"groceries","grocery":"groceries","delivery":"food_delivery","snack":"meal","beverage":"meal","card_payment":"card_transaction","card_purchase":"card_transaction"},"travel":{"flight_booking":"flight","flight_departure":"flight","flight_ticket":"flight","train_ticket_booking":"train","train_ticket":"train","bus_ticket":"bus","ride":"cab","taxi":"cab","hotel_booking":"hotel","location":"trip","travel_insurance":"insurance"},"subscription":{"bill_payment":"bill","card_purchase":"renewal","card_payment":"renewal","online_card_purchase":"renewal","payment":"renewal","insurance":"renewal","membership":"renewal"},"transfer":{"credit_card_bill_repayment":"card_bill_payment","scheduled_bill_payment":"card_bill_payment","card_payment":"card_bill_payment","credit_card_payment":"card_bill_payment","card_repayment":"card_bill_payment","interest_credit":"interest","bank_interest":"interest","loyalty_reward":"reward","rewards":"reward","neft":"bank_transfer","imps":"bank_transfer"},"entertainment":{"cinema_booking":"movie","movie_ticket":"movie"},"delivery":{"package_delivery":"package","shipped":"order_shipped","delivered":"order_delivered"},"health":{"lab_test_booking_request":"lab_test","travel_insurance":"insurance","activity":"workout"},"activity":{"attempted_workout":"workout"},"note":{"health_metric":"observation"},"gift":{"food_delivery":"received"},"other":{"insurance_issuance":"insurance","loyalty_reward":"reward"}},"buckets":["investments","rent","food","fuel","sinking","lifestyle"],"categories":{"dining":"food","food_delivery":"food","groceries":"food","rent":"rent","fuel":"fuel","investments":"investments","travel":"sinking","insurance":"sinking","vehicle":"sinking","medical":"sinking","gifts":"sinking","tax":"sinking","fees":"sinking","shopping":"lifestyle","clothing":"lifestyle","electronics":"lifestyle","entertainment":"lifestyle","subscriptions":"lifestyle","utilities":"lifestyle","transport":"lifestyle","personal_care":"lifestyle","education":"lifestyle","home":"lifestyle","work":null,"stored_value":null,"other":null,"income":null,"transfer":null},"category_synonyms":{"restaurant":"dining","restaurants":"dining","cafe":"dining","coffee":"dining","food":"dining","meal":"dining","beverages":"dining","beverage":"dining","eating_out":"dining","food_and_dining":"dining","dine_in":"dining","dineout":"dining","snacks":"dining","canteen":"dining","delivery":"food_delivery","food_order":"food_delivery","grocery":"groceries","supermarket":"groceries","quick_commerce":"groceries","housing":"rent","house_rent":"rent","petrol":"fuel","diesel":"fuel","gas_station":"fuel","investment":"investments","sip":"investments","mutual_fund":"investments","stocks":"investments","air_travel":"travel","train_travel":"travel","flight":"travel","flights":"travel","hotel":"travel","hotels":"travel","lodging":"travel","trip":"travel","bus":"travel","train":"travel","souvenir":"travel","cargo":"travel","lounge":"travel","travel_booking":"travel","cab":"transport","taxi":"transport","ride":"transport","rides":"transport","metro":"transport","auto":"transport","travel_insurance":"insurance","health_insurance":"insurance","life_insurance":"insurance","insurance_premium":"insurance","car":"vehicle","bike":"vehicle","parking":"vehicle","toll":"vehicle","vehicle_service":"vehicle","car_service":"vehicle","health":"medical","healthcare":"medical","pharmacy":"medical","medicine":"medical","medicines":"medical","doctor":"medical","diagnostic_test":"medical","health_screening":"medical","health_checkup":"medical","lab_test":"medical","hospital":"medical","gift":"gifts","donation":"gifts","donations":"gifts","charity":"gifts","taxes":"tax","income_tax":"tax","gst":"tax","fee":"fees","charges":"fees","bank_charges":"fees","banking":"fees","late_fee":"fees","convenience_fee":"fees","purchase":"shopping","online_purchase":"shopping","retail":"shopping","journal":"shopping","book":"shopping","books":"shopping","stationery":"shopping","jewellery":"shopping","jewelry":"shopping","general":"shopping","fashion":"clothing","apparel":"clothing","clothes":"clothing","footwear":"clothing","shoes":"clothing","gadgets":"electronics","technology_hardware":"electronics","movie":"entertainment","movies":"entertainment","cinema":"entertainment","event":"entertainment","events":"entertainment","concert":"entertainment","ticket":"entertainment","tickets":"entertainment","games":"entertainment","gaming":"entertainment","subscription":"subscriptions","software":"subscriptions","software_subscription":"subscriptions","saas":"subscriptions","membership":"subscriptions","streaming":"subscriptions","technology":"subscriptions","cloud":"subscriptions","utility":"utilities","telecom":"utilities","mobile":"utilities","phone":"utilities","internet":"utilities","broadband":"utilities","electricity":"utilities","recharge":"utilities","bills":"utilities","laundry":"personal_care","salon":"personal_care","grooming":"personal_care","beauty":"personal_care","course":"education","courses":"education","tuition":"education","household":"home","furniture":"home","home_improvement":"home","hardware":"home","reimbursable":"work","office":"work","wallet":"stored_value","wallet_topup":"stored_value","top_up":"stored_value","topup":"stored_value","voucher":"stored_value","vouchers":"stored_value","gift_card":"stored_value","gift_voucher":"stored_value","misc":"other","miscellaneous":"other","uncategorised":"other","uncategorized":"other","unknown":"other","cashback":"income","dividend":"income","interest":"income","bank_interest":"income","salary":"income","rewards":"income","reward":"income","loyalty_reward":"income","refund":"income","investment_income":"income","bill_payment":"transfer","self_transfer":"transfer","card_bill":"transfer"},"note_categories":{"food":"dining","lunch":"dining","dinner":"dining","breakfast":"dining","snacks":"dining","coffee":"dining","groceries":"groceries","grocery":"groceries","rent":"rent","fuel":"fuel","petrol":"fuel","investment":"investments","sip":"investments","flight":"travel","hotel":"travel","bus":"travel","train":"travel","souvenir":"travel","cargo":"travel","trip":"travel","travel":"travel","cab":"transport","auto":"transport","metro":"transport","insurance":"insurance","parking":"vehicle","vehicle":"vehicle","toll":"vehicle","health":"medical","medicine":"medical","doctor":"medical","gift":"gifts","donation":"gifts","tax":"tax","fee":"fees","fees":"fees","shopping":"shopping","purchase":"shopping","book":"shopping","clothes":"clothing","clothing":"clothing","electronics":"electronics","movie":"entertainment","event":"entertainment","ticket":"entertainment","subscription":"subscriptions","telecom":"utilities","utilities":"utilities","electricity":"utilities","laundry":"personal_care","salon":"personal_care","haircut":"personal_care","course":"education","home":"home","work":"work","voucher":"stored_value","topup":"stored_value","wallet":"stored_value"},"subtype_categories":{"food/food_delivery":"food_delivery","food/groceries":"groceries","food/restaurant":"dining","food/meal":"dining","travel/cab":"transport","travel/insurance":"insurance","travel/toll":"vehicle","travel/*":"travel","entertainment/streaming":"subscriptions","entertainment/book":"shopping","entertainment/*":"entertainment","subscription/bill":"utilities","health/insurance":"insurance","health/*":"medical","appointment/medical":"medical","appointment/personal":"personal_care","appointment/restaurant_reservation":"dining","gift/*":"gifts","other/insurance":"insurance","other/reward":"income","purchase/gift_card":"stored_value","transfer/self_transfer":"transfer","transfer/card_bill_payment":"transfer","transfer/bank_transfer":"transfer","transfer/insurance_premium":"insurance","transfer/credit":"income","transfer/salary":"income","transfer/interest":"income","transfer/dividend":"income","transfer/cashback":"income","transfer/reward":"income"},"type_categories":{"purchase":"other","food":"dining","travel":"travel","subscription":"subscriptions","entertainment":"entertainment","health":"medical","gift":"gifts","transfer":"transfer"},"merchant_categories":[["amazon pay","stored_value"],["amazonpay","stored_value"],["amazonpayindiaprivatet","stored_value"],["magicpin","stored_value"],["samast","stored_value"],["onpoint","stored_value"],["gyftr","stored_value"],["anthropic","subscriptions"],["claude","subscriptions"],["openai","subscriptions"],["cursor","subscriptions"],["netflix","subscriptions"],["spotify","subscriptions"],["spotifyindia","subscriptions"],["appleservices","subscriptions"],["apple","subscriptions"],["google","subscriptions"],["microsoft","subscriptions"],["narakeet","subscriptions"],["narakeet com","subscriptions"],["hostinger","subscriptions"],["timesprime","subscriptions"],["airalo","utilities"],["jio","utilities"],["myjio","utilities"],["rjil","utilities"],["airtel","utilities"],["bbps","utilities"],["billpay","utilities"],["bescom","utilities"],["act fibernet","utilities"],["swiggy","food_delivery"],["instamart","groceries"],["bundl","food_delivery"],["zomato","food_delivery"],["eternal","food_delivery"],["ownly","food_delivery"],["ctrlx","food_delivery"],["dominos","food_delivery"],["jubilant foodworks","food_delivery"],["jubilantfoodworksltd","food_delivery"],["mcdelivery","food_delivery"],["blinkit","groceries"],["zepto","groceries"],["zeptonow","groceries"],["bigbasket","groceries"],["avenue supermarts","groceries"],["dmart","groceries"],["max hypermarket","groceries"],["smart bazaar","groceries"],["reliance smart","groceries"],["reliance retail","groceries"],["topmarthypermarket","groceries"],["lulu","groceries"],["district dining","dining"],["eazydiner","dining"],["smartworks","dining"],["starbucks","dining"],["third wave","dining"],["blue tokai","dining"],["chai point","dining"],["tim hortons","dining"],["mcdonalds","dining"],["mc donalds","dining"],["restaurant brands","dining"],["devyani","dining"],["tgif opulence","dining"],["haldiram","dining"],["oam industries","dining"],["vendingsoftware","dining"],["district","entertainment"],["orbgen","entertainment"],["bookmyshow","entertainment"],["bookmyshow com","entertainment"],["pvr","entertainment"],["inox","entertainment"],["cinepolis","entertainment"],["cinepolisindia","entertainment"],["uber","transport"],["uberindiasystepvtltd","transport"],["uberindiasystemspri","transport"],["ola","transport"],["rapido","transport"],["namma yatri","transport"],["bmtc","transport"],["makemytrip","travel"],["make my trip","travel"],["makemytripindiapvt","travel"],["makemytripindiapvtl","travel"],["makemytripindiapvtlt","travel"],["mmt","travel"],["goibibo","travel"],["ibibo","travel"],["yatra","travel"],["cleartrip","travel"],["easy trip planners","travel"],["easemytrip","travel"],["ixigo","travel"],["hsbcin twp","travel"],["hoppr","travel"],["irctc","travel"],["indian railways","travel"],["indigo","travel"],["air","travel"],["airindia","travel"],["akasa","travel"],["vistara","travel"],["abhibus","travel"],["intrcity","travel"],["redbus","travel"],["airbnb","travel"],["oyo","travel"],["booking com","travel"],["lounge","travel"],["loungeone","travel"],["loungeoneai","travel"],["travelclublounge","travel"],["kolkatalounge","travel"],["delhidomesticlounge","travel"],["bangaloreairportdome","travel"],["varun hospitality","travel"],["hdfc life","insurance"],["hdfclifeinsurancecompanylimited","insurance"],["niva bupa","insurance"],["nivabupahealthinsurancecompanylimited","insurance"],["acko","insurance"],["policybazaar","insurance"],["ramji motor","vehicle"],["vfm motors","vehicle"],["honda","vehicle"],["parkwiz","vehicle"],["propbuild","vehicle"],["fastag","vehicle"],["iocl","fuel"],["indian oil","fuel"],["bpcl","fuel"],["hpcl","fuel"],["shell","fuel"],["petropark","fuel"],["seagullpetropark","fuel"],["petrol","fuel"],["fuel","fuel"],["tata 1mg","medical"],["1mg","medical"],["apollo","medical"],["pharmeasy","medical"],["hospital","medical"],["frank ross","medical"],["netmeds","medical"],["eportal incometax","tax"],["incometax","tax"],["itr","tax"],["flipkart","shopping"],["flipkartinternetpvtl","shopping"],["amazon","shopping"],["caratlane","shopping"],["mr diy","shopping"],["daiso","shopping"],["miniso","shopping"],["ventota","shopping"],["printo","shopping"],["sapna","shopping"],["crossword","shopping"],["atta galatta","shopping"],["firkiwholesale","shopping"],["loyal world market","shopping"],["fujifilm","shopping"],["rajkarinc","shopping"],["portronics","electronics"],["lenovo","electronics"],["croma","electronics"],["reliance digital","electronics"],["myntra","clothing"],["ajio","clothing"],["westside","clothing"],["westsideonline","clothing"],["vedant fashions","clothing"],["manyavar","clothing"],["shoppers stop","clothing"],["pantaloons","clothing"],["aditya birla fashion","clothing"],["life style","clothing"],["max fashion","clothing"],["jockey","clothing"],["the souled store","clothing"],["campus shoes","clothing"],["neeman","clothing"],["neemans","clothing"],["moxie","personal_care"],["metro wash","personal_care"],["the metro wash","personal_care"],["iitm","education"],["indian institute of te","education"],["coursera","education"],["udemy","education"],["lively legacy","rent"],["nobroker","rent"],["groww","investments"],["zerodha","investments"],["hdfc securities","investments"],["hdfcsecurities","investments"],["kuvera","investments"],["coin by zerodha","investments"]],"review":{"large_spend_inr":25000,"large_subscription_inr":5000,"large_ok_categories":["travel","rent","vehicle","insurance","investments","tax","electronics","education"],"trusted_sources":["manual","hermes"]}}$taxonomy$::jsonb;
$fn$;

comment on function public.ledger_taxonomy() is
  'The ledger taxonomy (subtypes, categories, budget buckets, merchant categories, review rule). Mirrors TAXONOMY in src/ledger/taxonomy.js.';


-- ────────────────────────────────────────────────────────────
-- Names. The SQL twin of normalizeName() in src/ledger/normalize.js.
-- ────────────────────────────────────────────────────────────
create or replace function public.ledger_normalize_name(p_name text)
returns text
language plpgsql
immutable
set search_path = public, pg_temp
as $$
declare
  v text := regexp_replace(regexp_replace(lower(coalesce(p_name, '')), '[''’‘`]', '', 'g'), '[^a-z0-9]+', ' ', 'g');
  v_prev text;
begin
  -- "kapoor s cafe" (an apostrophe a bank turned into a space) is "kapoors cafe".
  v := regexp_replace(' ' || v || ' ', '([a-z]{2,}) s(?= )', '\1s', 'g');
  loop
    v_prev := v;
    v := regexp_replace(v, '\s+(pvt|private|ltd|limited|inc|llc|india|technologies|services)\s*$', '');
    exit when v = v_prev;
  end loop;
  return nullif(btrim(v), '');
end;
$$;


-- ────────────────────────────────────────────────────────────
-- Vocabulary lookups. Each mirrors the function of the same purpose in
-- src/ledger/taxonomy.js — change one, change both.
-- ────────────────────────────────────────────────────────────
create or replace function public.ledger_slug(p_value text)
returns text
language sql
immutable
set search_path = ''
as $$
  select nullif(btrim(regexp_replace(replace(lower(btrim(coalesce(p_value, ''))), '&', ' and '), '[^a-z0-9]+', '_', 'g'), '_'), '');
$$;

create or replace function public.ledger_canonical_category(p_value text)
returns text
language plpgsql
immutable
set search_path = public, pg_temp
as $$
declare
  t      jsonb := public.ledger_taxonomy();
  v_key  text  := public.ledger_slug(p_value);
  v_word text;
  v_words text[];
  i      int;
begin
  if v_key is null then return null; end if;
  if t -> 'categories' ? v_key then return v_key; end if;
  if t -> 'category_synonyms' ? v_key then return t -> 'category_synonyms' ->> v_key; end if;
  -- "Software subscription", "Men Health Checkup Premium": the nouns, last first.
  v_words := string_to_array(v_key, '_');
  for i in reverse coalesce(array_length(v_words, 1), 0) .. 1 loop
    v_word := v_words[i];
    if t -> 'categories' ? v_word and v_word <> 'other' then return v_word; end if;
    if t -> 'category_synonyms' ? v_word and t -> 'category_synonyms' ->> v_word <> 'other' then
      return t -> 'category_synonyms' ->> v_word;
    end if;
  end loop;
  return null;
end;
$$;

create or replace function public.ledger_canonical_subtype(p_type text, p_subtype text)
returns text
language plpgsql
immutable
set search_path = public, pg_temp
as $$
declare
  t     jsonb := public.ledger_taxonomy();
  v_key text  := public.ledger_slug(p_subtype);
begin
  if v_key is null then return null; end if;
  -- A value the column would reject anyway is left for the constraint to report.
  if v_key !~ '^[a-z][a-z0-9_]{1,47}$' then return p_subtype; end if;
  if coalesce(t -> 'subtypes' -> p_type, '[]'::jsonb) ? v_key then return v_key; end if;
  return coalesce(coalesce(t -> 'subtype_aliases' -> p_type, t -> 'subtype_aliases' -> '*') ->> v_key, v_key);
end;
$$;

create or replace function public.ledger_merchant_category(p_normalized text)
returns text
language sql
immutable
set search_path = public, pg_temp
as $$
  select m.value ->> 1
    from jsonb_array_elements(public.ledger_taxonomy() -> 'merchant_categories') with ordinality m(value, n)
   where p_normalized is not null
     and position(' ' || (m.value ->> 0) || ' ' in ' ' || p_normalized || ' ') > 0
   order by m.n
   limit 1;
$$;

create or replace function public.ledger_note_category(p_description text)
returns text
language sql
immutable
set search_path = public, pg_temp
as $$
  select public.ledger_taxonomy() -> 'note_categories' ->> lower(substring(p_description from '^([A-Za-z]+)(?::|$| \|)'));
$$;

-- A spend category, or NULL when the value is not one (income, own transfers, other).
create or replace function public.ledger_spend_only(p_category text)
returns text
language sql
immutable
set search_path = ''
as $$
  select case when p_category in ('income', 'transfer', 'other') then null else p_category end;
$$;

-- The ladder in deriveCategory(): note, type/subtype pair, transfer rules,
-- the old subtype read as a category, the source's word, the merchant, the
-- type's default.
create or replace function public.ledger_derive_category(
  p_type        text,
  p_subtype     text,
  p_raw_subtype text,
  p_stated      text,
  p_description text,
  p_merchant    text,
  p_has_amount  boolean
)
returns text
language plpgsql
immutable
set search_path = public, pg_temp
as $$
declare
  t      jsonb := public.ledger_taxonomy();
  v_note text  := public.ledger_note_category(p_description);
  v      text;
begin
  if v_note is not null and p_type is distinct from 'transfer' then return v_note; end if;

  v := t -> 'subtype_categories' ->> (p_type || '/' || coalesce(p_subtype, ''));
  if v is not null then return v; end if;

  if p_type = 'transfer' then
    if p_subtype = 'refund' then
      return coalesce(public.ledger_spend_only(public.ledger_canonical_category(p_stated)), 'income');
    end if;
    if p_subtype is distinct from 'payment' then return 'transfer'; end if;
  end if;

  -- Only a subtype that IS a category word (purchase/clothing, purchase/fuel);
  -- never a word inside one, or "online_card_purchase" would read as shopping.
  if p_raw_subtype is not null and p_raw_subtype is distinct from p_subtype then
    v := public.ledger_spend_only(case
           when t -> 'categories' ? p_raw_subtype then p_raw_subtype
           else t -> 'category_synonyms' ->> p_raw_subtype end);
    if v is not null then return v; end if;
  end if;

  v := public.ledger_canonical_category(p_stated);
  if v is not null and v <> 'other' then return v; end if;

  v := public.ledger_merchant_category(p_merchant);
  if v is not null then return v; end if;

  v := t -> 'subtype_categories' ->> (p_type || '/*');
  if v is not null then return v; end if;
  if t -> 'type_categories' ? p_type then return t -> 'type_categories' ->> p_type; end if;
  return case when p_has_amount then 'other' end;
end;
$$;

-- No SET clause, fully qualified: inlinable, so per-row callers get a constant.
create or replace function public.ledger_budget_bucket(p_category text)
returns text
language sql
immutable
as $$
  select public.ledger_taxonomy() -> 'categories' ->> p_category;
$$;

-- The read-time category, kept for callers that pass raw fields: the stored
-- canonical category when there is one, otherwise the derivation.
create or replace function public.ledger_spend_category(p_type text, p_subtype text, p_data jsonb, p_description text)
returns text
language sql
immutable
set search_path = public, pg_temp
as $$
  select coalesce(
    public.ledger_canonical_category(p_data ->> 'category'),
    public.ledger_derive_category(p_type, p_subtype, null, p_data ->> 'category', p_description,
      public.ledger_normalize_name(coalesce(p_data ->> 'merchant', p_data ->> 'restaurant', p_data ->> 'provider')),
      p_data ? 'amount'),
    'other');
$$;


-- ────────────────────────────────────────────────────────────
-- Entities: one merchant, whichever type a source filed it under.
-- ────────────────────────────────────────────────────────────

-- Entity types that all name a business. A card alert files a restaurant as a
-- `merchant`, the receipt as a `restaurant`, the bill as a `company`.
create or replace function public.ledger_entity_family(p_type text)
returns text[]
language sql
immutable
set search_path = ''
as $$
  select case when p_type in ('merchant', 'restaurant', 'company')
              then array['merchant', 'restaurant', 'company'] else array[p_type] end;
$$;

create or replace function public.ledger_resolve_entity(
  p_user_id         uuid,
  p_type            text,
  p_name            text,
  p_normalized_name text default null,
  p_metadata        jsonb default '{}'::jsonb
)
returns uuid
language plpgsql
set search_path = public, extensions, pg_temp
as $$
declare
  v_norm    text := coalesce(nullif(public.ledger_normalize_name(p_normalized_name), ''), public.ledger_normalize_name(p_name));
  v_family  text[] := public.ledger_entity_family(p_type);
  v_id      uuid;
  v_next    uuid;
  v_min_sim numeric;
  v_alias   boolean := false;
  i         int;
begin
  if v_norm is null or p_name is null then return null; end if;

  -- Exact name: this type first, then the rest of the family.
  select id into v_id from public.entities
   where user_id = p_user_id and type = any (v_family) and normalized_name = v_norm
   order by (type = p_type) desc, (metadata ? 'merged_into'), created_at
   limit 1;

  -- A known other name. Before the fuzzy match, on purpose: "papa" is nowhere
  -- near the legal name it stands for.
  if v_id is null then
    select id into v_id from public.entities
     where user_id = p_user_id and type = any (v_family)
       and jsonb_typeof(metadata -> 'aliases') = 'array'
       and metadata -> 'aliases' ? v_norm
     order by (type = p_type) desc, (metadata ? 'merged_into'), created_at
     limit 1;
    v_alias := v_id is not null;
  end if;

  if v_id is null then
    v_min_sim := public.ledger_setting(p_user_id, 'ledger_entity_similarity', 0.82);
    select id into v_id from public.entities
     where user_id = p_user_id and type = any (v_family)
       and not (metadata ? 'merged_into')
       and extensions.similarity(normalized_name, v_norm) >= v_min_sim
     order by extensions.similarity(normalized_name, v_norm) desc, (type = p_type) desc
     limit 1;
  end if;

  -- A merged entity hands over to the one it was merged into.
  for i in 1 .. 5 loop
    exit when v_id is null;
    select nullif(metadata ->> 'merged_into', '')::uuid into v_next from public.entities where id = v_id;
    exit when v_next is null or v_next = v_id;
    v_id := v_next;
    v_alias := true;
  end loop;

  if v_id is null then
    insert into public.entities (user_id, type, name, normalized_name, metadata)
    values (p_user_id, p_type, p_name, v_norm, coalesce(p_metadata, '{}'::jsonb))
    on conflict (user_id, type, normalized_name) do update set name = public.entities.name
    returning id into v_id;
  else
    update public.entities
       -- An alias never renames: "Papa" is longer than nothing, but it is not
       -- his name, and "KAPOOR S CAFE" is not the café's.
       set name     = case when not v_alias and char_length(p_name) > char_length(name) then p_name else name end,
           metadata = metadata || (coalesce(p_metadata, '{}'::jsonb) - 'aliases' - 'merged_into')
     where id = v_id;
  end if;

  return v_id;
end;
$$;

-- Fold one entity into another. The absorbed row is kept — marked
-- `merged_into`, its name an alias of the target — so the merge is visible
-- and reversible, and ingestion that still names it lands on the target.
-- Links that would duplicate one the target already has (same event, same
-- relationship) are the only rows removed.
create or replace function public.ledger_merge_entities(p_target uuid, p_duplicate uuid)
returns jsonb
language plpgsql
set search_path = public, pg_temp
as $$
declare
  v_target public.entities%rowtype;
  v_dup    public.entities%rowtype;
  v_moved  int;
begin
  if p_target = p_duplicate then raise exception 'cannot merge an entity into itself'; end if;
  select * into v_target from public.entities where id = p_target;
  if not found then raise exception 'target entity % not found', p_target using errcode = 'P0002'; end if;
  select * into v_dup from public.entities where id = p_duplicate;
  if not found then raise exception 'duplicate entity % not found', p_duplicate using errcode = 'P0002'; end if;
  if not public.ledger_can_act_as(v_target.user_id) or v_target.user_id <> v_dup.user_id
     or not (v_dup.type = any (public.ledger_entity_family(v_target.type))) then
    raise exception 'not authorized, or not the same kind of entity' using errcode = '42501';
  end if;
  if v_target.metadata ? 'merged_into' then
    raise exception 'target % was itself merged into %', p_target, v_target.metadata ->> 'merged_into';
  end if;

  update public.event_entities ee set entity_id = p_target
   where ee.entity_id = p_duplicate
     and not exists (select 1 from public.event_entities t
                      where t.event_id = ee.event_id and t.entity_id = p_target and t.relationship = ee.relationship);
  get diagnostics v_moved = row_count;
  delete from public.event_entities where entity_id = p_duplicate;

  update public.entities e
     set metadata = (e.metadata || (v_dup.metadata - 'aliases' - 'merged_into' - 'merged_at')) || jsonb_build_object('aliases', (
           select coalesce(jsonb_agg(distinct a), '[]'::jsonb)
             from (select jsonb_array_elements_text(coalesce(e.metadata -> 'aliases', '[]'::jsonb)) as a
                   union select jsonb_array_elements_text(coalesce(v_dup.metadata -> 'aliases', '[]'::jsonb))
                   union select v_dup.normalized_name) s
            where a is not null and a <> e.normalized_name))
   where e.id = p_target;

  update public.entities
     set metadata = metadata || jsonb_build_object('merged_into', p_target, 'merged_at', now())
   where id = p_duplicate;

  -- Anything that had been merged into the duplicate now points at the target.
  update public.entities
     set metadata = metadata || jsonb_build_object('merged_into', p_target)
   where user_id = v_target.user_id and metadata ->> 'merged_into' = p_duplicate::text;

  perform public.ledger_log(v_target.user_id, 'entities_merged', 'entities', p_target,
    jsonb_build_object('absorbed', to_jsonb(v_dup)), jsonb_build_object('target', p_target, 'links_moved', v_moved));

  return jsonb_build_object('target', p_target, 'merged', p_duplicate, 'events_moved', v_moved);
end;
$$;

-- Merged entities are history, not search results.
create or replace function public.ledger_search_entities(p_query text default null, p_type text default null, p_limit integer default 25, p_user_id uuid default null)
returns jsonb
language plpgsql
stable
set search_path = public, extensions, pg_temp
as $$
declare
  v_uid  uuid := coalesce(p_user_id, auth.uid());
  v_norm text := public.ledger_normalize_name(p_query);
begin
  if not public.ledger_can_act_as(v_uid) then
    raise exception 'not authorized' using errcode = '42501';
  end if;

  return coalesce((
    select jsonb_agg(jsonb_build_object(
             'id', x.id, 'type', x.type, 'name', x.name, 'normalized_name', x.normalized_name,
             'event_count', x.event_count, 'last_seen_at', x.last_seen_at) order by x.event_count desc)
    from (
      select en.*,
             (select count(*) from public.event_entities ee where ee.entity_id = en.id) as event_count,
             (select max(e.occurred_at) from public.event_entities ee join public.events e on e.id = ee.event_id
               where ee.entity_id = en.id) as last_seen_at
      from public.entities en
      where en.user_id = v_uid
        and not (en.metadata ? 'merged_into')
        and (p_type is null or en.type = p_type)
        and (v_norm is null
             or en.normalized_name like '%' || v_norm || '%'
             or extensions.similarity(en.normalized_name, v_norm) >= 0.4
             or (jsonb_typeof(en.metadata -> 'aliases') = 'array' and en.metadata -> 'aliases' ? v_norm))
      limit greatest(p_limit, 1)
    ) x
  ), '[]'::jsonb);
end;
$$;

grant execute on function public.ledger_taxonomy() to authenticated, service_role;
grant execute on function public.ledger_slug(text) to authenticated, service_role;
grant execute on function public.ledger_canonical_category(text) to authenticated, service_role;
grant execute on function public.ledger_canonical_subtype(text, text) to authenticated, service_role;
grant execute on function public.ledger_merchant_category(text) to authenticated, service_role;
grant execute on function public.ledger_note_category(text) to authenticated, service_role;
grant execute on function public.ledger_spend_only(text) to authenticated, service_role;
grant execute on function public.ledger_derive_category(text, text, text, text, text, text, boolean) to authenticated, service_role;
grant execute on function public.ledger_budget_bucket(text) to authenticated, service_role;
grant execute on function public.ledger_entity_family(text) to authenticated, service_role;
