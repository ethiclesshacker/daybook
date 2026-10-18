// ======================================================
// The pipeline: messages in, ledger rows out.
//
//   connector → extraction → normalization → dedupe → storage → entities
//
// Only the first stage knows what a mailbox is, and only the last knows what
// Postgres is. Everything between is the same for any source: hand this
// function a list of messages in the normalized shape and it fills the ledger.
//
// Three rules it enforces regardless of which extraction rung fired:
//
//   - Every message that was read *and judged* produces a source row, even
//     when it produces no event. That is what makes a "we looked at this and
//     there was nothing here" verdict durable, and what the fingerprint cache
//     learns from.
//   - A message that was never judged — the model call failed, the per-run
//     call ceiling stopped short of it, a rule threw, or its write failed —
//     gets no verdict. It comes back in `unprocessed`, and the job keeps it on
//     the checkpoint's retry list. Writing "model returned no event" for a
//     call that returned 401 is how four days of mail went missing in October
//     2026, and how a sender could be taught to the fingerprint cache as
//     never-an-event.
//   - Nothing is written except through ledger_ingest_event, so deduplication
//     and merge rules are applied identically to every writer.
// ======================================================

import { config } from './config.js';
import * as database from './db.js';
import { extractDeterministic, buildIngestPayload } from '../src/ledger/email.js';
import { extractWithLLM as realExtractWithLLM } from './extract/llm.js';

// A sender/subject shape seen this many times that has never yielded an event
// is not worth another model call. The cheap half of the cost control: it only
// ever suppresses negatives, so it cannot cause a missed event that the rules
// would have caught.
const FINGERPRINT_MIN_SIGHTINGS = 3;

// How many runs a message may fail *for a reason of its own* before it is
// written as needs-review instead of retried again. Failures that are not the
// message's fault — the model down for everyone, the call ceiling — do not
// count, so a long outage never turns into a pile of give-ups.
export const MAX_ATTEMPTS = 5;

// Reasons a message can come back unprocessed, and whether a failure for that
// reason counts against MAX_ATTEMPTS.
const COUNTS_AS_ATTEMPT = {
  parse_error: true,      // the connector could not read it
  extract_error: true,    // a rule threw on it
  ingest_error: true,     // the database refused its payload
  llm_error: true,        // only when the model answered some other batch (below)
  llm_ceiling: false,     // never asked: not the message's fault
  llm_unavailable: false, // enabled but no API key: not the message's fault
};

/**
 * Messages in, ledger rows out.
 *
 * `priorAttempts(message)` says how many earlier runs failed on this message
 * (the job reads it from the checkpoint's retry list). `deps` exists for the
 * tests; the job never passes it.
 *
 * Returns counters, including `unprocessed`: one entry per message that got no
 * verdict this run, `{ message, reason, error, attempts }`. Every other message
 * was handled — an event, a durable no-event verdict, or (after MAX_ATTEMPTS)
 * a needs-review source row.
 */
export async function runPipeline({
  userId, accountKey, selfAddresses = [], messages, dryRun = false,
  priorAttempts = () => 0, deps = {},
}) {
  const { ingestEvent, fingerprintStats, foodMerchants, setting } = { ...database, ...deps };
  const extractWithLLM = deps.extractWithLLM || realExtractWithLLM;
  const llmEnabled = deps.llmEnabled ?? config.llm.enabled;
  const limits = { ...config.limits, ...(deps.limits || {}) };

  const counters = {
    itemsSeen: messages.length,
    eventsCreated: 0,
    eventsUpdated: 0,
    eventsSkipped: 0,
    sourcesOnly: 0,
    llmCalls: 0,
    llmUsage: { prompt_tokens: 0, completion_tokens: 0 },
    byExtractor: {},
    errors: [],
    unprocessed: [],
    needsReview: 0,
  };

  // Messages with no verdict yet this run: { message, reason, error }.
  const failed = [];
  const fail = (message, reason, error) => failed.push({ message, reason, error: String(error || reason) });

  // Who counts as "me" for the purpose of spotting self-transfers. Read once
  // per run rather than per message.
  const selfIdentifiers = String(await setting(userId, 'ledger_self_identifiers', ''))
    .split(',').map(v => v.trim()).filter(Boolean);

  // Which merchants are places you eat. Read once per run and handed to the
  // rules, so a card alert from a restaurant lands as a meal rather than as a
  // purchase the Food screen never sees. A failure here costs classification,
  // never the run.
  let knownFood = new Set();
  try {
    knownFood = await foodMerchants(userId);
  } catch (err) {
    counters.errors.push({ stage: 'food_merchants', error: err.message });
  }

  // ── Stage 1: deterministic extraction ────────────────
  const deterministic = [];
  const llmCandidates = [];
  const noEvent = [];

  for (const message of messages) {
    // The connector could not parse it. It still occupies a UID, so it is
    // handed over as a stub rather than dropped or left to stall the folder.
    if (message.parseError) {
      counters.errors.push({ stage: 'parse', message: message.messageId, error: message.parseError });
      fail(message, 'parse_error', message.parseError);
      continue;
    }

    let result;
    try {
      result = extractDeterministic(message, {
        timeZone: config.timeZone, selfAddresses, selfIdentifiers, foodMerchants: knownFood,
      });
    } catch (err) {
      counters.errors.push({ stage: 'extract', message: message.messageId, error: err.message });
      fail(message, 'extract_error', err.message);
      continue;
    }

    // A rule that throws is a bug in the rule, not an odd email — it would
    // otherwise silently stop extracting from every message it matches.
    if (result.ruleErrors?.length) {
      for (const failure of result.ruleErrors) counters.errors.push({ stage: 'rule', ...failure });
    }

    if (result.decision === 'extracted') deterministic.push({ message, result });
    else if (result.decision === 'llm')  llmCandidates.push({ message, result });
    else                                 noEvent.push({ message, result });
  }

  // ── Stage 2: fingerprint cache ───────────────────────
  let suppressed = 0;
  if (llmCandidates.length) {
    let known = {};
    try {
      known = (await fingerprintStats(userId, 90)) || {};
    } catch (err) {
      counters.errors.push({ stage: 'fingerprints', error: err.message });
    }

    for (let i = llmCandidates.length - 1; i >= 0; i--) {
      const stat = known[llmCandidates[i].result.fingerprint];
      if (stat && stat.seen >= FINGERPRINT_MIN_SIGHTINGS && stat.events === 0) {
        const [item] = llmCandidates.splice(i, 1);
        item.result = { ...item.result, reason: `fingerprint seen ${stat.seen}×, never an event` };
        noEvent.push(item);
        suppressed++;
      }
    }
  }
  counters.fingerprintSuppressed = suppressed;

  // ── Stage 3: the model, for what is left ─────────────
  const llmExtractions = new Map();   // index in llmCandidates → result
  const notAnswered = new Map();      // index in llmCandidates → { reason, error }
  let llmAnswered = 0;                // batches the model actually answered

  if (llmCandidates.length && llmEnabled) {
    const batchSize = Math.max(1, limits.llmBatchSize);
    const maxCalls = limits.maxLlmCalls;
    const markFrom = (start, end, reason, error) => {
      for (let i = start; i < end; i++) notAnswered.set(i, { reason, error });
    };

    for (let offset = 0; offset < llmCandidates.length; offset += batchSize) {
      if (counters.llmCalls >= maxCalls) {
        const left = llmCandidates.length - offset;
        counters.errors.push({
          stage: 'llm',
          error: `call ceiling of ${maxCalls} reached; ${left} messages kept on the retry list for the next run`,
        });
        markFrom(offset, llmCandidates.length, 'llm_ceiling', `call ceiling of ${maxCalls} reached`);
        break;
      }

      const batch = llmCandidates.slice(offset, offset + batchSize);
      const { results, calls, error, skipped, usage } =
        await extractWithLLM(batch.map(b => b.message), { selfIdentifiers, timeZone: config.timeZone });
      counters.llmCalls += calls || 0;
      if (usage) {
        counters.llmUsage.prompt_tokens += usage.prompt_tokens || 0;
        counters.llmUsage.completion_tokens += usage.completion_tokens || 0;
      }
      if (error) {
        counters.errors.push({ stage: 'llm', error });
        markFrom(offset, offset + batch.length, 'llm_error', error);
        continue;
      }
      if (skipped) {
        // Enabled but unusable (no key): nothing was asked, so nothing was
        // answered. Keep every remaining candidate for a run that can ask.
        counters.errors.push({ stage: 'llm', error: `model not called: ${skipped}` });
        markFrom(offset, llmCandidates.length, 'llm_unavailable', skipped);
        break;
      }

      llmAnswered++;
      for (const [batchIndex, result] of results) {
        llmExtractions.set(offset + batchIndex, result);
      }
    }
  }

  // ── Stage 4: storage ─────────────────────────────────
  // Chronological, so an order is in the ledger before the delivery mail that
  // wants to relate to it.
  const writes = [];

  for (const { message, result } of deterministic) {
    for (const extraction of result.extractions) {
      writes.push({ message, extraction });
      counters.byExtractor[extraction.extracted_by] = (counters.byExtractor[extraction.extracted_by] || 0) + 1;
    }
  }

  llmCandidates.forEach((candidate, index) => {
    const unanswered = notAnswered.get(index);
    if (unanswered) {
      // Never asked, or asked and the call failed: there is no verdict to record.
      fail(candidate.message, unanswered.reason, unanswered.error);
      return;
    }

    if (!llmEnabled) {
      // The model is switched off on purpose, so this is as far as the message
      // goes. Recorded, but kept out of the fingerprint cache: "not asked" is
      // not evidence that the shape never carries an event.
      writes.push({ message: candidate.message, extraction: null,
                    verdict: 'not classified: model disabled', unlearned: true });
      return;
    }

    const result = llmExtractions.get(index);
    if (!result) {
      // The reply skipped this email's index. Not a verdict on it.
      fail(candidate.message, 'llm_error', 'the model returned no result for this message');
      return;
    }
    if (result.isEvent && result.extractions.length) {
      for (const extraction of result.extractions) {
        writes.push({ message: candidate.message, extraction });
        counters.byExtractor[extraction.extracted_by] = (counters.byExtractor[extraction.extracted_by] || 0) + 1;
      }
    } else {
      // Asked and answered: record the source so the next run has the verdict.
      writes.push({ message: candidate.message, extraction: null,
                    verdict: result.reason || 'model returned no event' });
    }
  });

  for (const { message, result } of noEvent) {
    writes.push({ message, extraction: null, verdict: result.reason });
  }

  // Which failures count against the message. A model error counts only when
  // the model answered some other batch this run: a 401 for everyone is an
  // outage, not something wrong with this mail.
  for (const item of failed) {
    const counts = COUNTS_AS_ATTEMPT[item.reason] && (item.reason !== 'llm_error' || llmAnswered > 0);
    const attempts = (priorAttempts(item.message) || 0) + (counts ? 1 : 0);
    if (counts && attempts >= MAX_ATTEMPTS) {
      // Out of attempts: written as needs-review, so it stops being retried
      // and stays findable, rather than being dropped.
      writes.push({
        message: item.message, extraction: null, unlearned: true,
        giveUp: { ...item, attempts },
        verdict: `needs review: ${item.reason} after ${attempts} attempts — ${item.error}`.slice(0, 500),
      });
    } else {
      counters.unprocessed.push({ ...item, attempts });
    }
  }

  writes.sort((a, b) => new Date(a.message.date) - new Date(b.message.date));

  // A message can yield several writes; a failure on any of them leaves the
  // message unprocessed once, and the retry replays all of them (idempotent).
  const failedMessages = new Set();
  const writeFailed = (write, error) => {
    if (failedMessages.has(write.message)) return;
    failedMessages.add(write.message);
    if (write.giveUp) {
      // Even the minimal needs-review row was refused. Keep it on the retry
      // list; the job abandons it after twice MAX_ATTEMPTS.
      counters.unprocessed.push({ ...write.giveUp, error: `needs-review write failed: ${error}` });
    } else {
      counters.unprocessed.push({ message: write.message, reason: 'ingest_error', error,
                                  attempts: (priorAttempts(write.message) || 0) + 1 });
    }
  };

  for (const write of writes) {
    let payload;
    try {
      payload = buildIngestPayload({
        extraction: write.extraction,
        message: write.message,
        accountKey,
        // A message being given up on keeps nothing of its body: the body may
        // be exactly what the database refused.
        storeSnippet: config.storeSnippets && !write.giveUp,
      });
    } catch (err) {
      counters.errors.push({ stage: 'payload', message: write.message.messageId, error: err.message });
      writeFailed(write, err.message);
      continue;
    }

    if (write.verdict) {
      payload.source.metadata = { ...payload.source.metadata, verdict: write.verdict };
    }
    if (write.unlearned) {
      // ledger_fingerprint_stats only counts sources that carry `fingerprint`.
      const { fingerprint, ...rest } = payload.source.metadata || {};
      payload.source.metadata = { ...rest, fingerprint_unlearned: fingerprint || null };
    }
    if (write.giveUp) {
      payload.source.metadata = {
        ...payload.source.metadata, needs_review: true,
        failed_reason: write.giveUp.reason, failed_attempts: write.giveUp.attempts,
      };
    } else if (write.extraction && priorAttempts(write.message) > 0) {
      // A retried message that finally produced an event: clear any failure
      // markers a previous run left on its source.
      payload.source.metadata = {
        ...payload.source.metadata, verdict: null, needs_review: null,
        failed_reason: null, failed_attempts: null,
      };
    }

    if (dryRun) {
      counters.eventsSkipped++;
      continue;
    }

    try {
      const outcome = await ingestEvent(userId, payload);
      switch (outcome?.action) {
        case 'created':     counters.eventsCreated++; break;
        case 'updated':     counters.eventsUpdated++; break;
        case 'skipped':     counters.eventsSkipped++; break;
        case 'source_only': counters.sourcesOnly++;  break;
        default: break;
      }
      if (write.giveUp) counters.needsReview++;
      if (outcome?.conflicts?.length) {
        counters.errors.push({ stage: 'merge', event: outcome.event_id, conflicts: outcome.conflicts });
      }
    } catch (err) {
      counters.errors.push({ stage: 'ingest', message: write.message.messageId, error: err.message });
      writeFailed(write, err.message);
    }
  }

  if (counters.needsReview) {
    counters.errors.push({ stage: 'needs_review',
      error: `${counters.needsReview} message(s) failed ${MAX_ATTEMPTS} runs and were recorded as needs-review sources` });
  }

  // A merge conflict is the ledger working as designed — information, not a
  // failure. Everything else means part of the run fell short.
  counters.failures = counters.errors.filter(e => e.stage !== 'merge').length;

  return counters;
}
