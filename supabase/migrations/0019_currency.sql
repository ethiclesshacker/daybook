-- ============================================================
-- One place where money becomes rupees.
--
-- Until this migration no SQL looked at data.currency. Fifteen card charges
-- billed in US dollars (Cursor, Airalo and the Claude subscription, about
-- $1,250 between Dec 2025 and Aug 2026) were summed as if each dollar were a
-- rupee — a $100 charge counted as ₹100 instead of ~₹9,500 — and two Tata Neu
-- reward credits, denominated in NeuCoins, counted as rupees of income.
--
-- So:
--   * public.fx_rates holds a monthly INR rate per currency (the monthly mean
--     of the ECB reference rate, via api.frankfurter.app). Not per-user data:
--     everyone may read it, nobody but the owner writes it.
--   * public.ledger_normalize_currency() is the one spelling rule — ISO 4217
--     upper-case, '$' → USD, '₹'/'Rs' → INR — and the events trigger
--     (0021) runs it on every write, so email, Hermes and the UI all land the
--     same code. JS twin: normalizeCurrency() in src/ledger/normalize.js.
--   * public.ledger_amount_inr(data, occurred_at) is the single conversion
--     point. Everything that sums an amount goes through it (0022). A unit
--     that is not money (NEUCOIN, any non-ISO code) converts to NULL and is
--     therefore never in a cash total; a currency with no rate also gives NULL
--     rather than a guess — a missing number announces itself, a wrong one
--     does not.
--
-- Safe to apply while ingestion runs: new objects only, nothing rewritten.
-- Adding a month: insert into public.fx_rates (…) on conflict do update.
-- ============================================================

create table if not exists public.fx_rates (
  currency      text    not null check (currency ~ '^[A-Z]{3}$'),
  month         date    not null check (month = date_trunc('month', month)::date),
  inr_per_unit  numeric not null check (inr_per_unit > 0),
  source        text    not null default 'frankfurter.app (ECB reference, monthly mean)',
  observations  integer,
  primary key (currency, month)
);

comment on table public.fx_rates is
  'Monthly INR value of one unit of a currency. Read by ledger_amount_inr(); seeded in 0019_currency.sql.';

alter table public.fx_rates enable row level security;
drop policy if exists fx_rates_read on public.fx_rates;
create policy fx_rates_read on public.fx_rates for select to authenticated using (true);
revoke all on public.fx_rates from anon, public;
grant select on public.fx_rates to authenticated;
grant all on public.fx_rates to service_role;

insert into public.fx_rates (currency, month, inr_per_unit, observations) values
  ('USD', date '2025-08-01', 87.5571, 21),
  ('USD', date '2025-09-01', 88.3045, 22),
  ('USD', date '2025-10-01', 88.4191, 23),
  ('USD', date '2025-11-01', 88.8485, 20),
  ('USD', date '2025-12-01', 90.0290, 21),
  ('USD', date '2026-01-01', 90.8795, 21),
  ('USD', date '2026-02-01', 90.7655, 20),
  ('USD', date '2026-03-01', 92.8750, 22),
  ('USD', date '2026-04-01', 93.5245, 20),
  ('USD', date '2026-05-01', 95.5530, 20),
  ('USD', date '2026-06-01', 94.9309, 22),
  ('USD', date '2026-07-01', 95.8317, 23),
  ('USD', date '2026-08-01', 95.4476, 21),
  ('USD', date '2026-09-01', 95.4705, 22),
  ('USD', date '2026-10-01', 95.9875, 12),
  ('EUR', date '2025-08-01', 101.8425, 21),
  ('EUR', date '2025-09-01', 103.6023, 22),
  ('EUR', date '2025-10-01', 102.8353, 23),
  ('EUR', date '2025-11-01', 102.7101, 20),
  ('EUR', date '2025-12-01', 105.4131, 21),
  ('EUR', date '2026-01-01', 106.6826, 21),
  ('EUR', date '2026-02-01', 107.3203, 20),
  ('EUR', date '2026-03-01', 107.3446, 22),
  ('EUR', date '2026-04-01', 109.4829, 20),
  ('EUR', date '2026-05-01', 111.5368, 20),
  ('EUR', date '2026-06-01', 109.3451, 22),
  ('EUR', date '2026-07-01', 109.4158, 23),
  ('EUR', date '2026-08-01', 110.6529, 21),
  ('EUR', date '2026-09-01', 109.9142, 22),
  ('EUR', date '2026-10-01', 107.6588, 12),
  ('GBP', date '2025-08-01', 117.7010, 21),
  ('GBP', date '2025-09-01', 119.2264, 22),
  ('GBP', date '2025-10-01', 117.9952, 23),
  ('GBP', date '2025-11-01', 116.7200, 20),
  ('GBP', date '2025-12-01', 120.4738, 21),
  ('GBP', date '2026-01-01', 122.8676, 21),
  ('GBP', date '2026-02-01', 123.3150, 20),
  ('GBP', date '2026-03-01', 123.9109, 22),
  ('GBP', date '2026-04-01', 125.9420, 20),
  ('GBP', date '2026-05-01', 128.8490, 20),
  ('GBP', date '2026-06-01', 126.5968, 22),
  ('GBP', date '2026-07-01', 128.1370, 23),
  ('GBP', date '2026-08-01', 129.2600, 21),
  ('GBP', date '2026-09-01', 128.0877, 22),
  ('GBP', date '2026-10-01', 127.1008, 12)
on conflict (currency, month) do update
  set inr_per_unit = excluded.inr_per_unit, observations = excluded.observations, source = excluded.source;


-- ────────────────────────────────────────────────────────────
-- Spelling. Mirrors normalizeCurrency() — change one, change both.
-- ────────────────────────────────────────────────────────────
create or replace function public.ledger_normalize_currency(p_value text)
returns text
language sql
immutable
set search_path = ''
as $$
  select case
    when p_value is null or btrim(p_value) = '' then null
    when lower(btrim(p_value)) in ('₹', 'rs', 'rs.', 'inr', 'rupee', 'rupees', 'inr.') then 'INR'
    when lower(btrim(p_value)) in ('$', 'us$', 'usd', 'dollar', 'dollars') then 'USD'
    when lower(btrim(p_value)) in ('€', 'euro', 'euros') then 'EUR'
    when lower(btrim(p_value)) in ('£', 'pound', 'pounds') then 'GBP'
    when lower(btrim(p_value)) = 's$' then 'SGD'
    when lower(btrim(p_value)) = 'a$' then 'AUD'
    when lower(btrim(p_value)) in ('aed', 'dhs') then 'AED'
    when btrim(p_value) = '¥' then 'JPY'
    when btrim(p_value) ~* '^[a-z]{3}$' then upper(btrim(p_value))
    -- Not money: reward points and the like. "NeuCoins" and "NeuCoin" are one unit.
    else nullif(regexp_replace(regexp_replace(upper(p_value), '[^A-Z0-9]+', '', 'g'), 'S$', ''), '')
  end;
$$;

-- Money that has a rupee value. A null currency is rupees.
create or replace function public.ledger_is_cash_currency(p_code text)
returns boolean
language sql
immutable
set search_path = ''
as $$
  select coalesce(p_code, 'INR') ~ '^[A-Z]{3}$';
$$;


-- ────────────────────────────────────────────────────────────
-- The conversion. Rupees pass straight through without touching fx_rates.
-- The month is the IST calendar month the money moved in; a month with no rate
-- yet (the current one before it is seeded) borrows the nearest earlier month,
-- then the nearest later one.
--
-- PL/pgSQL on purpose: it is called once per row by every aggregate, and the
-- rupee case returns after two simple expressions. (A SQL function with a
-- sub-select cannot be inlined, and running it through the SQL-function
-- executor per row cost ~0.15 ms a row — 300 ms on a full-ledger ledger_stats.)
-- ────────────────────────────────────────────────────────────
create or replace function public.ledger_amount_inr(p_data jsonb, p_at timestamptz)
returns numeric
language plpgsql
stable
set search_path = public, pg_temp
as $$
declare
  -- A JSON number needs no parsing guard; ledger_num's exception block (a
  -- subtransaction per call) is kept for amounts stored as strings.
  v_amount numeric := case jsonb_typeof(p_data -> 'amount')
                        when 'number' then (p_data ->> 'amount')::numeric
                        when 'string' then public.ledger_num(p_data, 'amount') end;
  v_raw    text;
  v_cur    text;
  v_month  date;
  v_rate   numeric;
begin
  if v_amount is null then return null; end if;
  v_raw := p_data ->> 'currency';
  if v_raw is null or v_raw = 'INR' then return v_amount; end if;
  v_cur := public.ledger_normalize_currency(v_raw);
  if v_cur is null or v_cur = 'INR' then return v_amount; end if;
  if v_cur !~ '^[A-Z]{3}$' then return null; end if;   -- not money (reward points)
  v_month := date_trunc('month', p_at at time zone 'Asia/Kolkata')::date;
  select r.inr_per_unit into v_rate
    from public.fx_rates r
   where r.currency = v_cur
   order by (r.month > v_month), abs(r.month - v_month)
   limit 1;
  return round(v_amount * v_rate, 2);
end;
$$;

comment on function public.ledger_amount_inr(jsonb, timestamptz) is
  'The one place an event amount becomes rupees. NULL for no amount, a non-cash unit, or a currency with no rate.';

grant execute on function public.ledger_normalize_currency(text) to authenticated, service_role;
grant execute on function public.ledger_is_cash_currency(text) to authenticated, service_role;
grant execute on function public.ledger_amount_inr(jsonb, timestamptz) to authenticated, service_role;
