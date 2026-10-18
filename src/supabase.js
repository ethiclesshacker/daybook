// import { createClient } from '@supabase/supabase-js';  // replaced below: it bundles realtime + storage (~95 KB) this app never uses
import { AuthClient } from '@supabase/auth-js';
import { PostgrestClient } from '@supabase/postgrest-js';
import { fatalPanel } from './utils.js';

const SUPABASE_URL = import.meta.env.VITE_SUPABASE_URL;
const SUPABASE_KEY = import.meta.env.VITE_SUPABASE_ANON_KEY;

// Vite inlines these at *build* time. A build run without .env present (or a CI
// build with the vars unset) ships a bundle where createClient throws on import
// and the page renders blank with only a console error — fail loudly instead.
if (!SUPABASE_URL || !SUPABASE_KEY) {
  fatalPanel('Configuration error',
    'This build is missing <code>VITE_SUPABASE_URL</code> / <code>VITE_SUPABASE_ANON_KEY</code>. ' +
    'They are baked in at build time, so set them in <code>.env</code> and run <code>npm run build</code> again before deploying.');
  throw new Error('Missing VITE_SUPABASE_URL / VITE_SUPABASE_ANON_KEY at build time.');
}

// The two halves of supabase-js this app uses, wired the way createClient
// wires them (supabase-js 2.110, SupabaseClient's constructor): auth on
// /auth/v1 with the anon key, PostgREST on /rest/v1 through a fetch that
// attaches the signed-in user's access token. createClient also builds a
// RealtimeClient and a StorageClient on construction — about 95 KB of the
// bundle for websockets and file buckets that nothing here opens.
//
// export const supabase = createClient(SUPABASE_URL, SUPABASE_KEY, { auth: { …same options… } });
const BASE_URL = SUPABASE_URL.replace(/\/+$/, '');
const CLIENT_INFO = { 'X-Client-Info': 'finance-hub (supabase auth-js + postgrest-js)' };

const auth = new AuthClient({
  url: `${BASE_URL}/auth/v1`,
  headers: { Authorization: `Bearer ${SUPABASE_KEY}`, apikey: SUPABASE_KEY, ...CLIENT_INFO },
  persistSession:    true,  // store session in localStorage → survives page reloads & browser restarts
  autoRefreshToken:  true,  // silently refresh the access token before it expires
  detectSessionInUrl: false, // sign-in is an email code typed into the page; nothing arrives in the URL
  storageKey: 'finance-hub-session', // namespaced key so it doesn't clash with other Supabase apps
  flowType: 'implicit',     // supabase-js's default; OTP verification does not use it
});

/** fetch with the apikey and the session's bearer token — supabase-js's fetchWithAuth. */
async function fetchWithAuth(input, init = {}) {
  const { data } = await auth.getSession();
  const token = data?.session?.access_token ?? SUPABASE_KEY;
  const headers = new Headers(init.headers);
  if (!headers.has('apikey')) headers.set('apikey', SUPABASE_KEY);
  if (!headers.has('Authorization')) headers.set('Authorization', `Bearer ${token}`);
  return fetch(input, { ...init, headers });
}

const rest = new PostgrestClient(`${BASE_URL}/rest/v1`, {
  headers: { ...CLIENT_INFO },
  schema: 'public',
  fetch: fetchWithAuth,
});

/** The same surface the app used from createClient: `.auth`, `.from()`, `.rpc()`. */
export const supabase = {
  auth,
  from: relation => rest.from(relation),
  rpc: (fn, args = {}, options = {}) => rest.rpc(fn, args, options),
};

/**
 * Returns the current authenticated user's UUID, or null if not signed in.
 *
 * Read from the stored session, not auth.getUser(): getUser() is a network
 * round trip to /auth/v1/user on every save, and the id is only ever used to
 * stamp `user_id` on a row that RLS checks against the JWT anyway.
 */
export async function getCurrentUserId() {
  const { data: { session } } = await supabase.auth.getSession();
  return session?.user?.id ?? null;
}
