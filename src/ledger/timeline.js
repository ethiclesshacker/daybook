// ======================================================
// What the timeline shows of the events it has loaded.
//
// A parcel writes three or four mails on its way to you and a weigh-in writes a
// row most mornings, so between them they crowded out the days. Nothing here
// changes or removes an event: it only decides which rows are drawn, so the
// stages stay searchable and a filter on Delivery still lists every one.
//
// A row with money on it or a question waiting is never folded away.
// ======================================================

// A parcel's mails arrive within days. Past this, the same shop is a new order.
const PARCEL_WINDOW_MS = 14 * 86_400_000;

const isDelivered = event => event.subtype === 'order_delivered' || /\bdelivered\b/i.test(event.title || '');

const foldable = event => event.status !== 'needs_review' && event.status !== 'inferred'
  && !Number.isFinite(Number(event.data?.amount ?? NaN));

const sameParcel = (group, event) => {
  const { order_id: order, tracking_number: tracking, merchant, carrier } = event.data || {};
  if (Math.abs(new Date(group.oldest) - new Date(event.occurred_at)) > PARCEL_WINDOW_MS) return false;
  if ((order && group.orders.has(order)) || (tracking && group.trackings.has(tracking))) return true;
  // Two different numbers are two parcels, even from one shop on one day.
  if ((order && group.orders.size) || (tracking && group.trackings.size)) return false;
  const party = String(merchant || carrier || '').toLowerCase();
  if (!party || party !== group.party) return false;
  // With only a courier's name to go on, a second "dispatched" is a second parcel.
  return Boolean(merchant) || !group.stages.has(event.subtype);
};

/**
 * One row per parcel, newest first as given. The row kept is the delivery if
 * there was one, since a late "arriving soon" mail is not news after it, and it
 * carries `parcel_updates`: how many mails it stands for.
 */
export function collapseParcels(events) {
  const groups = [];
  const groupOf = new Map();

  for (const event of events) {
    if (event.type !== 'delivery' || !foldable(event)) continue;
    // One mail can tie two groups together: the courier's tracking number on one
    // side, the shop's name on the other. They were one parcel all along.
    const [found, ...others] = groups.filter(g => sameParcel(g, event));
    const group = found || {
      rows: [], orders: new Set(), trackings: new Set(), stages: new Set(), oldest: event.occurred_at,
      party: String(event.data?.merchant || event.data?.carrier || '').toLowerCase(),
    };
    if (!found) groups.push(group);
    for (const other of others) {
      group.rows.push(...other.rows);
      for (const key of ['orders', 'trackings', 'stages']) other[key].forEach(value => group[key].add(value));
      for (const row of other.rows) groupOf.set(row.id, group);
      groups.splice(groups.indexOf(other), 1);
    }
    group.rows.push(event);
    group.rows.sort((x, y) => new Date(y.occurred_at) - new Date(x.occurred_at));
    group.oldest = event.occurred_at;
    group.stages.add(event.subtype);
    if (event.data?.order_id) group.orders.add(event.data.order_id);
    if (event.data?.tracking_number) group.trackings.add(event.data.tracking_number);
    groupOf.set(event.id, group);
  }

  const shown = [];
  for (const event of events) {
    const group = groupOf.get(event.id);
    if (!group) { shown.push(event); continue; }
    const head = group.rows.find(isDelivered) || group.rows[0];
    if (event.id !== head.id) continue;
    shown.push(group.rows.length > 1 ? { ...event, parcel_updates: group.rows.length } : event);
  }
  return shown;
}

export const isWeighIn = event => event.type === 'health' && event.subtype === 'measurement'
  && event.data?.metric === 'weight' && foldable(event);

/**
 * The rows to draw. Asking for something specific turns the folding off: a
 * search or a type filter should show everything it matched. A date range does
 * not, because it narrows when and says nothing about which rows are wanted.
 */
export function visibleEvents(events, { filters = {}, showWeighIns = false, review = false } = {}) {
  const specific = review || filters.query || filters.types?.length || filters.statuses?.length || filters.sourceTypes?.length;
  if (specific) return events;
  return collapseParcels(showWeighIns ? events : events.filter(event => !isWeighIn(event)));
}
