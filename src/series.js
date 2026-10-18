// @ts-check
// ======================================================
// Time series with their gaps left in.
//
// A chart given only the days that have a reading joins Monday to Thursday
// with one straight line, and the eye reads two days that never happened as
// a trend. Every slot in the range gets a point here; a slot with no reading
// gets `null`, which Chart.js (with spanGaps: false) draws as a break.
//
// Pure and import-free apart from the date helpers, so it is tested in node.
// ======================================================

import { shiftISO, startOfWeek } from './ledger/dates.js';

/** The slot an ISO day falls in, for a grain. Weeks key on their Monday. */
export function slotOf(day, grain) {
  if (grain === 'month') return `${day.slice(0, 7)}-01`;
  if (grain === 'week') return startOfWeek(day);
  return day.slice(0, 10);
}

function nextSlot(slot, grain) {
  if (grain === 'day') return shiftISO(slot, 1);
  if (grain === 'week') return shiftISO(slot, 7);
  const [y, m] = slot.split('-').map(Number);
  return m === 12 ? `${y + 1}-01-01` : `${y}-${String(m + 1).padStart(2, '0')}-01`;
}

/**
 * Every slot from `from` to `to` (ISO days, inclusive), each carrying the row
 * whose `keyOf(row)` names it, or `{ [at]: slot, empty: true }`.
 *
 * `from` is clamped to the first row, so an "all time" range does not draw a
 * decade of nothing before the first reading.
 *
 * @param {any[]} rows
 * @param {{ grain?: string, from?: string, to?: string, keyOf?: (r: any) => any, at?: string }} [opts]
 */
export function fillSeries(rows, { grain = 'day', from, to, keyOf = r => r.at, at = 'at' } = {}) {
  if (!rows.length) return [];
  const byKey = new Map(rows.map(r => [slotOf(String(keyOf(r)), grain), r]));
  const firstKey = [...byKey.keys()].sort()[0];
  let slot = slotOf(from && from > firstKey ? from : firstKey, grain);
  const last = slotOf(to || [...byKey.keys()].sort().pop(), grain);
  const out = [];
  for (let guard = 0; slot <= last && guard < 5000; guard++) {
    out.push(byKey.get(slot) ?? { [at]: slot, empty: true });
    slot = nextSlot(slot, grain);
  }
  return out;
}
