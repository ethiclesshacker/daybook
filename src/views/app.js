import { supabase } from '../supabase.js';
import * as settings from '../settings.js';
import { escapeHTML } from '../utils.js';
import { navigateTo, registerLazyRoute, startRouter, prefetchRoute } from '../router.js';
import { NAV_ITEMS } from '../routes.js';

// Each view module exports `render(container)` and, where it holds charts,
// grids, timers or document listeners, `unmount()`. Every one is its own
// chunk now, fetched on first visit: one 722 KB bundle used to hold all nine
// screens, Chart.js and the ledger's sentence parser in front of the first
// paint of any of them.
const VIEWS = {
  dashboard: () => import('./dashboard.js'),
  networth:  () => import('./networth.js'),
  points:    () => import('./points.js'),
  // Hidden with its nav item (routes.js); the module is kept, not deleted.
  // fi:     () => import('./fi.js'),
  ledger:    () => import('./ledger.js'),
  food:      () => import('./food.js'),
  dishes:    () => import('./dishes.js'),
  health:    () => import('./health.js'),
  settings:  () => import('./settings.js'),
};

// Below this the sidebar is an off-canvas drawer (style.css, 900px).
const DRAWER_QUERY = '(max-width: 900px)';

// Private-mode Safari throws on localStorage, and a thrown preference must
// not take the navigation down with it.
const RAIL_KEY = 'daybook-sidebar-rail';

function isRailCollapsed() {
  try { return localStorage.getItem(RAIL_KEY) === '1'; } catch (_) { return false; }
}

export function renderApp(session) {
  // Register all routes — the same list the sidebar is drawn from.
  for (const { id } of NAV_ITEMS) {
    if (VIEWS[id]) registerLazyRoute(id, VIEWS[id]);
  }

  const userEmail = session?.user?.email || '';
  // Falls back to the local part of the email until a display name is set.
  const userName  = settings.get('display_name') || userEmail.split('@')[0] || 'You';

  document.getElementById('app').innerHTML = `
    <!-- Mobile Header -->
    <div class="mobile-header">
      <button type="button" class="hamburger" id="hamburger-btn" aria-label="Open navigation" aria-expanded="false" aria-controls="sidebar">
        <i class="fas fa-bars"></i>
      </button>
      <span class="mobile-header-title">Daybook</span>
      <span class="mobile-header-spacer" aria-hidden="true"></span>
    </div>

    <div id="app-shell">
      <!-- Sidebar overlay (mobile) -->
      <div class="sidebar-overlay" id="sidebar-overlay"></div>

      <!-- Sidebar -->
      <nav class="sidebar" id="sidebar" aria-label="Main">
        <!-- Collapses the sidebar to an icon rail on desktop. Below the
             breakpoint where the sidebar is a drawer there is nothing to
             collapse, so the button is hidden there. -->
        <button type="button" class="sidebar-toggle" id="sidebar-toggle"
                aria-controls="sidebar" aria-expanded="true" title="Collapse sidebar">
          <i class="fas fa-angles-left" aria-hidden="true"></i>
          <span class="sr-only">Collapse sidebar</span>
        </button>

        <div class="sidebar-logo">
          <div class="sidebar-logo-icon" aria-hidden="true"><i class="fas fa-wallet"></i></div>
          <div class="sidebar-logo-names">
            <div class="sidebar-logo-text">Daybook</div>
            <div class="sidebar-logo-sub">Personal finance</div>
          </div>
        </div>

        <div class="sidebar-nav">
          ${NAV_ITEMS.map(item => `
            ${item.group !== undefined ? `
              <div class="nav-group" ${item.group ? '' : 'aria-hidden="true"'}>${escapeHTML(item.group)}</div>` : ''}
            <button
              type="button"
              class="nav-item ${item.id === 'dashboard' ? 'active' : ''}"
              data-view="${item.id}"
              id="nav-${item.id}"
              title="${escapeHTML(item.label)}"
              ${item.id === 'dashboard' ? 'aria-current="page"' : ''}
            >
              <i class="fas ${item.icon}" aria-hidden="true"></i>
              <span class="nav-item-label">${escapeHTML(item.label)}</span>
            </button>
          `).join('')}
        </div>

        <!-- The account opens a menu, and Sign out is a labelled item in it.
             It was a bare icon at the edge of the profile row, one stray click
             from ending the session. -->
        <div class="sidebar-footer">
          <div class="user-menu-wrap">
            <div class="user-menu" id="user-menu" hidden>
              <button type="button" class="user-menu-item" id="sign-out-btn">
                <i class="fas fa-arrow-right-from-bracket" aria-hidden="true"></i>
                <span>Sign out</span>
              </button>
            </div>
            <button type="button" class="user-profile" id="user-menu-btn"
                    aria-haspopup="true" aria-expanded="false" aria-controls="user-menu" title="Account">
              <div class="user-avatar" id="user-avatar" aria-hidden="true">${escapeHTML(userName[0].toUpperCase())}</div>
              <div class="user-info">
                <div class="user-name" id="user-name">${escapeHTML(userName)}</div>
                <div class="user-email" title="${escapeHTML(userEmail)}">${escapeHTML(userEmail) || 'Signed in'}</div>
              </div>
              <i class="fas fa-chevron-up user-menu-caret" aria-hidden="true"></i>
              <span class="sr-only">Account menu</span>
            </button>
          </div>
        </div>
      </nav>

      <!-- Main content area -->
      <main class="main-content" id="main-content">
        <div id="view-container"></div>
      </main>
    </div>
  `;

  // Navigation click handlers
  document.querySelectorAll('.nav-item[data-view]').forEach(item => {
    item.addEventListener('click', () => {
      navigateTo(item.dataset.view);
      closeSidebar();
    });
    // Pointing at a screen is a good hint you are about to open it.
    item.addEventListener('pointerenter', () => prefetchRoute(item.dataset.view), { once: true });
    item.addEventListener('focus', () => prefetchRoute(item.dataset.view), { once: true });
  });

  // The display name lives in user_settings, which now loads alongside the
  // first screen instead of before the shell. Fill it in when it arrives.
  settings.ready().then(() => {
    const name = settings.get('display_name');
    if (!name) return;
    const nameEl = document.getElementById('user-name');
    const avatarEl = document.getElementById('user-avatar');
    if (nameEl) nameEl.textContent = name;
    if (avatarEl) avatarEl.textContent = name[0].toUpperCase();
  });

  // ── Account menu ─────────────────────────────────────
  const menuBtn = document.getElementById('user-menu-btn');
  const menu = document.getElementById('user-menu');
  const setMenu = open => {
    menu.hidden = !open;
    menuBtn.setAttribute('aria-expanded', String(open));
    if (open) menu.querySelector('button')?.focus();
  };
  menuBtn.addEventListener('click', () => setMenu(menu.hidden));
  document.addEventListener('click', e => {
    if (!menu.hidden && !e.target.closest('.user-menu-wrap')) setMenu(false);
  });
  menu.addEventListener('keydown', e => {
    if (e.key === 'Escape') { e.preventDefault(); setMenu(false); menuBtn.focus(); }
  });

  // Sign out
  document.getElementById('sign-out-btn').addEventListener('click', async () => {
    setMenu(false);
    await supabase.auth.signOut();
  });

  // ── Sidebar rail ──────────────────────────────────────
  //
  // Collapsed state is per browser, not per account: it is a preference about
  // this screen, so localStorage rather than user_settings — no round trip,
  // and it is applied before the first paint of the next visit.
  const shell        = document.getElementById('app-shell');
  const railToggle   = document.getElementById('sidebar-toggle');

  function setRail(collapsed) {
    shell.classList.toggle('is-rail', collapsed);
    railToggle.setAttribute('aria-expanded', String(!collapsed));
    const label = collapsed ? 'Expand sidebar' : 'Collapse sidebar';
    railToggle.title = label;
    railToggle.querySelector('.sr-only').textContent = label;
    try { localStorage.setItem(RAIL_KEY, collapsed ? '1' : '0'); } catch (_) {}
  }

  setRail(isRailCollapsed());
  railToggle.addEventListener('click', () => setRail(!shell.classList.contains('is-rail')));

  // Mobile sidebar toggle
  const hamburger = document.getElementById('hamburger-btn');
  const overlay   = document.getElementById('sidebar-overlay');
  const sidebar   = document.getElementById('sidebar');

  // A closed drawer is off-canvas, not gone: without `inert` its links stay in
  // the tab order and the screen reader's reading order, invisible.
  const drawerMedia = window.matchMedia(DRAWER_QUERY);
  const syncInert = () => {
    const closed = !sidebar.classList.contains('open');
    sidebar.inert = drawerMedia.matches && closed;
  };
  drawerMedia.addEventListener?.('change', syncInert);

  hamburger?.addEventListener('click', () => {
    sidebar.classList.add('open');
    overlay.classList.add('visible');
    hamburger.setAttribute('aria-expanded', 'true');
    syncInert();
    sidebar.querySelector('.nav-item.active, .nav-item')?.focus();
  });
  overlay?.addEventListener('click', closeSidebar);
  document.addEventListener('keydown', e => {
    if (e.key === 'Escape' && sidebar.classList.contains('open')) {
      closeSidebar();
      hamburger?.focus();
    }
  });

  function closeSidebar() {
    sidebar?.classList.remove('open');
    overlay?.classList.remove('visible');
    hamburger?.setAttribute('aria-expanded', 'false');
    syncInert();
  }
  syncInert();

  // Load initial view
  startRouter();
}
