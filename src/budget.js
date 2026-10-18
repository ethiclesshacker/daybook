// ======================================================
// Spend against a monthly budget — the one rule, wherever it is drawn.
//
// Pure and import-free (the money formatter is passed in), so the thresholds
// are tested in node rather than eyeballed on the dashboard.
//
//   danger   at or above 125% of the budget. Not "ahead of pace": over.
//   warning  over the budget by less than that, or under it but spending
//            faster than the month is passing (10% grace on the pace line).
//   ok       otherwise.
//
// The note says what happened in plain words — "5.4× budget · ₹1.74 L over",
// "62% of budget · ₹15,200 left" — instead of the old "Ahead of pace — ₹X
// above where day 18 would put you", which described a 5× overrun as a
// matter of timing.
// ======================================================

export const DANGER_RATIO = 1.25;
const PACE_GRACE = 1.1;
// The bar is drawn on a track of at most twice the budget, so one wild month
// cannot squash the budget mark into the first pixel; past that, the overflow
// segment runs to the end and the bar says it carries on.
const TRACK_CAP = 2;

/**
 * @param {object} p
 *   spent, budget          rupees
 *   dayOfMonth, daysInMonth
 *   money                  (value) => string, for the note
 */
export function budgetStatus({ spent, budget, dayOfMonth, daysInMonth, money = v => String(Math.round(v)) }) {
  spent = Math.max(Number(spent) || 0, 0);
  budget = Math.max(Number(budget) || 0, 0);
  const monthShare = daysInMonth > 0 ? Math.min(dayOfMonth / daysInMonth, 1) : 0;

  if (!budget) {
    return {
      tone: 'ok', ratio: null, over: 0, left: 0, note: 'No budget set',
      bar: { fill: 0, overflow: 0, budgetMark: null, pace: monthShare * 100, beyond: false },
    };
  }

  const ratio = spent / budget;
  const expected = budget * monthShare;
  const over = Math.max(spent - budget, 0);
  const left = Math.max(budget - spent, 0);

  const tone = ratio >= DANGER_RATIO ? 'danger'
    : (ratio > 1 || (expected > 0 && spent > expected * PACE_GRACE)) ? 'warning'
    : 'ok';

  const share = ratio >= 2 ? `${trimRatio(ratio)}× budget` : `${Math.round(ratio * 100)}% of budget`;
  const note = over > 0
    ? `${share} · ${money(over)} over`
    : `${share} · ${money(left)} left · day ${dayOfMonth} of ${daysInMonth}`;

  // Bar geometry, as percentages of the track.
  const track = Math.max(budget, Math.min(spent, budget * TRACK_CAP));
  const pct = v => (track > 0 ? Math.min((v / track) * 100, 100) : 0);
  const bar = {
    fill: pct(Math.min(spent, budget)),           // the part inside the budget
    overflow: over > 0 ? pct(spent) - pct(budget) : 0,
    budgetMark: over > 0 ? pct(budget) : null,     // only needed once the track is longer than the budget
    pace: pct(expected),
    beyond: spent > track,                         // overrun larger than the drawn track
  };

  return { tone, ratio, over, left, note, bar };
}

function trimRatio(ratio) {
  return ratio >= 10 ? String(Math.round(ratio)) : String(Number(ratio.toFixed(1)));
}
