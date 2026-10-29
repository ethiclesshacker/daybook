import { createTable } from '../table.js';
import { getCurrentUserId } from '../supabase.js';
import { listEntries, saveEntry, deleteEntry, refresh as refreshEntries } from '../networth/api.js';
import * as settings from '../settings.js';
import {
  formatINR, formatINRFull, formatPercent, formatDate, formatShortDate, todayISO, inrColumnFormatter,
  destroyChart, downloadCSV, escapeHTML,
  openModal, closeModal, showToast, parseNum, withBusy,
  computeNet, computeAssets, computeLiquid, computeEmergencyFund, computeInvestables, ASSET_FIELDS, renderKpiCards,
  numCell, rowActions,
} from '../utils.js';
import { netWorthSeriesChart, allocationDoughnut, wireChartToggle } from '../charts.js';

let entries = [];
let netWorthChartRef = null;
let allocationChartRef = null;
let table = null;
let editingId = null;
let chartType = 'line';
let filterYear = '';
// A load that resolves after the user has left must not paint a dead DOM.
let loadToken = 0;

export async function renderNetWorth(container) {
  editingId = null;
  chartType = 'line';
  filterYear = '';

  container.innerHTML = `
    <div class="page-header">
      <div class="page-header-left">
        <h2>Net Worth</h2>
        <p>Track your assets, liabilities and runway</p>
      </div>
      <div class="page-actions">
        <button type="button" class="btn-sm btn-ghost" id="nw-export-btn">
          <i class="fas fa-download"></i> Export CSV
        </button>
      </div>
    </div>

    <div class="page-body">
      <!-- KPI Cards -->
      <div class="kpi-grid kpi-grid--3col" id="nw-kpi-grid">
        ${Array(6).fill(0).map(() => `
          <div class="kpi-card">
            <div class="skeleton skeleton--kpi"></div>
          </div>
        `).join('')}
      </div>

      <!-- Charts -->
      <div class="charts-grid">
        <div class="chart-card">
          <div class="chart-header">
            <div>
              <div class="chart-title">Wealth Accumulation</div>
              <div class="chart-subtitle">Net worth over time</div>
            </div>
            <div class="chart-toggle">
              <button type="button" class="chart-toggle-btn active" id="nw-line-btn">Line</button>
              <button type="button" class="chart-toggle-btn" id="nw-bar-btn">Bar</button>
            </div>
          </div>
          <div class="chart-canvas-wrap">
            <canvas id="nw-accumulation-chart"></canvas>
          </div>
        </div>
        <div class="chart-card">
          <div class="chart-header">
            <div>
              <div class="chart-title">Asset Distribution</div>
              <div class="chart-subtitle">Latest snapshot breakdown</div>
            </div>
          </div>
          <div class="chart-canvas-wrap">
            <canvas id="nw-allocation-chart"></canvas>
          </div>
        </div>
      </div>

      <!-- History Table -->
      <div class="table-section">
        <div class="table-toolbar">
          <div class="table-title">
            <i class="fas fa-clock-rotate-left" aria-hidden="true"></i>
            Historical Snapshots
          </div>
          <div class="table-actions">
            <select id="nw-year-filter" class="form-select toolbar-select" aria-label="Filter by year">
              <option value="">All Years</option>
            </select>
            <button type="button" class="btn-icon" id="nw-refresh-btn" title="Refresh" aria-label="Refresh">
              <i class="fas fa-rotate-right"></i>
            </button>
          </div>
        </div>
        <div class="table-inner">
          <div id="nw-table-container"></div>
        </div>
      </div>
    </div>

    <!-- FAB -->
    <button type="button" class="fab" id="nw-fab" title="Add snapshot" aria-label="Add snapshot">
      <i class="fas fa-plus"></i>
    </button>
  `;

  wireChartToggle('nw-line-btn', 'nw-bar-btn', type => {
    chartType = type;
    buildAccumulationChart(entries, type);
  });

  document.getElementById('nw-fab').addEventListener('click', () => openEntryForm());
  document.getElementById('nw-export-btn').addEventListener('click', exportCSV);
  document.getElementById('nw-refresh-btn').addEventListener('click', () => { refreshEntries(); loadData(); });

  document.getElementById('nw-year-filter')?.addEventListener('change', e => {
    filterYear = e.target.value;
    renderTable();
  });

  await loadData();
}

export { renderNetWorth as render };

/** Release the charts and the grid before the router replaces the DOM. */
export function unmount() {
  loadToken++;
  netWorthChartRef = destroyChart(netWorthChartRef);
  allocationChartRef = destroyChart(allocationChartRef);
  table?.destroy();
  table = null;
}

async function loadData() {
  const token = ++loadToken;
  let data;
  try {
    [data] = await Promise.all([listEntries(), settings.ready()]);
  } catch (err) {
    if (token === loadToken) showToast('Failed to load data: ' + err.message, 'error');
    return;
  }
  if (token !== loadToken || !document.getElementById('nw-kpi-grid')) return;

  entries = data || [];
  renderKPIs();
  buildAccumulationChart(entries, chartType);
  allocationChartRef = destroyChart(allocationChartRef);
  allocationChartRef = allocationDoughnut(document.getElementById('nw-allocation-chart'), entries[entries.length - 1]);
  renderYearFilter();
  renderTable();
}

// ── KPI Cards ──────────────────────────────────────────
function renderKPIs() {
  const latest = entries[entries.length - 1];
  const prev = entries[entries.length - 2];

  const cur = {
    assets:      computeAssets(latest),
    liabilities: latest?.credit_cards || 0,
    net:         computeNet(latest),
    liquid:      computeLiquid(latest),
  };
  const prv = { net: computeNet(prev) };

  const nwChange = prv.net !== 0 ? ((cur.net - prv.net) / Math.abs(prv.net)) * 100 : 0;
  // Once, with the date it is measured from. It used to be a "+1.2%" badge
  // and "↑ 1.2% from last" under it: the same number twice, from nobody knew when.
  const nwChangeLabel = prev
    ? `${nwChange >= 0 ? '↑' : '↓'} ${Math.abs(nwChange).toFixed(1)}% from last snapshot (${formatShortDate(prev.date)})`
    : 'First snapshot';

  const monthlyExpenses = settings.get('monthly_expenses');
  const runwayTarget    = settings.get('emergency_runway_target');
  const solvencyTarget  = settings.get('solvency_target');
  const fiMultiplier    = settings.get('fi_multiplier');
  const fiTarget        = settings.fiTarget();
  const passiveYield    = settings.get('passive_income_yield') / 100;
  const basis = settings.get('emergency_fund_basis');
  const emergencyFund = computeEmergencyFund(latest, basis);
  const cashRunway = monthlyExpenses > 0 ? computeEmergencyFund(latest, 'cash_like') / monthlyExpenses : 0;
  const accessibleRunway = monthlyExpenses > 0 ? computeLiquid(latest) / monthlyExpenses : 0;

  const solvency = cur.liabilities > 0 ? (cur.assets / cur.liabilities) : null;
  const passiveIncome = computeInvestables(latest) * passiveYield / 12;
  const runway = monthlyExpenses > 0 ? emergencyFund / monthlyExpenses : 0;
  const fiPct = fiTarget > 0 ? (cur.net / fiTarget) * 100 : 0;

  const expectedWealth = (settings.get('age') * settings.get('monthly_net_income') * 12) / settings.get('wealth_score_divisor');
  const wealthScore = expectedWealth > 0 ? (cur.net / expectedWealth).toFixed(2) : '—';
  // "PAW" and "UAW" are the book's terms, not the reader's. Say what they mean.

  const kpis = [
    {
      id: 'kpi-nw', label: 'Net worth', icon: 'fa-chart-column', tone: 'accent', value: formatINRFull(cur.net), raw: cur.net,
      sub: nwChangeLabel,
      tooltip: 'Total assets minus total liabilities at latest snapshot date.',
    },
    {
      id: 'kpi-assets', label: 'Total assets', icon: 'fa-building-columns', tone: 'success', value: formatINRFull(cur.assets), raw: cur.assets,
      sub: `Liquid: ${formatINR(cur.liquid)}`,
      tooltip: 'Sum of all asset classes in latest snapshot.',
    },
    {
      id: 'kpi-solvency', label: 'Solvency ratio', icon: 'fa-scale-balanced', tone: 'warning', value: solvency !== null ? solvency.toFixed(2) : 'No debt',
      unit: solvency !== null ? '×' : '',
      raw: solvency?.toFixed(2) ?? 0,
      sub: cur.liabilities > 0 ? `Liabilities: ${formatINR(cur.liabilities)}` : 'No liabilities recorded',
      badge: solvency !== null ? { text: solvency > solvencyTarget ? 'Strong' : 'Watch it', type: solvency > solvencyTarget ? 'positive' : 'neutral' } : { text: 'Debt-free', type: 'positive' },
      tooltip: `Assets ÷ Liabilities. Higher is better. > ${solvencyTarget}× is considered healthy.`,
    },
    {
      id: 'kpi-passive', label: 'Illustrative monthly yield', icon: 'fa-money-bill-wave', tone: 'purple', value: formatINR(passiveIncome), unit: '/mo', raw: passiveIncome.toFixed(0),
      sub: `Assumed ${(passiveYield * 100).toFixed(0)}% yield · not recorded income`,
      tooltip: `(Stocks + ETFs + MFs + FDs) × ${(passiveYield * 100).toFixed(0)}% ÷ 12. Blended estimated monthly passive income.`,
    },
    {
      id: 'kpi-runway', label: basis === 'cash_like' ? 'Cash runway' : 'Accessible runway', icon: 'fa-shield-halved', tone: runway >= runwayTarget ? 'success' : 'warning',
      value: runway.toFixed(1), unit: 'months', raw: runway.toFixed(1),
      badge: { text: basis !== 'cash_like' ? 'Includes market risk' : runway >= runwayTarget ? 'At your target' : 'Below target', type: basis === 'cash_like' && runway >= runwayTarget ? 'positive' : 'neutral' },
      sub: basis === 'cash_like' ? `Cash + FDs · ${accessibleRunway.toFixed(1)} mo including market holdings` : `${cashRunway.toFixed(1)} mo in cash + FDs; remaining runway uses market holdings`,
      tooltip: `Emergency fund ÷ monthly baseline expenses. Target: ≥ ${runwayTarget} months.`,
    },
    {
      id: 'kpi-fi', label: 'FI progress', icon: 'fa-bullseye', tone: 'pink', value: formatPercent(Math.min(fiPct, 100)), raw: fiPct.toFixed(1),
      sub: settings.get('show_wealth_benchmark') === 'shown' ? `Optional age benchmark: ${wealthScore}×` : 'Against your chosen FI target',
      progress: Math.min(Math.max(fiPct, 0), 100),
      tooltip: `${fiMultiplier}× rule: target ₹${(fiTarget/1e7).toFixed(2)}Cr. Wealth Score from "The Millionaire Next Door".`,
    },
  ];

  renderKpiCards(document.getElementById('nw-kpi-grid'), kpis);
}

// ── Charts ──────────────────────────────────────────────
function buildAccumulationChart(data, type) {
  netWorthChartRef = destroyChart(netWorthChartRef);
  netWorthChartRef = netWorthSeriesChart(document.getElementById('nw-accumulation-chart'), data, type, { withAssets: true });
}

function renderYearFilter() {
  const select = document.getElementById('nw-year-filter');
  if (!select) return;

  const years = [...new Set(entries.map(e => e.date?.slice(0, 4)))].filter(Boolean).sort().reverse();
  const currentVal = select.value;
  select.innerHTML = '<option value="">All Years</option>' +
    years.map(y => `<option value="${escapeHTML(y)}">${escapeHTML(y)}</option>`).join('');
  if (years.includes(currentVal)) {
    select.value = currentVal;
  } else {
    filterYear = '';
  }
}

// ── Table ───────────────────────────────────────────────
// One asset column per class, in ASSET_FIELDS order, then the totals.
const MONEY_COLUMNS = {
  ...Object.fromEntries(ASSET_FIELDS.map(f => [f.key, r => parseNum(r.e[f.key])])),
  assets:       r => r.assets,
  credit_cards: r => parseNum(r.e.credit_cards),
  net:          r => r.net,
};
const columnFormat = {};

function renderTable() {
  const container = document.getElementById('nw-table-container');
  if (!container) return;

  const filtered = filterYear ? entries.filter(e => e.date?.startsWith(filterYear)) : entries;

  // Change is against the snapshot before it in time, whatever the table's
  // sort; computed once here so sorting by it compares the same numbers.
  const rows = filtered.map(e => {
    const idx = entries.indexOf(e);
    const prev = idx > 0 ? entries[idx - 1] : null;
    const net = computeNet(e);
    const prevNet = prev ? computeNet(prev) : null;
    return { e, net, assets: computeAssets(e), chgPct: prevNet ? ((net - prevNet) / Math.abs(prevNet)) * 100 : null };
  });

  // One scale for the table, chosen from every snapshot (not just this page or
  // year), so a column never reads "₹80.0k" above "₹1.20 L" and does not
  // change unit as you page or filter. Recomputed on every draw; the column
  // definitions, built once, read it from `columnFormat`.
  const allRows = entries.map(e => ({ e, net: computeNet(e), assets: computeAssets(e) }));
  // One scale across the money columns: Gold at ₹58,972 next to Stocks at
  // ₹12.80 L read as two units in one row.
  const tableFormat = inrColumnFormatter(Object.values(MONEY_COLUMNS).flatMap(value => allRows.map(value)));
  for (const key of Object.keys(MONEY_COLUMNS)) columnFormat[key] = tableFormat;
  const money = (key, label, opts) => ({
    key, label, type: 'number', align: 'end', value: MONEY_COLUMNS[key], hideWhenEmpty: true,
    render: r => numCell(columnFormat[key](MONEY_COLUMNS[key](r)), opts),
  });
  table ??= createTable(container, {
    id: 'net-worth',
    defaultSort: { key: 'date', dir: 'desc' },
    empty: 'No snapshots found. Add your first one!',
    // Column names come from ASSET_FIELDS, the same words the form and the
    // allocation chart use. This once read "MFs" next to a chart that said
    // "Mutual Funds". A class nobody has filled in (Stocks, for now) hides
    // itself: hideWhenEmpty.
    columns: [
      { key: 'date', label: 'Date', type: 'date', value: r => r.e.date, render: r => escapeHTML(formatDate(r.e.date)) },
      ...ASSET_FIELDS.map(f => money(f.key, f.label)),
      money('assets', 'Total Assets'),
      money('credit_cards', 'Liabilities', { tone: 'danger' }),
      money('net', 'Net Worth', { tone: 'accent', bold: true }),
      { key: 'change', label: 'Change', type: 'number', align: 'end', value: r => r.chgPct,
        render: r => (r.chgPct === null
          ? numCell('—')
          : numCell(`${r.chgPct >= 0 ? '↑' : '↓'} ${Math.abs(r.chgPct).toFixed(1)}%`, { tone: r.chgPct >= 0 ? 'success' : 'danger' })) },
      { key: 'actions', label: 'Actions', actions: true,
        render: r => rowActions(`window.__nwEdit('${r.e.id}')`, `window.__nwDelete('${r.e.id}')`, 'snapshot') },
    ],
  });
  table.setRows(rows);

  window.__nwEdit = (id) => {
    const entry = entries.find(e => e.id === id);
    if (entry) openEntryForm(entry);
  };

  window.__nwDelete = async (id) => {
    if (!confirm('Delete this snapshot?')) return;
    try {
      await deleteEntry(id);
    } catch (err) {
      showToast('Delete failed: ' + err.message, 'error');
      return;
    }
    showToast('Snapshot deleted.');
    await loadData();
  };
}

// ── Form Modal ───────────────────────────────────────────
function openEntryForm(entry = null, carry = false) {
  editingId = entry?.id || null;

  const previous = entries[entries.length - 1];
  const seed = entry || (carry ? previous : null);
  const money = (id, label, value) => `
    <div class="form-group">
      <label class="form-label" for="${id}">${label}</label>
      <input type="number" class="form-input" id="${id}" placeholder="0" min="0" value="${value ?? ''}" />
    </div>`;

  openModal({
    title: entry ? 'Edit snapshot' : 'Add a snapshot',
    body: `
      ${!entry && previous ? `<div class="snapshot-start"><p>${carry ? `Balances copied from ${escapeHTML(formatDate(previous.date))}. Review every carried balance before saving.` : 'Start with your last balances and update only what changed.'}</p><button type="button" class="btn-sm btn-ghost" id="nw-carry">${carry ? 'Start blank instead' : 'Start from latest snapshot'}</button></div>` : ''}
      ${carry ? '<label class="form-check"><input type="checkbox" id="nw-reviewed" /> I reviewed all carried balances</label>' : ''}
      <div class="form-group">
        <label class="form-label" for="nw-f-date">Date</label>
        <input type="date" class="form-input" id="nw-f-date" value="${escapeHTML(entry?.date || todayISO())}" />
      </div>

      <div class="form-section is-success">
        <i class="fas fa-arrow-up" aria-hidden="true"></i>Assets
      </div>
      <div class="form-row">
        ${money('nw-f-etfs', 'ETFs (₹)', seed?.etfs)}
        ${money('nw-f-stocks', 'Stocks (₹)', seed?.stocks)}
      </div>
      <div class="form-row">
        ${money('nw-f-mf', 'Mutual Funds (₹)', seed?.mutual_funds)}
        ${money('nw-f-fds', 'Fixed Deposits (₹)', seed?.fds)}
      </div>
      <div class="form-row">
        ${money('nw-f-cash', 'Cash & Bank (₹)', seed?.cash)}
        ${money('nw-f-epf', 'EPF (₹)', seed?.epf)}
      </div>
      <div class="form-row">
        ${money('nw-f-gold', 'Physical metals (₹)', seed?.gold)}
        ${money('nw-f-lent', 'Lent & owed to you (₹)', seed?.lent)}
      </div>

      <div class="form-section is-danger">
        <i class="fas fa-arrow-down" aria-hidden="true"></i>Liabilities
      </div>
      ${money('nw-f-cc', 'Credit Cards Outstanding (₹)', seed?.credit_cards)}
      <p class="form-hint">Enter the full card dues here and what people owe you under Lent — the net shows below, so neither needs adjusting by hand.</p>

      <!-- Live preview -->
      <div class="form-preview">
        <div class="form-preview-label">Live Preview</div>
        <div class="form-preview-row">
          <span>Total Assets</span>
          <span class="form-preview-value" id="nw-preview-assets">₹0</span>
        </div>
        <div class="form-preview-row">
          <span>Net Worth</span>
          <span class="form-preview-value is-accent" id="nw-preview-net">₹0</span>
        </div>
      </div>`,
    footer: `
      <button type="button" class="btn-cancel" data-close>Cancel</button>
      <button type="button" class="btn-submit" id="nw-form-submit">${entry ? 'Save changes' : 'Add snapshot'}</button>`,
  });

  document.getElementById('nw-carry')?.addEventListener('click', () => openEntryForm(null, !carry));

  // Live preview
  const fields = [...ASSET_FIELDS.map(f => FIELD_IDS[f.key]), 'nw-f-cc'];
  fields.forEach(id => {
    document.getElementById(id)?.addEventListener('input', updatePreview);
  });
  updatePreview();

  document.getElementById('nw-form-submit').addEventListener('click', submitForm);
}

// Form input id per asset class; the form, the preview and the save all read it.
const FIELD_IDS = {
  stocks: 'nw-f-stocks', etfs: 'nw-f-etfs', mutual_funds: 'nw-f-mf', cash: 'nw-f-cash',
  epf: 'nw-f-epf', gold: 'nw-f-gold', fds: 'nw-f-fds', lent: 'nw-f-lent',
};

/** The snapshot as the form currently has it — the same shape as a table row. */
function readForm() {
  const entry = Object.fromEntries(ASSET_FIELDS.map(f => [f.key, parseNum(document.getElementById(FIELD_IDS[f.key])?.value)]));
  entry.credit_cards = parseNum(document.getElementById('nw-f-cc')?.value);
  return entry;
}

function updatePreview() {
  const entry = readForm();
  const assets = computeAssets(entry);
  const net = computeNet(entry);

  const pa = document.getElementById('nw-preview-assets');
  const pn = document.getElementById('nw-preview-net');
  if (pa) pa.textContent = formatINRFull(assets);
  if (pn) {
    pn.textContent = formatINRFull(net);
    pn.classList.toggle('is-accent', net >= 0);
    pn.classList.toggle('is-danger', net < 0);
  }
}

async function submitForm() {
  const btn = document.getElementById('nw-form-submit');
  await withBusy(btn, 'Saving…', async () => {
    const payload = {
      date:    document.getElementById('nw-f-date')?.value,
      ...readForm(),
      user_id: await getCurrentUserId(),
    };

    const reviewed = document.getElementById('nw-reviewed');
    if (reviewed && !reviewed.checked) { showToast('Review the carried balances and tick the confirmation before saving.', 'error'); return; }
    if (!payload.date) { showToast('Please select a date.', 'error'); return; }
    if (editingId) payload.id = editingId;

    try {
      await saveEntry(payload);
    } catch (err) {
      showToast('Save failed: ' + err.message, 'error');
      return;
    }

    closeModal();
    showToast(editingId ? 'Snapshot updated!' : 'Snapshot added!');
    await loadData();
  });
}

// ── Export ───────────────────────────────────────────────
function exportCSV() {
  const headers = ['Date', ...ASSET_FIELDS.map(f => f.label), 'Credit Cards', 'Total Assets', 'Net Worth'];
  const rows = entries.map(e => [
    e.date, ...ASSET_FIELDS.map(f => e[f.key] || 0), e.credit_cards || 0, computeAssets(e), computeNet(e),
  ]);
  downloadCSV(headers, rows, `net_worth_export_${todayISO()}.csv`);
  showToast('CSV exported!');
}
