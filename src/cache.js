// ======================================================
// A tiny per-session read cache for the API modules.
//
// Food and Dishes each read the same 1,000 food events; Dashboard, Net Worth
// and Points each read the same snapshots and card rows. Moving between them
// re-fetched all of it. A read is now kept for a short while, keyed by what
// was asked, and two screens asking at once share one request.
//
// It is a cache of reads only, and deliberately blunt about invalidation: any
// write through an API module clears that module's whole namespace, so a
// screen can never show its own edit missing. The refresh buttons clear it
// too — they mean "go and look", not "show me what you remember".
// ======================================================

const DEFAULT_TTL_MS = 60_000;
const store = new Map();   // key → { at, promise }

/**
 * `fn()`'s result for `key`, reused for `ttl` ms. A rejected promise is not
 * kept, so a failed read is retried on the next ask rather than remembered.
 */
export function cached(key, fn, ttl = DEFAULT_TTL_MS) {
  const hit = store.get(key);
  if (hit && Date.now() - hit.at < ttl) return hit.promise;
  const promise = Promise.resolve().then(fn);
  store.set(key, { at: Date.now(), promise });
  promise.catch(() => { if (store.get(key)?.promise === promise) store.delete(key); });
  return promise;
}

/** Forget every key under `namespace` (`'ledger'` clears `ledger:…`), or everything. */
export function invalidate(namespace = null) {
  if (!namespace) { store.clear(); return; }
  for (const key of [...store.keys()]) {
    if (key === namespace || key.startsWith(namespace + ':')) store.delete(key);
  }
}

/** Wrap a write so it clears `namespaces` once it has gone through (or failed). */
export function invalidating(namespaces, fn) {
  return async (...args) => {
    try {
      return await fn(...args);
    } finally {
      for (const ns of [].concat(namespaces)) invalidate(ns);
    }
  };
}
