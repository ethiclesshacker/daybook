import { moneyFlow } from './summary.js';

// @ts-check
/** Apply only explicitly edited fields; preserve receipt IDs, items and other facts. */
export function correctFacts(original, edits) {
  if (!original || Array.isArray(original) || typeof original !== 'object') {
    throw new Error('Facts must be a JSON object.');
  }
  const data = { ...original };
  for (const [key, raw] of Object.entries(edits)) {
    if (!['amount', 'currency', 'merchant', 'restaurant', 'category'].includes(key)) continue;
    const value = String(raw ?? '').trim();
    if (!value) { delete data[key]; continue; }
    if (key === 'amount') {
      const amount = Number(value);
      if (!Number.isFinite(amount) || amount < 0) throw new Error('Enter a non-negative amount.');
      data[key] = amount;
    } else if (key === 'currency') {
      if (!/^[a-z]{3}$/i.test(value)) throw new Error('Use a three-letter currency code, such as INR.');
      data[key] = value.toUpperCase();
    } else data[key] = value;
  }
  return data;
}

export function reviewFilters(filters) {
  const allowed = ['needs_review', 'inferred'];
  return { ...filters, statuses: filters.statuses?.length
    ? filters.statuses.filter(s => allowed.includes(s)) : allowed };
}

/**
 * "Does this count against my budget?" is the question an edit is usually
 * answering, and type, subtype and category each hold part of the answer. These
 * are the three answers, and what each one has to write so that moneyFlow() agrees.
 *
 * Work is not here: it is ticked on the card's row in Points, which is what the
 * dashboard takes off the budget.
 */
export const COUNTS_AS = [
  { id: 'spend', label: 'Spending' },
  { id: 'inflow', label: 'Income' },
  { id: 'moved', label: 'Moved between my accounts' },
];

/** Which answer an event currently gives. */
export function countsAs(event) {
  return { spend: 'spend', inflow: 'inflow' }[moneyFlow(event)] || 'moved';
}

/**
 * What to change so an event gives this answer. `category: null` means work it
 * out again, since a category like "transfer" would be wrong after the change.
 */
export function countsAsChanges(event, choice) {
  if (choice === 'moved') return { type: 'transfer', subtype: 'self_transfer', category: 'transfer' };
  if (choice === 'inflow') {
    return { type: 'transfer', subtype: moneyFlow(event) === 'inflow' ? event.subtype : 'credit', direction: 'credit', category: null };
  }
  return { type: 'purchase', subtype: 'payment', direction: 'debit', category: null };
}
