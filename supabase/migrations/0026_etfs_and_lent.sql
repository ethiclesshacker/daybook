-- ============================================================
-- Two more asset classes on a snapshot: ETFs and money lent out
--
-- `stocks` had been carrying gold, silver and Nifty ETFs since the first
-- snapshot (2025-09-14): there have been no real stock holdings since the
-- March 2025 sell-off, only leftovers. The allocation chart therefore called
-- ~90% of the assets "Stocks". `etfs` gets its own column, and every existing
-- row is split using the demat trade log (Fold, 2026-10-24): the only
-- non-ETF positions over the snapshot period were Mahindra Lifespace (50 sh,
-- bought 2025-09-18 at 379, sold 2025-11-26 at 416 — ~₹20,000), Suzlon (1 sh)
-- and Avance Technologies (350 sh at ~1.5), both gone by 2026-01-05. Reliance
-- is deliberately absent: it is held for his father and was never in a
-- snapshot. Prices are trade-implied, so the split is right to about ±₹1,000
-- on the three months that held Mahindra and exact otherwise.
--
-- `lent` is money owed to the user — loans to people and work spend awaiting
-- reimbursement. He had been netting it against credit card dues by hand
-- before typing the liability, which made the liability wrong and the
-- receivable invisible. It is an asset, counted in total assets and net worth,
-- but not in `liquid` or `cash_like`: it cannot be spent until it comes back.
--
-- `gold` is physical gold and always was; the labels now say so.
--
-- Replaces: finance_net_worth (0011), which restates the arithmetic in
-- src/networth-math.js.
-- ============================================================

alter table public.net_worth_entries
  add column if not exists etfs numeric default 0,
  add column if not exists lent numeric default 0;

update public.net_worth_entries n
   set stocks = least(coalesce(n.stocks, 0), held.value),
       etfs   = greatest(coalesce(n.stocks, 0) - held.value, 0)
  from (select id,
               case when date between date '2025-09-18' and date '2025-11-25' then 20600
                    when date <  date '2026-01-05'                              then 600
                    else 0 end as value
          from public.net_worth_entries) held
 where held.id = n.id
   and coalesce(n.etfs, 0) = 0
   and coalesce(n.stocks, 0) > 0;

create or replace function public.finance_net_worth(p_limit integer default 12, p_user_id uuid default null)
returns jsonb language plpgsql stable
set search_path = public, pg_temp as $$
declare
  v_user uuid := coalesce(p_user_id, auth.uid());
  v_out  jsonb;
begin
  if not public.ledger_can_act_as(v_user) then
    raise exception 'not authorized for user %', v_user using errcode = '42501';
  end if;

  with snap as (
    select n.date,
           coalesce(n.stocks,0) + coalesce(n.etfs,0) + coalesce(n.mutual_funds,0) + coalesce(n.cash,0)
             + coalesce(n.epf,0) + coalesce(n.gold,0) + coalesce(n.fds,0) + coalesce(n.lent,0) as assets,
           coalesce(n.credit_cards,0)                                                          as liabilities,
           coalesce(n.stocks,0) + coalesce(n.etfs,0) + coalesce(n.mutual_funds,0) + coalesce(n.cash,0) as liquid,
           coalesce(n.cash,0) + coalesce(n.fds,0)                                              as cash_like,
           jsonb_build_object('stocks', n.stocks, 'etfs', n.etfs, 'mutual_funds', n.mutual_funds, 'cash', n.cash,
                              'epf', n.epf, 'gold', n.gold, 'fds', n.fds, 'lent', n.lent)      as breakdown
      from public.net_worth_entries n
     where n.user_id = v_user
  ),
  ranked as (
    select s.*, s.assets - s.liabilities as net, row_number() over (order by s.date desc) as rn,
           count(*) over () as total
      from snap s
  )
  select jsonb_build_object(
    'currency', 'INR',
    'snapshots', coalesce(max(r.total), 0),
    'latest', (select jsonb_build_object('date', l.date, 'net_worth', round(l.net), 'assets', round(l.assets),
                        'liabilities', round(l.liabilities), 'liquid', round(l.liquid),
                        'cash_like', round(l.cash_like), 'breakdown', l.breakdown)
                 from ranked l where l.rn = 1),
    'previous', (select jsonb_build_object('date', p.date, 'net_worth', round(p.net)) from ranked p where p.rn = 2),
    'change', (select round(l.net - p.net) from ranked l, ranked p where l.rn = 1 and p.rn = 2),
    'change_pct', (select round(((l.net - p.net) / nullif(abs(p.net), 0) * 100)::numeric, 1)
                     from ranked l, ranked p where l.rn = 1 and p.rn = 2),
    'history', coalesce((select jsonb_agg(jsonb_build_object('date', h.date, 'net_worth', round(h.net)) order by h.date)
                           from ranked h where h.rn <= greatest(p_limit, 1)), '[]'::jsonb)
  ) into v_out
  from ranked r;

  return v_out;
end;
$$;
