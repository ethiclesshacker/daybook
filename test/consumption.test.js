import { test } from 'node:test';
import assert from 'node:assert/strict';
import { eatenAt, eatenItems, eventNutrition, summarise } from '../src/ledger/nutrition.js';
import { correctFacts, reviewFilters } from '../src/ledger/corrections.js';
import { readingLabel, rollingMean } from '../src/health/summary.js';
import { parseRoute } from '../src/routes.js';

const dict = new Map([['dosa', { kcal: 600, protein_g: 12 }]]);
const receipt = { occurred_at: '2026-10-23T10:00:00Z', subtype: 'food_delivery',
  status: 'confirmed', data: { amount: 300, items: [{ name: 'Dosa', qty: 2 }] } };

test('purchases and dismissed / uneaten food never enter intake or its coverage denominator', () => {
  const events = [receipt, { ...receipt, subtype: 'groceries' },
    { ...receipt, status: 'dismissed' }, { ...receipt, data: { ...receipt.data, not_eaten: true } }];
  const total = summarise(events, dict, { dateOf: x => x.slice(0, 10) });
  assert.equal(total.kcal, 1200);
  assert.equal(total.priced, 1);
  assert.equal(total.coverage, 1);
  assert.equal(eventNutrition(events[1], dict).kcal, null);
});

test('half servings and eating dates change intake without rewriting a receipt', () => {
  const changed = { ...receipt, data: { ...receipt.data,
    eaten_at: '2026-10-24T12:00:00Z', eaten_items: [{ name: 'Dosa', qty: 0.5 }] } };
  assert.equal(eventNutrition(changed, dict).kcal, 300);
  assert.equal(eatenItems(changed)[0].qty, 0.5);
  assert.equal(eatenAt(changed), '2026-10-24T12:00:00Z');
  assert.deepEqual(changed.data.items, [{ name: 'Dosa', qty: 2 }]);
  assert.equal(changed.data.amount, 300);
  assert.equal(changed.occurred_at, receipt.occurred_at);
  assert.equal(summarise([changed], dict, { dateOf: x => x.slice(0, 10) }).days[0].day, '2026-10-24');
});

test('explicit empty intake does not fall back to the purchase basket', () => {
  assert.equal(eventNutrition({ ...receipt, data: { ...receipt.data, eaten_items: [] } }, dict).kcal, null);
});

test('stated zero is retained while null calories remain unresolved', () => {
  const meal = data => ({ ...receipt, data });
  assert.equal(eventNutrition(meal({ items: [{ name: 'Water', kcal: 0 }] }), dict).kcal, 0);
  assert.equal(eventNutrition(meal({ items: [{ name: 'Unknown', calories: null }] }), dict).kcal, null);
});

test('typed corrections preserve unknown facts and do not mutate their input', () => {
  const original = { ...receipt.data, order_id: 'order-1', nested: { evidence: 'receipt' } };
  const corrected = correctFacts(original, { amount: '249.50', currency: 'eur', merchant: 'Cafe' });
  assert.equal(corrected.amount, 249.5);
  assert.equal(corrected.currency, 'EUR');
  assert.equal(corrected.order_id, 'order-1');
  assert.deepEqual(corrected.items, original.items);
  assert.deepEqual(corrected.nested, original.nested);
  assert.equal(original.amount, 300);
  assert.equal(correctFacts(original, { amount: '' }).amount, undefined);
  assert.throws(() => correctFacts(original, { amount: '-1' }));
  assert.throws(() => correctFacts(original, { currency: 'rupees' }));
  assert.throws(() => correctFacts([], {}));
});

test('review filtering retains search and date constraints and cannot include confirmed records', () => {
  const filters = { query: 'cafe', from: '2026-10-01', statuses: [] };
  assert.deepEqual(reviewFilters(filters), { ...filters, statuses: ['needs_review', 'inferred'] });
  assert.deepEqual(reviewFilters({ statuses: ['confirmed'] }).statuses, []);
  assert.deepEqual(reviewFilters({ statuses: ['inferred'] }).statuses, ['inferred']);
});

test('deep links identify the requested review queue and safely preserve search parameters', () => {
  assert.equal(parseRoute('#ledger?tab=review').id, 'ledger');
  assert.equal(parseRoute('#ledger?tab=review').params.get('tab'), 'review');
  assert.equal(parseRoute('#dishes?query=Dosa%20%26%20curd').params.get('query'), 'Dosa & curd');
  assert.equal(parseRoute('#unknown').id, 'dashboard');
});

test('old sleep is dated rather than called last night', () => {
  assert.equal(readingLabel('2026-10-19', '2026-10-24', { sleep: true }), 'Recorded 19 Oct');
  assert.equal(readingLabel('2026-10-24', '2026-10-24', { sleep: true }), 'Last night');
});

test('weight averages use calendar windows and leave unrecorded days empty', () => {
  const days = [ { weight: 90 }, {}, { weight: 88 }, {}, {}, {}, {}, { weight: 86 } ];
  const mean = rollingMean(days, 'weight');
  assert.equal(mean[0], 90);
  assert.equal(mean[1], null);
  assert.equal(mean[2], 89);
  assert.equal(mean[7], 87); // first day's reading has left the seven-day window
});
