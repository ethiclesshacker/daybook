// @ts-check
// Hash-based SPA router
// URLs: /#dashboard, /#networth, /#points, /#ledger, /#food, /#dishes, /#health
// Handles refresh, back/forward, and deep-links automatically.
//
// A view is registered as { render, unmount }. Before a new view is drawn the
// previous one's unmount runs, which is where charts, grids, timers and
// document-level listeners are released — without it every visit to a screen
// leaked the last visit's Chart.js instances and their resize observers.
//
// A route can also be registered lazily, as a `load()` that resolves to the
// view module — `() => import('./views/food.js')` — so each screen is its own
// chunk, fetched the first time it is opened rather than in front of the
// first paint of every screen.

import { VIEW_IDS, FALLBACK_VIEW } from './routes.js';

const routes = {};
let currentId = null;
// Bumped on every navigation, so a slow chunk for a view the user has already
// left does not render over the one they went to.
let renderToken = 0;

/**
 * @param {string} id
 * @param {(container: HTMLElement) => void|Promise<void>} render
 * @param {() => void} [unmount]
 */
export function registerRoute(id, render, unmount) {
  routes[id] = { render, unmount };
}

/**
 * Register a view whose module is fetched on first visit.
 * @param {string} id
 * @param {() => Promise<{render: Function, unmount?: Function}>} load
 */
export function registerLazyRoute(id, load) {
  let module = null;
  routes[id] = {
    async resolve() {
      module ??= await load();
      return module;
    },
    get render() { return module?.render; },
    get unmount() { return module?.unmount; },
  };
}

/** Start fetching a lazy view's chunk without rendering it (hover / idle prefetch). */
export function prefetchRoute(id) {
  routes[id]?.resolve?.().catch(() => {});
}

/** Read the current hash and return the view ID it maps to. */
function hashToView() {
  const hash = window.location.hash.replace('#', '').trim();
  if (VIEW_IDS.includes(hash)) return hash;
  // An unknown or retired route (#fi) lands on the fallback with the URL to match,
  // so the nav highlights it and a reload does not repeat the detour.
  history.replaceState(null, '', '#' + FALLBACK_VIEW);
  return FALLBACK_VIEW;
}

/** Navigate to a view — updates hash, active nav item, renders the view. */
export function navigateTo(viewId) {
  if (!VIEW_IDS.includes(viewId)) viewId = FALLBACK_VIEW;

  // Only push a new hash if we're actually changing views
  // (avoids double-render on the initial hashchange after page load)
  if (window.location.hash !== '#' + viewId) {
    window.location.hash = viewId;
    return; // hashchange handler will call _render
  }

  _render(viewId);
}

function _render(viewId) {
  // Update nav active state
  /** @type {NodeListOf<HTMLElement>} */ (document.querySelectorAll('.nav-item[data-view]')).forEach(item => {
    const isActive = item.dataset.view === viewId;
    item.classList.toggle('active', isActive);
    // Tell assistive tech which view is current, not just which one is blue.
    if (isActive) item.setAttribute('aria-current', 'page');
    else item.removeAttribute('aria-current');
  });

  const container = document.getElementById('view-container');
  if (!container) return;

  // Let the outgoing view release what it holds before its DOM goes away.
  const leaving = currentId && routes[currentId];
  if (leaving?.unmount) {
    try { leaving.unmount(); } catch (err) { console.error(`[router] unmount ${currentId} failed:`, err); }
  }

  const route = routes[viewId] || routes[FALLBACK_VIEW];
  const changed = currentId !== viewId;
  currentId = route ? viewId : null;
  const token = ++renderToken;

  // A new screen starts at its top. The router never reset scroll, so opening
  // Settings from the foot of a long timeline landed halfway down Settings.
  // Viewport-locked pages (.vp-page) scroll inside their own panel and are
  // rebuilt fresh, so resetting the page itself is all either kind needs.
  if (changed) {
    window.scrollTo(0, 0);
    const main = document.getElementById('main-content');
    if (main) main.scrollTop = 0;
  }

  if (!route) return;
  if (route.resolve && !route.render) {
    // First visit to a lazy screen: a skeleton while its chunk arrives.
    container.innerHTML = '<div class="page-body"><div class="skeleton skeleton--table"></div></div>';
  }
  Promise.resolve(route.resolve ? route.resolve() : route)
    .then(() => {
      if (token !== renderToken) return;   // the user has already moved on
      return route.render?.(container);
    })
    .catch(err => {
      console.error(`[router] render ${viewId} failed:`, err);
      if (token === renderToken && route.resolve && !route.render) {
        // The chunk itself failed — usually a deploy replaced it under an open tab.
        container.innerHTML = `<div class="page-body"><div class="dash-banner dash-banner--error" role="alert">
          <div><strong>This screen could not load.</strong>
          <div class="dash-banner-sub">Reload the page to fetch the latest version.</div></div></div></div>`;
      }
    });
}

let isListenerAdded = false;

/** Call once after the app shell is mounted. */
export function startRouter() {
  // Handle back/forward and hash changes
  if (!isListenerAdded) {
    window.addEventListener('hashchange', () => _render(hashToView()));
    isListenerAdded = true;
  }

  // Render the initial view from the current hash (handles refresh & deep-link)
  _render(hashToView());
}
