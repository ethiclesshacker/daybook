import { supabase } from './supabase.js';
import './vendor.js';
import { loadSettings } from './settings.js';
import { renderLogin } from './views/login.js';
import { renderApp } from './views/app.js';
import { applyChartDefaults, installCallListener, fatalPanel } from './utils.js';
import './style.css';

// Which user is currently painted on screen.
//   undefined → nothing rendered yet
//   null      → login screen
//   <uuid>    → app shell for that user
let renderedUserId;

async function render(session) {
  const userId = session?.user?.id ?? null;

  // Auth events fire far more often than the UI actually changes —
  // TOKEN_REFRESHED every hour, SIGNED_IN again whenever the tab regains
  // focus. Re-rendering on those wiped the DOM mid-use and bounced the
  // user back to the dashboard, so only repaint on a real identity change.
  if (userId === renderedUserId) return;
  renderedUserId = userId;

  if (userId) {
    // Every view reads settings synchronously, so they have to be in hand
    // before the shell mounts. loadSettings never rejects — a missing table or
    // a network blip falls back to the schema defaults.
    await loadSettings();
    renderApp(session);
  } else {
    renderLogin();
  }
}

async function init() {
  // Apply Chart.js global defaults once — all views share these settings.
  applyChartDefaults();

  // Buttons in generated table markup (Edit, Delete, Confirm…) run through one
  // delegated listener, because the production CSP refuses inline handlers.
  installCallListener();

  const { data: { session } } = await supabase.auth.getSession();
  await render(session);

  supabase.auth.onAuthStateChange((_event, session) => {
    // Never call back into supabase from inside this callback — it runs while
    // the auth lock is held and any await on supabase.* deadlocks. Renders kick
    // off data fetches, so bounce to a fresh task first.
    setTimeout(() => {
      render(session).catch(err => console.error('[auth] render failed:', err));
    }, 0);
  });
}

init().catch(err => {
  console.error('[init] failed:', err);
  fatalPanel('Something went wrong starting up',
    'Reload the page. If it keeps happening, check the browser console for details.');
});
