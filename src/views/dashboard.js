// ======================================================
// Dashboard — the one screen that reads everything.
//
// It composes rather than computes: net worth rows come from the same
// fetcher the Net Worth screen uses, points arithmetic from points-math.js,
// the day from life_days (the join Hermes reads), money direction from the
// one rule in 0017, and the two charts from charts.js — so the figure here is
// always the figure on the screen it summarises.
//
// Top to bottom it runs from what changes by the hour to what changes by the
// month: what needs you, today's body, this month's spending, then net worth
// and points. Every section past the header is optional; a source that has
// not been set up removes its card rather than showing zeros.
// ======================================================

import * as ledger from '../ledger/api.js';
import * as health from '../health/api.js';
import { listEntries } from '../networth/api.js';
import { listTransactions, listRedemptions } from '../points/api.js';
import { EUR_INR_FALLBACK } from '../constants.js';
import * as settings from '../settings.js';
import {
  formatINR, formatINRFull, formatPercent, destroyChart, fetchEURtoINR, cachedEURtoINR, escapeHTML,
  computeNet, computeAssets, computeLiquid, computeEmergencyFund,
  bannerHTML, todayISO, formatDate, formatShortDate,
} from '../utils.js';
import { netWorthSeriesChart } from '../charts.js';
import { budgetStatus } from '../budget.js';
import { pointsSummary } from '../points-math.js';
import { impliedSavingsRate, monthsBetween } from '../finance.js';
import { shiftISO, formatHours, meanOf, latestOf } from '../health/summary.js';
import { navigateTo } from '../router.js';
import { categoryMeta, typeMeta } from '../ledger/taxonomy.js';
import { amountInr } from '../ledger/normalize.js';
import { isInflow } from '../ledger/summary.js';

let netWorthChart = null;
let clockTimer = null;
// A load that resolves after the user has left must not paint a dead DOM.
let loadToken = 0;

// A snapshot older than this is worth a nudge: the KPIs below all read it.
const STALE_SNAPSHOT_DAYS = 45;
// The Today strip is the phone's last sync. Past this it is dimmed: steps
// "so far" from a sync at 9am are not what you have walked by 4pm.
const STALE_SYNC_MS = 3 * 60 * 60 * 1000;

export async function renderDashboard(container) {
  // One screen, no page scroll on a laptop: a header line, then two rows —
  // this month and today on top, net worth and the money figures below. The
  // allocation donut, the FI progress card and the points breakdown live on
  // their own screens (Net Worth, Points); each card title links there.
  container.innerHTML = `
    <div class="page-body dash-page">

      <header class="dash-top">
        <div class="dash-left">
          <h2 class="dash-greeting" id="dash-greeting"></h2>
          <div class="dash-date" id="dash-date"></div>
        </div>
        <!-- Only what needs you; each pill opens the screen that closes it. -->
        <ul class="dash-todo" id="dash-todo-list" aria-label="Worth a look"></ul>
        <div class="dash-nw-stat">
          <div class="dash-nw-label">Net worth</div>
          <div class="dash-nw-value mono" id="hero-net-worth">—</div>
          <div class="dash-nw-change" id="hero-nw-change"></div>
        </div>
      </header>

      <div id="dash-alert"></div>

      <!-- Two columns that size on their own: money on the left (this month,
           the slow figures, then the chart in whatever height is left), the
           day on the right (today, then the latest the ledger heard). -->
      <div class="dash-grid">
        <div class="dash-col">
          <section class="chart-card dash-card" id="dash-life-card">
            <button type="button" class="dash-card-title" data-goto="ledger"
                    title="Recorded personal spending against your monthly budget. Only what reached your inbox or was told to Hermes; cash and anything unrecorded is not here.">
              This month <i class="fas fa-arrow-right" aria-hidden="true"></i>
            </button>
            <div id="dash-life-strip"><div class="skeleton skeleton--strip"></div></div>
          </section>

          <section class="chart-card dash-card" id="dash-money-card">
            <button type="button" class="dash-card-title" data-goto="points">
              Money &amp; points <i class="fas fa-arrow-right" aria-hidden="true"></i>
            </button>
            <div class="dash-stats dash-stats--row" id="dash-money">
              ${Array(4).fill(0).map(() => '<div class="skeleton skeleton--stat"></div>').join('')}
            </div>
          </section>

          <section class="chart-card dash-card dash-chart-card">
            <div class="dash-card-head">
              <button type="button" class="dash-card-title" data-goto="networth">
                Net worth over time <i class="fas fa-arrow-right" aria-hidden="true"></i>
              </button>
              <span class="dash-card-meta" id="dash-assets"></span>
            </div>
            <div class="chart-canvas-wrap"><canvas id="dash-nw-chart" role="img" aria-label="Net worth over time"></canvas></div>
          </section>
        </div>

        <div class="dash-col">
          <section class="chart-card dash-card" id="dash-today-card">
            <button type="button" class="dash-card-title" data-goto="health">
              Today <span class="dash-asof" id="dash-today-asof"></span> <i class="fas fa-arrow-right" aria-hidden="true"></i>
            </button>
            <div class="dash-stats" id="dash-today">
              ${Array(4).fill(0).map(() => '<div class="skeleton skeleton--stat"></div>').join('')}
            </div>
          </section>

          <section class="chart-card dash-card dash-latest-card" id="dash-latest-card">
            <button type="button" class="dash-card-title" data-goto="ledger"
                    title="The newest entries from email, Edith and you — the quickest place to catch a duplicate or a misread">
              Latest <i class="fas fa-arrow-right" aria-hidden="true"></i>
            </button>
            <ul class="dash-latest" id="dash-latest">
              ${Array(5).fill(0).map(() => '<li><div class="skeleton skeleton--stat"></div></li>').join('')}
            </ul>
          </section>
        </div>
      </div>

    </div>
  `;

  // The greeting and date used to be baked in at render time, so a tab left
  // open overnight kept saying "Good evening" and showing yesterday's date.
  updateClock();
  clearInterval(clockTimer);
  clockTimer = setInterval(updateClock, 60_000);

  // One delegated handler for every "go to that screen" button, including the
  // ones the to-do list draws later.
  container.querySelector('.dash-page').addEventListener('click', e => {
    const target = e.target.closest('[data-goto]');
    if (target) navigateTo(target.dataset.goto);
  });

  await loadDashboardData();
}

export { renderDashboard as render };

/** Release everything the screen holds before the router replaces its DOM. */
export function unmount() {
  loadToken++;
  clearInterval(clockTimer);
  clockTimer = null;
  netWorthChart = destroyChart(netWorthChart);
}

function updateClock() {
  const now = new Date();
  const h = now.getHours();
  const greeting = h < 12 ? 'morning' : h < 17 ? 'afternoon' : 'evening';

  const greetEl = document.getElementById('dash-greeting');
  const dateEl  = document.getElementById('dash-date');
  if (!greetEl || !dateEl) { clearInterval(clockTimer); return; }

  const name = settings.get('display_name');
  greetEl.textContent = name ? `Good ${greeting}, ${name} 👋` : `Good ${greeting} 👋`;
  dateEl.textContent  = now.toLocaleDateString('en-IN', {
    weekday: 'long', day: 'numeric', month: 'long', year: 'numeric',
  });
}

function showAlert(message) {
  const el = document.getElementById('dash-alert');
  if (!el) return;
  el.innerHTML = bannerHTML({
    tone: 'error', title: "Couldn't load your data.", sub: message,
    action: { id: 'dash-retry', label: 'Retry', ghost: true },
  });
  document.getElementById('dash-retry')?.addEventListener('click', () => loadDashboardData());
}

function showEmptyState() {
  const el = document.getElementById('dash-alert');
  if (!el) return;
  el.innerHTML = bannerHTML({
    tone: 'empty', title: 'No snapshots yet.',
    sub: 'Add your first net worth snapshot and the dashboard fills in.',
    action: { id: 'dash-goto-nw', label: 'Add snapshot' },
  });
  document.getElementById('dash-goto-nw')?.addEventListener('click', () => navigateTo('networth'));
}

function removeCard(id) {
  document.getElementById(id)?.remove();
}

async function loadDashboardData() {
  const token = ++loadToken;
  const todo = new TodoList(token);

  // The ledger and Apple Health are optional: the dashboard predates both and
  // has to keep working when their migrations have not been run or nothing
  // has arrived yet. Each removes its own card on failure.
  renderDayAndMonth(token)
    .catch(err => {
      console.warn('[dashboard] life_days:', err?.message || err);
      if (token === loadToken) { removeCard('dash-today-card'); removeCard('dash-life-card'); }
    });
  renderLatest(token).catch(err => {
    console.warn('[dashboard] latest:', err?.message || err);
    if (token === loadToken) removeCard('dash-latest-card');
  });
  ledger.reviewQueue(50)
    .then(rows => {
      // The RPC answers { total, events }; an array was the pre-0004 shape.
      const n = Array.isArray(rows) ? rows.length : Number(rows?.total ?? rows?.events?.length ?? 0);
      if (n) todo.add('review', {
        icon: 'fa-inbox', goto: 'ledger',
        text: `${n} to review`,
        title: `${n} ledger event${n === 1 ? '' : 's'} the model read but nobody has confirmed`,
      });
    })
    .catch(() => {});

  // The EUR rate only values the points balance, so it never holds the page:
  // draw with the cached (or fallback) rate now, redraw the strip if a fresh
  // one arrives. It used to sit in this Promise.all, so a slow frankfurter.dev
  // kept every KPI on its skeleton.
  let eurRate = cachedEURtoINR() ?? EUR_INR_FALLBACK;
  const freshRate = cachedEURtoINR() === null ? fetchEURtoINR(EUR_INR_FALLBACK) : null;

  let entries, transactions, redemptions;
  try {
    [entries, transactions, redemptions] = await Promise.all([
      listEntries(), listTransactions(), listRedemptions(), settings.ready(),
    ]);
  } catch (err) {
    // A failed query used to be swallowed by `?.data || []`, so a network drop
    // or a denied RLS policy rendered a confident, well-formatted net worth of ₹0.
    if (token === loadToken) showAlert(err.message);
    return;
  }
  if (token !== loadToken || !document.getElementById('dash-money')) return;

  entries      = entries || [];
  transactions = transactions || [];
  redemptions  = redemptions || [];

  const alertEl = document.getElementById('dash-alert');
  if (alertEl) alertEl.innerHTML = '';
  if (!entries.length) showEmptyState();

  // ── Net Worth ─────────────────────────────────────────
  const latest = entries[entries.length - 1];
  const prev   = entries[entries.length - 2];

  const netWorth    = computeNet(latest);
  const prevNW      = computeNet(prev);
  const nwChange    = prevNW !== 0 ? ((netWorth - prevNW) / Math.abs(prevNW)) * 100 : 0;
  const totalAssets = computeAssets(latest);

  const heroEl   = document.getElementById('hero-net-worth');
  const changeEl = document.getElementById('hero-nw-change');
  if (heroEl) heroEl.textContent = entries.length ? formatINRFull(netWorth) : '—';
  if (changeEl && prev) {
    const isPos = nwChange >= 0;
    changeEl.innerHTML = `<span class="${isPos ? 'is-up' : 'is-down'}">${isPos ? '↑' : '↓'} ${Math.abs(nwChange).toFixed(1)}%</span> since ${escapeHTML(formatShortDate(prev.date))}`;
  } else if (changeEl) {
    changeEl.textContent = entries.length ? 'First snapshot' : 'No data yet';
  }

  // Everything below the hero reads the latest snapshot, so say how old it is.
  if (latest?.date) {
    const ageDays = Math.round(monthsBetween(String(latest.date).slice(0, 10), todayISO()) * 30.4375);
    if (ageDays > STALE_SNAPSHOT_DAYS) todo.add('snapshot', {
      icon: 'fa-camera', goto: 'networth',
      text: `Snapshot ${formatAge(ageDays)} old`,
      title: `Last net worth snapshot was ${formatDate(latest.date)}`,
    });
  }
  const assetsEl = document.getElementById('dash-assets');
  if (assetsEl && latest) {
    assetsEl.textContent = `Assets ${formatINR(totalAssets)} · liquid ${formatINR(computeLiquid(latest))}`;
  }

  // ── Points ────────────────────────────────────────────
  const pointsPerEur = settings.get('points_per_eur');
  const rewardTarget = settings.get('cc_reward_target_rate');
  // Rows made from card alerts arrive as a guess until you look at them.
  const assumed = transactions.filter(t => t.basis === 'assumed').length;
  if (assumed) todo.add('points', {
    icon: 'fa-credit-card', goto: 'points',
    text: `${assumed} card spend${assumed === 1 ? '' : 's'} to confirm`,
    title: 'Labelled from a merchant rule, not yet confirmed',
  });

  // ── Money ─────────────────────────────────────────────
  // Four figures that change slowly: what you keep, how long you could stop,
  // and what the card has earned. FI progress left with the FI screen.
  const monthlyExp    = settings.get('monthly_expenses');
  const runwayTarget  = settings.get('emergency_runway_target');
  const basis         = settings.get('emergency_fund_basis');
  const emergencyFund = computeEmergencyFund(latest, basis);
  const runway        = monthlyExp > 0 ? emergencyFund / monthlyExp : 0;
  const runwayOK      = runway >= runwayTarget;

  const savings = impliedSavingsRate(entries, settings.get('monthly_net_income'), 12);
  const budgetRate = settings.budgetedSavingsRate();

  const paintMoney = rate => {
    const pts = pointsSummary(transactions, redemptions, { pointsPerEur, eurRate: rate });
    renderStats(document.getElementById('dash-money'), [
      {
        label: 'Savings rate',
        value: savings ? formatPercent(savings.rate) : '—',
        sub: savings ? `budget ${budgetRate.toFixed(0)}%` : 'needs two snapshots',
        tone: savings && savings.rate < budgetRate ? 'warning' : undefined,
        title: 'Net worth growth ÷ income over the last 12 months. Includes market moves.',
      },
      {
        label: 'Runway',
        value: `${runway.toFixed(1)} mo`,
        sub: `target ${runwayTarget} mo`,
        tone: runwayOK ? 'success' : 'warning',
        title: `${basis === 'cash_like' ? 'Cash and FDs' : 'Cash, stocks and funds'} ÷ ${formatINRFull(monthlyExp)} a month`,
      },
      {
        label: 'Points value',
        value: formatINR(pts.balanceINR),
        sub: `${Math.round(pts.balance).toLocaleString('en-IN')} pts`,
        title: `At 1 EUR = ₹${rate.toFixed(0)}`,
      },
      {
        label: 'Reward rate',
        value: formatPercent(pts.rewardRate),
        sub: `target ${rewardTarget}%`,
        tone: pts.rewardRate >= rewardTarget ? 'success' : 'warning',
      },
    ]);
  };
  paintMoney(eurRate);
  freshRate?.then(rate => {
    if (token === loadToken && rate !== eurRate) { eurRate = rate; paintMoney(rate); }
  });

  buildNetWorthChart(entries, 'line');
}

function buildNetWorthChart(entries, type = 'line') {
  netWorthChart = destroyChart(netWorthChart);
  netWorthChart = netWorthSeriesChart(document.getElementById('dash-nw-chart'), entries, type);
}

/** Label / figure / note cells in a 2×2 grid, shared by the Today and Money cards. */
function renderStats(el, items) {
  if (!el) return;
  el.innerHTML = items.map(item => `
    <div class="dash-stat"${item.title ? ` title="${escapeHTML(item.title)}"` : ''}>
      <div class="dash-stat-label">${escapeHTML(item.label)}</div>
      <div class="dash-stat-value mono ${item.tone ? `is-${item.tone}` : ''}">${escapeHTML(item.value)}</div>
      <div class="dash-stat-sub">${escapeHTML(item.sub)}</div>
    </div>
  `).join('');
}

// "14 Sep 2026" is utils.formatDate now — the one date style for the app.

/** The browser-local calendar date of an instant, as YYYY-MM-DD. */
function localISODate(date) {
  const pad = n => String(n).padStart(2, '0');
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

function formatAge(days) {
  if (days < 60) return `${days} days`;
  return `${Math.round(days / 30.44)} months`;
}

// ======================================================
// Worth a look
//
// The things only you can close: events the ledger could not read with
// confidence, card spends labelled by a rule, a stale snapshot. Items arrive from several loads at different
// times, so the list is keyed and redrawn on each arrival.
// ======================================================

class TodoList {
  constructor(token) {
    this.token = token;
    this.items = new Map();
    this.draw();
  }

  add(key, item) {
    if (this.token !== loadToken) return;
    this.items.set(key, item);
    this.draw();
  }

  draw() {
    const list = document.getElementById('dash-todo-list');
    if (!list) return;
    list.hidden = this.items.size === 0;
    list.innerHTML = [...this.items.values()].map(item => `
      <li>
        <button type="button" class="dash-pill" data-goto="${escapeHTML(item.goto)}"${item.title ? ` title="${escapeHTML(item.title)}"` : ''}>
          <i class="fas ${item.icon}" aria-hidden="true"></i>${escapeHTML(item.text)}
        </button>
      </li>
    `).join('');
  }

}

// ======================================================
// Today and this month — both from life_days
//
// One call covers the month so far and the week before today, whichever
// starts earlier: the day strip needs a week for its averages, the month
// strip needs every day since the 1st.
// ======================================================

async function renderDayAndMonth(token) {
  const today = todayISO();
  const monthStart = `${today.slice(0, 8)}01`;
  const weekStart = shiftISO(today, -7);
  const from = weekStart < monthStart ? weekStart : monthStart;

  const [days, stats, catalog] = await Promise.all([
    health.days(from, today),
    ledger.stats(new Date(`${monthStart}T00:00:00`).toISOString(), null).catch(() => null),
    // Only for "as of": when the phone last synced. Optional.
    health.catalog().catch(() => null),
    settings.ready(),
  ]);
  if (token !== loadToken) return;

  const list = Array.isArray(days) ? days : [];
  renderToday(list.filter(d => d.day >= weekStart), today, catalog?.last_sync_at || null);
  renderMonth(list.filter(d => d.day >= monthStart), stats, today);
}

// ── Today ────────────────────────────────────────────────

function renderToday(days, today, lastSyncAt) {
  const el = document.getElementById('dash-today');
  if (!el) return;

  // "as of 14:05": a strip of numbers "so far today" means nothing without
  // the moment they were true. Dimmed once the sync is over three hours old.
  const asOf = document.getElementById('dash-today-asof');
  const stale = lastSyncAt ? Date.now() - new Date(lastSyncAt).getTime() > STALE_SYNC_MS : false;
  if (asOf) {
    if (lastSyncAt) {
      const when = new Date(lastSyncAt);
      const sameDay = todayISO() === localISODate(when);
      const clock = when.toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit', hour12: false });
      asOf.textContent = `as of ${sameDay ? clock : `${formatShortDate(localISODate(when))} ${clock}`}`;
      asOf.title = `Apple Health last synced ${when.toLocaleString('en-IN')}`;
      asOf.classList.toggle('is-stale', stale);
    } else {
      asOf.textContent = '';
    }
  }
  el.classList.toggle('is-stale', stale);

  // life_days nests body fields; the Health helpers read them flat.
  const flat = days.map(d => ({ day: d.day, ...(d.body || {}) }));
  const earlier = flat.filter(d => d.day !== today);
  const todayRow = days.find(d => d.day === today) || {};

  const hasBody = flat.some(d => Object.keys(d).length > 1);
  const hasFood = days.some(d => d.food);
  if (!hasBody && !hasFood) { removeCard('dash-today-card'); return; }

  // A night is dated by the morning it ended, so last night is today's row
  // once the Watch has synced it — and yesterday's until then.
  const lastNight = latestOf(flat.filter(d => d.day >= shiftISO(today, -1)), 'sleep_hours');
  const sleepAvg = meanOf(earlier, 'sleep_hours');

  const steps = todayRow.body?.steps ?? null;
  const stepsAvg = meanOf(earlier, 'steps');

  const food = todayRow.food;
  const target = Number(todayRow.energy?.target_kcal ?? settings.get('food_kcal_target')) || 0;

  const weight = latestOf(flat, 'weight_kg');
  const weekAgo = flat.find(d => d.weight_kg != null && d.day < (weight?.day || ''));
  const weightDelta = weight && weekAgo ? weight.value - Number(weekAgo.weight_kg) : null;

  const num = n => Math.round(n).toLocaleString('en-IN');

  renderStats(el, [
    {
      label: 'Sleep',
      value: lastNight ? formatHours(lastNight.value) : '—',
      sub: lastNight
        ? `${lastNight.day === today ? 'last night' : 'night before'}${sleepAvg != null ? ` · avg ${formatHours(sleepAvg)}` : ''}`
        : 'No night synced yet',
    },
    {
      label: 'Steps',
      value: steps != null ? num(steps) : '—',
      sub: stepsAvg != null ? `so far · avg ${num(stepsAvg)}` : 'so far today',
    },
    {
      label: 'Eaten',
      value: food?.eaten_kcal != null ? `${num(food.eaten_kcal)} kcal` : '—',
      sub: [
        target ? `of ${num(target)}` : null,
        food?.protein_g != null ? `${food.protein_g} g protein` : null,
      ].filter(Boolean).join(' · ') || 'Nothing logged yet',
    },
    {
      label: 'Weight',
      value: weight ? `${weight.value.toFixed(1)} kg` : '—',
      sub: weight
        ? `${weight.day === today ? 'today' : formatShortDate(weight.day)}${weightDelta != null ? ` · ${weightDelta > 0 ? '+' : weightDelta < 0 ? '−' : '±'}${Math.abs(weightDelta).toFixed(1)} this week` : ''}`
        : 'Not measured this week',
    },
  ]);
}

// ── This month, actually ─────────────────────────────────
//
// Every other number on this dashboard — savings rate, runway, time to FI —
// is derived from `monthly_expenses`, a figure typed into Settings once. The
// ledger knows what was actually spent. Putting the two side by side is the
// only place in the app where the plan meets the record, which makes it worth
// the strip it occupies.
//
// Work spend (a points row ticked as work) is reimbursed, so it is shown but
// not measured against a personal budget. Money moved between your own
// accounts is neither spend nor income (0017) and is not here at all.

function renderMonth(days, stats, today) {
  const strip = document.getElementById('dash-life-strip');
  if (!strip) return;

  let spend = 0, work = 0, events = 0;
  for (const d of days) {
    events += Number(d.events) || 0;
    spend += Number(d.money?.spend) || 0;
    work += Number(d.money?.work_spend) || 0;
  }
  if (!events) { removeCard('dash-life-card'); return; }
  const personal = Math.max(spend - work, 0);

  const budget = settings.get('monthly_expenses');

  // Pace, not just position: a third of the way through the month, half the
  // budget gone is the thing worth knowing. The thresholds and the wording
  // live in src/budget.js: red at 125% of budget, amber when over pace.
  const [y, m, dayOfMonth] = today.split('-').map(Number);
  const daysInMonth = new Date(y, m, 0).getDate();
  const status = budgetStatus({ spent: personal, budget, dayOfMonth, daysInMonth, money: formatINR });
  const toneClass = status.tone === 'ok' ? '' : `is-${status.tone}`;
  const { bar } = status;

  const categories = Object.entries(stats?.spend?.by_category || {})
    .sort((a, b) => b[1] - a[1]).slice(0, 4);

  strip.innerHTML = `
    <div class="life-strip">
      <div class="life-spend">
        <div class="life-spend-value mono ${toneClass}">${escapeHTML(formatINRFull(personal))}</div>
        <div class="life-spend-sub">
          of ${escapeHTML(formatINRFull(budget))}${work ? ` · plus ${escapeHTML(formatINR(work))} work` : ''}
        </div>
        <div class="progress-wrap life-bar ${toneClass}" role="img"
             aria-label="${escapeHTML(`${formatINRFull(personal)} of a ${formatINRFull(budget)} budget`)}">
          <div class="progress-bar" style="width:${bar.fill.toFixed(1)}%"></div>
          ${bar.overflow > 0 ? `<div class="life-overflow ${bar.beyond ? 'is-beyond' : ''}"
               style="left:${bar.fill.toFixed(1)}%;width:${bar.overflow.toFixed(1)}%"
               title="${escapeHTML(formatINRFull(status.over))} over budget"></div>` : ''}
          ${bar.budgetMark !== null ? `<span class="life-budget-mark" style="left:${bar.budgetMark.toFixed(1)}%"
               title="Budget: ${escapeHTML(formatINRFull(budget))}"></span>` : ''}
          <span class="life-pace" style="left:${bar.pace.toFixed(1)}%"
                title="Where the month is: day ${dayOfMonth} of ${daysInMonth}"></span>
        </div>
        <div class="life-spend-note ${toneClass}">${escapeHTML(status.note)}</div>
      </div>
      <div class="life-cats">
        ${categories.length ? categories.map(([key, value]) => `
          <div class="life-cat">
            <span class="life-cat-label">${escapeHTML(categoryMeta(key).label)}</span>
            <span class="life-cat-value mono">${escapeHTML(formatINRFull(value))}</span>
          </div>
        `).join('') : '<div class="life-cat"><span class="life-cat-label">No categorised spending yet</span></div>'}
      </div>
    </div>
  `;
}

// ── Latest ───────────────────────────────────────────────
//
// The last few things the ledger heard, newest first: an email order, a meal
// told to Edith, a card alert. It is here so a duplicate or a misread is seen
// the evening it happens, not in the weekly review.

const LATEST_COUNT = 8;
const SOURCE_ICON = { email: 'fa-envelope', hermes: 'fa-comment', manual: 'fa-pen' };

async function renderLatest(token) {
  const result = await ledger.searchEvents({ limit: LATEST_COUNT });
  if (token !== loadToken) return;
  const el = document.getElementById('dash-latest');
  if (!el) return;
  const events = result?.events || [];
  if (!events.length) { removeCard('dash-latest-card'); return; }

  const today = todayISO();
  el.innerHTML = events.map(event => {
    const day = localISODate(new Date(event.occurred_at));
    const when = day === today
      ? new Date(event.occurred_at).toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit', hour12: false })
      : formatShortDate(day);
    const amount = amountInr(event);
    const inflow = isInflow(event);
    const type = typeMeta(event.type);
    const source = SOURCE_ICON[event.source_type || event.sources?.[0]?.type] || null;
    // The extractor's titles end in the amount ("Zepto — ₹298"); it has its own column.
    const title = String(event.title || type.label).replace(/\s*[—–-]\s*[₹$€£]\s?[\d,.]+\s*$/, '');
    return `
      <li class="dash-latest-row">
        <span class="dash-latest-when mono">${escapeHTML(when)}</span>
        <i class="fas ${type.icon} dash-latest-icon" style="color:${type.color}" aria-hidden="true"></i>
        <span class="dash-latest-title" title="${escapeHTML(event.title || '')}">${escapeHTML(title)}</span>
        ${source ? `<i class="fas ${source} dash-latest-src" aria-hidden="true"></i>` : ''}
        <span class="dash-latest-amount mono ${inflow ? 'is-in' : ''}">${amount !== null && amount > 0 ? escapeHTML((inflow ? '+' : '') + formatINRFull(Math.round(amount))) : ''}</span>
      </li>`;
  }).join('');
}
