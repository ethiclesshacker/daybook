// @ts-check
// ======================================================
// The every-15-minutes job.
//
// One run per mailbox: read the checkpoint, ask the connector what is new,
// push it through the pipeline, then move the checkpoint — in that order. A
// crash anywhere leaves the checkpoint where it was, so the next run re-reads
// a handful of messages, which idempotent ingestion makes free. The opposite
// order would turn a crash into a permanent hole in the ledger.
//
// A message the pipeline could not finish (model down, call ceiling, a write
// refused) is not a crash, and must not become a hole either. The checkpoint
// moves past it but keeps it on the folder's retry list, and every run fetches
// the retry list again until the message is handled — or, after MAX_ATTEMPTS
// failures of its own, recorded as a needs-review source.
//
// One failing account never stops the others: each is wrapped, recorded in
// ingestion_runs and reported at the end.
// ======================================================

import { config, loadAccounts } from '../config.js';
import { getConnector } from '../connectors/index.js';
import * as database from '../db.js';
import { runPipeline, MAX_ATTEMPTS } from '../pipeline.js';
import { redactSecrets } from '../extract/openai.js';

// A retry entry that has failed this many times — including failing to be
// written even as needs-review — is dropped from the list and reported, so
// nothing lingers for ever.
export const ABANDON_AFTER = MAX_ATTEMPTS * 2;

/**
 * The folder's next retry list: what was there, minus what this run handled
 * or found deleted, plus what it could not finish. Pure, for the tests.
 *
 * `fetchedUids` are the UIDs the connector handed over for this folder;
 * `unprocessed` the pipeline's entries for this folder.
 */
export function nextRetryList(previous = [], { fetchedUids = [], unprocessed = [], missingUids = [], now = new Date().toISOString() } = {}) {
  const byUid = new Map(previous.map(entry => [Number(entry.uid), entry]));
  const failedUids = new Set(unprocessed.map(u => Number(u.message.uid)));

  for (const uid of fetchedUids) if (!failedUids.has(Number(uid))) byUid.delete(Number(uid));
  for (const uid of missingUids) byUid.delete(Number(uid));

  const abandoned = [];
  for (const item of unprocessed) {
    const uid = Number(item.message.uid);
    const before = byUid.get(uid);
    const entry = {
      uid,
      message_id: item.message.messageId || null,
      subject: String(item.message.subject || '').slice(0, 120) || null,
      reason: item.reason,
      error: redactSecrets(item.error).slice(0, 300),
      attempts: item.attempts ?? before?.attempts ?? 0,
      first_failed_at: before?.first_failed_at || now,
      last_failed_at: now,
    };
    if (entry.attempts >= ABANDON_AFTER) {
      byUid.delete(uid);
      abandoned.push(entry);
    } else {
      byUid.set(uid, entry);
    }
  }

  return { retry: [...byUid.values()].sort((a, b) => a.uid - b.uid), abandoned };
}

export async function ingestEmail(options = {}, deps = {}) {
  const db = { ...database, ...(deps.db || {}) };
  const connectorFor = deps.getConnector || getConnector;
  const pipeline = deps.runPipeline || runPipeline;

  const userId = await db.resolveUserId();
  const accounts = (deps.accounts || loadAccounts()).filter(a => !options.account || a.key === options.account);

  if (!accounts.length) {
    throw new Error(options.account
      ? `No enabled account with key "${options.account}".`
      : 'No enabled mail accounts in accounts.json.');
  }

  const summary = { started_at: new Date().toISOString(), accounts: [] };
  const backfillDays = options.backfillDays ? parseInt(options.backfillDays, 10) : null;

  for (const account of accounts) {
    const started = Date.now();
    let runId = null;
    // Whatever happens below, the run row gets a verdict. A crash that left it
    // `running` forever is how the "is this thing on?" badge lied for days.
    let outcome = null;
    try {
      const connector = connectorFor(account.protocol);
      // Inside the try: a run row that cannot be opened is this account's
      // failure, not the end of every other account's run.
      runId = await db.startRun(userId, connector.sourceType, account.key, {
        host: account.host, folders: account.folders,
        dry_run: Boolean(options.dryRun),
        backfill_days: backfillDays,
      });

      const cursor = await db.getCheckpoint(userId, connector.sourceType, account.key);

      const { messages, cursor: nextCursor, stats } = await connector.fetchNew(account, cursor, {
        // A backfill is allowed a bigger bite, since it is a one-off catch-up
        // rather than the every-15-minutes path.
        maxMessages: options.limit ? parseInt(options.limit, 10)
                   : backfillDays ? Math.max(config.limits.maxMessages, 1000)
                   : config.limits.maxMessages,
        maxMessageBytes: config.limits.maxMessageBytes,
        maxPdfMessageBytes: config.limits.maxPdfMessageBytes,
        ignoreCursor: Boolean(backfillDays),
        lookbackDays: backfillDays || undefined,
      });

      // A run that hit the ceiling read only part of the window it was asked
      // for, and the part it missed is the newest. Reported as an error so the
      // run lands as `partial` and the gap is visible, rather than as a
      // success that quietly did two thirds of the job.
      if (stats.notReached > 0) {
        stats.warning = `${stats.notReached} messages in the window were not read (per-run ceiling). `
          + 'Re-run with a narrower --backfill-days, or a larger --limit.';
      }

      // Attempts so far, from the retry lists the connector carried over.
      const attemptsByKey = new Map();
      for (const [folder, state] of Object.entries(nextCursor.folders || {})) {
        for (const entry of state.retry || []) attemptsByKey.set(`${folder}\u0000${entry.uid}`, entry.attempts || 0);
      }
      const priorAttempts = (message) => attemptsByKey.get(`${message.folder}\u0000${message.uid}`) || 0;

      const counters = await pipeline({
        userId, accountKey: account.key, selfAddresses: [account.user],
        messages, dryRun: Boolean(options.dryRun), priorAttempts,
      });

      // Rewrite each folder's retry list from what this run actually managed.
      const now = new Date().toISOString();
      const unprocessed = counters.unprocessed || [];
      const retrying = [];
      for (const [folder, state] of Object.entries(nextCursor.folders || {})) {
        const { retry, abandoned } = nextRetryList(state.retry, {
          fetchedUids: messages.filter(m => m.folder === folder).map(m => m.uid),
          unprocessed: unprocessed.filter(u => u.message.folder === folder),
          missingUids: stats.retryMissing?.[folder] || [],
          now,
        });
        if (retry.length) state.retry = retry; else delete state.retry;
        retrying.push(...retry.map(r => ({ folder, ...r })));
        for (const entry of abandoned) {
          counters.errors.push({ stage: 'retry', error:
            `abandoned ${folder} UID ${entry.uid} (${entry.message_id || 'no message id'}) after ${entry.attempts} attempts: ${entry.error}` });
        }
      }
      // Anything the pipeline could not finish that has no folder/UID to come
      // back by. Said out loud, since nothing will retry it.
      for (const item of unprocessed.filter(u => !u.message.folder || u.message.uid == null)) {
        counters.errors.push({ stage: 'retry', error: `cannot retry ${item.message.messageId}: no folder/UID (${item.reason})` });
      }
      if (unprocessed.length) {
        counters.errors.push({ stage: 'unprocessed', error:
          `${unprocessed.length} message(s) not finished this run (${[...new Set(unprocessed.map(u => u.reason))].join(', ')}); kept on the retry list` });
      }

      // Only now, with every event committed and every unfinished message on
      // a retry list.
      if (!options.dryRun) {
        await db.setCheckpoint(userId, connector.sourceType, account.key, nextCursor, unprocessed.length === 0);
      }

      if (stats.notReached > 0) {
        counters.errors.push({ stage: 'connector', error: stats.warning });
      }

      const errors = counters.errors.map(e => (e.error ? { ...e, error: redactSecrets(e.error) } : e));
      const failures = errors.filter(e => e.stage !== 'merge').length;
      const status = failures ? 'partial' : 'succeeded';

      outcome = {
        status,
        itemsSeen: counters.itemsSeen,
        eventsCreated: counters.eventsCreated,
        eventsUpdated: counters.eventsUpdated,
        eventsSkipped: counters.eventsSkipped,
        errors,
        metadata: {
          connector: stats,
          sources_only: counters.sourcesOnly,
          llm_calls: counters.llmCalls,
          llm_usage: counters.llmUsage,
          fingerprint_suppressed: counters.fingerprintSuppressed,
          by_extractor: counters.byExtractor,
          unprocessed: unprocessed.length,
          needs_review: counters.needsReview || 0,
          retry_list: retrying.length,
          duration_ms: Date.now() - started,
        },
      };

      const { unprocessed: _u, errors: _e, ...rest } = counters;
      summary.accounts.push({
        account: account.key, ok: status === 'succeeded', status, ...rest, errors,
        unprocessed: unprocessed.map(u => ({ folder: u.message.folder, uid: u.message.uid,
                                             subject: u.message.subject, reason: u.reason, attempts: u.attempts })),
        retry_list: retrying.length,
        connector: stats,
      });
    } catch (err) {
      const error = redactSecrets(err.message);
      outcome = {
        status: 'failed',
        errors: [{ stage: 'run', error }],
        metadata: { duration_ms: Date.now() - started },
      };
      summary.accounts.push({ account: account.key, ok: false, status: 'failed', error });
    } finally {
      if (runId) {
        try {
          await db.finishRun(runId, outcome || {
            status: 'failed',
            errors: [{ stage: 'run', error: 'the run ended without recording an outcome' }],
            metadata: { duration_ms: Date.now() - started },
          });
        } catch (err) {
          // The database is the one thing that can stop the row being closed;
          // say so in the report rather than losing the account's result.
          summary.accounts.push({ account: account.key, ok: false, status: 'failed', error: `finishRun: ${err.message}` });
        }
      }
    }
  }

  // New card alerts become Points rows here, so the page is current without
  // anyone opening it. Never fatal: the events are already safely in.
  if (!options.dryRun) {
    try {
      summary.card_points = await db.syncCardPoints(userId);
    } catch (err) {
      summary.card_points = { error: err.message };
    }
    // Keep the review queue to real questions: a bank alert is a fact, not
    // something to ask "did this happen?" about. After the points sync, so a
    // row that corroborates an event already exists.
    try {
      summary.auto_confirmed = await db.autoConfirm(userId);
    } catch (err) {
      summary.auto_confirmed = { error: err.message };
    }
  }

  // The worst account decides: what the CLI exits with, so launchd's last
  // exit status shows a failing job instead of a clean 0.
  const statuses = summary.accounts.map(a => a.status);
  summary.status = statuses.includes('failed') ? 'failed'
                 : statuses.includes('partial') ? 'partial' : 'succeeded';
  summary.completed_at = new Date().toISOString();
  return summary;
}
