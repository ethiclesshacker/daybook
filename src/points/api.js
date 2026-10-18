// @ts-check
// ======================================================
// Browser client for card points (HSBC TravelOne).
//
// Reads come from the `cc_points` view rather than the table: a row linked
// to a card alert takes its amount and date from the alert, not from a typed
// copy. Writes go to `cc_transactions` directly or through the SQL functions
// from 0012_card_points.sql / 0013_card_reconcile.sql, which is where the
// "any edit confirms" rule and the reconcile bookkeeping live.
// ======================================================

import { supabase } from '../supabase.js';
import { rpc, unwrap } from '../rpc.js';
import { cached, invalidate, invalidating } from '../cache.js';

// Reads cached for the session (src/cache.js). Card rows feed the ledger's
// review queue and a day's work spend, so a write here clears everything.
const read = (key, fn) => cached(`points:${key}`, fn);
const write = fn => invalidating(null, fn);

/** Drop everything cached, so the next read goes to the database. */
export const refresh = () => invalidate();

// ── Reads ──────────────────────────────────────────────

export const listTransactions = () =>
  read('tx', () => unwrap(supabase.from('cc_points').select('*').order('date', { ascending: false })));

export const listRedemptions = () =>
  read('rd', () => unwrap(supabase.from('cc_redemptions').select('*').order('date', { ascending: false })));

export const listRules = () =>
  read('rules', () => unwrap(supabase.from('cc_merchant_rules').select('*').order('uses', { ascending: false })));

/** What never paired: typed rows without an alert, alerts without a row. */
export const reconcile = () => read('reconcile', () => rpc('cc_reconcile'));

/**
 * Pick up card spend the ledger has seen since the last visit. Idempotent.
 * Resolves to what it did ({ created, … }); when it created rows the cached
 * reads are stale, so they are dropped here.
 */
export async function syncFromEvents() {
  const result = await rpc('cc_sync_from_events');
  if (Number(result?.created) > 0) invalidate();
  return result;
}

// ── Transactions ───────────────────────────────────────

export const upsertTransaction = write(payload => unwrap(supabase.from('cc_transactions').upsert([payload])));
export const deleteTransaction = write(id => unwrap(supabase.from('cc_transactions').delete().eq('id', id)));

/** One update across many rows — never a loop of single-row updates. */
export const updateTransactions = write((ids, patch) =>
  unwrap(supabase.from('cc_transactions').update(patch).in('id', ids)));

/**
 * Confirm a row that arrived from a card alert, optionally correcting it.
 * With no fields it only flips `basis` to confirmed; with fields it is the
 * edit path for a linked row (date and amount stay the bank's).
 */
export const confirmTransaction = write((id, fields = {}) => rpc('cc_confirm', { p_id: id, ...fields }));

// ── Redemptions ────────────────────────────────────────

export const upsertRedemption = write(payload => unwrap(supabase.from('cc_redemptions').upsert([payload])));
export const deleteRedemption = write(id => unwrap(supabase.from('cc_redemptions').delete().eq('id', id)));

// ── Merchant rules ─────────────────────────────────────

export const updateRule = write((merchantKey, patch) =>
  unwrap(supabase.from('cc_merchant_rules').update(patch).eq('merchant_key', merchantKey)));

export const deleteRule = write(merchantKey =>
  unwrap(supabase.from('cc_merchant_rules').delete().eq('merchant_key', merchantKey)));

// ── Reconcile actions ──────────────────────────────────

export const linkToEvent     = write((id, eventId) => rpc('cc_link', { p_id: id, p_event_id: eventId }));
export const markNoAlert     = write(ids           => rpc('cc_mark_no_alert', { p_ids: ids }));
export const createFromEvent = write(eventId       => rpc('cc_create_from_event', { p_event_id: eventId }));
export const ignoreEvents    = write(eventIds      => rpc('cc_ignore_events', { p_event_ids: eventIds }));
