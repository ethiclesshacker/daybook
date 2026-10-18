// @ts-check
// ======================================================
// Event taxonomy.
//
// The database treats `type` as open text and registers anything it has not
// seen before (see ledger_event_types in 0003), so this file is a catalogue for
// labelling and filtering — not a gate. A connector that invents
// `type: 'concert'` will store fine; it just shows up unlabelled until someone
// adds it here.
//
// Everything in this module is pure. It is imported by the browser bundle, by
// the ingestion jobs under ledger/, and by the tests.
// ======================================================

import { DEFAULT_TIME_ZONE, localClock } from './dates.js';

export const EVENT_TYPES = [
  { id: 'activity',      label: 'Activity',      icon: 'fa-person-walking',  color: '#38bdf8' },
  { id: 'purchase',      label: 'Purchase',      icon: 'fa-bag-shopping',    color: '#a78bfa' },
  { id: 'food',          label: 'Food',          icon: 'fa-utensils',        color: '#fb923c' },
  { id: 'travel',        label: 'Travel',        icon: 'fa-plane',           color: '#2dd4bf' },
  { id: 'work',          label: 'Work',          icon: 'fa-briefcase',       color: '#94a3b8' },
  { id: 'meeting',       label: 'Meeting',       icon: 'fa-users',           color: '#38bdf8' },
  { id: 'communication', label: 'Communication', icon: 'fa-comments',        color: '#94a3b8' },
  { id: 'health',        label: 'Health',        icon: 'fa-heart-pulse',     color: '#f472b6' },
  { id: 'entertainment', label: 'Entertainment', icon: 'fa-film',            color: '#a78bfa' },
  { id: 'subscription',  label: 'Subscription',  icon: 'fa-arrows-rotate',   color: '#f59e0b' },
  { id: 'delivery',      label: 'Delivery',      icon: 'fa-truck',           color: '#f59e0b' },
  { id: 'appointment',   label: 'Appointment',   icon: 'fa-calendar-check',  color: '#38bdf8' },
  { id: 'note',          label: 'Note',          icon: 'fa-note-sticky',     color: '#94a3b8' },
  { id: 'task',          label: 'Task',          icon: 'fa-circle-check',    color: '#10b981' },
  { id: 'milestone',     label: 'Milestone',     icon: 'fa-flag',            color: '#10b981' },
  { id: 'location',      label: 'Location',      icon: 'fa-location-dot',    color: '#2dd4bf' },
  // Money moving without anything being bought: refunds, credits, salary, a
  // card bill being paid. Separate from `purchase` so that every "what did I
  // spend" answer is correct without having to remember to exclude them.
  { id: 'transfer',      label: 'Transfer',      icon: 'fa-right-left',      color: '#10b981' },
  // Something given or received without money changing hands on your side.
  // Not a purchase: a camera someone gave you must never appear in "what did I
  // spend", and not a note either — it names a thing and a person.
  { id: 'gift',          label: 'Gift',          icon: 'fa-gift',            color: '#f472b6' },
  { id: 'other',         label: 'Other',         icon: 'fa-circle-dot',      color: '#94a3b8' },
];

const TYPE_INDEX = Object.fromEntries(EVENT_TYPES.map(t => [t.id, t]));

export function typeMeta(id) {
  return TYPE_INDEX[id] || { id, label: titleCase(id), icon: 'fa-circle-dot', color: '#94a3b8' };
}

// ── Subtypes and spend categories ──────────────────────
//
// Everything from here to the review rule is DATA, collected into TAXONOMY at
// the bottom, and the SQL side reads the very same object:
// public.ledger_taxonomy() in 0020_taxonomy.sql returns this JSON verbatim,
// and test/taxonomy.test.js fails if the two ever differ. The before-write
// trigger on events uses it to land every write canonical — email rules, the
// model, Hermes and the UI alike — so nothing downstream has to know that a
// model once said "online_card_purchase".
//
// The subtype says HOW an event was seen or WHAT KIND of thing it is within
// its type; the category says what the money was FOR. "card_transaction" is
// how you paid, never what you bought, which is why a purchase seen only as a
// card alert carries its meaning in `data.category` (from the merchant, your
// note, or what the merchant's other events were) and not in its subtype.

/** Canonical subtypes per type. The first entry is not a default; order is display order. */
export const SUBTYPES = {
  purchase:      ['card_transaction', 'upi_payment', 'payment', 'order', 'bill', 'gift_card'],
  food:          ['food_delivery', 'restaurant', 'meal', 'groceries', 'card_transaction', 'upi_payment'],
  travel:        ['flight', 'train', 'bus', 'cab', 'hotel', 'trip', 'toll', 'insurance'],
  subscription:  ['renewal', 'bill', 'invoice', 'signup', 'trial', 'cancellation'],
  transfer:      ['self_transfer', 'card_bill_payment', 'bank_transfer', 'payment', 'insurance_premium',
                  'credit', 'salary', 'refund', 'interest', 'dividend', 'cashback', 'reward'],
  entertainment: ['movie', 'event', 'concert', 'streaming', 'game', 'book'],
  delivery:      ['package', 'order_shipped', 'order_delivered'],
  health:        ['measurement', 'workout', 'sleep', 'symptom', 'medication', 'appointment', 'lab_test', 'insurance'],
  activity:      ['workout', 'errand', 'visit'],
  appointment:   ['medical', 'personal', 'service', 'restaurant_reservation'],
  meeting:       ['calendar_event', 'call', 'one_on_one', 'interview'],
  work:          ['meeting', 'school_visit', 'visit', 'project_activity', 'work_email', 'work_task', 'deadline'],
  communication: ['email', 'message', 'call'],
  note:          ['observation', 'idea', 'reminder'],
  milestone:     ['personal', 'work', 'financial'],
  location:      ['visit', 'checkin'],
  gift:          ['received', 'given'],
  other:         ['insurance', 'reward'],
};

/**
 * Subtypes that have been seen in the wild, mapped to the canonical one.
 * Per type, because the same word means different things under different
 * types: a `card_payment` purchase was paid by card, a `card_payment` transfer
 * paid the card's bill. `*` applies to any type that has no entry of its own.
 */
export const SUBTYPE_ALIASES = {
  purchase: {
    card_payment: 'card_transaction', card_purchase: 'card_transaction', online_card_purchase: 'card_transaction',
    credit_card: 'card_transaction', debit_card: 'card_transaction', pos: 'card_transaction',
    upi: 'upi_payment', wallet_payment: 'upi_payment',
    amazon_order: 'order', online_order: 'order', online_purchase: 'order',
    restaurant_payment: 'payment', grocery_purchase: 'order', groceries: 'order', clothing: 'order', electronics: 'order',
    gift: 'order', subscription_payment: 'payment', fuel: 'payment', pharmacy: 'order', retail: 'payment',
    observation: 'payment', insurance_premium: 'bill', bill_payment: 'bill', invoice: 'bill',
    gift_voucher: 'gift_card', voucher: 'gift_card',
  },
  food: {
    restaurant_payment: 'restaurant', restaurant_bill: 'restaurant', dine_in: 'restaurant', dineout: 'restaurant',
    grocery_purchase: 'groceries', grocery: 'groceries', delivery: 'food_delivery', snack: 'meal', beverage: 'meal',
    card_payment: 'card_transaction', card_purchase: 'card_transaction',
  },
  travel: {
    flight_booking: 'flight', flight_departure: 'flight', flight_ticket: 'flight',
    train_ticket_booking: 'train', train_ticket: 'train', bus_ticket: 'bus',
    ride: 'cab', taxi: 'cab', hotel_booking: 'hotel', location: 'trip',
    travel_insurance: 'insurance',
  },
  subscription: {
    bill_payment: 'bill', card_purchase: 'renewal', card_payment: 'renewal', online_card_purchase: 'renewal',
    payment: 'renewal', insurance: 'renewal', membership: 'renewal',
  },
  transfer: {
    credit_card_bill_repayment: 'card_bill_payment', scheduled_bill_payment: 'card_bill_payment',
    card_payment: 'card_bill_payment', credit_card_payment: 'card_bill_payment', card_repayment: 'card_bill_payment',
    interest_credit: 'interest', bank_interest: 'interest', loyalty_reward: 'reward', rewards: 'reward',
    neft: 'bank_transfer', imps: 'bank_transfer',
  },
  entertainment: { cinema_booking: 'movie', movie_ticket: 'movie' },
  delivery: { package_delivery: 'package', shipped: 'order_shipped', delivered: 'order_delivered' },
  health: { lab_test_booking_request: 'lab_test', travel_insurance: 'insurance', activity: 'workout' },
  activity: { attempted_workout: 'workout' },
  note: { health_metric: 'observation' },
  gift: { food_delivery: 'received' },
  other: { insurance_issuance: 'insurance', loyalty_reward: 'reward' },
};

/** The six buckets of the monthly budget (memory: monthly-budget). */
export const BUDGET_BUCKETS = [
  { id: 'investments', label: 'Investments' },
  { id: 'rent',        label: 'Rent' },
  { id: 'food',        label: 'Food + groceries' },
  { id: 'fuel',        label: 'Fuel' },
  { id: 'sinking',     label: 'Sinking fund' },
  { id: 'lifestyle',   label: 'Lifestyle' },
];

/**
 * What money was for. `bucket` is the budget line it counts against; null
 * means it sits outside the budget on purpose — work spend Ei reimburses,
 * money parked in a wallet or a voucher (counted when it buys something), and
 * the two non-spend categories.
 */
export const CATEGORIES = [
  { id: 'dining',        label: 'Dining out',      bucket: 'food' },
  { id: 'food_delivery', label: 'Food delivery',   bucket: 'food' },
  { id: 'groceries',     label: 'Groceries',       bucket: 'food' },
  { id: 'rent',          label: 'Rent',            bucket: 'rent' },
  { id: 'fuel',          label: 'Fuel',            bucket: 'fuel' },
  { id: 'investments',   label: 'Investments',     bucket: 'investments' },
  { id: 'travel',        label: 'Travel',          bucket: 'sinking' },
  { id: 'insurance',     label: 'Insurance',       bucket: 'sinking' },
  { id: 'vehicle',       label: 'Vehicle',         bucket: 'sinking' },
  { id: 'medical',       label: 'Medical',         bucket: 'sinking' },
  { id: 'gifts',         label: 'Gifts',           bucket: 'sinking' },
  { id: 'tax',           label: 'Tax',             bucket: 'sinking' },
  { id: 'fees',          label: 'Fees & charges',  bucket: 'sinking' },
  { id: 'shopping',      label: 'Shopping',        bucket: 'lifestyle' },
  { id: 'clothing',      label: 'Clothing',        bucket: 'lifestyle' },
  { id: 'electronics',   label: 'Electronics',     bucket: 'lifestyle' },
  { id: 'entertainment', label: 'Entertainment',   bucket: 'lifestyle' },
  { id: 'subscriptions', label: 'Subscriptions',   bucket: 'lifestyle' },
  { id: 'utilities',     label: 'Phone & utilities', bucket: 'lifestyle' },
  { id: 'transport',     label: 'Local transport', bucket: 'lifestyle' },
  { id: 'personal_care', label: 'Personal care & laundry', bucket: 'lifestyle' },
  { id: 'education',     label: 'Education',       bucket: 'lifestyle' },
  { id: 'home',          label: 'Home',            bucket: 'lifestyle' },
  { id: 'work',          label: 'Work (reimbursable)', bucket: null },
  { id: 'stored_value',  label: 'Wallet top-ups & vouchers', bucket: null },
  { id: 'other',         label: 'Uncategorised',   bucket: null },
  // Not spend: money arriving, and money moving between your own pockets.
  { id: 'income',        label: 'Money in',        bucket: null },
  { id: 'transfer',      label: 'Own transfers',   bucket: null },
];

/** Words sources and people use for a category, mapped to the canonical id. Keys are slugs (lower, `_`). */
export const CATEGORY_SYNONYMS = {
  restaurant: 'dining', restaurants: 'dining', cafe: 'dining', coffee: 'dining', food: 'dining', meal: 'dining',
  beverages: 'dining', beverage: 'dining', eating_out: 'dining', food_and_dining: 'dining', dine_in: 'dining',
  dineout: 'dining', snacks: 'dining', canteen: 'dining',
  delivery: 'food_delivery', food_order: 'food_delivery',
  grocery: 'groceries', supermarket: 'groceries', quick_commerce: 'groceries',
  housing: 'rent', house_rent: 'rent',
  petrol: 'fuel', diesel: 'fuel', gas_station: 'fuel',
  investment: 'investments', sip: 'investments', mutual_fund: 'investments', stocks: 'investments',
  air_travel: 'travel', train_travel: 'travel', flight: 'travel', flights: 'travel', hotel: 'travel', hotels: 'travel',
  lodging: 'travel', trip: 'travel', bus: 'travel', train: 'travel', souvenir: 'travel', cargo: 'travel', lounge: 'travel',
  travel_booking: 'travel',
  cab: 'transport', taxi: 'transport', ride: 'transport', rides: 'transport', metro: 'transport', auto: 'transport',
  travel_insurance: 'insurance', health_insurance: 'insurance', life_insurance: 'insurance', insurance_premium: 'insurance',
  car: 'vehicle', bike: 'vehicle', parking: 'vehicle', toll: 'vehicle', vehicle_service: 'vehicle', car_service: 'vehicle',
  health: 'medical', healthcare: 'medical', pharmacy: 'medical', medicine: 'medical', medicines: 'medical', doctor: 'medical',
  diagnostic_test: 'medical', health_screening: 'medical', health_checkup: 'medical', lab_test: 'medical', hospital: 'medical',
  gift: 'gifts', donation: 'gifts', donations: 'gifts', charity: 'gifts',
  taxes: 'tax', income_tax: 'tax', gst: 'tax',
  fee: 'fees', charges: 'fees', bank_charges: 'fees', banking: 'fees', late_fee: 'fees', convenience_fee: 'fees',
  purchase: 'shopping', online_purchase: 'shopping', retail: 'shopping', journal: 'shopping', book: 'shopping',
  books: 'shopping', stationery: 'shopping', jewellery: 'shopping', jewelry: 'shopping', general: 'shopping',
  fashion: 'clothing', apparel: 'clothing', clothes: 'clothing', footwear: 'clothing', shoes: 'clothing',
  gadgets: 'electronics', technology_hardware: 'electronics',
  movie: 'entertainment', movies: 'entertainment', cinema: 'entertainment', event: 'entertainment', events: 'entertainment',
  concert: 'entertainment', ticket: 'entertainment', tickets: 'entertainment', games: 'entertainment', gaming: 'entertainment',
  subscription: 'subscriptions', software: 'subscriptions', software_subscription: 'subscriptions', saas: 'subscriptions',
  membership: 'subscriptions', streaming: 'subscriptions', technology: 'subscriptions', cloud: 'subscriptions',
  utility: 'utilities', telecom: 'utilities', mobile: 'utilities', phone: 'utilities', internet: 'utilities',
  broadband: 'utilities', electricity: 'utilities', recharge: 'utilities', bills: 'utilities',
  laundry: 'personal_care', salon: 'personal_care', grooming: 'personal_care', beauty: 'personal_care',
  course: 'education', courses: 'education', tuition: 'education',
  household: 'home', furniture: 'home', home_improvement: 'home', hardware: 'home',
  reimbursable: 'work', office: 'work',
  wallet: 'stored_value', wallet_topup: 'stored_value', top_up: 'stored_value', topup: 'stored_value',
  voucher: 'stored_value', vouchers: 'stored_value', gift_card: 'stored_value', gift_voucher: 'stored_value',
  misc: 'other', miscellaneous: 'other', uncategorised: 'other', uncategorized: 'other', unknown: 'other',
  cashback: 'income', dividend: 'income', interest: 'income', bank_interest: 'income', salary: 'income',
  rewards: 'income', reward: 'income', loyalty_reward: 'income', refund: 'income', investment_income: 'income',
  bill_payment: 'transfer', self_transfer: 'transfer', card_bill: 'transfer',
};

/**
 * The type word of a note (`Food: lunch | Saloni`), lower-cased, to a category.
 * Your own label beats anything a source or a rule guessed.
 */
export const NOTE_CATEGORIES = {
  food: 'dining', lunch: 'dining', dinner: 'dining', breakfast: 'dining', snacks: 'dining', coffee: 'dining',
  groceries: 'groceries', grocery: 'groceries',
  rent: 'rent', fuel: 'fuel', petrol: 'fuel', investment: 'investments', sip: 'investments',
  flight: 'travel', hotel: 'travel', bus: 'travel', train: 'travel', souvenir: 'travel', cargo: 'travel', trip: 'travel',
  travel: 'travel', cab: 'transport', auto: 'transport', metro: 'transport',
  insurance: 'insurance', parking: 'vehicle', vehicle: 'vehicle', toll: 'vehicle',
  health: 'medical', medicine: 'medical', doctor: 'medical',
  gift: 'gifts', donation: 'gifts', tax: 'tax', fee: 'fees', fees: 'fees',
  shopping: 'shopping', purchase: 'shopping', book: 'shopping', clothes: 'clothing', clothing: 'clothing',
  electronics: 'electronics', movie: 'entertainment', event: 'entertainment', ticket: 'entertainment',
  subscription: 'subscriptions', telecom: 'utilities', utilities: 'utilities', electricity: 'utilities',
  laundry: 'personal_care', salon: 'personal_care', haircut: 'personal_care', course: 'education',
  home: 'home', work: 'work', voucher: 'stored_value', topup: 'stored_value', wallet: 'stored_value',
};

/** `type/subtype` pairs that settle the category by themselves. `type/*` is that type's catch-all. */
export const SUBTYPE_CATEGORIES = {
  'food/food_delivery': 'food_delivery', 'food/groceries': 'groceries', 'food/restaurant': 'dining', 'food/meal': 'dining',
  'travel/cab': 'transport', 'travel/insurance': 'insurance', 'travel/toll': 'vehicle', 'travel/*': 'travel',
  'entertainment/streaming': 'subscriptions', 'entertainment/book': 'shopping', 'entertainment/*': 'entertainment',
  'subscription/bill': 'utilities',
  'health/insurance': 'insurance', 'health/*': 'medical', 'appointment/medical': 'medical',
  'appointment/personal': 'personal_care', 'appointment/restaurant_reservation': 'dining',
  'gift/*': 'gifts', 'other/insurance': 'insurance', 'other/reward': 'income',
  'purchase/gift_card': 'stored_value',
  'transfer/self_transfer': 'transfer', 'transfer/card_bill_payment': 'transfer', 'transfer/bank_transfer': 'transfer',
  'transfer/insurance_premium': 'insurance',
  'transfer/credit': 'income', 'transfer/salary': 'income', 'transfer/interest': 'income', 'transfer/dividend': 'income',
  'transfer/cashback': 'income', 'transfer/reward': 'income',
};

/** When nothing else decided: the type's own default. Types not listed get no category unless they carry an amount. */
export const TYPE_CATEGORIES = {
  purchase: 'other', food: 'dining', travel: 'travel', subscription: 'subscriptions', entertainment: 'entertainment',
  health: 'medical', gift: 'gifts', transfer: 'transfer',
};

/**
 * Merchants whose name settles what was bought. Each entry is a run of whole
 * tokens of the normalized name (normalizeName / ledger_normalize_name), so
 * "uber" matches "uber india systems" but not "suberb". First match wins, so
 * the specific comes before the general ("amazon pay" before "amazon").
 */
export const MERCHANT_CATEGORIES = [
  ['amazon pay', 'stored_value'], ['amazonpay', 'stored_value'], ['amazonpayindiaprivatet', 'stored_value'],
  ['magicpin', 'stored_value'], ['samast', 'stored_value'], ['onpoint', 'stored_value'], ['gyftr', 'stored_value'],
  ['anthropic', 'subscriptions'], ['claude', 'subscriptions'], ['openai', 'subscriptions'], ['cursor', 'subscriptions'],
  ['netflix', 'subscriptions'], ['spotify', 'subscriptions'], ['spotifyindia', 'subscriptions'], ['appleservices', 'subscriptions'],
  ['apple', 'subscriptions'], ['google', 'subscriptions'], ['microsoft', 'subscriptions'], ['narakeet', 'subscriptions'],
  ['narakeet com', 'subscriptions'], ['hostinger', 'subscriptions'], ['timesprime', 'subscriptions'], ['airalo', 'utilities'],
  ['jio', 'utilities'], ['myjio', 'utilities'], ['rjil', 'utilities'], ['airtel', 'utilities'], ['bbps', 'utilities'],
  ['billpay', 'utilities'], ['bescom', 'utilities'], ['act fibernet', 'utilities'],
  ['swiggy', 'food_delivery'], ['instamart', 'groceries'], ['bundl', 'food_delivery'], ['zomato', 'food_delivery'],
  ['eternal', 'food_delivery'], ['ownly', 'food_delivery'], ['ctrlx', 'food_delivery'], ['dominos', 'food_delivery'],
  ['jubilant foodworks', 'food_delivery'], ['jubilantfoodworksltd', 'food_delivery'], ['mcdelivery', 'food_delivery'],
  ['blinkit', 'groceries'], ['zepto', 'groceries'], ['zeptonow', 'groceries'], ['bigbasket', 'groceries'],
  ['avenue supermarts', 'groceries'], ['dmart', 'groceries'], ['max hypermarket', 'groceries'], ['smart bazaar', 'groceries'],
  ['reliance smart', 'groceries'], ['reliance retail', 'groceries'], ['topmarthypermarket', 'groceries'], ['lulu', 'groceries'],
  ['district dining', 'dining'], ['eazydiner', 'dining'], ['smartworks', 'dining'], ['starbucks', 'dining'],
  ['third wave', 'dining'], ['blue tokai', 'dining'], ['chai point', 'dining'], ['tim hortons', 'dining'],
  ['mcdonalds', 'dining'], ['mc donalds', 'dining'], ['restaurant brands', 'dining'], ['devyani', 'dining'],
  ['tgif opulence', 'dining'], ['haldiram', 'dining'], ['oam industries', 'dining'], ['vendingsoftware', 'dining'],
  ['district', 'entertainment'], ['orbgen', 'entertainment'], ['bookmyshow', 'entertainment'], ['bookmyshow com', 'entertainment'],
  ['pvr', 'entertainment'], ['inox', 'entertainment'], ['cinepolis', 'entertainment'], ['cinepolisindia', 'entertainment'],
  ['uber', 'transport'], ['uberindiasystepvtltd', 'transport'], ['uberindiasystemspri', 'transport'], ['ola', 'transport'],
  ['rapido', 'transport'], ['namma yatri', 'transport'], ['bmtc', 'transport'],
  ['makemytrip', 'travel'], ['make my trip', 'travel'], ['makemytripindiapvt', 'travel'], ['makemytripindiapvtl', 'travel'],
  ['makemytripindiapvtlt', 'travel'], ['mmt', 'travel'], ['goibibo', 'travel'], ['ibibo', 'travel'], ['yatra', 'travel'],
  ['cleartrip', 'travel'], ['easy trip planners', 'travel'], ['easemytrip', 'travel'], ['ixigo', 'travel'],
  ['hsbcin twp', 'travel'], ['hoppr', 'travel'], ['irctc', 'travel'], ['indian railways', 'travel'], ['indigo', 'travel'],
  ['air', 'travel'], ['airindia', 'travel'], ['akasa', 'travel'], ['vistara', 'travel'],
  ['abhibus', 'travel'], ['intrcity', 'travel'], ['redbus', 'travel'], ['airbnb', 'travel'], ['oyo', 'travel'],
  ['booking com', 'travel'], ['lounge', 'travel'], ['loungeone', 'travel'], ['loungeoneai', 'travel'],
  ['travelclublounge', 'travel'], ['kolkatalounge', 'travel'], ['delhidomesticlounge', 'travel'],
  ['bangaloreairportdome', 'travel'], ['varun hospitality', 'travel'],
  ['hdfc life', 'insurance'], ['hdfclifeinsurancecompanylimited', 'insurance'], ['niva bupa', 'insurance'],
  ['nivabupahealthinsurancecompanylimited', 'insurance'], ['acko', 'insurance'], ['policybazaar', 'insurance'],
  ['ramji motor', 'vehicle'], ['vfm motors', 'vehicle'], ['honda', 'vehicle'], ['parkwiz', 'vehicle'],
  ['propbuild', 'vehicle'], ['fastag', 'vehicle'],
  ['iocl', 'fuel'], ['indian oil', 'fuel'], ['bpcl', 'fuel'], ['hpcl', 'fuel'], ['shell', 'fuel'], ['petropark', 'fuel'],
  ['seagullpetropark', 'fuel'], ['petrol', 'fuel'], ['fuel', 'fuel'],
  ['tata 1mg', 'medical'], ['1mg', 'medical'], ['apollo', 'medical'], ['pharmeasy', 'medical'], ['hospital', 'medical'],
  ['frank ross', 'medical'], ['netmeds', 'medical'],
  ['eportal incometax', 'tax'], ['incometax', 'tax'], ['itr', 'tax'],
  ['flipkart', 'shopping'], ['flipkartinternetpvtl', 'shopping'], ['amazon', 'shopping'], ['caratlane', 'shopping'],
  ['mr diy', 'shopping'], ['daiso', 'shopping'], ['miniso', 'shopping'], ['ventota', 'shopping'], ['printo', 'shopping'],
  ['sapna', 'shopping'], ['crossword', 'shopping'], ['atta galatta', 'shopping'], ['firkiwholesale', 'shopping'],
  ['loyal world market', 'shopping'], ['fujifilm', 'shopping'], ['rajkarinc', 'shopping'], ['portronics', 'electronics'],
  ['lenovo', 'electronics'], ['croma', 'electronics'], ['reliance digital', 'electronics'],
  ['myntra', 'clothing'], ['ajio', 'clothing'], ['westside', 'clothing'], ['westsideonline', 'clothing'],
  ['vedant fashions', 'clothing'], ['manyavar', 'clothing'], ['shoppers stop', 'clothing'], ['pantaloons', 'clothing'],
  ['aditya birla fashion', 'clothing'], ['life style', 'clothing'], ['max fashion', 'clothing'], ['jockey', 'clothing'],
  ['the souled store', 'clothing'], ['campus shoes', 'clothing'], ['neeman', 'clothing'], ['neemans', 'clothing'],
  ['moxie', 'personal_care'], ['metro wash', 'personal_care'], ['the metro wash', 'personal_care'],
  ['iitm', 'education'], ['indian institute of te', 'education'], ['coursera', 'education'], ['udemy', 'education'],
  ['lively legacy', 'rent'], ['nobroker', 'rent'],
  ['groww', 'investments'], ['zerodha', 'investments'], ['hdfc securities', 'investments'], ['hdfcsecurities', 'investments'],
  ['kuvera', 'investments'], ['coin by zerodha', 'investments'],
];

/**
 * When an event goes to the review queue no matter how sure its reader was.
 *
 * A wrong amount is worse than a missing one: it is summed into every total
 * and never announces itself. A ₹1,60,000 "subscription" read off a hotel
 * loyalty mailer was a third of a month's spend. So a large spend that is not
 * in a category where large is normal waits for a person, and so does any
 * subscription above what a subscription costs. Typed or told by you (manual,
 * Hermes) is never second-guessed.
 */
export const REVIEW_RULES = {
  large_spend_inr: 25000,
  large_subscription_inr: 5000,
  large_ok_categories: ['travel', 'rent', 'vehicle', 'insurance', 'investments', 'tax', 'electronics', 'education'],
  trusted_sources: ['manual', 'hermes'],
};

/** Everything above, as one JSON object. The SQL side reads exactly this (public.ledger_taxonomy()). */
export const TAXONOMY = {
  version: 1,
  subtypes: SUBTYPES,
  subtype_aliases: SUBTYPE_ALIASES,
  buckets: BUDGET_BUCKETS.map(b => b.id),
  categories: Object.fromEntries(CATEGORIES.map(c => [c.id, c.bucket])),
  category_synonyms: CATEGORY_SYNONYMS,
  note_categories: NOTE_CATEGORIES,
  subtype_categories: SUBTYPE_CATEGORIES,
  type_categories: TYPE_CATEGORIES,
  merchant_categories: MERCHANT_CATEGORIES,
  review: REVIEW_RULES,
};

const CATEGORY_INDEX = Object.fromEntries(CATEGORIES.map(c => [c.id, c]));
const slug = value => String(value ?? '').trim().toLowerCase().replace(/&/g, ' and ').replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '');

export function categoryMeta(id) {
  return CATEGORY_INDEX[id] || { id, label: titleCase(id || 'other'), bucket: null };
}

/** The canonical category for whatever a source or a person called it; null when it names nothing known. */
export function canonicalCategory(value) {
  const key = slug(value);
  if (!key) return null;
  if (CATEGORY_INDEX[key]) return key;
  if (CATEGORY_SYNONYMS[key]) return CATEGORY_SYNONYMS[key];
  // "Software subscription", "Men Health Checkup Premium" — try each word, last first (the noun).
  const words = key.split('_').reverse();
  for (const word of words) {
    if (CATEGORY_INDEX[word] && word !== 'other') return word;
    if (CATEGORY_SYNONYMS[word] && CATEGORY_SYNONYMS[word] !== 'other') return CATEGORY_SYNONYMS[word];
  }
  return null;
}

/** The canonical subtype for a type; unknown values pass through slugged (types stay open). */
export function canonicalSubtype(type, subtype) {
  const key = slug(subtype);
  if (!key) return null;
  if ((SUBTYPES[type] || []).includes(key)) return key;
  const aliases = SUBTYPE_ALIASES[type] || SUBTYPE_ALIASES['*'] || {};
  return aliases[key] || key;
}

/** Is `subtype` one of the listed ones for `type`? */
export function isCanonicalSubtype(type, subtype) {
  return (SUBTYPES[type] || []).includes(subtype);
}

function hasTokenRun(normalized, run) {
  return ` ${normalized} `.includes(` ${run} `);
}

/** A category from a normalized merchant name, or null. */
export function merchantCategory(normalizedName) {
  if (!normalizedName) return null;
  for (const [run, category] of MERCHANT_CATEGORIES) {
    if (hasTokenRun(normalizedName, run)) return category;
  }
  return null;
}

/** The type word a note starts with ("Food: lunch | Saloni" → food). */
export function noteCategory(description) {
  const m = String(description || '').match(/^([A-Za-z]+)(?::|$| \|)/);
  return m ? NOTE_CATEGORIES[m[1].toLowerCase()] || null : null;
}

const SPEND_TYPES = new Set(Object.keys(TYPE_CATEGORIES));

/**
 * What an event's money was for. The SQL twin is ledger_derive_category();
 * both walk the same ladder, cheapest certainty first:
 *
 *   1. your note's type word
 *   2. a type/subtype pair that settles it (a cab ride is transport)
 *   3. the subtype read as a category (old rows: purchase/clothing)
 *   4. what the source called it
 *   5. the merchant's name
 *   6. the type's default
 *
 * `merchant` is the normalized merchant name. `stated` is the category a
 * source gave, before canonicalisation. Returns null for events that are not
 * about money at all (a meeting, a parcel).
 */
export function deriveCategory({ type, subtype, rawSubtype = null, stated = null, description = null, merchant = null, hasAmount = false }) {
  const isTransfer = type === 'transfer';
  const fromNote = noteCategory(description);
  if (fromNote && !isTransfer) return fromNote;

  const pair = SUBTYPE_CATEGORIES[`${type}/${subtype}`];
  if (pair) return pair;

  if (isTransfer) {
    // Refunds keep the category of what they refund when a source said; other
    // transfers that left for good (a payment to someone) fall through.
    if (subtype === 'refund') return spendOnly(canonicalCategory(stated)) || 'income';
    if (subtype !== 'payment') return 'transfer';
  }

  // Only a subtype that IS a category word (purchase/clothing); never a word
  // inside one, or "online_card_purchase" would read as shopping.
  const fromSubtype = rawSubtype && rawSubtype !== subtype
    ? spendOnly(CATEGORY_INDEX[rawSubtype] ? rawSubtype : CATEGORY_SYNONYMS[rawSubtype] || null) : null;
  if (fromSubtype) return fromSubtype;

  const fromSource = canonicalCategory(stated);
  if (fromSource && fromSource !== 'other') return fromSource;

  const fromMerchant = merchantCategory(merchant);
  if (fromMerchant) return fromMerchant;

  const typeWide = SUBTYPE_CATEGORIES[`${type}/*`];
  if (typeWide) return typeWide;
  if (SPEND_TYPES.has(type)) return TYPE_CATEGORIES[type];
  return hasAmount ? 'other' : null;
}

function spendOnly(category) {
  return category && category !== 'income' && category !== 'transfer' && category !== 'other' ? category : null;
}

/** Which budget bucket a category counts against, or null for outside the budget. */
export function budgetBucket(category) {
  return CATEGORY_INDEX[category]?.bucket ?? null;
}

/**
 * Why this event must wait for a person, or null. JS twin of
 * public.ledger_review_reason(). `amountInr` is the amount in rupees (the
 * caller converts); `flow` is moneyFlow(event).
 */
export function reviewReason({ sourceType, flow, amountInr, category, type }) {
  if (REVIEW_RULES.trusted_sources.includes(sourceType)) return null;
  if (flow !== 'spend' || !Number.isFinite(amountInr)) return null;
  if ((category === 'subscriptions' || type === 'subscription') && amountInr > REVIEW_RULES.large_subscription_inr) {
    return 'large_subscription';
  }
  if (amountInr > REVIEW_RULES.large_spend_inr && !REVIEW_RULES.large_ok_categories.includes(category)) {
    return 'large_spend';
  }
  return null;
}

// The four states an event can be in, plus `scheduled` for things that are on
// the calendar but have not happened yet — a calendar entry is evidence of an
// intention, not of an event.
export const STATUSES = [
  { id: 'confirmed',    label: 'Confirmed',    badge: 'badge-green',  hint: 'Stated by a source we trust, or entered by you.' },
  { id: 'inferred',     label: 'Inferred',     badge: 'badge-blue',   hint: 'Extracted with reasonable but not certain confidence.' },
  { id: 'scheduled',    label: 'Scheduled',    badge: 'badge-purple', hint: 'Planned. Not yet reconciled against evidence that it happened.' },
  { id: 'needs_review', label: 'Needs review', badge: 'badge-yellow', hint: 'Low confidence — confirm, correct, merge or dismiss it.' },
  { id: 'dismissed',    label: 'Dismissed',    badge: 'badge-gray',   hint: 'Not a real event. Kept so it is not re-created.' },
];

const STATUS_INDEX = Object.fromEntries(STATUSES.map(s => [s.id, s]));
export function statusMeta(id) {
  return STATUS_INDEX[id] || { id, label: titleCase(id || 'unknown'), badge: 'badge-gray', hint: '' };
}

// ── Meals ──────────────────────────────────────────────
//
// Which meal a plate of food was depends only on the clock, so it is derived
// on read rather than stored: change a boundary here and every meal already in
// the ledger is relabelled, with no re-ingestion and nothing to migrate.
//
// The day starts at 04:30, not at midnight. Food ordered at 01:00 belongs to
// the night before, and calling it breakfast would put a biryani at the top of
// Tuesday morning.

export const MEAL_SLOTS = [
  { id: 'breakfast', label: 'Breakfast', icon: 'fa-mug-saucer',  color: '#f59e0b', window: '04:30 – 12:15' },
  { id: 'lunch',     label: 'Lunch',     icon: 'fa-bowl-food',   color: '#2dd4bf', window: '12:15 – 15:00' },
  { id: 'snack',     label: 'Snacks',    icon: 'fa-cookie-bite', color: '#a78bfa', window: '15:00 – 19:00 and 00:00 – 04:30' },
  { id: 'dinner',    label: 'Dinner',    icon: 'fa-utensils',    color: '#38bdf8', window: '19:00 – 00:00' },
  // Not a meal: a grocery order is bought, not eaten, and the hour it arrived
  // says nothing about when any of it was.
  { id: 'groceries', label: 'Groceries', icon: 'fa-basket-shopping', color: '#94a3b8', window: 'any time' },
];

const MEAL_INDEX = Object.fromEntries(MEAL_SLOTS.map(m => [m.id, m]));
export function mealMeta(id) {
  return MEAL_INDEX[id] || { id, label: titleCase(id || 'other'), icon: 'fa-utensils', color: '#94a3b8', window: '' };
}

// Boundaries in minutes past local midnight, ascending. The last one to have
// started is the answer, which is why 00:00 has to be in the list.
const MEAL_WINDOWS = [
  { from: 0,          slot: 'snack' },      // 00:00
  { from: 4 * 60 + 30, slot: 'breakfast' }, // 04:30
  { from: 12 * 60 + 15, slot: 'lunch' },    // 12:15
  { from: 15 * 60,     slot: 'snack' },     // 15:00
  { from: 19 * 60,     slot: 'dinner' },    // 19:00
];

/**
 * Which meal an event's clock time falls in, in the user's zone.
 *
 * `subtype` decides first: a grocery delivery is not a meal whatever hour it
 * turned up, and labelling one "snacks" would put toilet roll in the middle of
 * an afternoon tea.
 */
export function mealSlot(instant, timeZone = DEFAULT_TIME_ZONE, subtype = null) {
  if (subtype === 'groceries') return 'groceries';

  const date = instant instanceof Date ? instant : new Date(instant);
  if (Number.isNaN(date.getTime())) return null;

  const clock = localClock(date, timeZone);
  const minutes = clock.hour * 60 + clock.minute;

  let slot = MEAL_WINDOWS[0].slot;
  for (const window of MEAL_WINDOWS) {
    if (minutes >= window.from) slot = window.slot;
  }
  return slot;
}

export const SOURCE_TYPES = [
  { id: 'email',    label: 'Email',    icon: 'fa-envelope' },
  { id: 'calendar', label: 'Calendar', icon: 'fa-calendar' },
  { id: 'hermes',   label: 'Hermes',   icon: 'fa-robot' },
  { id: 'manual',   label: 'Manual',   icon: 'fa-pen' },
  { id: 'card',     label: 'Card',     icon: 'fa-credit-card' },
  { id: 'health',   label: 'Health',   icon: 'fa-heart-pulse' },
  { id: 'other',    label: 'Other',    icon: 'fa-circle-dot' },
];

const SOURCE_INDEX = Object.fromEntries(SOURCE_TYPES.map(s => [s.id, s]));
export function sourceMeta(id) {
  return SOURCE_INDEX[id] || { id, label: titleCase(id || 'unknown'), icon: 'fa-circle-dot' };
}

function titleCase(s) {
  return String(s).replace(/_/g, ' ').replace(/\b\w/g, c => c.toUpperCase());
}
