// The browser-side rules from the 2026-10-18 review that can run in node:
// the money format, the budget tones, gap-filled series, CSV cells, URL
// safety, the session cache, and that every icon used exists in the subset.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import {
  formatINR, formatINRFull, inrAxisTick, inrColumnFormatter, formatMoney, isINR,
  formatDate, formatShortDate, timeAgo, csvCell, safeHttpUrl,
} from '../src/utils.js';
import { budgetStatus } from '../src/budget.js';
import { fillSeries } from '../src/series.js';
import { cached, invalidate, invalidating } from '../src/cache.js';
import { usedIconNames, buildSubset, SUBSET_PATH, NOT_ICONS } from '../scripts/fa-subset.mjs';

// ── Money ────────────────────────────────────────────────

test('formatINR never uses k: plain grouping below a lakh, L and Cr above', () => {
  assert.equal(formatINR(80000), '₹80,000');
  assert.equal(formatINR(450000), '₹4.50 L');
  assert.equal(formatINR(12000000), '₹1.20 Cr');
  assert.equal(formatINR(-450000), '−₹4.50 L');
  assert.equal(formatINR(null), '—');
});

test('formatINRFull keeps the sign and groups the Indian way', () => {
  assert.equal(formatINRFull(1234567), '₹12,34,567');
  assert.equal(formatINRFull(-500), '−₹500');
});

test('axis ticks read ₹0, ₹40L, ₹1.2Cr, and plain rupees on a small axis', () => {
  const big = [0, 4e6, 8e6, 1.2e7].map(value => ({ value }));
  assert.equal(inrAxisTick(0, 0, big), '₹0');
  assert.equal(inrAxisTick(4e6, 1, big), '₹40L');
  assert.equal(inrAxisTick(1.2e7, 3, big), '₹1.2Cr');
  assert.equal(inrAxisTick(250000, 0, [{ value: 250000 }]), '₹2.5L');
  const small = [0, 20000, 40000].map(value => ({ value }));
  assert.equal(inrAxisTick(40000, 2, small), '₹40,000');
});

test('a column picks one scale for every row', () => {
  const lakhs = inrColumnFormatter([45000, 320000]);
  assert.equal(lakhs(45000), '₹0.45 L');
  assert.equal(lakhs(320000), '₹3.20 L');
  const rupees = inrColumnFormatter([450, 9800]);
  assert.equal(rupees(9800), '₹9,800');
});

test('event amounts render in their own currency', () => {
  assert.equal(formatMoney(1200, 'INR'), '₹1,200');
  assert.equal(formatMoney(25, 'USD'), '$25.00');
  assert.equal(formatMoney(9.99, 'eur'), '€9.99');
  assert.equal(formatMoney(94.58, 'INR', { exact: true }), '₹94.58');
  assert.equal(formatMoney(5, 'XYZ'), 'XYZ 5.00');
  assert.equal(isINR(undefined), true);
  assert.equal(isINR('USD'), false);
});

// ── Dates ────────────────────────────────────────────────

test('one date style: "5 Oct 2026" and "5 Oct"', () => {
  assert.equal(formatDate('2026-10-05'), '5 Oct 2026');
  assert.equal(formatDate('2026-10-05T18:30:00Z'), '5 Oct 2026');
  assert.equal(formatShortDate('2026-10-05'), '5 Oct');
  assert.equal(formatDate(null), '—');
});

test('timeAgo', () => {
  const now = Date.parse('2026-10-18T12:00:00Z');
  assert.equal(timeAgo('2026-10-18T11:59:30Z', now), 'just now');
  assert.equal(timeAgo('2026-10-18T11:30:00Z', now), '30 min ago');
  assert.equal(timeAgo('2026-10-18T07:00:00Z', now), '5 h ago');
  assert.equal(timeAgo('2026-10-10T12:00:00Z', now), '8 days ago');
});

// ── Budget ───────────────────────────────────────────────

const money = v => formatINR(v);

test('25% or more over budget is danger, with plain wording', () => {
  const s = budgetStatus({ spent: 216000, budget: 40000, dayOfMonth: 18, daysInMonth: 31, money });
  assert.equal(s.tone, 'danger');
  assert.equal(s.note, '5.4× budget · ₹1.76 L over');
  assert.ok(s.bar.overflow > 0);
  assert.ok(s.bar.beyond, 'a 5× overrun runs off the drawn track');
  assert.equal(s.bar.fill + s.bar.overflow, 100);
});

test('over budget by less than 25% is a warning', () => {
  const s = budgetStatus({ spent: 46000, budget: 40000, dayOfMonth: 28, daysInMonth: 31, money });
  assert.equal(s.tone, 'warning');
  assert.equal(s.note, '115% of budget · ₹6,000 over');
  assert.equal(s.bar.beyond, false);
  assert.ok(s.bar.budgetMark > 0 && s.bar.budgetMark < 100);
});

test('under budget but ahead of the month is a warning; on pace is ok', () => {
  const ahead = budgetStatus({ spent: 30000, budget: 40000, dayOfMonth: 10, daysInMonth: 30, money });
  assert.equal(ahead.tone, 'warning');
  assert.equal(ahead.note, '75% of budget · ₹10,000 left · day 10 of 30');
  const onPace = budgetStatus({ spent: 12000, budget: 40000, dayOfMonth: 10, daysInMonth: 30, money });
  assert.equal(onPace.tone, 'ok');
  assert.equal(onPace.bar.budgetMark, null);
});

test('no budget is not an error', () => {
  const s = budgetStatus({ spent: 5000, budget: 0, dayOfMonth: 1, daysInMonth: 30, money });
  assert.equal(s.tone, 'ok');
  assert.equal(s.note, 'No budget set');
});

// ── Series ───────────────────────────────────────────────

test('fillSeries leaves a null slot for every missing day', () => {
  const rows = [{ at: '2026-10-01', kcal: 1800 }, { at: '2026-10-04', kcal: 2100 }];
  const out = fillSeries(rows, { grain: 'day', from: '2026-09-25', to: '2026-10-05' });
  assert.deepEqual(out.map(r => r.at), ['2026-10-01', '2026-10-02', '2026-10-03', '2026-10-04', '2026-10-05']);
  assert.equal(out[1].empty, true);
  assert.equal(out[3].kcal, 2100);
});

test('fillSeries steps by week and by month', () => {
  const weeks = fillSeries([{ at: '2026-09-07' }, { at: '2026-09-28' }], { grain: 'week', to: '2026-10-04' });
  assert.deepEqual(weeks.map(r => r.at), ['2026-09-07', '2026-09-14', '2026-09-21', '2026-09-28']);
  const months = fillSeries([{ at: '2025-11-01' }, { at: '2026-02-01' }], { grain: 'month', to: '2026-02-10' });
  assert.deepEqual(months.map(r => r.at), ['2025-11-01', '2025-12-01', '2026-01-01', '2026-02-01']);
});

test('fillSeries keys rows by any field', () => {
  const out = fillSeries([{ day: '2026-10-01', steps: 5 }], { grain: 'day', to: '2026-10-02', keyOf: d => d.day, at: 'day' });
  assert.deepEqual(out, [{ day: '2026-10-01', steps: 5 }, { day: '2026-10-02', empty: true }]);
});

// ── CSV and URLs ─────────────────────────────────────────

test('CSV cells cannot start a formula', () => {
  assert.equal(csvCell('=HYPERLINK("x")'), `"'=HYPERLINK(""x"")"`);
  assert.equal(csvCell('+91 98'), `"'+91 98"`);
  assert.equal(csvCell('-5'), `"'-5"`);
  assert.equal(csvCell('@SUM'), `"'@SUM"`);
  assert.equal(csvCell(-250), '-250');
  assert.equal(csvCell('Zomato'), '"Zomato"');
  assert.equal(csvCell(null), '""');
});

test('only http(s) URLs survive', () => {
  assert.equal(safeHttpUrl('https://mail.google.com/x'), 'https://mail.google.com/x');
  assert.equal(safeHttpUrl('javascript:alert(1)'), null);
  assert.equal(safeHttpUrl('data:text/html,hi'), null);
  assert.equal(safeHttpUrl('not a url'), null);
  assert.equal(safeHttpUrl(''), null);
});

// ── Cache ────────────────────────────────────────────────

test('cached shares one request, and a write clears it', async () => {
  let calls = 0;
  const read = () => cached('t:x', async () => { calls++; return calls; });
  assert.equal(await read(), 1);
  assert.equal(await read(), 1);
  const write = invalidating('t', async () => 'ok');
  await write();
  assert.equal(await read(), 2);
  invalidate();
  assert.equal(await read(), 3);
});

test('a failed read is not remembered', async () => {
  let calls = 0;
  const read = () => cached('t:fail', async () => { calls++; if (calls === 1) throw new Error('blip'); return 'ok'; });
  await assert.rejects(read());
  await new Promise(r => setTimeout(r, 0));
  assert.equal(await read(), 'ok');
  invalidate();
});

// ── Icons ────────────────────────────────────────────────

test('every fa- icon used in src/ is in the generated subset', () => {
  const css = readFileSync(SUBSET_PATH, 'utf8');
  const { found } = buildSubset();
  const missing = [...usedIconNames()].filter(n => !NOT_ICONS.has(n) && !found.has(n));
  assert.deepEqual(missing, [], `icons used but not in Font Awesome: ${missing.join(', ')}`);
  assert.equal(css, buildSubset().css, 'src/icons.css is stale: run node scripts/fa-subset.mjs');
});
