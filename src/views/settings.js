import * as settings from '../settings.js';
import { SETTINGS_SCHEMA, SETTING_GROUPS } from '../settings.js';
import { escapeHTML, showToast, parseNum, formatINR, withBusy } from '../utils.js';

// ======================================================
// Settings.
//
// The whole screen is still generated from SETTINGS_SCHEMA — adding a setting
// there makes it appear here, with no markup to write. What changed is the
// shape around it:
//
//   · Save used to live in the page header, twenty-four fields above the one
//     being edited. It is a bar at the foot of the screen now, and it only
//     appears once something has actually changed — so it doubles as the
//     answer to "did that take?".
//   · Nothing said which fields were edited. Changed fields are marked, and
//     the bar counts them.
//   · The derived figures — FI target, surplus, real return — scrolled away
//     from the fields that produce them. They stay in view while you type.
//   · The ledger's eleven matching thresholds carried the same weight as
//     monthly income. That group is collapsed until asked for.
// ======================================================

let draft = {};
let saved = {};

/** A rupee field: shown with digit grouping, edited as plain digits. */
const isMoney = spec => spec.type === 'number' && spec.prefix === '₹';
const grouped = value => (Number.isFinite(Number(value)) ? Number(value).toLocaleString('en-IN', { maximumFractionDigits: 2 }) : '');
const readNumber = text => parseNum(String(text).replace(/[,\s₹]/g, ''));

export async function renderSettings(container) {
  // Boot no longer waits for user_settings before painting, so this screen
  // does — it is the one screen that shows the stored values themselves.
  if (!container.querySelector('.set-body')) {
    container.innerHTML = '<div class="page-body"><div class="skeleton skeleton--table"></div></div>';
  }
  await settings.ready();
  if (!container.isConnected) return;
  draft = settings.all();
  saved = settings.all();

  container.innerHTML = `
    <div class="page-header">
      <div class="page-header-left">
        <h2>Settings</h2>
        <p>Your numbers. Everything on the other screens is derived from these.</p>
      </div>
    </div>

    <div class="page-body set-body">
      <div class="set-layout">
        <div class="set-groups">
          ${SETTING_GROUPS.map(groupMarkup).join('')}

          <!-- Developer note (user_settings key/value storage) hidden from the screen; it is in the README. -->
          <!-- <p class="settings-footnote">Stored per user in <code>user_settings</code> as key/value pairs…</p> -->
        </div>

        <aside class="set-aside" aria-label="Derived figures">
          <div class="set-derived" id="set-derived"></div>
        </aside>
      </div>
    </div>

    <!-- Appears only when there is something to save. -->
    <div class="set-bar" id="set-bar" hidden>
      <span class="set-bar-count" id="set-bar-count"></span>
      <div class="set-bar-actions">
        <button type="button" class="btn-sm btn-ghost" id="set-revert">Discard changes</button>
        <button type="button" class="btn-sm btn-accent" id="set-save">Save changes</button>
      </div>
    </div>
  `;

  Object.keys(SETTINGS_SCHEMA).forEach(key => {
    const input = document.getElementById(`set-${key}`);
    const spec = SETTINGS_SCHEMA[key];
    input?.addEventListener('input', () => {
      draft[key] = spec.type === 'number' ? readNumber(input.value) : input.value;
      reflectField(key);
      renderDerived();
      reflectBar();
    });

    // ₹93,795 to read, 93795 to edit: grouping while typing moves the caret.
    if (isMoney(spec) && input) {
      input.addEventListener('focus', () => { input.value = draft[key] ? String(draft[key]) : ''; });
      input.addEventListener('blur', () => { input.value = grouped(draft[key]); });
    }

    document.getElementById(`reset-${key}`)?.addEventListener('click', () => resetOne(key));
  });

  // Every field's state on arrival, not only after a keystroke: "Reset to
  // default" for a saved value used to appear only once you had typed in it.
  Object.keys(SETTINGS_SCHEMA).forEach(reflectField);

  document.getElementById('set-save')?.addEventListener('click', save);
  document.getElementById('set-revert')?.addEventListener('click', async () => {
    await renderSettings(container);
    showToast('Changes discarded.');
  });

  renderDerived();
  reflectBar();
}

export { renderSettings as render };

// ── Markup ─────────────────────────────────────────────

function groupMarkup(group) {
  const fields = Object.entries(SETTINGS_SCHEMA)
    .filter(([, spec]) => spec.group === group.name)
    .map(([key, spec]) => fieldMarkup(key, spec))
    .join('');

  const head = `
    <div class="set-group-head">
      <span class="set-group-icon" aria-hidden="true"><i class="fas ${group.icon}"></i></span>
      <div>
        <h3 class="set-group-title">${escapeHTML(group.name)}</h3>
        <p class="set-group-blurb">${escapeHTML(group.blurb)}</p>
      </div>
    </div>`;

  // Advanced groups open on demand. Everything else is open by definition.
  return group.advanced
    ? `<details class="set-group is-advanced">
         <summary>${head}</summary>
         <div class="settings-fields">${fields}</div>
       </details>`
    : `<section class="set-group">
         ${head}
         <div class="settings-fields">${fields}</div>
       </section>`;
}

function fieldMarkup(key, spec) {
  const value = draft[key];

  const control = spec.type === 'enum'
    ? `<select class="form-select" id="set-${key}">
         ${spec.options.map(o => `
           <option value="${escapeHTML(o.value)}" ${o.value === value ? 'selected' : ''}>
             ${escapeHTML(o.label)}
           </option>`).join('')}
       </select>`
    : `<div class="set-input ${spec.prefix ? 'has-prefix' : ''} ${spec.suffix ? 'has-suffix' : ''}">
         ${spec.prefix ? `<span class="set-affix is-prefix" aria-hidden="true">${escapeHTML(spec.prefix)}</span>` : ''}
         <input
           type="${spec.type === 'number' && !isMoney(spec) ? 'number' : 'text'}"
           ${isMoney(spec) ? 'inputmode="decimal" autocomplete="off"' : ''}
           class="form-input"
           id="set-${key}"
           value="${escapeHTML(isMoney(spec) ? grouped(value) : value)}"
           ${spec.min !== undefined && !isMoney(spec) ? `min="${spec.min}"` : ''}
           ${spec.max !== undefined && !isMoney(spec) ? `max="${spec.max}"` : ''}
           ${spec.step !== undefined && !isMoney(spec) ? `step="${spec.step}"` : ''}
           aria-describedby="${spec.hint ? `hint-${key} ` : ''}clamp-${key}"
         />
         ${spec.suffix ? `<span class="set-affix is-suffix" aria-hidden="true">${escapeHTML(spec.suffix)}</span>` : ''}
       </div>`;

  return `
    <div class="set-field" id="field-${key}" data-key="${key}">
      <div class="set-field-head">
        <label class="set-field-label" for="set-${key}">${escapeHTML(spec.label)}</label>
        <span class="set-field-state" id="state-${key}"></span>
      </div>
      ${control}
      <p class="set-clamp" id="clamp-${key}" role="status" hidden></p>
      ${spec.hint ? `<p class="form-hint" id="hint-${key}">${escapeHTML(spec.hint)}</p>` : ''}
    </div>
  `;
}

// ── State ──────────────────────────────────────────────

/** Which keys differ from what is stored. */
function changedKeys() {
  return Object.keys(SETTINGS_SCHEMA).filter(k => draft[k] !== saved[k]);
}

/** Mark one field as edited, or offer to put it back to its default. */
function reflectField(key) {
  const field = document.getElementById(`field-${key}`);
  const state = document.getElementById(`state-${key}`);
  if (!field || !state) return;

  const isChanged = draft[key] !== saved[key];
  const isDefault = draft[key] === SETTINGS_SCHEMA[key].default;
  field.classList.toggle('is-changed', isChanged);

  // Out of bounds is clamped on save (settings.js coerce). Say so while
  // typing, rather than letting 500 quietly become 50.
  const spec = SETTINGS_SCHEMA[key];
  const clamp = document.getElementById(`clamp-${key}`);
  if (clamp && spec.type === 'number') {
    const v = Number(draft[key]);
    const msg = spec.max !== undefined && v > spec.max ? `Above the maximum — it will be saved as ${spec.max.toLocaleString('en-IN')}.`
      : spec.min !== undefined && v < spec.min ? `Below the minimum — it will be saved as ${spec.min.toLocaleString('en-IN')}.`
      : '';
    clamp.textContent = msg;
    clamp.hidden = !msg;
    field.classList.toggle('is-clamped', Boolean(msg));
  }

  if (isChanged) {
    state.innerHTML = '<span class="set-chip">Edited</span>';
  } else if (!isDefault) {
    state.innerHTML = `<button type="button" class="settings-reset" id="reset-${key}">Reset to default</button>`;
    document.getElementById(`reset-${key}`)?.addEventListener('click', () => resetOne(key));
  } else {
    state.innerHTML = '';
  }
}

/** The save bar exists only while there is something to save. */
function reflectBar() {
  const bar   = document.getElementById('set-bar');
  const count = document.getElementById('set-bar-count');
  if (!bar || !count) return;

  const n = changedKeys().length;
  bar.hidden = n === 0;
  count.textContent = n === 1 ? '1 unsaved change' : `${n} unsaved changes`;
}

/** Live preview of the numbers that fall out of the current draft. */
function renderDerived() {
  const el = document.getElementById('set-derived');
  if (!el) return;

  // The same functions every other screen derives from, fed the draft rather
  // than the saved settings — so the preview cannot drift from the real thing.
  const annual   = settings.annualExpenses(draft);
  const target   = settings.fiTarget(draft);
  const surplus  = settings.budgetedSurplus(draft);
  const rate     = settings.budgetedSavingsRate(draft);
  const realRet  = settings.realReturnRate(draft) * 100;
  const expected = draft.wealth_score_divisor > 0
    ? (draft.age * draft.monthly_net_income * 12) / draft.wealth_score_divisor : 0;

  const items = [
    { label: 'Annual expenses',       value: formatINR(annual),
      note: 'Monthly baseline × 12' },
    { label: 'FI target',             value: formatINR(target),
      note: `${draft.fi_multiplier}× annual expenses` },
    { label: 'Monthly surplus',       value: formatINR(surplus), warn: surplus < 0,
      note: surplus < 0 ? 'Spending more than you earn' : 'Income − expenses' },
    { label: 'Budgeted savings rate', value: rate.toFixed(1) + '%', warn: rate < 0,
      note: 'Surplus as a share of income' },
    { label: 'Real return',           value: realRet.toFixed(2) + '%', warn: realRet <= 0,
      note: realRet <= 0 ? 'Inflation is eating the return' : 'After inflation' },
    { label: 'Expected net worth for your age', value: formatINR(expected),
      note: `Age × annual income ÷ ${draft.wealth_score_divisor}; the wealth score is your net worth ÷ this` },
  ];

  el.innerHTML = `
    <h3 class="set-derived-title">What these produce</h3>
    <dl class="set-derived-list">
      ${items.map(i => `
        <div class="set-derived-item">
          <dt>${escapeHTML(i.label)}</dt>
          <dd class="mono ${i.warn ? 'text-danger' : ''}">${escapeHTML(i.value)}</dd>
          <p class="set-derived-note">${escapeHTML(i.note)}</p>
        </div>
      `).join('')}
    </dl>
    <p class="set-derived-foot">Updates as you type. Nothing is stored until you save.</p>
  `;
}

// ── Writes ─────────────────────────────────────────────

async function resetOne(key) {
  const value = SETTINGS_SCHEMA[key].default;
  draft[key] = value;

  const input = document.getElementById(`set-${key}`);
  if (input) input.value = isMoney(SETTINGS_SCHEMA[key]) ? grouped(value) : value;
  reflectField(key);
  renderDerived();
  reflectBar();
  showToast(`${SETTINGS_SCHEMA[key].label} reset in your draft. Save changes to apply it.`);
}

async function save() {
  const btn = document.getElementById('set-save');
  const keys = changedKeys();

  if (!keys.length) { showToast('Nothing to save.'); return; }

  // Only what actually changed, so untouched keys keep falling back to their
  // defaults instead of being pinned to a copy of the default.
  const patch = Object.fromEntries(keys.map(k => [k, draft[k]]));
  const { error } = await withBusy(btn, 'Saving…', () => settings.saveSettings(patch));

  if (error) { showToast('Save failed: ' + error.message, 'error'); return; }

  saved = settings.all();
  keys.forEach(reflectField);
  reflectBar();
  showToast(keys.length === 1 ? 'Setting saved.' : `${keys.length} settings saved.`);
}
