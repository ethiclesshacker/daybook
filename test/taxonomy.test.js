// Run with: npm test
// The shared vocabulary (src/ledger/taxonomy.js) and its SQL mirror, currency
// normalisation, and the outlier rule. Every case is something the ledger
// actually held on 2026-10-18.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import {
  TAXONOMY, SUBTYPES, SUBTYPE_ALIASES, CATEGORIES, CATEGORY_SYNONYMS, NOTE_CATEGORIES, SUBTYPE_CATEGORIES,
  TYPE_CATEGORIES, MERCHANT_CATEGORIES, REVIEW_RULES, BUDGET_BUCKETS,
  canonicalCategory, canonicalSubtype, deriveCategory, budgetBucket, merchantCategory, noteCategory, reviewReason,
} from '../src/ledger/taxonomy.js';
import { normalizeName, normalizeCurrency, isCashCurrency, amountInr, CURRENCY_ALIASES } from '../src/ledger/normalize.js';
import { buildDigest, moneyFlow, spendCategory } from '../src/ledger/summary.js';
import { extractDeterministic, isCardBillPayment } from '../src/ledger/email.js';

const migration = name => readFileSync(new URL(`../supabase/migrations/${name}`, import.meta.url), 'utf8');

// ── The SQL mirror ─────────────────────────────────────

test('ledger_taxonomy() in 0020 is TAXONOMY, verbatim', () => {
  const sql = migration('0020_taxonomy.sql');
  const literal = sql.match(/select \$taxonomy\$([\s\S]*?)\$taxonomy\$/)?.[1];
  assert.ok(literal, 'no $taxonomy$ literal in 0020_taxonomy.sql');
  assert.deepEqual(JSON.parse(literal), TAXONOMY,
    'taxonomy.js changed without 0020: paste JSON.stringify(TAXONOMY) into ledger_taxonomy() and re-apply');
});

test('every mapping in the taxonomy lands on something that exists', () => {
  const cats = new Set(CATEGORIES.map(c => c.id));
  const buckets = new Set(BUDGET_BUCKETS.map(b => b.id));
  for (const [type, aliases] of Object.entries(SUBTYPE_ALIASES)) {
    for (const [from, to] of Object.entries(aliases)) {
      assert.ok((SUBTYPES[type] || []).includes(to), `${type}/${from} → ${to} is not canonical`);
    }
  }
  for (const [k, v] of Object.entries({ ...CATEGORY_SYNONYMS, ...NOTE_CATEGORIES, ...SUBTYPE_CATEGORIES, ...TYPE_CATEGORIES })) {
    assert.ok(cats.has(v), `${k} → ${v}`);
  }
  for (const [run, v] of MERCHANT_CATEGORIES) {
    assert.ok(cats.has(v), `${run} → ${v}`);
    assert.equal(normalizeName(run), run, `merchant pattern "${run}" is not in normalized form`);
  }
  for (const c of CATEGORIES) assert.ok(c.bucket === null || buckets.has(c.bucket), c.id);
  for (const c of REVIEW_RULES.large_ok_categories) assert.ok(cats.has(c), c);
  // Each subtype's check constraint: ^[a-z][a-z0-9_]{1,47}$
  for (const list of Object.values(SUBTYPES)) for (const s of list) assert.match(s, /^[a-z][a-z0-9_]{1,47}$/);
});

test('the six budget buckets are the budget', () => {
  assert.deepEqual(BUDGET_BUCKETS.map(b => b.id), ['investments', 'rent', 'food', 'fuel', 'sinking', 'lifestyle']);
  assert.equal(budgetBucket('dining'), 'food');
  assert.equal(budgetBucket('groceries'), 'food');
  assert.equal(budgetBucket('travel'), 'sinking');
  assert.equal(budgetBucket('subscriptions'), 'lifestyle');
  assert.equal(budgetBucket('work'), null);
  assert.equal(budgetBucket('income'), null);
});

// ── Subtypes ───────────────────────────────────────────

test('the model\'s ways of saying "a card was charged" are one subtype', () => {
  for (const s of ['card_payment', 'card_purchase', 'online_card_purchase', 'credit_card', 'card_transaction']) {
    assert.equal(canonicalSubtype('purchase', s), 'card_transaction', s);
  }
  // …but under a transfer, a card payment is paying the card's bill.
  assert.equal(canonicalSubtype('transfer', 'card_payment'), 'card_bill_payment');
  assert.equal(canonicalSubtype('transfer', 'credit_card_bill_repayment'), 'card_bill_payment');
  assert.equal(canonicalSubtype('transfer', 'interest_credit'), 'interest');
  assert.equal(canonicalSubtype('purchase', 'amazon_order'), 'order');
  assert.equal(canonicalSubtype('food', 'restaurant_payment'), 'restaurant');
  assert.equal(canonicalSubtype('travel', 'flight_booking'), 'flight');
  // Unknown values pass through slugged: types stay open.
  assert.equal(canonicalSubtype('purchase', 'Return'), 'return');
  assert.equal(canonicalSubtype('purchase', null), null);
});

// ── Categories ─────────────────────────────────────────

test('canonicalCategory folds the spellings the ledger held', () => {
  assert.equal(canonicalCategory('food'), 'dining');
  assert.equal(canonicalCategory('cafe'), 'dining');
  assert.equal(canonicalCategory('food_delivery'), 'food_delivery');
  assert.equal(canonicalCategory('software subscription'), 'subscriptions');
  assert.equal(canonicalCategory('Air travel'), 'travel');
  assert.equal(canonicalCategory('Men Health Checkup Premium with Smart Report'), 'medical');
  assert.equal(canonicalCategory('gift card'), 'stored_value');
  assert.equal(canonicalCategory('purchase'), 'shopping');
  assert.equal(canonicalCategory('bill payment'), 'transfer');
  assert.equal(canonicalCategory(''), null);
  assert.equal(canonicalCategory('pets'), null);
});

test('deriveCategory: your note, then the type, the source, the merchant, the default', () => {
  // A note's type word is yours and wins.
  assert.equal(deriveCategory({ type: 'purchase', subtype: 'card_transaction', description: 'Parking: Forum mall', merchant: 'forum mall managements' }), 'vehicle');
  assert.equal(deriveCategory({ type: 'purchase', subtype: 'card_transaction', description: 'Food: lunch | Saloni' }), 'dining');
  // A pair that settles it.
  assert.equal(deriveCategory({ type: 'travel', subtype: 'cab' }), 'transport');
  assert.equal(deriveCategory({ type: 'food', subtype: 'food_delivery', stated: 'groceries' }), 'food_delivery');
  // The old subtype read as a category — but only when it IS a category word.
  assert.equal(deriveCategory({ type: 'purchase', subtype: 'order', rawSubtype: 'clothing' }), 'clothing');
  assert.equal(deriveCategory({ type: 'subscription', subtype: 'renewal', rawSubtype: 'online_card_purchase', stated: 'software subscription' }), 'subscriptions');
  // The merchant, when the alert said nothing else.
  assert.equal(deriveCategory({ type: 'purchase', subtype: 'card_transaction', merchant: 'makemytripindiapvtl', hasAmount: true }), 'travel');
  assert.equal(deriveCategory({ type: 'purchase', subtype: 'card_transaction', merchant: 'district dining cybs', hasAmount: true }), 'dining');
  assert.equal(deriveCategory({ type: 'purchase', subtype: 'card_transaction', merchant: 'district', hasAmount: true }), 'entertainment');
  // Nothing known: "other", never the type's name.
  assert.equal(deriveCategory({ type: 'purchase', subtype: 'card_transaction', hasAmount: true }), 'other');
  // Transfers: own pockets, income, or what a refund refunds.
  assert.equal(deriveCategory({ type: 'transfer', subtype: 'card_bill_payment' }), 'transfer');
  assert.equal(deriveCategory({ type: 'transfer', subtype: 'cashback' }), 'income');
  assert.equal(deriveCategory({ type: 'transfer', subtype: 'refund', stated: 'food_delivery' }), 'food_delivery');
  assert.equal(deriveCategory({ type: 'transfer', subtype: 'insurance_premium' }), 'insurance');
  // Not about money: no category.
  assert.equal(deriveCategory({ type: 'meeting', subtype: 'call' }), null);
});

test('merchantCategory matches whole tokens, specific before general', () => {
  assert.equal(merchantCategory('amazon pay'), 'stored_value');
  assert.equal(merchantCategory('amazon'), 'shopping');
  assert.equal(merchantCategory('uber india systems'), 'transport');
  assert.equal(merchantCategory('suberb'), null);
  assert.equal(noteCategory('Telecom: Jio'), 'utilities');
  assert.equal(noteCategory('morning walk'), null);
});

test('spendCategory reads the stored category before deriving one', () => {
  assert.equal(spendCategory({ type: 'purchase', data: { category: 'Shopping' } }), 'shopping');
  assert.equal(spendCategory({ type: 'purchase', subtype: 'card_transaction', data: { amount: 10 } }), 'other');
  assert.equal(spendCategory({ type: 'food', subtype: 'card_transaction', data: { amount: 10 } }), 'dining');
});

// ── Names ──────────────────────────────────────────────

test('Kapoor\'s Cafe, KAPOOR S CAFE and Kapoors Cafe are one name', () => {
  assert.equal(normalizeName("Kapoor's Cafe"), 'kapoors cafe');
  assert.equal(normalizeName('KAPOOR S CAFE'), 'kapoors cafe');
  assert.equal(normalizeName('Kapoors Cafe'), 'kapoors cafe');
  assert.equal(normalizeName("Domino's"), 'dominos');
  assert.equal(normalizeName('Neeman’S'), 'neemans');
  // A lone initial is not an apostrophe's leftover.
  assert.equal(normalizeName('A S Rao'), 'a s rao');
  assert.equal(normalizeName('AMAZON PAY INDIA PRIVATE LIMITED'), 'amazon pay');
});

test('ledger_normalize_name in 0020 does what normalizeName does', () => {
  const fn = migration('0020_taxonomy.sql');
  const body = fn.slice(fn.indexOf('function public.ledger_normalize_name'));
  assert.match(body, /\[''’‘`\]/, 'apostrophes dropped');
  assert.match(body, /\(\[a-z\]\{2,\}\) s\(\?= \)/, 'lone s re-joined');
  const js = readFileSync(new URL('../src/ledger/normalize.js', import.meta.url), 'utf8');
  assert.match(js, /\(\[a-z\]\{2,\}\) s\(\?= \)/);
});

// ── Currency ───────────────────────────────────────────

test('normalizeCurrency: ISO 4217, upper-case; points are not money', () => {
  assert.equal(normalizeCurrency('$'), 'USD');
  assert.equal(normalizeCurrency('usd'), 'USD');
  assert.equal(normalizeCurrency('₹'), 'INR');
  assert.equal(normalizeCurrency('Rs.'), 'INR');
  assert.equal(normalizeCurrency('Rs'), 'INR');
  assert.equal(normalizeCurrency('eur'), 'EUR');
  assert.equal(normalizeCurrency('NeuCoin'), 'NEUCOIN');
  assert.equal(normalizeCurrency('NeuCoins'), 'NEUCOIN');
  assert.equal(normalizeCurrency(''), null);
  assert.equal(normalizeCurrency(null), null);
  assert.ok(isCashCurrency('USD'));
  assert.ok(isCashCurrency(null));
  assert.ok(!isCashCurrency('NEUCOIN'));
});

test('ledger_normalize_currency in 0019 knows every spelling normalizeCurrency does', () => {
  const sql = migration('0019_currency.sql');
  for (const [alias, code] of Object.entries(CURRENCY_ALIASES)) {
    if (alias.length === 3 && alias.toUpperCase() === code) continue;   // the ISO rule covers it
    assert.ok(sql.includes(`'${alias}'`), `${alias} → ${code} missing from 0019`);
  }
});

test('amountInr: the API\'s amount_inr wins; plain rupees pass; anything else is unknown', () => {
  assert.equal(amountInr({ amount_inr: 9544.76, data: { amount: 100, currency: 'USD' } }), 9544.76);
  assert.equal(amountInr({ amount_inr: null, data: { amount: 14.24, currency: 'NEUCOIN' } }), null);
  assert.equal(amountInr({ data: { amount: 450 } }), 450);
  assert.equal(amountInr({ data: { amount: 450, currency: 'Rs' } }), 450);
  assert.equal(amountInr({ data: { amount: 100, currency: 'USD' } }), null);
  assert.equal(amountInr({ data: {} }), null);
});

test('a digest sums rupees: $100 is not ₹100, and NeuCoins are not income', () => {
  const at = '2026-08-04T06:00:00Z';
  const digest = buildDigest([
    { id: '1', type: 'subscription', subtype: 'renewal', occurred_at: at, title: 'Claude', status: 'inferred',
      data: { amount: 100, currency: 'USD', category: 'subscriptions' }, amount_inr: 9544.76 },
    { id: '2', type: 'transfer', subtype: 'reward', occurred_at: at, title: 'NeuCoins', status: 'confirmed',
      data: { amount: 14.24, currency: 'NEUCOIN' }, amount_inr: null },
    { id: '3', type: 'food', subtype: 'food_delivery', occurred_at: at, title: 'Zomato', status: 'confirmed',
      data: { amount: 300, category: 'food_delivery' } },
  ], { timeZone: 'Asia/Kolkata' });
  assert.equal(digest.spend.total, 9845);
  assert.equal(digest.inflow.total, 0);
  assert.deepEqual(digest.spend.by_bucket, { subscriptions: 9545, food_delivery: 300 });
});

test('moneyFlow knows the canonical transfer subtypes', () => {
  assert.equal(moneyFlow({ type: 'transfer', subtype: 'bank_transfer', data: { direction: 'debit' } }), null);
  assert.equal(moneyFlow({ type: 'transfer', subtype: 'interest', data: {} }), 'inflow');
  assert.equal(moneyFlow({ type: 'transfer', subtype: 'salary', data: {} }), 'inflow');
});

test('ledger_money_flow in 0021 lists the same subtypes as moneyFlow', () => {
  const sql = migration('0021_events_write_path.sql');
  const fn = sql.slice(sql.indexOf('function public.ledger_money_flow'), sql.indexOf('$$;', sql.indexOf('function public.ledger_money_flow')));
  for (const s of ['self_transfer', 'card_bill_payment', 'bank_transfer', 'credit_card_bill_repayment', 'scheduled_bill_payment',
                   'payment', 'insurance_premium', 'credit', 'salary', 'refund', 'interest', 'interest_credit', 'dividend', 'cashback', 'reward']) {
    assert.ok(fn.includes(`'${s}'`), s);
  }
});

// ── The outlier rule ───────────────────────────────────

test('reviewReason: a big spend outside the big categories waits for a person', () => {
  const base = { sourceType: 'email', flow: 'spend' };
  // The real one: ₹1,60,000 "subscription" off a loyalty mailer.
  assert.equal(reviewReason({ ...base, amountInr: 160000, category: 'subscriptions', type: 'subscription' }), 'large_subscription');
  assert.equal(reviewReason({ ...base, amountInr: 9544.76, category: 'subscriptions', type: 'subscription' }), 'large_subscription');
  assert.equal(reviewReason({ ...base, amountInr: 4999, category: 'subscriptions', type: 'subscription' }), null);
  assert.equal(reviewReason({ ...base, amountInr: 128173, category: 'shopping', type: 'purchase' }), 'large_spend');
  assert.equal(reviewReason({ ...base, amountInr: 25000, category: 'shopping', type: 'purchase' }), null);
  // Large is normal here.
  assert.equal(reviewReason({ ...base, amountInr: 42416, category: 'travel', type: 'purchase' }), null);
  assert.equal(reviewReason({ ...base, amountInr: 204000, category: 'vehicle', type: 'purchase' }), null);
  assert.equal(reviewReason({ ...base, amountInr: 45000, category: 'rent', type: 'purchase' }), null);
  // Not spend, not rupees, or yours: never flagged.
  assert.equal(reviewReason({ ...base, flow: null, amountInr: 297769, category: 'transfer', type: 'transfer' }), null);
  assert.equal(reviewReason({ ...base, amountInr: null, category: 'shopping', type: 'purchase' }), null);
  assert.equal(reviewReason({ sourceType: 'manual', flow: 'spend', amountInr: 90000, category: 'shopping', type: 'purchase' }), null);
  assert.equal(reviewReason({ sourceType: 'hermes', flow: 'spend', amountInr: 90000, category: 'other', type: 'purchase' }), null);
});

test('ledger_review_reason in 0021 reads its thresholds from the taxonomy', () => {
  const sql = migration('0021_events_write_path.sql');
  assert.match(sql, /'large_subscription_inr'/);
  assert.match(sql, /'large_spend_inr'/);
  assert.match(sql, /'large_ok_categories'/);
  assert.equal(TAXONOMY.review.large_spend_inr, 25000);
  assert.equal(TAXONOMY.review.large_subscription_inr, 5000);
});

// ── Rules that produced the outliers ───────────────────

const SELF = { selfAddresses: ['me@example.com'], timeZone: 'Asia/Kolkata' };
const to = [{ address: 'me@example.com' }];

test('a loyalty tier upgrade is not a ₹1,60,000 subscription', () => {
  const result = extractDeterministic({
    subject: 'Congratulations! Your Club ITC Membership X12AB34 Has Been Upgraded to Silver Tier.',
    date: new Date('2026-09-30T05:15:44Z'),
    from: { name: 'Club ITC', address: 'no-reply@t.clubitc.itc-hotels.net' }, to,
    text: 'We welcome you to the Silver Tier of Club ITC. Spend ₹1,60,000 to reach Gold Tier.',
  }, SELF);
  assert.ok(!result.extractions?.some(e => e.type === 'subscription'), JSON.stringify(result.extractions));
});

test('paying a card bill is a transfer, not a purchase', () => {
  assert.ok(isCardBillPayment('Great news! We received your credit card bill payment.'));
  assert.ok(isCardBillPayment('Repayment successful! We’ve received your payment of ₹25,778.68 towards your Scapia Federal Credit Card.'));
  assert.ok(isCardBillPayment('Rs.5583.89 is debited from your HDFC Bank Debit Card ending 1234 at CREDCCBILLPAYMENT'));
  assert.ok(isCardBillPayment('debited', ['cred.club@axisb']));
  assert.ok(!isCardBillPayment('bill payment of Rs. 25778.68 via SmartPay has been declined'));
  assert.ok(!isCardBillPayment('Your bill payment at Kapoor\'s Cafe'));
  assert.ok(!isCardBillPayment('used for INR 140.00 at STARBUCKS', ['STARBUCKS']));

  const scapia = extractDeterministic({
    subject: 'Bill payment successful!', date: new Date('2026-05-21T03:52:00Z'),
    from: { address: 'alerts@scapia.cards' }, to,
    text: 'Great news! We received your credit card bill payment. Card: HSBC Bank XXXX-1234 Amount Paid: ₹12,345.67 Paid Via: upi. Your payment of ₹12,345.67 to HSBC Bank is successful.',
  }, SELF);
  for (const e of scapia.extractions || []) {
    assert.equal(e.type, 'transfer', JSON.stringify(e));
    assert.equal(e.subtype, 'card_bill_payment');
  }
});
