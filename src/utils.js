// ======================================================
// Formatting utilities
//
// Money has one rule, in three shapes:
//
//   formatINRFull  — hero figures and anything read on its own: every rupee,
//                    Indian grouping. "₹12,34,567".
//   formatINR      — compact, for KPI footnotes, tooltips and table cells:
//                    lakh and crore with two decimals, and plain grouping
//                    below a lakh. "₹4.50 L", "₹1.20 Cr", "₹45,000". There is
//                    no "k": a column that read "₹80.0k" above "₹1.20 L" made
//                    the eye compare two different units.
//   inrAxisTick    — chart axes: "₹0", "₹40L", "₹1.2Cr". An axis whose top
//                    tick is under a lakh uses plain grouping throughout.
//
// A table column picks one scale for all its rows with inrColumnFormatter.
// ======================================================

const INR_UNITS = [
  { min: 1e7, div: 1e7, unit: 'Cr' },
  { min: 1e5, div: 1e5, unit: 'L' },
];

// Sign goes in front of the ₹, not inside the number — "−₹1.20 Cr", not "₹-1.20 Cr".
const signOf = value => (value < 0 ? '−' : '');

const isMissing = value => value === null || value === undefined || value === '' || Number.isNaN(Number(value));

export function formatINR(value) {
  if (isMissing(value)) return '—';
  value = Number(value);
  const abs = Math.abs(value);
  const scale = INR_UNITS.find(u => abs >= u.min);
  if (!scale) return formatINRFull(value);
  return `${signOf(value)}₹${(abs / scale.div).toFixed(2)} ${scale.unit}`;
}

export function formatINRFull(value) {
  if (isMissing(value)) return '—';
  value = Number(value);
  // Keep the sign. Math.abs() alone rendered a negative net worth as a healthy
  // positive number — the worst possible way for this app to be wrong.
  return signOf(value) + '₹' + Math.abs(value).toLocaleString('en-IN', { maximumFractionDigits: 0 });
}

/**
 * One formatter for a whole column: if any row reaches a lakh, every row is
 * written in lakh (or crore, for rows that reach one), so ₹45,000 reads as
 * "₹0.45 L" beside "₹3.20 L" and the decimals line up down the column.
 */
export function inrColumnFormatter(values) {
  const max = Math.max(0, ...values.map(v => Math.abs(Number(v) || 0)));
  if (max < 1e5) return formatINRFull;
  return value => {
    if (isMissing(value)) return '—';
    value = Number(value);
    const abs = Math.abs(value);
    const scale = abs >= 1e7 ? INR_UNITS[0] : INR_UNITS[1];
    return `${signOf(value)}₹${(abs / scale.div).toFixed(2)} ${scale.unit}`;
  };
}

/** Axis tick: "₹0", "₹40L", "₹1.2Cr"; plain grouping when the axis tops out under a lakh. */
export function inrAxisTick(value, _index, ticks) {
  const v = Number(value);
  if (!v) return '₹0';
  const top = Array.isArray(ticks) && ticks.length
    ? Math.max(...ticks.map(t => Math.abs(Number(t.value) || 0)))
    : Math.abs(v);
  const abs = Math.abs(v);
  if (top < 1e5) return signOf(v) + '₹' + abs.toLocaleString('en-IN', { maximumFractionDigits: 0 });
  const trim = n => String(Number(n.toFixed(1)));
  return abs >= 1e7
    ? `${signOf(v)}₹${trim(abs / 1e7)}Cr`
    : `${signOf(v)}₹${trim(abs / 1e5)}L`;
}

// An amount in the currency it was charged in: "₹1,200", "$25.00", "€9.99".
// Ledger events carry `data.currency`; rupees stay whole, everything else
// keeps its cents, because $25 and ₹25 are not the same kind of number.
const CURRENCY_SYMBOLS = { INR: '₹', USD: '$', EUR: '€', GBP: '£', SGD: 'S$', JPY: '¥' };

export function formatMoney(amount, currency = 'INR', { exact = false } = {}) {
  if (isMissing(amount)) return '—';
  const n = Number(amount);
  const code = String(currency || 'INR').toUpperCase();
  if (code === 'INR') {
    return exact && !Number.isInteger(n)
      ? signOf(n) + '₹' + Math.abs(n).toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })
      : formatINRFull(n);
  }
  const symbol = CURRENCY_SYMBOLS[code] ?? `${code} `;
  return signOf(n) + symbol + Math.abs(n).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

/** True for an amount the browser may add into a rupee total (no currency means INR). */
export function isINR(currency) {
  return !currency || String(currency).toUpperCase() === 'INR';
}

export function formatPercent(value, decimals = 1) {
  if (value === null || value === undefined || isNaN(value)) return '—';
  return value.toFixed(decimals) + '%';
}

// ── Dates ──────────────────────────────────────────────
//
// One style across the app: "5 Oct 2026", or "5 Oct" where the year is
// obvious. Own month table rather than toLocaleDateString, whose output
// ("05-Oct-2026", "Sept") changes with the browser's ICU.

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

/** "5 Oct 2026" from an ISO date or timestamp (its calendar date, as written). */
export function formatDate(dateStr, { year = true } = {}) {
  if (!dateStr) return '—';
  const [y, m, d] = String(dateStr).slice(0, 10).split('-').map(Number);
  if (!y || !m || !d) return '—';
  return year ? `${d} ${MONTHS[m - 1]} ${y}` : `${d} ${MONTHS[m - 1]}`;
}

/** "5 Oct" — for a footnote, or anywhere the year goes without saying. */
export function formatShortDate(dateStr) {
  return formatDate(dateStr, { year: false });
}

/** "just now", "12 min ago", "3 h ago", "4 days ago", "2 months ago". */
export function timeAgo(iso, now = Date.now()) {
  const mins = Math.max(0, Math.round((now - new Date(iso).getTime()) / 60000));
  if (mins < 2) return 'just now';
  if (mins < 60) return `${mins} min ago`;
  if (mins < 48 * 60) return `${Math.round(mins / 60)} h ago`;
  const days = Math.round(mins / 1440);
  if (days < 60) return `${days} days ago`;
  return `${Math.round(days / 30.44)} months ago`;
}

export function todayISO() {
  // Local date, not UTC. toISOString() east of UTC returns yesterday's date
  // for anyone opening the app before ~05:30 IST.
  const d = new Date();
  const pad = n => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

// ======================================================
// Chart helpers
// ======================================================

// Read off the design tokens in style.css, so a chart and the card around it
// cannot drift apart. Getters, because the tokens resolve only once the
// stylesheet has loaded; the hex after each is the fallback for that moment
// and for node. (Chart.js global defaults — font, colour, tension — now live
// in src/chart-setup.js, with the library itself.)
const tokenColor = (name, fallback) => () => cssVar(name, fallback);
const COLOR_TOKENS = {
  accent:  tokenColor('--accent', '#38bdf8'),
  purple:  tokenColor('--purple', '#a78bfa'),
  success: tokenColor('--success', '#10b981'),
  warning: tokenColor('--warning', '#f59e0b'),
  danger:  tokenColor('--danger-solid', '#ef4444'),   // fills and lines, never text
  pink:    tokenColor('--pink', '#f472b6'),
  teal:    tokenColor('--teal', '#2dd4bf'),
  orange:  () => '#fb923c',                           // no token; used for one series
  muted:   tokenColor('--text-muted', '#8b9ab0'),
};
export const CHART_COLORS = Object.defineProperties({}, Object.fromEntries(
  Object.entries(COLOR_TOKENS).map(([key, get]) => [key, { get, enumerable: true }])));

// One tone per class in ASSET_FIELDS (networth-math.js); the doughnut and the
// stacked series read these by key.
const ASSET_TONES = {
  stocks: 'accent', etfs: 'orange', mutual_funds: 'purple', cash: 'success',
  epf: 'warning', gold: 'pink', fds: 'teal', lent: 'muted',
};
export const ASSET_COLORS = Object.defineProperties({}, Object.fromEntries(
  Object.entries(ASSET_TONES).map(([key, tone]) => [key, { get: COLOR_TOKENS[tone], enumerable: true }])));

export function destroyChart(chartRef) {
  if (chartRef) {
    try { chartRef.destroy(); } catch (_) {}
  }
  return null;
}

// ======================================================
// Toast notification
// ======================================================

let toastTimeout = null;

/**
 * A short message in the corner. `message` is plain text: it is set with
 * textContent, so an error string that carries a merchant name or a server
 * message cannot become markup. (It used to be innerHTML, and every caller
 * had to remember to escape.)
 */
export function showToast(message, type = 'success') {
  const existing = document.querySelector('.toast');
  if (existing) existing.remove();
  if (toastTimeout) clearTimeout(toastTimeout);

  const icon = type === 'success' ? 'fa-check-circle' : 'fa-exclamation-circle';
  const toast = document.createElement('div');
  toast.className = `toast ${type}`;
  // An error interrupts; a confirmation waits its turn.
  toast.setAttribute('role', type === 'error' ? 'alert' : 'status');
  toast.innerHTML = `<i class="fas ${icon}" aria-hidden="true"></i>`;
  toast.append(document.createTextNode(' ' + String(message ?? '')));
  document.body.appendChild(toast);

  toastTimeout = setTimeout(() => toast.remove(), 3000);
}

// ======================================================
// Click-to-copy KPI cards
// ======================================================

export function makeCopyable(cardEl, rawValue) {
  if (!cardEl) return;
  // Clickable, so it has to be reachable and operable from the keyboard too.
  cardEl.tabIndex = 0;
  cardEl.setAttribute('role', 'button');
  cardEl.addEventListener('keydown', e => {
    if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); cardEl.click(); }
  });
  cardEl.addEventListener('click', () => {
    navigator.clipboard.writeText(String(rawValue)).catch(() => {});
    cardEl.classList.add('copied');
    setTimeout(() => cardEl.classList.remove('copied'), 1500);
  });
}

// ======================================================
// KPI cards
//
// Four screens rendered this same card from four copies of the same template
// string, which is how they drifted: one called the tint `glow` and another
// called it `color`, the badge and the footnote ran together on one line, and
// the progress bar carried its spacing in an inline style. One renderer now,
// and one place to change the shape of a KPI.
//
// A card is: { id, label, icon, tone, value, unit, raw, sub, badge, progress,
//              tooltip }
//   tone     — a semantic name ('accent' | 'success' | 'warning' | 'danger' |
//              'purple' | 'pink' | 'teal'). It drives both the icon wash and
//              the hover glow, so a card cannot be tinted one colour and
//              washed another, which is what happened when they were two
//              separate hand-written values.
//   unit     — 'months', '/mo', 'pts', '×'. Set apart from the figure rather
//              than concatenated into it, so the number stays the number.
//   progress — 0-100; omit entirely for a card with no meter.
// ======================================================

const KPI_TONES = ['accent', 'success', 'warning', 'danger', 'purple', 'pink', 'teal'];

export function renderKpiCards(container, kpis) {
  if (!container) return;

  container.innerHTML = kpis.map(k => {
    const tone = KPI_TONES.includes(k.tone) ? k.tone : 'accent';
    return `
    <div class="kpi-card" id="${escapeHTML(k.id)}"
         style="--kpi-tint:var(--${tone});--kpi-glow:var(--${tone}-glow)"
         title="${escapeHTML(k.tooltip || '')}">
      <div class="kpi-header">
        <span class="kpi-label">${escapeHTML(k.label)}</span>
        <span class="kpi-icon" aria-hidden="true"><i class="fas ${escapeHTML(k.icon)}"></i></span>
      </div>
      <div class="kpi-value">${escapeHTML(k.value)}${
        k.unit ? `<span class="kpi-unit">${escapeHTML(k.unit)}</span>` : ''}</div>
      ${k.progress !== undefined && k.progress !== null ? `
        <div class="progress-wrap kpi-meter">
          <div class="progress-bar" style="width:${Math.max(0, Math.min(100, k.progress))}%"></div>
        </div>` : ''}
      <div class="kpi-sub">
        ${k.badge ? `<span class="kpi-badge ${escapeHTML(k.badge.type)}">${escapeHTML(k.badge.text)}</span>` : ''}
        ${k.sub ? `<span>${escapeHTML(k.sub)}</span>` : ''}
      </div>
    </div>`;
  }).join('');

  kpis.forEach(k => makeCopyable(container.querySelector('#' + CSS.escape(k.id)), k.raw));
}

// ======================================================
// Table cells
//
// A column of money is read by comparing figures down it, which needs three
// things the tables were not doing: one decimal convention, tabular digits,
// and right alignment. The Amount column showed "₹760", "₹879.4" and
// "₹10,168.64" side by side, because toLocaleString with no options keeps up
// to three fraction digits — so the same column had three different shapes.
// ======================================================

/** A right-aligned numeric table cell. `tone` is a semantic token name. */
export function numCell(text, { tone, bold = false } = {}) {
  const style = [
    tone ? `color:var(--${tone})` : '',
    bold ? 'font-weight:600' : '',
  ].filter(Boolean).join(';');
  return `<span class="num"${style ? ` style="${style}"` : ''}>${escapeHTML(text)}</span>`;
}

/** Edit and delete for one row. Was four copies of the same inline flexbox. */
// ── Buttons inside generated markup ────────────────────
//
// Table cells are built as HTML strings, and the obvious way to make a button
// in one do something is onclick="...". That works in `npm run dev` and is
// silently dead in production: the site's Content-Security-Policy is
// `script-src 'self'`, which refuses every inline handler. No error reaches
// the page — the button simply does nothing — which is how the Edit and Delete
// buttons on every table stayed broken without anyone being told.
//
// So a button carries its call as data, and ONE listener on the document runs
// it. callAttrs() takes the same "window.__fn('a','b')" string the call sites
// already had, so none of them needed rewriting.

/** "window.__ptTxEdit('abc')" → data-call="__ptTxEdit" data-args='["abc"]' */
export function callAttrs(call) {
  const match = /^\s*window\.(__[A-Za-z0-9_$]+)\((.*)\)\s*;?\s*$/s.exec(String(call));
  if (!match) throw new Error(`callAttrs: not a window.__handler(...) call: ${call}`);
  const args = [...match[2].matchAll(/'((?:[^'\\]|\\.)*)'/g)].map(m => m[1].replace(/\\(.)/g, '$1'));
  return `data-call="${match[1]}" data-args="${escapeHTML(JSON.stringify(args))}"`;
}

let callListenerInstalled = false;

/** Install the one delegated listener. Safe to call more than once. */
export function installCallListener(root = document) {
  if (callListenerInstalled) return;
  callListenerInstalled = true;
  root.addEventListener('click', (event) => {
    const el = event.target.closest?.('[data-call]');
    if (!el || el.disabled) return;
    // Only the app's own double-underscore handlers: markup can name a function
    // to run, so it must not be able to name an arbitrary one.
    const name = el.dataset.call;
    const handler = /^__[A-Za-z0-9_$]+$/.test(name) ? window[name] : null;
    if (typeof handler !== 'function') return;
    let args = [];
    try { args = JSON.parse(el.dataset.args || '[]'); } catch (_) { return; }
    handler(...args);
  });
}

/**
 * Edit and delete for one row. Delete is drawn quiet — muted until the row is
 * hovered or the button has focus — so a column of red bins is not the
 * loudest thing on a table of money (style.css, .row-actions).
 */
export function rowActions(editCall, deleteCall, noun = 'row') {
  return `
    <div class="row-actions">
      <button type="button" class="btn-icon" ${callAttrs(editCall)}
              title="Edit ${noun}" aria-label="Edit ${noun}"><i class="fas fa-pencil"></i></button>
      <button type="button" class="btn-icon is-danger" ${callAttrs(deleteCall)}
              title="Delete ${noun}" aria-label="Delete ${noun}"><i class="fas fa-trash"></i></button>
    </div>`;
}

// ======================================================
// CSV Export
// ======================================================

/**
 * One CSV cell. A value that starts with = + - @ (or a tab / carriage return)
 * is a formula to Excel and Sheets — a merchant called "=HYPERLINK(...)"
 * from an email would run on open — so it gets a leading apostrophe.
 * Numbers are left alone: -250 is a refund, not a formula.
 */
export function csvCell(cell) {
  if (typeof cell === 'number') return String(cell);
  let text = String(cell ?? '');
  if (/^[=+\-@\t\r]/.test(text)) text = `'${text}`;
  return `"${text.replace(/"/g, '""')}"`;
}

export function downloadCSV(headers, rows, filename) {
  const csvContent = [
    headers.map(csvCell).join(','),
    ...rows.map(row => row.map(csvCell).join(','))
  ].join('\n');
  downloadBlob(csvContent, 'text/csv;charset=utf-8;', filename);
}

/** Hand the browser a file to save. The blob/anchor dance, written once. */
export function downloadBlob(content, mime, filename) {
  const blob = new Blob([content], { type: mime });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  a.click();
  URL.revokeObjectURL(url);
}

// ======================================================
// Modal helpers
//
// One modal at a time. openModal draws the frame — header with title and
// close button, optional tab strip, body, optional footer — and wires every
// way out of it: the × button, any control carrying `data-close`, the
// backdrop and Escape. Eleven dialogs used to each add their own close and
// cancel listeners by id; now they only describe what goes inside.
// ======================================================

let modalOnClose = null;
// Where focus was before the modal opened, so closing it puts focus back on
// the button that opened it rather than at the top of the document.
let modalReturnFocus = null;

const FOCUSABLE = 'a[href], button:not([disabled]), input:not([disabled]):not([type="hidden"]), select:not([disabled]), textarea:not([disabled]), summary, [tabindex]:not([tabindex="-1"])';

/**
 * @param {object} opts
 *   title      — plain text; escaped here
 *   icon       — Font Awesome class for an icon before the title (optional)
 *   iconColor  — CSS colour for that icon (optional; dynamic values only)
 *   tabs       — HTML for a `.modal-tabs` strip between header and body (optional)
 *   body       — HTML for `.modal-body`
 *   footer     — HTML for `.modal-footer` (optional). Buttons with `data-close`
 *                close the modal.
 *   footerClass — extra class on the footer (optional)
 *   onClose    — runs when the user dismisses the modal or closeModal() is
 *                called; not when another openModal replaces it.
 */
export function openModal({ title = '', icon = '', iconColor = '', tabs = '', body = '', footer = '', footerClass = '', onClose = null } = {}) {
  // A modal replacing a modal (detail → edit) keeps the original opener.
  const replacing = Boolean(document.getElementById('modal-overlay'));
  if (!replacing) modalReturnFocus = document.activeElement instanceof HTMLElement ? document.activeElement : null;
  closeModal({ silent: true, restoreFocus: false });
  modalOnClose = onClose;

  const overlay = document.createElement('div');
  overlay.className = 'modal-overlay';
  overlay.id = 'modal-overlay';
  overlay.innerHTML = `
    <div class="modal" role="dialog" aria-modal="true" aria-label="${escapeHTML(title)}">
      <div class="modal-header">
        <div class="modal-title">
          ${icon ? `<i class="fas ${escapeHTML(icon)}"${iconColor ? ` style="color:${escapeHTML(iconColor)}"` : ''} aria-hidden="true"></i>` : ''}
          ${escapeHTML(title)}
        </div>
        <button type="button" class="modal-close" data-close aria-label="Close"><i class="fas fa-times" aria-hidden="true"></i></button>
      </div>
      ${tabs}
      <div class="modal-body">${body}</div>
      ${footer ? `<div class="modal-footer ${escapeHTML(footerClass)}">${footer}</div>` : ''}
    </div>`;
  document.body.appendChild(overlay);

  overlay.addEventListener('click', e => {
    // The backdrop, or anything marked as a way out.
    if (e.target === overlay || e.target.closest('[data-close]')) closeModal();
  });
  document.addEventListener('keydown', handleModalKeys);

  // Focus goes into the dialog: the first field if there is one (a form is
  // opened to be filled in), otherwise the dialog itself. Callers that focus
  // something specific afterwards still win.
  const dialog = overlay.querySelector('.modal');
  dialog.tabIndex = -1;
  const first = overlay.querySelector('.modal-body input:not([type="hidden"]):not([disabled]), .modal-body select:not([disabled]), .modal-body textarea:not([disabled])');
  (first || dialog).focus({ preventScroll: true });
}

function handleModalKeys(e) {
  // A control inside the modal that used Escape itself — a combobox closing
  // its list, a filter panel — has said so with preventDefault. Without this
  // check one Escape closed the list *and* the whole dialog under it.
  if (e.key === 'Escape') {
    if (e.defaultPrevented) return;
    closeModal();
    return;
  }
  if (e.key === 'Tab') trapFocus(e);
}

/** Keep Tab inside the open dialog: aria-modal says so, the keyboard has to agree. */
function trapFocus(e) {
  const dialog = document.querySelector('#modal-overlay .modal');
  if (!dialog) return;
  const items = [...dialog.querySelectorAll(FOCUSABLE)].filter(el => el.getClientRects().length > 0);
  if (!items.length) { e.preventDefault(); dialog.focus(); return; }
  const first = items[0];
  const last = items[items.length - 1];
  const active = document.activeElement;
  if (!dialog.contains(active)) { e.preventDefault(); first.focus(); return; }
  if (e.shiftKey && (active === first || active === dialog)) { e.preventDefault(); last.focus(); }
  else if (!e.shiftKey && active === last) { e.preventDefault(); first.focus(); }
}

export function closeModal({ silent = false, restoreFocus = true } = {}) {
  const overlay = document.getElementById('modal-overlay');
  if (overlay) overlay.remove();
  document.removeEventListener('keydown', handleModalKeys);
  const done = modalOnClose;
  modalOnClose = null;
  if (restoreFocus && overlay) {
    const target = modalReturnFocus;
    modalReturnFocus = null;
    if (target?.isConnected) target.focus({ preventScroll: true });
  }
  if (!silent && typeof done === 'function') done();
}

// ======================================================
// Empty states and banners
// ======================================================

const EMPTY_TONES = ['accent', 'success', 'warning', 'danger', 'muted'];

/**
 * The "nothing here" block. Thirteen copies of the same markup carried the
 * same inline styles; one renderer now.
 *
 *   icon   — Font Awesome class
 *   tone   — 'accent' | 'success' | 'warning' | 'danger' | 'muted' (default)
 *   title  — plain text
 *   hint   — plain text, escaped (optional)
 *   detail — HTML the caller has already escaped, for a hint that needs <code> (optional)
 *   action — { id, label } for a button after the text (optional)
 */
export function emptyState({ icon = 'fa-inbox', tone = 'muted', title = '', hint = '', detail = '', action = null } = {}) {
  const t = EMPTY_TONES.includes(tone) ? tone : 'muted';
  return `
    <div class="empty-state is-${t}">
      <i class="fas ${escapeHTML(icon)}" aria-hidden="true"></i>
      <p class="empty-state-title">${escapeHTML(title)}</p>
      ${hint ? `<p class="empty-state-hint">${escapeHTML(hint)}</p>` : ''}
      ${detail ? `<p class="empty-state-hint">${detail}</p>` : ''}
      ${action ? `<button type="button" class="btn-sm btn-accent empty-state-action" id="${escapeHTML(action.id)}">${escapeHTML(action.label)}</button>` : ''}
    </div>`;
}

/**
 * A one-line banner above a page's content: a load failure with a retry,
 * or "nothing yet" with a way to add something.
 *
 *   tone   — 'error' | 'empty'
 *   title  — bold lead text
 *   sub    — the sentence under it (optional)
 *   action — { id, label, ghost } (optional)
 */
export function bannerHTML({ tone = 'error', title = '', sub = '', action = null } = {}) {
  const isError = tone === 'error';
  return `
    <div class="dash-banner dash-banner--${isError ? 'error' : 'empty'}" role="${isError ? 'alert' : 'status'}">
      <i class="fas ${isError ? 'fa-triangle-exclamation' : 'fa-seedling'}" aria-hidden="true"></i>
      <div>
        <strong>${escapeHTML(title)}</strong>
        ${sub ? `<div class="dash-banner-sub">${escapeHTML(sub)}</div>` : ''}
      </div>
      ${action ? `<button type="button" class="btn-sm ${action.ghost ? 'btn-ghost' : 'btn-accent'}" id="${escapeHTML(action.id)}">${escapeHTML(action.label)}</button>` : ''}
    </div>`;
}

// ======================================================
// Busy buttons
// ======================================================

/**
 * Run `fn` with the button disabled and relabelled, then put it back — even
 * if `fn` throws, and even if the modal it lived in has been closed since.
 * Resolves to whatever `fn` resolved to.
 */
export async function withBusy(btn, label, fn) {
  if (!btn) return fn();
  const before = btn.innerHTML;
  btn.disabled = true;
  btn.textContent = label;
  try {
    return await fn();
  } finally {
    btn.disabled = false;
    btn.innerHTML = before;
  }
}

// ======================================================
// Fatal startup panel
//
// Painted when the app cannot start at all — a missing build-time config or
// an init that threw. style.css may not have loaded by then, so this is the
// one place hex colours are written inline rather than as tokens.
// ======================================================

export function fatalPanel(title, messageHTML) {
  const app = document.getElementById('app');
  if (!app) return;
  app.innerHTML =
    '<div style="max-width:34rem;margin:20vh auto;padding:1.5rem;font-family:Inter,system-ui,sans-serif;color:#e2e8f0;background:#1e293b;border-radius:12px;line-height:1.6">' +
    `<h1 style="font-size:1.1rem;margin:0 0 .75rem">${escapeHTML(title)}</h1>` +
    `<p style="margin:0;color:#94a3b8">${messageHTML}</p></div>`;
}

// ======================================================
// Number parsing
// ======================================================

export function parseNum(val) {
  const n = parseFloat(val);
  return isNaN(n) ? 0 : n;
}

// ======================================================
// HTML escaping
//
// Every view builds its markup with template strings and innerHTML, so any
// database value dropped into one is executable unless it goes through here.
// ======================================================

const HTML_ESCAPES = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };

export function escapeHTML(value) {
  if (value === null || value === undefined) return '';
  return String(value).replace(/[&<>"']/g, ch => HTML_ESCAPES[ch]);
}

/**
 * A URL that is safe to put in an href: absolute http(s) only. A source's
 * `external_url` comes out of an email, and `javascript:` in an href runs on
 * click whatever escaping was applied to it. Returns null for anything else.
 */
export function safeHttpUrl(value) {
  if (!value) return null;
  try {
    const url = new URL(String(value));
    return url.protocol === 'http:' || url.protocol === 'https:' ? url.href : null;
  } catch {
    return null;
  }
}

// ======================================================
// Canvas colour resolution
//
// Chart.js paints to a canvas, where `var(--token)` never resolves — it
// silently falls back and the styling is quietly lost. Read the token off the
// document instead.
// ======================================================

export function cssVar(name, fallback = '#000000') {
  if (typeof document === 'undefined') return fallback;
  const value = getComputedStyle(document.documentElement).getPropertyValue(name).trim();
  return value || fallback;
}

// ======================================================
// FX Rate
// ======================================================

// The rate is published once a working day, so a copy from this morning is
// as good as a fresh one. It is kept in localStorage for six hours: a reload
// costs no request at all, and a dead API (or a slow one — there is a 4s
// timeout now) can no longer hold a screen hostage.
const FX_KEY = 'daybook-fx-eur-inr';
const FX_TTL_MS = 6 * 60 * 60 * 1000;
const FX_TIMEOUT_MS = 4000;
let fxInFlight = null;

/** The last rate this browser fetched, if it is recent enough to use. Synchronous. */
export function cachedEURtoINR() {
  try {
    const stored = JSON.parse(localStorage.getItem(FX_KEY) || 'null');
    if (stored && Number.isFinite(stored.rate) && Date.now() - stored.at < FX_TTL_MS) return stored.rate;
  } catch { /* private window or a malformed value: no cache */ }
  return null;
}

export async function fetchEURtoINR(fallback = 110.0) {
  const cached = cachedEURtoINR();
  if (cached !== null) return cached;
  // Two screens asking at once share one request.
  fxInFlight ??= (async () => {
    const controller = typeof AbortController !== 'undefined' ? new AbortController() : null;
    const timer = setTimeout(() => controller?.abort(), FX_TIMEOUT_MS);
    try {
      const res = await fetch('https://api.frankfurter.dev/v1/latest?base=EUR&symbols=INR', { signal: controller?.signal });
      if (!res.ok) return null;
      const data = await res.json();
      const rate = Number(data?.rates?.INR);
      if (!Number.isFinite(rate) || rate <= 0) return null;
      try { localStorage.setItem(FX_KEY, JSON.stringify({ rate, at: Date.now() })); } catch { /* not persisted */ }
      return rate;
    } catch {
      return null;
    } finally {
      clearTimeout(timer);
      fxInFlight = null;
    }
  })();
  return (await fxInFlight) ?? fallback;
}

// ======================================================
// Combobox — type it, or pick one you have used before.
//
// A select cannot hold a value it was not given, so a field that needs both
// ends up as two controls: a dropdown, and a text box beside it for everything
// the dropdown does not know. That is two decisions ("which of these?" and
// "is my answer in there?") for one piece of information.
//
// This is one control. It is a text input — so anything can be typed, and the
// value is read with `.value` exactly as before — with the answers you have
// already given offered underneath it, filtered as you type.
// ======================================================

/**
 * The markup. `options` is a list of strings, in the order they should be
 * offered — most-used first beats alphabetical for a field you fill in daily.
 */
export function comboboxHTML({ id, value = '', placeholder = '', options = [] }) {
  return `
    <div class="cb" data-cb="${escapeHTML(id)}">
      <input type="text" class="form-input cb-input" id="${escapeHTML(id)}"
             value="${escapeHTML(value)}" placeholder="${escapeHTML(placeholder)}"
             autocomplete="off" role="combobox" aria-expanded="false"
             aria-controls="${escapeHTML(id)}-list" aria-autocomplete="list" />
      <button type="button" class="cb-toggle" tabindex="-1" aria-label="Show what you have used before">
        <i class="fas fa-chevron-down" aria-hidden="true"></i>
      </button>
      <ul class="cb-list" id="${escapeHTML(id)}-list" role="listbox" hidden
          data-options="${escapeHTML(JSON.stringify(options))}"></ul>
    </div>`;
}

/**
 * Wire one up. Safe to call on markup that is already wired — it is idempotent,
 * which matters because the points modal re-renders its body on a tab switch.
 */
export function wireCombobox(id) {
  const input = document.getElementById(id);
  const list = document.getElementById(`${id}-list`);
  if (!input || !list || input.dataset.cbWired) return;
  input.dataset.cbWired = '1';

  const wrap = input.closest('.cb');
  let options = [];
  try { options = JSON.parse(list.dataset.options || '[]'); } catch { options = []; }
  let active = -1;

  const close = () => {
    list.hidden = true;
    input.setAttribute('aria-expanded', 'false');
    input.removeAttribute('aria-activedescendant');
    active = -1;
  };

  /**
   * `whole` is for opening the list rather than typing into it: arriving at a
   * field that already holds an answer and wanting a different one is as
   * common as filling an empty one, so focusing shows everything.
   *
   * It is deliberately not applied while typing. "am" is a prefix of Amazon
   * and also, in this ledger, a merchant of its own — so treating an exact
   * match as "show everything" made typing `am` list all fifty merchants.
   */
  const paint = ({ whole = false } = {}) => {
    const needle = input.value.trim().toLowerCase();
    const exact = whole && options.some(o => o.toLowerCase() === needle);
    const matches = (!needle || exact) ? options : options.filter(o => o.toLowerCase().includes(needle));

    if (!matches.length) { close(); return; }

    list.innerHTML = matches.slice(0, 50).map((option, index) => {
      const current = option.toLowerCase() === needle;
      return `
      <li class="cb-option ${index === active ? 'is-active' : ''} ${current ? 'is-selected' : ''}"
          role="option" id="${escapeHTML(id)}-opt-${index}" aria-selected="${current}"
          data-value="${escapeHTML(option)}">${escapeHTML(option)}</li>`;
    }).join('');
    list.hidden = false;
    input.setAttribute('aria-expanded', 'true');

    // Opening a filled field shows the whole list, which can be fifty long —
    // so put the answer it currently holds where the eye already is.
    list.querySelector('.cb-option.is-selected')?.scrollIntoView({ block: 'nearest' });

    // Up, when there is no room below. The modal body scrolls, so a panel that
    // simply hung downwards would be cut off by it rather than overflowing.
    const room = window.innerHeight - input.getBoundingClientRect().bottom;
    wrap.classList.toggle('is-above', room < 220);
  };

  const commit = (value) => {
    input.value = value;
    // The points preview recalculates on input, so a pick has to look like
    // typing — otherwise choosing a merchant leaves the preview stale.
    input.dispatchEvent(new Event('input', { bubbles: true }));
    // Closed *after* the event, not before: that handler repaints, and a value
    // that exactly matches an option opens the full list again. Picking one
    // would leave the list standing open over the next field.
    close();
  };

  input.addEventListener('input', () => { active = -1; paint(); });
  input.addEventListener('focus', () => paint({ whole: true }));

  wrap.querySelector('.cb-toggle').addEventListener('mousedown', e => {
    e.preventDefault();                       // keep focus in the input
    if (list.hidden) { input.focus(); paint({ whole: true }); } else close();
  });

  input.addEventListener('keydown', e => {
    const items = [...list.querySelectorAll('.cb-option')];
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault();
      if (list.hidden) { paint({ whole: true }); return; }
      active = e.key === 'ArrowDown'
        ? Math.min(active + 1, items.length - 1)
        : Math.max(active - 1, 0);
      items.forEach((el, i) => el.classList.toggle('is-active', i === active));
      items[active]?.scrollIntoView({ block: 'nearest' });
      input.setAttribute('aria-activedescendant', items[active]?.id || '');
    } else if (e.key === 'Enter' && !list.hidden && active >= 0) {
      e.preventDefault();
      commit(items[active].dataset.value);
    } else if (e.key === 'Escape' && !list.hidden) {
      e.preventDefault();                     // close the list, not the modal (handleModalKeys checks this)
      close();
    }
  });

  // mousedown, not click: the input's blur fires first and would hide the
  // option before the click landed on it.
  list.addEventListener('mousedown', e => {
    const option = e.target.closest('.cb-option');
    if (!option) return;
    e.preventDefault();
    commit(option.dataset.value);
  });

  input.addEventListener('blur', () => setTimeout(close, 120));
}

// ======================================================
// Net worth computations
//
// Moved to ./networth-math.js — pure and import-free, so the maths runs
// (and is testable) outside a browser. Re-exported here so every existing
// `from '../utils.js'` import keeps working unchanged.
// ======================================================

export {
  computeAssets, computeLiquid, computeCashLike, computeEmergencyFund, computeInvestables, computeNet, ASSET_FIELDS,
} from './networth-math.js';
