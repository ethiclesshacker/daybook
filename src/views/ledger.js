// ======================================================
// The Life timeline.
//
// A chronological record of what happened, newest first, grouped by day. The
// database is the product here — this screen exists so that a ledger filling
// itself from email is inspectable and correctable, not so that anything has
// to be typed into it.
//
// Three things every row must show, because they are what make the record
// trustworthy: when it happened, where the claim came from, and how sure the
// system is. An event with no visible provenance is indistinguishable from one
// a model made up.
// ======================================================

import * as api from '../ledger/api.js';
import { EVENT_TYPES, STATUSES, SOURCE_TYPES, SUBTYPES, typeMeta, statusMeta, sourceMeta, categoryMeta } from '../ledger/taxonomy.js';
// import { parseQuickEntry } from '../ledger/nlparse.js';  // now loaded on demand, see loadParser()
import { summariseItems } from '../ledger/items.js';
import { localDateISO, amountInr } from '../ledger/normalize.js';
import { formatTime as fmtTime, formatDayHeading, toLocalInput, dayStartISO } from '../ledger/dates.js';
import { isInflow, moneyFlow } from '../ledger/summary.js';
import * as settings from '../settings.js';
import {
  escapeHTML, formatINRFull, formatMoney, isINR, openModal, closeModal, showToast, todayISO, downloadCSV, downloadBlob,
  comboboxHTML, wireCombobox, renderKpiCards, emptyState, safeHttpUrl, timeAgo,
} from '../utils.js';

// The sentence parser is 1,100 lines of rules that only the quick-add dialog
// uses, so it is its own chunk, fetched when that dialog opens.
let parserModule = null;
const loadParser = () => (parserModule ??= import('../ledger/nlparse.js'));

// The timeline asks for this many at a time; "Load more" asks for the next page.
const PAGE = 200;

let events = [];
let summaries = {};
// How many events match what is on screen, of which `events` holds the first
// few hundred. It was read and never shown, so a truncated list looked whole.
let total = 0;
let activeTab = 'timeline';       // timeline | review
let filters = { query: '', types: [], statuses: [], sourceTypes: [], from: null, to: null };
let searchDebounce = null;
// A load that resolves after the user has left must not paint a dead DOM.
let loadToken = 0;
// The click-outside handler for the filter panel lives on `document`, so it
// has to be removed on unmount or every visit stacks another one.
let docClickHandler = null;

const timeZone = () => settings.get('ledger_timezone') || 'Asia/Kolkata';
const formatTime = iso => fmtTime(iso, timeZone());

export async function renderLedger(container) {
  activeTab = 'timeline';
  filters = { query: '', types: [], statuses: [], sourceTypes: [], from: null, to: null };

  container.innerHTML = `
    <div class="page-header lg-header">
      <div class="page-header-left">
        <h2>Life</h2>
        <p>A structured record of what happened — mostly filled in by itself</p>
      </div>
      <div class="lg-header-right">
        <div class="lg-header-actions">
          <span id="lg-ingest-badge" class="badge badge-gray" title="Last ingestion run">
            <i class="fas fa-circle-notch fa-spin" aria-hidden="true"></i> Checking…
          </span>
          <button type="button" class="btn-sm btn-ghost" id="lg-export-btn">
            <i class="fas fa-download"></i> Export
          </button>
        </div>
      </div>
    </div>

    <div class="page-body lg-body vp-page">
      <div class="kpi-grid lg-kpis" id="lg-stats"></div>

      <div class="table-section vp-panel">
        <div class="table-toolbar fd-toolbar">
          <div class="table-tabs" role="tablist" aria-label="Life views">
            <button type="button" class="table-tab active" id="lg-tab-timeline" role="tab" aria-selected="true">
              <i class="fas fa-stream" aria-hidden="true"></i>Timeline
            </button>
            <button type="button" class="table-tab" id="lg-tab-review" role="tab" aria-selected="false">
              <i class="fas fa-circle-question" aria-hidden="true"></i>Review
              <span class="kpi-badge neutral" id="lg-review-count">0</span>
            </button>
          </div>
          <div class="lg-controls">
            <div class="search-input-wrap lg-search">
              <i class="fas fa-search"></i>
              <input type="search" class="search-input" id="lg-search" placeholder="Search the ledger" aria-label="Search the ledger" />
            </div>
            <details class="lg-filters" id="lg-filters">
              <summary title="Narrow the timeline">
                <i class="fas fa-sliders" aria-hidden="true"></i>
                <span>Filter</span>
                <span class="lg-filter-count" id="lg-filter-count" hidden></span>
              </summary>
              <div class="lg-filter-grid">
                <label class="lg-field">
                  <span>Type</span>
                  <select class="form-select lg-filter" id="lg-filter-type">
                    <option value="">Any</option>
                    ${EVENT_TYPES.map(t => `<option value="${t.id}">${escapeHTML(t.label)}</option>`).join('')}
                  </select>
                </label>
                <label class="lg-field">
                  <span>Source</span>
                  <select class="form-select lg-filter" id="lg-filter-source">
                    <option value="">Any</option>
                    ${SOURCE_TYPES.map(t => `<option value="${t.id}">${escapeHTML(t.label)}</option>`).join('')}
                  </select>
                </label>
                <label class="lg-field">
                  <span>State</span>
                  <select class="form-select lg-filter" id="lg-filter-status">
                    <option value="">Any</option>
                    ${STATUSES.map(t => `<option value="${t.id}">${escapeHTML(t.label)}</option>`).join('')}
                  </select>
                </label>
                <label class="lg-field">
                  <span>From</span>
                  <input type="date" class="form-input lg-filter" id="lg-filter-from" />
                </label>
                <label class="lg-field">
                  <span>To</span>
                  <input type="date" class="form-input lg-filter" id="lg-filter-to" />
                </label>
                <button type="button" class="btn-sm btn-ghost" id="lg-clear-filters">Clear all</button>
              </div>
            </details>
            <button type="button" class="btn-icon" id="lg-refresh-btn" title="Check for new events" aria-label="Check for new events">
              <i class="fas fa-rotate-right"></i>
            </button>
          </div>
        </div>
        <div class="vp-scroll">
          <div id="lg-timeline"></div>
        </div>
      </div>
    </div>

    <button type="button" class="fab" id="lg-fab" title="Add event" aria-label="Add event">
      <i class="fas fa-plus"></i>
    </button>
  `;

  document.getElementById('lg-tab-timeline').addEventListener('click', () => switchTab('timeline'));
  document.getElementById('lg-tab-review').addEventListener('click', () => switchTab('review'));
  document.getElementById('lg-fab').addEventListener('click', () => openQuickAdd());
  document.getElementById('lg-refresh-btn').addEventListener('click', () => { api.refresh(); loadData(); });
  document.getElementById('lg-export-btn').addEventListener('click', exportLedger);

  document.getElementById('lg-search').addEventListener('input', e => {
    filters.query = e.target.value.trim();
    clearTimeout(searchDebounce);
    searchDebounce = setTimeout(loadData, 250);
  });

  document.getElementById('lg-clear-filters').addEventListener('click', () => {
    document.querySelectorAll('.lg-filter').forEach(el => { el.value = ''; });
    filters = { ...filters, types: [], statuses: [], sourceTypes: [], from: null, to: null };
    reflectFilterCount();
    loadData();
  });

  document.querySelectorAll('.lg-filter').forEach(el => el.addEventListener('change', () => {
    filters.types       = pick('lg-filter-type');
    filters.sourceTypes = pick('lg-filter-source');
    filters.statuses    = pick('lg-filter-status');
    filters.from = dayBoundary('lg-filter-from', false);
    filters.to   = dayBoundary('lg-filter-to', true);
    reflectFilterCount();
    loadData();
  }));

  reflectFilterCount();

  // The filters are a panel floating over the timeline now, so they need the
  // two things every panel needs: a click outside and Escape both close it.
  const filterPanel = document.getElementById('lg-filters');
  if (docClickHandler) document.removeEventListener('click', docClickHandler);
  docClickHandler = e => {
    if (filterPanel.open && !e.target.closest('#lg-filters')) filterPanel.open = false;
  };
  document.addEventListener('click', docClickHandler);
  filterPanel.addEventListener('keydown', e => {
    if (e.key === 'Escape') { filterPanel.open = false; filterPanel.querySelector('summary').focus(); }
  });

  await loadData();
}

export { renderLedger as render };

/** Drop the document listener and the pending search before the DOM goes. */
export function unmount() {
  loadToken++;
  clearTimeout(searchDebounce);
  searchDebounce = null;
  if (docClickHandler) document.removeEventListener('click', docClickHandler);
  docClickHandler = null;
}

/** Show how many filters are on, so a narrowed timeline never looks empty. */
function reflectFilterCount() {
  const active = [...document.querySelectorAll('.lg-filter')].filter(el => el.value).length;
  const badge = document.getElementById('lg-filter-count');
  const wrap = document.getElementById('lg-filters');
  if (!badge || !wrap) return;
  badge.textContent = active;
  badge.hidden = active === 0;
  wrap.classList.toggle('is-active', active > 0);
}

function pick(id) {
  const value = document.getElementById(id)?.value;
  return value ? [value] : [];
}

/** A date input is a local calendar day; the ledger stores instants. */
function dayBoundary(id, exclusiveEnd) {
  const value = document.getElementById(id)?.value;
  if (!value) return null;
  const [y, m, d] = value.split('-').map(Number);
  const date = new Date(Date.UTC(y, m - 1, d + (exclusiveEnd ? 1 : 0)));
  // Approximate the user's zone by asking the browser for the same wall clock.
  return new Date(date.toISOString().slice(0, 10) + 'T00:00:00' + zoneSuffix()).toISOString();
}

function zoneSuffix() {
  const offset = -new Date().getTimezoneOffset();
  const sign = offset >= 0 ? '+' : '-';
  const pad = n => String(Math.floor(Math.abs(n))).padStart(2, '0');
  return `${sign}${pad(offset / 60)}:${pad(offset % 60)}`;
}

async function switchTab(tab) {
  activeTab = tab;
  for (const [name, el] of [['timeline', 'lg-tab-timeline'], ['review', 'lg-tab-review']]) {
    const button = document.getElementById(el);
    button?.classList.toggle('active', tab === name);
    button?.setAttribute('aria-selected', String(tab === name));
  }
  // The other tab's list starts at its top, not wherever Load more left this one.
  const scroller = document.querySelector('#view-container .vp-scroll');
  if (scroller) scroller.scrollTop = 0; else window.scrollTo(0, 0);
  await loadData();
}

async function loadData() {
  afterMutate = loadData;
  const token = ++loadToken;
  const container = document.getElementById('lg-timeline');
  if (container) container.innerHTML = `<div class="skeleton skeleton--table"></div>`;

  try {
    const [result, review, runs, written, kpiStats] = await Promise.all([
      activeTab === 'review' ? api.reviewQueue(PAGE) : api.searchEvents({ ...filters, limit: PAGE }),
      api.reviewQueue(PAGE),
      api.recentRuns(3).catch(() => []),
      // Written nightly from the same events. Missing summaries are normal —
      // a day the job has not reached yet simply has none.
      api.dailySummaries(null, null).catch(() => ({})),
      // The header numbers come from ledger_stats over fixed windows, never
      // from the list below: they used to be counted off `events`, so the
      // Review tab or a filter quietly changed what "Today" and "7 days" meant.
      loadKpiStats().catch(() => null),
      settings.ready(),
    ]);
    if (token !== loadToken || !container?.isConnected) return;

    summaries = written || {};

    events = result?.events || [];
    total = result?.total ?? events.length;

    const reviewCount = review?.total ?? 0;
    const badge = document.getElementById('lg-review-count');
    if (badge) badge.textContent = reviewCount;

    renderKPIs(reviewCount, kpiStats);
    renderIngestBadge(runs);
    renderTimeline();
  } catch (err) {
    if (token !== loadToken) return;
    if (container) {
      container.innerHTML = emptyState({
        icon: 'fa-triangle-exclamation', tone: 'warning',
        title: 'Could not load the ledger.', hint: err.message,
        detail: 'If this says a function is missing, the ledger migrations (<code>0003_event_ledger.sql</code>, <code>0004_ledger_api.sql</code>) have not been run yet.',
      });
    }
  }
}

function renderIngestBadge(runs) {
  const badge = document.getElementById('lg-ingest-badge');
  if (!badge) return;

  const last = runs?.[0];
  if (!last) {
    badge.className = 'badge badge-gray';
    badge.innerHTML = `<i class="fas fa-plug" aria-hidden="true"></i> No ingestion yet`;
    badge.title = 'Run: npm run ledger:ingest';
    return;
  }

  const ago = timeAgo(last.started_at);

  const tone = last.status === 'succeeded' ? 'badge-green'
             : last.status === 'partial' ? 'badge-yellow' : 'badge-red';
  badge.className = `badge ${tone}`;
  badge.innerHTML = `<i class="fas fa-envelope" aria-hidden="true"></i> ${escapeHTML(last.source_type)} · ${ago}`;
  badge.title = `${last.status} — ${last.items_seen} seen, ${last.events_created} created, ${last.events_updated} updated`;
}

/**
 * The header's three windows, from ledger_stats: today and the last seven
 * days on the ledger's clock, and everything (for the share that arrived by
 * itself). Spend is the server's total, which applies the one money-flow rule
 * and — as the currency work lands — converts non-rupee amounts; the browser
 * adding up `data.amount` mixed dollars into rupees.
 */
function loadKpiStats() {
  const zone = timeZone();
  const today = localDateISO(new Date(), zone);
  const weekStart = localDateISO(new Date(Date.now() - 6 * 86_400_000), zone);
  const startOf = day => dayStartISO(day, zone);
  return Promise.all([
    api.stats(startOf(today), null),
    api.stats(startOf(weekStart), null),
    api.stats(null, null),
  ]).then(([day, week, all]) => ({ day, week, all }));
}

const plural = (n, word) => `${n.toLocaleString('en-IN')} ${word}${n === 1 ? '' : 's'}`;

function renderKPIs(reviewCount, kpiStats) {
  const grid = document.getElementById('lg-stats');
  if (!grid) return;

  const count = s => Number(s?.event_count) || 0;
  const spend = s => Number(s?.spend?.total) || 0;
  const todayCount = count(kpiStats?.day);
  const weekCount = count(kpiStats?.week);
  const allCount = count(kpiStats?.all);
  const bySource = kpiStats?.all?.by_source || {};
  const byHand = (Number(bySource.manual) || 0) + (Number(bySource.hermes) || 0);
  const auto = Math.max(allCount - byHand, 0);
  const autoPct = allCount ? Math.round((auto / allCount) * 100) : 0;
  const missing = kpiStats ? '' : 'unavailable';

  // Full cards, not the header chips these used to be. The chips existed
  // because four cards pushed a *scrolling* timeline down to three visible
  // rows — but the timeline scrolls inside its own panel now, so the cards no
  // longer cost it anything. Same trade, opposite answer.
  renderKpiCards(grid, [
    { id: 'lg-kpi-today', label: 'Today', icon: 'fa-calendar-day',
      // "3 events", not a bare "3" beside the word Today.
      value: todayCount ? todayCount.toLocaleString('en-IN') : '—', unit: todayCount ? (todayCount === 1 ? 'event' : 'events') : '',
      sub: missing || (todayCount ? `${formatINRFull(spend(kpiStats.day))} spent` : 'nothing yet'),
      raw: todayCount },
    { id: 'lg-kpi-week', label: '7 days', icon: 'fa-calendar-week', tone: 'teal',
      value: weekCount.toLocaleString('en-IN'), unit: weekCount === 1 ? 'event' : 'events',
      sub: missing || `${formatINRFull(spend(kpiStats.week))} spent`,
      raw: weekCount },
    { id: 'lg-kpi-auto', label: 'Automatic', icon: 'fa-wand-magic-sparkles', tone: 'purple',
      value: `${autoPct}%`, sub: missing || `${auto.toLocaleString('en-IN')} of ${plural(allCount, 'event')}`,
      tooltip: 'Events the ledger filled in by itself, from email and card alerts, across the whole ledger',
      raw: autoPct },
    { id: 'lg-kpi-review', label: 'To review', icon: 'fa-circle-question',
      tone: reviewCount ? 'warning' : 'success',
      value: String(reviewCount),
      badge: reviewCount ? undefined : { type: 'ok', text: 'All clear' },
      sub: reviewCount ? 'needs a look — click to open' : 'nothing waiting',
      tooltip: reviewCount ? 'Open the review queue' : '',
      raw: reviewCount },
  ]);

  // The review card is a door, not just a number.
  const reviewCard = document.getElementById('lg-kpi-review');
  if (reviewCard && reviewCount) {
    reviewCard.addEventListener('click', () => switchTab('review'));
  }
}

// ── Timeline ───────────────────────────────────────────

function renderTimeline() {
  const container = document.getElementById('lg-timeline');
  if (!container) return;

  if (!events.length) {
    container.innerHTML = timelineEmptyState();
    return;
  }
  const truncated = total > events.length;

  const days = new Map();
  for (const event of events) {
    const day = localDateISO(event.occurred_at, timeZone());
    if (!days.has(day)) days.set(day, []);
    days.get(day).push(event);
  }

  const today = localDateISO(new Date(), timeZone());
  const yesterday = localDateISO(new Date(Date.now() - 86_400_000), timeZone());

  container.innerHTML = `<div class="timeline">${[...days.entries()].map(([day, list]) => {
    const heading = day === today ? 'Today' : day === yesterday ? 'Yesterday' : formatDayHeading(day);
    // Money out only. A refund landing on a Tuesday should not read as if the
    // day cost less than it did. In rupees: amount_inr converts a $20 charge
    // at its month's rate, and a non-cash unit (NeuCoins) adds nothing.
    const dayTotal = list.reduce((sum, e) => sum + (isInflow(e) ? 0 : (amountInr(e) || 0)), 0);
    const written = summaries[day];

    return `
      <section class="tl-day" aria-label="${escapeHTML(heading)}">
        <header class="tl-day-head">
          <div class="tl-day-id">
            <span class="tl-day-label">${escapeHTML(heading)}</span>
            <span class="tl-day-meta">
              ${list.length} event${list.length === 1 ? '' : 's'}${dayTotal ? ` · ${escapeHTML(formatINRFull(dayTotal))}` : ''}
            </span>
          </div>
          ${written?.summary ? `
            <div class="tl-day-summary is-clamped" role="button" tabindex="0"
                    aria-expanded="false"
                    title="Written from these events by ${escapeHTML(written.generated_by || 'the system')}">
              ${summaryHTML(written.summary)}
            </div>` : ''}
        </header>
        ${list.map(renderRow).join('')}
      </section>`;
  }).join('')}</div>
  ${truncated ? `
    <div class="lg-more">
      <span class="lg-more-count">Showing ${events.length.toLocaleString('en-IN')} of ${total.toLocaleString('en-IN')}</span>
      <button type="button" class="btn-sm btn-ghost" id="lg-load-more">
        Load ${Math.min(PAGE, total - events.length).toLocaleString('en-IN')} more
      </button>
    </div>` : ''}`;

  document.getElementById('lg-load-more')?.addEventListener('click', e => loadMore(e.currentTarget));

  // A day's summary opens to full length on click. Clamped, it says enough to
  // decide whether to read on; unclamped on every day, it buries the events it
  // is describing — on a two-event day the paragraph was longer than the day.
  // A div with a button role rather than a <button>: the summary can now
  // hold a list, and a list is not allowed inside a button.
  container.querySelectorAll('.tl-day-summary').forEach(el => {
    const toggle = () => {
      const open = el.classList.toggle('is-clamped') === false;
      el.setAttribute('aria-expanded', String(open));
    };
    el.addEventListener('click', toggle);
    el.addEventListener('keydown', e => {
      if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); toggle(); }
    });
  });

  container.querySelectorAll('.tl-item').forEach(row => {
    row.addEventListener('click', () => openDetail(row.dataset.id));
    row.addEventListener('keydown', e => {
      if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); openDetail(row.dataset.id); }
    });
  });
}

/** The next page of the list on screen, appended — no repaint from the top. */
async function loadMore(button) {
  const token = loadToken;
  const scroller = button.closest('.vp-scroll');
  const keep = scroller ? scroller.scrollTop : window.scrollY;
  button.disabled = true;
  button.textContent = 'Loading…';
  try {
    const next = activeTab === 'review'
      // ledger_review_queue has no offset; it is a search on two statuses, so
      // ask for a longer queue and keep what is new.
      ? await api.reviewQueue(events.length + PAGE)
      : await api.searchEvents({ ...filters, limit: PAGE, offset: events.length });
    if (token !== loadToken) return;
    const seen = new Set(events.map(e => e.id));
    events = events.concat((next?.events || []).filter(e => !seen.has(e.id)));
    total = next?.total ?? total;
    renderTimeline();
    if (scroller) scroller.scrollTop = keep; else window.scrollTo(0, keep);
  } catch (err) {
    showToast('Could not load more: ' + err.message, 'error');
    button.disabled = false;
    button.textContent = 'Try again';
  }
}

/**
 * A day summary as markup. The writer uses markdown-ish dashes for a list of
 * moments; shown raw they ran together as "- Lunch at … - Cab to …". Lines
 * starting with "-", "*" or "•" become a list; everything is escaped.
 */
function summaryHTML(text) {
  const lines = String(text).split(/\r?\n/).map(l => l.trim()).filter(Boolean);
  const out = [];
  let items = [];
  const flush = () => {
    if (items.length) out.push(`<ul class="tl-summary-list">${items.map(i => `<li>${escapeHTML(i)}</li>`).join('')}</ul>`);
    items = [];
  };
  for (const line of lines) {
    const bullet = /^[-*•]\s+(.*)$/.exec(line);
    if (bullet) { items.push(bullet[1]); continue; }
    flush();
    out.push(`<span class="tl-summary-para">${escapeHTML(line)}</span>`);
  }
  flush();
  return out.join('');
}

/**
 * Why an event is waiting for you, in words. The queue showed a list of
 * ordinary-looking rows with nothing to say what was doubtful about them.
 */
function reviewReason(event) {
  const bits = [];
  const confidence = Number(event.confidence);
  if (event.confidence !== null && event.confidence !== undefined && Number.isFinite(confidence)) {
    bits.push(`${Math.round(confidence * 100)}% confident`);
  }
  const why = event.inference?.review_reason || event.inference?.reason;
  if (why) bits.push(String(why));
  else if (event.inference?.model || event.inference?.llm_note) bits.push('read by the model, not a rule');
  if (Number.isFinite(Number(event.data?.amount)) && !(event.data?.merchant || event.data?.restaurant || event.data?.place)
      && !(event.entities || []).length) bits.push('no merchant named');
  if (event.source_count <= 1 && event.source_type !== 'manual') bits.push('one source');
  return bits.join(' · ');
}

function renderRow(event) {
  const type = typeMeta(event.type);
  const status = statusMeta(event.status);
  const source = sourceMeta(event.source_type);
  const amount = Number(event.data?.amount);
  const currency = event.data?.currency;
  // Green and signed only for money that actually arrived — not for a transfer
  // between your own accounts, which is neither in nor out.
  const inflow = moneyFlow(event) === 'inflow';

  // Everything that is not the amount. The amount used to appear twice — once
  // inside the title the extractor wrote and again in this line — so it is now
  // pulled out into its own right-hand column where the figures align down the
  // day and can actually be compared.
  const bits = [];
  if (event.data?.origin && event.data?.destination) bits.push(`${event.data.origin} → ${event.data.destination}`);
  const where = event.data?.restaurant || event.data?.merchant || event.data?.place;
  if (where && !event.title.includes(where)) bits.push(where);
  // What was in the order, when the receipt listed it. On a food row this is
  // the line worth reading: "Kapoor's Cafe" is where, "Matar Paneer Mini
  // Thali" is what actually happened.
  const basket = summariseItems(event.data?.items);
  if (basket) bits.push(basket);
  const people = (event.entities || []).filter(e => e.type === 'person').map(e => e.name);
  if (people.length) bits.push(people.slice(0, 3).join(', '));

  const needsReview = event.status === 'needs_review';
  const scheduled = event.status === 'scheduled';
  // `inferred` is the common case for extracted events, so a badge on every
  // row would be wallpaper. It reads as a dimmed rule on the left edge
  // instead, and only the genuinely uncertain get a badge.
  const uncertain = event.status === 'inferred';

  const title = stripTrailingAmount(event.title);
  // Money rows say what the money was for ("Purchase · Travel"), which is the
  // question a row answers; the subtype ("card transaction") says how it was paid.
  const spendFor = amountInr(event) !== null && moneyFlow(event) === 'spend' && event.category && event.category !== 'other'
    ? categoryMeta(event.category).label : null;
  const typeLine = spendFor ?? (event.subtype ? event.subtype.replace(/_/g, ' ') : null);

  return `
    <article class="tl-item ${needsReview ? 'is-review' : ''} ${uncertain ? 'is-inferred' : ''}"
             data-id="${escapeHTML(event.id)}" role="button" tabindex="0"
             aria-label="${escapeHTML(event.title)}">
      <div class="tl-when">
        <span class="tl-time mono">${escapeHTML(formatTime(event.occurred_at))}</span>
        <span class="tl-src" title="From ${escapeHTML(source.label)}${event.source_count > 1 ? ` · ${event.source_count} sources agree` : ''}">
          <i class="fas ${source.icon}" aria-hidden="true"></i>${event.source_count > 1 ? `<b>${event.source_count}</b>` : ''}
        </span>
      </div>

      <span class="tl-icon" style="--tint:${type.color}"><i class="fas ${type.icon}" aria-hidden="true"></i></span>

      <div class="tl-body">
        <h3 class="tl-title">${escapeHTML(title)}</h3>
        <div class="tl-meta">
          <span class="tl-type" style="color:${type.color}">${escapeHTML(type.label)}${typeLine ? ` · ${escapeHTML(typeLine)}` : ''}</span>
          ${bits.map(b => `<span>${escapeHTML(b)}</span>`).join('')}
          ${needsReview ? `<span class="tl-flag" title="${escapeHTML(status.hint)}">Needs review</span>` : ''}
          ${scheduled ? `<span class="tl-flag is-scheduled" title="${escapeHTML(status.hint)}">Scheduled</span>` : ''}
        </div>
        ${activeTab === 'review' && (needsReview || uncertain) ? `
          <div class="tl-why"><i class="fas fa-circle-question" aria-hidden="true"></i>${escapeHTML(reviewReason(event) || status.hint)}</div>` : ''}
      </div>

      ${Number.isFinite(amount) ? `
        <div class="tl-amount mono ${inflow ? 'is-in' : ''} ${!inflow && isINR(currency) && amount >= 5000 ? 'is-large' : ''}">
          ${inflow ? '+' : ''}${escapeHTML(formatMoney(amount, currency))}
        </div>` : '<div class="tl-amount"></div>'}
    </article>`;
}

/**
 * Extractors put the amount in the title ("Zomato — ₹140") because a title has
 * to stand alone in a search result or a Hermes answer. In the timeline the
 * amount has its own column, so printing it twice on one row is just noise.
 */
function stripTrailingAmount(title) {
  return String(title).replace(/\s*[—–-]\s*[+]?[₹$€£]\s*[\d,]+(?:\.\d{1,2})?\s*$/, '').trim() || title;
}

function timelineEmptyState() {
  const filtered = filters.query || filters.types.length || filters.statuses.length
                || filters.sourceTypes.length || filters.from || filters.to;

  if (activeTab === 'review') {
    return emptyState({
      icon: 'fa-circle-check', tone: 'success', title: 'Nothing waiting for review.',
      hint: 'Uncertain extractions land here to be confirmed, corrected, merged or dismissed.',
    });
  }

  if (filtered) {
    return emptyState({ icon: 'fa-filter-circle-xmark', title: 'No events match those filters.' });
  }

  return emptyState({
    icon: 'fa-stream', tone: 'accent', title: 'The ledger is empty.',
    detail: 'It is meant to fill itself. Connect a mailbox in <code>ledger/accounts.json</code> and run '
          + '<code>npm run ledger:ingest</code> — or add something by hand with the + button.',
  });
}



// ── Detail ─────────────────────────────────────────────

/**
 * The event detail modal, opened from another screen.
 *
 * `onChange` is what to reload after a confirm, edit, merge or dismissal — the
 * Food page needs its own list refreshed, not this one's. It is held on the
 * module rather than threaded through every nested modal, because the edit and
 * merge dialogs are opened *by* the detail modal and have to refresh the same
 * caller.
 */
let afterMutate = loadData;

export function openEventDetail(eventId, onChange) {
  afterMutate = onChange || loadData;
  return openDetail(eventId);
}

async function openDetail(eventId) {
  openModal({ title: 'Event', body: '<div class="skeleton skeleton--table"></div>' });

  let event;
  try {
    event = await api.getEvent(eventId);
  } catch (err) {
    showToast('Could not load that event: ' + err.message, 'error');
    closeModal();
    return;
  }
  if (!event) { showToast('That event no longer exists.', 'error'); closeModal(); return; }

  const type = typeMeta(event.type);
  const status = statusMeta(event.status);
  const automatic = event.source_type !== 'manual' && event.source_type !== 'hermes';
  const needsAttention = event.status === 'needs_review' || event.status === 'inferred';

  openModal({
    title: stripTrailingAmount(event.title),
    icon: type.icon, iconColor: type.color,
    body: `
      <div class="lg-detail-head">
        <div class="lg-detail-when">
          <span class="mono">${escapeHTML(formatFullTime(event.occurred_at))}${
            event.occurred_at_end ? ` → ${escapeHTML(formatTime(event.occurred_at_end))}` : ''}</span>
          <span class="lg-detail-kind">
            ${escapeHTML(type.label)}${event.subtype ? ` · ${escapeHTML(event.subtype.replace(/_/g, ' '))}` : ''}
          </span>
        </div>
        <div class="lg-detail-badges">
          <span class="badge ${status.badge}" title="${escapeHTML(status.hint)}">${escapeHTML(status.label)}</span>
          <span class="badge ${automatic ? 'badge-blue' : 'badge-gray'}">
            ${automatic ? 'Extracted automatically' : 'Entered by you'}
          </span>
          ${event.confidence !== null && event.confidence !== undefined
            ? `<span class="badge badge-gray" title="How sure the extractor was">${Math.round(event.confidence * 100)}% confidence</span>` : ''}
        </div>
      </div>

      ${event.description ? `<p class="lg-detail-desc">${escapeHTML(event.description)}</p>` : ''}

      ${section('Facts', renderFields(event.data, event.data), 'What a source actually stated. Never overwritten by an interpretation.')}
      ${Object.keys(event.inference || {}).length
        ? section('Interpretation', renderFields(event.inference, event.data), 'Derived, not stated. Safe to disagree with.')
        : ''}

      ${section('Sources', renderSources(event.sources), 'Every piece of evidence for this event.')}
      ${event.entities?.length ? section('Entities', renderEntities(event.entities)) : ''}
      ${event.related_events?.length ? section('Related events', renderRelated(event.related_events)) : ''}
      ${event.history?.length ? section('History', renderHistory(event.history), 'Corrections are kept, not silently applied.') : ''}
      <dl class="lg-facts lg-detail-id">
        <dt class="lg-fact-key">Event ID</dt>
        <dd class="lg-fact-value is-wide">${idValue(event.id)}</dd>
      </dl>`,
    footerClass: 'is-wrap lg-detail-footer',
    // Delete sits apart, on the left, in red; Close is where the eye ends, on
    // the right. They used to be neighbours, one click apart.
    footer: `
      <button type="button" class="btn-sm btn-danger lg-footer-start" id="lg-delete-btn"><i class="fas fa-trash" aria-hidden="true"></i> Delete</button>
      ${needsAttention ? `<button type="button" class="btn-sm btn-accent" id="lg-confirm-btn"><i class="fas fa-check" aria-hidden="true"></i> Confirm</button>` : ''}
      <button type="button" class="btn-sm btn-ghost" id="lg-merge-btn"><i class="fas fa-code-merge" aria-hidden="true"></i> Merge</button>
      <button type="button" class="btn-sm btn-ghost" id="lg-edit-btn"><i class="fas fa-pencil" aria-hidden="true"></i> Edit</button>
      <button type="button" class="btn-sm btn-ghost" id="lg-dismiss-btn"><i class="fas fa-ban" aria-hidden="true"></i> Dismiss</button>
      <button type="button" class="btn-cancel" data-close>Close</button>`,
  });

  wireCopyButtons();

  document.getElementById('lg-confirm-btn')?.addEventListener('click', async () => {
    await mutate(() => api.updateEvent(event.id, { status: 'confirmed' }), 'Confirmed.');
  });

  document.getElementById('lg-edit-btn').addEventListener('click', () => openEdit(event));
  document.getElementById('lg-merge-btn').addEventListener('click', () => openMerge(event));

  document.getElementById('lg-dismiss-btn').addEventListener('click', async () => {
    const reason = prompt('Why is this not a real event? (optional)') ?? undefined;
    await mutate(() => api.dismissEvent(event.id, reason || null),
                 'Dismissed. It will not be re-created by a later run.');
  });

  document.getElementById('lg-delete-btn').addEventListener('click', async () => {
    if (!confirm('Delete this event permanently? Dismissing is usually better — it keeps the provenance and stops it coming back.')) return;
    const purge = confirm('Also delete the stored source references, if nothing else uses them?');
    await mutate(() => api.deleteEvent(event.id, purge), 'Deleted.');
  });
}

async function mutate(action, successMessage) {
  try {
    await action();
    showToast(successMessage);
    closeModal();
    await afterMutate();
  } catch (err) {
    showToast(err.message, 'error');
  }
}

function section(title, body, hint) {
  if (!body) return '';
  return `
    <div class="lg-section">
      <div class="lg-section-title">
        ${escapeHTML(title)}
        ${hint ? `<span class="lg-section-hint">${escapeHTML(hint)}</span>` : ''}
      </div>
      ${body}
    </div>`;
}

// Words a key is spelt with that read wrong in sentence case.
const KEY_WORDS = {
  id: 'ID', llm: 'LLM', upi: 'UPI', vpa: 'VPA', url: 'URL', utr: 'UTR', otp: 'OTP', inr: 'INR',
  pnr: 'PNR', gst: 'GST', gstin: 'GSTIN', kcal: 'kcal', ref: 'ref', eta: 'ETA', imap: 'IMAP',
};

/** "llm_note" → "LLM note", "order_id" → "Order ID". */
export function humaniseKey(key) {
  if (key === 'raw') return 'As first read';   // inference.raw: what the extractor said before normalising
  const words = String(key).split(/[_\s]+/).filter(Boolean)
    .map(w => KEY_WORDS[w.toLowerCase()] ?? w.toLowerCase());
  if (!words.length) return '';
  const [first, ...rest] = words;
  const lead = /^[A-Z]{2,}$/.test(first) || first === 'kcal' ? first : first[0].toUpperCase() + first.slice(1);
  return [lead, ...rest].join(' ');
}

/** Identifier-shaped: a key ending in id/ref/number, or one long unbroken token. */
function isIdentifier(key, value) {
  if (typeof value !== 'string' && typeof value !== 'number') return false;
  const text = String(value);
  return /(^|_)(id|ref|reference|number|no|utr|pnr|txn)$/i.test(key) || (/^\S{20,}$/.test(text) && !/^https?:/i.test(text));
}

/** An ID: monospace, cut with an ellipsis where it does not fit, and a copy button. */
function idValue(value) {
  const text = String(value);
  return `<span class="lg-id"><span class="lg-id-text mono" title="${escapeHTML(text)}">${escapeHTML(text)}</span>
    <button type="button" class="btn-icon lg-copy" data-copy="${escapeHTML(text)}" title="Copy" aria-label="Copy ${escapeHTML(text)}">
      <i class="fas fa-copy" aria-hidden="true"></i></button></span>`;
}

function wireCopyButtons() {
  document.querySelectorAll('#modal-overlay .lg-copy').forEach(button => {
    button.addEventListener('click', () => {
      navigator.clipboard?.writeText(button.dataset.copy).then(
        () => showToast('Copied.'),
        () => showToast('Could not copy — select the text instead.', 'error'));
    });
  });
}

function renderFields(data, facts = data) {
  const entries = Object.entries(data || {}).filter(([, v]) => v !== null && v !== undefined && v !== '');
  if (!entries.length) return '';
  return `<dl class="lg-facts">${entries.map(([key, value]) => {
    if (isIdentifier(key, value)) {
      return `
      <dt class="lg-fact-key">${escapeHTML(humaniseKey(key))}</dt>
      <dd class="lg-fact-value is-wide">${idValue(value)}</dd>`;
    }
    const text = formatValue(key, value, facts);
    // Items lists, addresses and snippets need the whole row; a merchant or an
    // amount does not, and pairing those two-up halves the height.
    const wide = Array.isArray(value) || text.length > 38;
    return `
      <dt class="lg-fact-key">${escapeHTML(humaniseKey(key))}</dt>
      <dd class="lg-fact-value ${typeof value === 'number' || key === 'amount' ? 'mono' : ''} ${wide ? 'is-wide' : ''}">${escapeHTML(text)}</dd>`;
  }).join('')}</dl>`;
}

function formatValue(key, value, facts = {}) {
  // Exact here. The timeline rounds for scanning, but this section is the
  // record of what a source stated, and ₹94.58 is not ₹95 — and $25 is not ₹25.
  if (key === 'amount' && Number.isFinite(Number(value))) {
    return formatMoney(Number(value), facts?.currency, { exact: true });
  }
  if (Array.isArray(value)) {
    return value.map(v => (typeof v === 'object' && v !== null ? (v.name || JSON.stringify(v)) : String(v))).join(', ');
  }
  // Nested records (the extractor's original reading, kept under inference.raw)
  // read as "subtype: scheduled bill payment · category: bill payment", not JSON.
  if (typeof value === 'object' && value !== null) {
    return Object.entries(value)
      .filter(([, v]) => v !== null && v !== undefined && v !== '')
      .map(([k, v]) => `${k.replace(/_/g, ' ')}: ${typeof v === 'object' ? JSON.stringify(v) : String(v).replace(/_/g, ' ')}`)
      .join(' · ');
  }
  return String(value);
}

function renderSources(sources) {
  if (!sources?.length) return `<p class="modal-note">No source recorded — this event was created directly.</p>`;
  return `<div class="lg-sources">${sources.map(source => {
    const meta = sourceMeta(source.source_type);
    const subject = source.metadata?.subject;
    return `
      <div class="lg-source">
        <i class="fas ${meta.icon}" aria-hidden="true"></i>
        <div class="lg-source-body">
          <div class="lg-source-title">${escapeHTML(subject || meta.label)}</div>
          <div class="lg-source-meta">
            ${escapeHTML(source.role)} · ${escapeHTML(source.extracted_by || 'unknown')}
            ${source.metadata?.from ? ` · ${escapeHTML(source.metadata.from)}` : ''}
            ${source.source_timestamp ? ` · ${escapeHTML(formatFullTime(source.source_timestamp))}` : ''}
          </div>
          ${source.metadata?.snippet ? `<div class="lg-source-snippet">${escapeHTML(source.metadata.snippet)}</div>` : ''}
        </div>
        ${safeHttpUrl(source.external_url)
          // http(s) only: the URL came out of an email, and a javascript:
          // href runs on click however well it is escaped.
          ? `<a class="btn-sm btn-ghost" href="${escapeHTML(safeHttpUrl(source.external_url))}" target="_blank" rel="noopener noreferrer">Open</a>`
          : ''}
      </div>`;
  }).join('')}</div>`;
}

function renderEntities(entities) {
  return `<div class="lg-chips">${entities.map(entity => `
    <button type="button" class="lg-chip" data-entity="${escapeHTML(entity.name)}" title="${escapeHTML(entity.type)} · ${escapeHTML(entity.relationship)}">
      ${escapeHTML(entity.name)}
    </button>`).join('')}</div>`;
}

function renderRelated(related) {
  return `<div class="lg-sources">${related.map(item => `
    <div class="lg-source">
      <i class="fas ${typeMeta(item.type).icon}" style="color:${typeMeta(item.type).color}" aria-hidden="true"></i>
      <div class="lg-source-body">
        <div class="lg-source-title">${escapeHTML(item.title)}</div>
        <div class="lg-source-meta">${escapeHTML(item.relationship.replace(/_/g, ' '))} · ${escapeHTML(formatFullTime(item.occurred_at))}</div>
      </div>
    </div>`).join('')}</div>`;
}

function renderHistory(history) {
  return `<div class="lg-history">${history.slice(0, 8).map(entry => `
    <div class="lg-history-row">
      <span class="mono">${escapeHTML(formatFullTime(entry.at))}</span>
      <span>${escapeHTML(entry.action.replace(/_/g, ' '))}</span>
      <span class="text-muted">${escapeHTML(shortActor(entry.actor))}</span>
    </div>`).join('')}</div>`;
}

function shortActor(actor) {
  if (!actor) return '';
  if (actor.startsWith('job:') || actor === 'service_role' || actor === 'hermes') return actor;
  return 'you';
}

function formatFullTime(iso) {
  // "5 Oct 2026, 14:05" — the app's date style, with the time.
  return new Date(iso).toLocaleString('en-IN', {
    day: 'numeric', month: 'short', year: 'numeric',
    hour: '2-digit', minute: '2-digit', hour12: false, timeZone: timeZone(),
  });
}

// ── Add ────────────────────────────────────────────────

/**
 * Quick add. Type a sentence, see what was understood before committing.
 *
 * Parsing is local and deterministic (src/ledger/nlparse.js), so the preview
 * updates as you type and adding an event never depends on a model being
 * reachable. Whatever the parser guessed is shown as a guess.
 */
function openQuickAdd() {
  openModal({
    title: 'Add an event',
    body: `
      <div class="form-group">
        <label class="form-label" for="lg-add-input">What happened?</label>
        <input type="text" class="form-input" id="lg-add-input" autocomplete="off"
               placeholder="Had lunch at Third Wave around 1pm, ₹320" />
        <div class="form-hint">Plain language. Times, amounts, places and people are picked out as you type.</div>
      </div>

      <div class="lg-preview" id="lg-add-preview">
        <span class="text-muted">Start typing and the parsed event appears here.</span>
      </div>

      <details class="lg-advanced" id="lg-add-advanced">
        <summary>Adjust the details</summary>
        <div class="form-row">
          <div class="form-group">
            <label class="form-label" for="lg-add-when">When</label>
            <input type="datetime-local" class="form-input" id="lg-add-when" />
          </div>
          <div class="form-group">
            <label class="form-label" for="lg-add-type">Type</label>
            <select class="form-select" id="lg-add-type">
              ${EVENT_TYPES.map(t => `<option value="${t.id}">${escapeHTML(t.label)}</option>`).join('')}
            </select>
          </div>
        </div>
        <div class="form-row">
          <div class="form-group">
            <label class="form-label" for="lg-add-title">Title</label>
            <input type="text" class="form-input" id="lg-add-title" />
          </div>
          <div class="form-group">
            <label class="form-label" for="lg-add-amount">Amount (₹)</label>
            <input type="number" class="form-input" id="lg-add-amount" step="0.01" min="0" />
          </div>
        </div>
        <div class="form-group">
          <label class="form-label form-check">
            <input type="checkbox" id="lg-add-separate" />
            Keep this separate even if a similar event already exists
          </label>
          <div class="form-hint">By default a matching event absorbs this as extra evidence instead of being duplicated.</div>
        </div>
      </details>`,
    footer: `
      <button type="button" class="btn-cancel" data-close>Cancel</button>
      <button type="button" class="btn-submit" id="lg-add-submit">Add event</button>`,
  });

  const input = document.getElementById('lg-add-input');
  const preview = document.getElementById('lg-add-preview');
  let parsed = null;
  // The parser's chunk starts downloading as the dialog opens; the first
  // keystroke almost never beats it, and if one does it waits for it.
  let parseQuickEntry = null;
  const parserReady = loadParser().then(mod => { parseQuickEntry = mod.parseQuickEntry; });
  parserReady.catch(err => showToast('Could not load the sentence parser: ' + err.message, 'error'));

  const update = () => {
    const value = input.value.trim();
    if (!value) {
      parsed = null;
      preview.innerHTML = `<span class="text-muted">Start typing and the parsed event appears here.</span>`;
      return;
    }
    if (!parseQuickEntry) { parserReady.then(update, () => {}); return; }

    parsed = parseQuickEntry(value, { timeZone: timeZone() });
    if (!parsed) return;

    const { event, parsed: info } = parsed;
    const type = typeMeta(event.type);
    preview.innerHTML = `
      <div class="lg-preview-row">
        <i class="fas ${type.icon}" style="color:${type.color}" aria-hidden="true"></i>
        <strong>${escapeHTML(event.title)}</strong>
      </div>
      <div class="lg-preview-meta">
        <span>${escapeHTML(type.label)}${event.subtype ? ` · ${escapeHTML(event.subtype.replace(/_/g, ' '))}` : ''}</span>
        <span class="mono">${escapeHTML(formatFullTime(event.occurred_at))}</span>
        ${info.amount ? `<span>${escapeHTML(formatINRFull(info.amount))}</span>` : ''}
        ${info.place ? `<span>${escapeHTML(info.place)}</span>` : ''}
        ${info.people?.length ? `<span>${escapeHTML(info.people.join(', '))}</span>` : ''}
        ${event.status === 'scheduled' ? `<span class="badge badge-purple">Scheduled</span>` : ''}
      </div>
      ${info.assumed.length ? `<div class="lg-preview-assumed">
        Assumed: ${escapeHTML(info.assumed.map(a => a.replace('assumed_', '')).join(', '))} — adjust below if wrong.
      </div>` : ''}`;

    // Keep the structured fields in step with the sentence, so opening the
    // details panel shows what is about to be saved rather than a blank form.
    document.getElementById('lg-add-title').value = event.title;
    document.getElementById('lg-add-type').value = event.type;
    document.getElementById('lg-add-amount').value = event.data?.amount ?? '';
    document.getElementById('lg-add-when').value = toLocalInput(event.occurred_at);
  };

  input.addEventListener('input', update);
  input.focus();

  document.getElementById('lg-add-submit').addEventListener('click', async () => {
    try { await parserReady; } catch { return; }
    const text = input.value.trim();
    if (!text && !document.getElementById('lg-add-title').value.trim()) {
      showToast('Describe what happened first.', 'error');
      return;
    }

    if (!parsed) parsed = parseQuickEntry(text || document.getElementById('lg-add-title').value, { timeZone: timeZone() });
    if (!parsed) { showToast('Could not make an event out of that.', 'error'); return; }

    const whenInput = document.getElementById('lg-add-when').value;
    const amountInput = document.getElementById('lg-add-amount').value;

    const data = { ...parsed.event.data };
    if (amountInput !== '') { data.amount = Number(amountInput); data.currency = data.currency || 'INR'; }
    else delete data.amount;

    const type = document.getElementById('lg-add-type').value || parsed.event.type;
    const occurredAt = whenInput ? new Date(whenInput).toISOString() : parsed.event.occurred_at;
    const event = {
      occurred_at: occurredAt,
      type,
      // A subtype belongs to the type the parser chose; changing the type
      // in the form makes the old subtype a lie.
      subtype: type === parsed.event.type ? parsed.event.subtype : null,
      title: document.getElementById('lg-add-title').value.trim() || parsed.event.title,
      description: text || null,
      data,
      inference: parsed.event.inference,
      // "Dinner with Rahul tomorrow" is a plan until the clock says otherwise.
      status: new Date(occurredAt).getTime() > Date.now() + 60_000 ? 'scheduled' : 'confirmed',
    };

    await mutate(
      () => api.createEvent(event, parsed.event.entities, {
        allowMerge: !document.getElementById('lg-add-separate').checked,
      }),
      'Event added.');
  });
}

/**
 * The subtypes worth offering for a type: the ones this ledger already holds,
 * then the catalogue's.
 *
 * Subtype is open text — a connector may invent one and the database stores it
 * — which is exactly why a plain box was the wrong control. Every typo made a
 * second subtype that filters and totals would never bring back together.
 */
function knownSubtypes(type) {
  const seen = events.filter(e => e.type === type && e.subtype).map(e => e.subtype);
  return [...new Set([...seen, ...(SUBTYPES[type] || [])])];
}


// ── Edit ───────────────────────────────────────────────

/**
 * Correcting an event is a first-class action, not an escape hatch: automatic
 * extraction is going to be wrong sometimes, and the ledger is only worth
 * trusting if fixing it is easy. The previous values survive in the audit log.
 */
function openEdit(event) {
  openModal({
    title: 'Edit event',
    body: `
      <div class="form-row">
        <div class="form-group">
          <label class="form-label" for="lg-e-when">When</label>
          <input type="datetime-local" class="form-input" id="lg-e-when" value="${escapeHTML(toLocalInput(event.occurred_at))}" />
        </div>
        <div class="form-group">
          <label class="form-label" for="lg-e-type">Type</label>
          <select class="form-select" id="lg-e-type">
            ${EVENT_TYPES.map(t => `<option value="${t.id}" ${t.id === event.type ? 'selected' : ''}>${escapeHTML(t.label)}</option>`).join('')}
          </select>
        </div>
      </div>
      <div class="form-row">
        <div class="form-group">
          <label class="form-label" for="lg-e-title">Title</label>
          <input type="text" class="form-input" id="lg-e-title" value="${escapeHTML(event.title)}" />
        </div>
        <div class="form-group">
          <label class="form-label" for="lg-e-subtype">Subtype</label>
          ${comboboxHTML({
            id: 'lg-e-subtype',
            value: event.subtype || '',
            placeholder: 'optional',
            options: knownSubtypes(event.type),
          })}
        </div>
      </div>
      <div class="form-group">
        <label class="form-label" for="lg-e-desc">Description</label>
        <input type="text" class="form-input" id="lg-e-desc" value="${escapeHTML(event.description || '')}" />
      </div>
      <div class="form-group">
        <label class="form-label" for="lg-e-data">Facts (JSON)</label>
        <textarea class="form-input is-code" id="lg-e-data" rows="7" spellcheck="false">${escapeHTML(JSON.stringify(event.data || {}, null, 2))}</textarea>
        <div class="form-hint">
          What the sources stated. Editing here is a correction by you and replaces the extracted value.
        </div>
      </div>
      <div class="form-group">
        <label class="form-label" for="lg-e-status">State</label>
        <select class="form-select" id="lg-e-status">
          ${STATUSES.filter(s => s.id !== 'dismissed').map(s =>
            `<option value="${s.id}" ${s.id === event.status ? 'selected' : ''}>${escapeHTML(s.label)}</option>`).join('')}
        </select>
      </div>`,
    footer: `
      <button type="button" class="btn-cancel" id="lg-edit-cancel">Cancel</button>
      <button type="button" class="btn-submit" id="lg-edit-save">Save changes</button>`,
  });

  wireCombobox('lg-e-subtype');

  // Cancel goes back to the detail it came from; the × closes outright.
  document.getElementById('lg-edit-cancel').addEventListener('click', () => openDetail(event.id));

  document.getElementById('lg-edit-save').addEventListener('click', async () => {
    let data;
    try {
      data = JSON.parse(document.getElementById('lg-e-data').value || '{}');
    } catch (err) {
      showToast('The facts field is not valid JSON: ' + err.message, 'error');
      return;
    }

    const whenValue = document.getElementById('lg-e-when').value;
    await mutate(() => api.updateEvent(event.id, {
      occurred_at: whenValue ? new Date(whenValue).toISOString() : undefined,
      type: document.getElementById('lg-e-type').value,
      subtype: document.getElementById('lg-e-subtype').value.trim() || null,
      title: document.getElementById('lg-e-title').value.trim(),
      description: document.getElementById('lg-e-desc').value.trim() || null,
      status: document.getElementById('lg-e-status').value,
      data,
    }, { replaceData: true }), 'Saved.');
  });
}

// ── Merge ──────────────────────────────────────────────

async function openMerge(event) {
  openModal({ title: 'Merge duplicates', body: '<div class="skeleton skeleton--strip"></div>' });

  let candidates = [];
  try {
    candidates = await api.duplicateCandidates(event.id, 8);
  } catch (err) {
    showToast(err.message, 'error');
  }

  openModal({
    title: `Merge into “${event.title}”`,
    body: `
      <p class="modal-note">
        Pick the event that describes the same real-world thing. Its sources move across and this event keeps its facts.
      </p>
      ${candidates.length ? `<div class="lg-sources">${candidates.map(candidate => `
        <div class="lg-source">
          <i class="fas ${typeMeta(candidate.type).icon}" style="color:${typeMeta(candidate.type).color}" aria-hidden="true"></i>
          <div class="lg-source-body">
            <div class="lg-source-title">${escapeHTML(candidate.title)}</div>
            <div class="lg-source-meta">
              ${escapeHTML(formatFullTime(candidate.occurred_at))} ·
              ${escapeHTML(String(candidate.minutes_apart))} min apart ·
              name similarity ${escapeHTML(String(candidate.similarity))}
            </div>
          </div>
          <button type="button" class="btn-sm btn-accent lg-merge-pick" data-id="${escapeHTML(candidate.id)}">Merge</button>
        </div>`).join('')}</div>`
      : `<p class="modal-note">Nothing similar found nearby in time.</p>`}`,
    footer: `<button type="button" class="btn-cancel" id="lg-merge-cancel">Close</button>`,
  });

  // Close goes back to the detail it came from; the × closes outright.
  document.getElementById('lg-merge-cancel').addEventListener('click', () => openDetail(event.id));

  document.querySelectorAll('.lg-merge-pick').forEach(button => {
    button.addEventListener('click', async () => {
      await mutate(() => api.mergeEvents(event.id, button.dataset.id), 'Merged.');
    });
  });
}

// ── Export ─────────────────────────────────────────────

function exportLedger() {
  openModal({
    title: 'Export',
    body: `
      <p class="modal-note">
        Your ledger, in formats nothing else has to be running to read.
      </p>
      <div class="modal-stack">
        <button type="button" class="btn-primary" id="lg-x-csv">
          <i class="fas fa-file-csv"></i> Events on screen, as CSV
        </button>
        <button type="button" class="btn-primary" id="lg-x-json">
          <i class="fas fa-file-code"></i> Everything, as JSON — events, sources, entities, summaries
        </button>
      </div>`,
    footer: `<button type="button" class="btn-cancel" data-close>Close</button>`,
  });

  document.getElementById('lg-x-csv').addEventListener('click', () => {
    downloadCSV(
      ['Occurred at', 'Type', 'Subtype', 'Title', 'Amount', 'Currency', 'Where', 'Status', 'Confidence', 'Source', 'Sources', 'Event ID'],
      events.map(event => [
        event.occurred_at, event.type, event.subtype || '', event.title,
        event.data?.amount ?? '', event.data?.currency ?? '',
        event.data?.restaurant || event.data?.merchant || event.data?.place || '',
        event.status, event.confidence ?? '', event.source_type, event.source_count, event.id,
      ]),
      `ledger-${todayISO()}.csv`);
    closeModal();
  });

  document.getElementById('lg-x-json').addEventListener('click', async () => {
    try {
      const payload = await api.exportLedger(null, null);
      downloadBlob(JSON.stringify(payload, null, 2), 'application/json', `ledger-export-${todayISO()}.json`);
      closeModal();
    } catch (err) {
      showToast('Export failed: ' + err.message, 'error');
    }
  });
}
