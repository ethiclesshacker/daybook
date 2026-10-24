// @ts-check
// ======================================================
// Net worth computations — single source of truth.
// All views must use these instead of inline arithmetic.
// To add a new asset class, update only here.
//
// Deliberately free of imports: no DOM, no Chart.js, no Supabase. That keeps
// it runnable (and testable) outside a browser, which is why finance.js pulls
// from here rather than from utils.js.
//
// The classes, in the order every screen lists them. `gold` is physical
// metals (the column predates the label); `lent` is money owed to you —
// loans to people and work spend awaiting reimbursement — which counts
// towards assets and net worth but not towards anything you could spend
// today.
// ======================================================

export const ASSET_FIELDS = [
  { key: 'stocks',       label: 'Stocks' },
  { key: 'etfs',         label: 'ETFs' },
  { key: 'mutual_funds', label: 'Mutual Funds' },
  { key: 'cash',         label: 'Cash' },
  { key: 'epf',          label: 'EPF' },
  { key: 'gold',         label: 'Physical metals' },
  { key: 'fds',          label: 'FDs' },
  { key: 'lent',         label: 'Lent' },
];

/**
 * Sum of all asset classes for a snapshot entry.
 * @param {object} e - a net_worth_entries row (may be null/undefined)
 */
export function computeAssets(e) {
  if (!e) return 0;
  return ASSET_FIELDS.reduce((sum, f) => sum + (e[f.key] || 0), 0);
}

/**
 * Everything you could reach quickly, market risk included.
 */
export function computeLiquid(e) {
  if (!e) return 0;
  return (e.stocks || 0) + (e.etfs || 0) + (e.mutual_funds || 0) + (e.cash || 0);
}

/**
 * Cash-like assets only — cash and fixed deposits.
 *
 * The conservative emergency-fund basis. Stocks and mutual funds tend to be
 * down at exactly the moment an emergency arrives, so counting them makes the
 * runway read healthier than it is. Which basis the runway KPI uses is the
 * `emergency_fund_basis` setting.
 */
export function computeCashLike(e) {
  if (!e) return 0;
  return (e.cash || 0) + (e.fds || 0);
}

/** Emergency fund under the user's chosen basis. */
export function computeEmergencyFund(e, basis) {
  return basis === 'cash_like' ? computeCashLike(e) : computeLiquid(e);
}

/** What the passive-income estimate is applied to: market and deposit holdings. */
export function computeInvestables(e) {
  if (!e) return 0;
  return (e.stocks || 0) + (e.etfs || 0) + (e.mutual_funds || 0) + (e.fds || 0);
}

/**
 * Net worth = total assets − liabilities.
 */
export function computeNet(e) {
  if (!e) return 0;
  return computeAssets(e) - (e.credit_cards || 0);
}
