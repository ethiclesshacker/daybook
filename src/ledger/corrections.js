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
