// ======================================================
// Tests for ingestion reliability: what happens when the model, the database
// or the mailbox lets a run down.
//
// The failure these guard against happened: from 14 to 18 October 2026 the
// OpenAI key returned 401, the pipeline wrote every mail that needed the model
// as "model returned no event", and the checkpoint moved past them. Nothing
// errored loudly; the mail was simply gone from the ledger.
//
// No network and no database: the pipeline and the job take their
// collaborators as injectable dependencies.
// ======================================================

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { runPipeline, MAX_ATTEMPTS } from '../ledger/pipeline.js';
import { ingestEmail, nextRetryList, ABANDON_AFTER } from '../ledger/jobs/ingest-email.js';
import { redactSecrets } from '../ledger/extract/openai.js';
import { proseFailedSummary } from '../ledger/jobs/summarize.js';

const ME = 'me@example.com';

let nextUid = 100;
/** A mail no sender rule knows, that looks transactional: it goes to the model. */
function llmMail(overrides = {}) {
  const uid = overrides.uid ?? nextUid++;
  return {
    messageId: `<m${uid}@quietshop.example>`, accountKey: 'test', folder: 'INBOX', uid,
    date: new Date(Date.UTC(2026, 9, 15, 10, uid % 60)),
    subject: 'Your order', from: { address: 'billing@quietshop.example', name: 'Quiet Shop' },
    to: [{ address: ME }], headers: {},
    text: `Order ID: QS${uid}000 confirmed. Paid Rs 450`, html: '', attachments: [],
    ...overrides,
  };
}

/** A newsletter: rejected by triage, never reaches the model. */
function bulkMail(overrides = {}) {
  return llmMail({ subject: 'Weekly digest', text: 'hello there friend',
                   headers: { 'list-unsubscribe': '<x>' }, ...overrides });
}

function fakeDb() {
  const writes = [];
  return {
    writes,
    deps: {
      setting: async (_u, _k, fallback) => fallback,
      foodMerchants: async () => new Set(),
      fingerprintStats: async () => ({}),
      ingestEvent: async (_u, payload) => {
        writes.push(payload);
        return { action: payload.event ? 'created' : 'source_only' };
      },
    },
  };
}

const failingModel = async (messages) =>
  ({ results: new Map(), calls: 1, error: 'OpenAI 401: Incorrect API key provided: sk-proj-****abcd' });

const answeringModel = (isEvent = false) => async (messages) => ({
  calls: 1,
  results: new Map(messages.map((m, i) => [i, isEvent
    ? { isEvent: true, reason: '', extractions: [{
        type: 'purchase', title: 'Quiet Shop order', occurred_at: new Date(m.date).toISOString(),
        data: { amount: 450, currency: 'INR' }, entities: [], confidence: 0.8,
        extracted_by: 'llm:test', dedupe_key: `test:${m.uid}` }] }
    : { isEvent: false, reason: 'a marketing mail', extractions: [] }])),
});

// ── The pipeline ───────────────────────────────────────

test('a failed model call writes no verdict and returns the messages as unprocessed', async () => {
  const { writes, deps } = fakeDb();
  const messages = [llmMail(), llmMail(), bulkMail()];

  const counters = await runPipeline({
    userId: 'u', accountKey: 'test', selfAddresses: [ME], messages,
    deps: { ...deps, llmEnabled: true, extractWithLLM: failingModel },
  });

  // Only the newsletter — judged by triage, not by the model — has a source row.
  assert.equal(writes.length, 1);
  assert.equal(writes[0].source.metadata.subject, 'Weekly digest');
  assert.ok(!writes.some(w => /model returned no event/.test(w.source.metadata.verdict || '')));

  assert.equal(counters.unprocessed.length, 2);
  assert.deepEqual(counters.unprocessed.map(u => u.reason), ['llm_error', 'llm_error']);
  // An outage is not the message's fault: no attempt is counted.
  assert.deepEqual(counters.unprocessed.map(u => u.attempts), [0, 0]);
  assert.ok(counters.failures > 0);
});

test('the call ceiling keeps the rest for the next run instead of writing them off', async () => {
  const { writes, deps } = fakeDb();
  const messages = [llmMail(), llmMail(), llmMail(), llmMail()];
  let calls = 0;

  const counters = await runPipeline({
    userId: 'u', accountKey: 'test', selfAddresses: [ME], messages,
    deps: { ...deps, llmEnabled: true, limits: { llmBatchSize: 1, maxLlmCalls: 2 },
            extractWithLLM: async (batch) => { calls++; return answeringModel(false)(batch); } },
  });

  assert.equal(calls, 2);
  // Two asked and answered: durable verdicts. Two never asked: no row at all.
  assert.equal(writes.length, 2);
  assert.ok(writes.every(w => w.source.metadata.verdict === 'a marketing mail'));
  assert.equal(counters.unprocessed.length, 2);
  assert.ok(counters.unprocessed.every(u => u.reason === 'llm_ceiling' && u.attempts === 0));
  assert.match(counters.errors.find(e => e.stage === 'llm').error, /kept on the retry list/);
});

test('a model error counts against the message only when the model is otherwise answering', async () => {
  const { deps } = fakeDb();
  const messages = [llmMail(), llmMail()];
  let n = 0;

  const counters = await runPipeline({
    userId: 'u', accountKey: 'test', selfAddresses: [ME], messages,
    deps: { ...deps, llmEnabled: true, limits: { llmBatchSize: 1 },
            extractWithLLM: async (batch) => (n++ === 0 ? failingModel(batch) : answeringModel(true)(batch)) },
  });

  assert.equal(counters.eventsCreated, 1);
  assert.equal(counters.unprocessed.length, 1);
  assert.equal(counters.unprocessed[0].attempts, 1);
});

test('a message out of attempts is written as needs-review, kept out of the fingerprint cache', async () => {
  const { writes, deps } = fakeDb();
  const poison = llmMail();
  const good = llmMail();
  const counters = await runPipeline({
    userId: 'u', accountKey: 'test', selfAddresses: [ME], messages: [poison, good],
    priorAttempts: (m) => (m === poison ? MAX_ATTEMPTS - 1 : 0),
    deps: { ...deps, llmEnabled: true, limits: { llmBatchSize: 1 },
            extractWithLLM: async (batch) => (batch[0] === poison ? failingModel(batch) : answeringModel(true)(batch)) },
  });

  assert.equal(counters.unprocessed.length, 0);
  assert.equal(counters.needsReview, 1);
  const row = writes.find(w => !w.event);
  assert.equal(row.source.metadata.needs_review, true);
  assert.match(row.source.metadata.verdict, /^needs review: llm_error after 5 attempts/);
  assert.equal(row.source.metadata.fingerprint, undefined);
  assert.equal(row.source.metadata.snippet, undefined);
});

test('a database write that fails leaves the message unprocessed', async () => {
  const { deps } = fakeDb();
  const counters = await runPipeline({
    userId: 'u', accountKey: 'test', selfAddresses: [ME], messages: [bulkMail()],
    deps: { ...deps, ingestEvent: async () => { throw new Error('ledger_ingest_event: Empty or invalid json'); } },
  });
  assert.equal(counters.unprocessed.length, 1);
  assert.equal(counters.unprocessed[0].reason, 'ingest_error');
  assert.equal(counters.unprocessed[0].attempts, 1);
});

test('an unparseable message is retried, not dropped and not a stall', async () => {
  const { writes, deps } = fakeDb();
  const stub = { ...llmMail(), text: '', parseError: 'bad MIME boundary' };
  const counters = await runPipeline({
    userId: 'u', accountKey: 'test', selfAddresses: [ME], messages: [stub, bulkMail()],
    deps: { ...deps, llmEnabled: true, extractWithLLM: answeringModel(false) },
  });
  assert.equal(writes.length, 1);
  assert.equal(counters.unprocessed[0].reason, 'parse_error');
});

test('with the model switched off, candidates are recorded without teaching the cache', async () => {
  const { writes, deps } = fakeDb();
  const counters = await runPipeline({
    userId: 'u', accountKey: 'test', selfAddresses: [ME], messages: [llmMail()],
    deps: { ...deps, llmEnabled: false },
  });
  assert.equal(counters.unprocessed.length, 0);
  assert.equal(writes[0].source.metadata.verdict, 'not classified: model disabled');
  assert.equal(writes[0].source.metadata.fingerprint, undefined);
});

// ── The checkpoint ─────────────────────────────────────

test('nextRetryList adds what failed, drops what was handled or deleted, abandons the hopeless', () => {
  const previous = [
    { uid: 5, attempts: 2, first_failed_at: 't0' },
    { uid: 6, attempts: 0 },
    { uid: 7, attempts: 1 },
    { uid: 8, attempts: ABANDON_AFTER - 1 },
  ];
  const { retry, abandoned } = nextRetryList(previous, {
    fetchedUids: [5, 6, 8, 20, 21],
    unprocessed: [
      { message: { uid: 5, messageId: '<5>' }, reason: 'llm_error', error: 'sk-proj-****abcd', attempts: 3 },
      { message: { uid: 21, messageId: '<21>' }, reason: 'llm_ceiling', error: 'x', attempts: 0 },
      { message: { uid: 8, messageId: '<8>' }, reason: 'ingest_error', error: 'x', attempts: ABANDON_AFTER },
    ],
    missingUids: [7],
    now: 't1',
  });

  assert.deepEqual(retry.map(r => r.uid), [5, 21]);
  assert.equal(retry[0].attempts, 3);
  assert.equal(retry[0].first_failed_at, 't0');
  assert.equal(retry[0].last_failed_at, 't1');
  assert.doesNotMatch(retry[0].error, /abcd/);
  assert.deepEqual(abandoned.map(a => a.uid), [8]);
});

function fakeJob({ messages, cursor, pipeline }) {
  const state = { checkpoint: null, runs: [], succeeded: null };
  const connector = {
    sourceType: 'email',
    fetchNew: async (_account, stored) => ({
      messages,
      cursor: { folders: { INBOX: { uidValidity: '1', lastUid: 50, ...(stored.folders?.INBOX?.retry ? { retry: stored.folders.INBOX.retry } : {}) } } },
      stats: { notReached: 0, retryMissing: {} },
    }),
  };
  const deps = {
    accounts: [{ key: 'test', protocol: 'imap', user: ME, folders: ['INBOX'] }],
    getConnector: () => connector,
    runPipeline: pipeline,
    db: {
      resolveUserId: async () => 'u',
      startRun: async () => 'run-1',
      finishRun: async (id, outcome) => { state.runs.push(outcome); },
      getCheckpoint: async () => cursor,
      setCheckpoint: async (_u, _t, _k, next, succeeded) => { state.checkpoint = next; state.succeeded = succeeded; },
      syncCardPoints: async () => ({}),
      autoConfirm: async () => ({}),
    },
  };
  return { state, deps };
}

test('the job keeps unfinished mail on the retry list and reports the run as partial', async () => {
  const failing = llmMail({ uid: 49 });
  const handled = bulkMail({ uid: 50 });
  const { state, deps } = fakeJob({
    messages: [failing, handled],
    cursor: { folders: { INBOX: { uidValidity: '1', lastUid: 40 } } },
    pipeline: async ({ messages }) => ({
      itemsSeen: messages.length, eventsCreated: 0, eventsUpdated: 0, eventsSkipped: 0, sourcesOnly: 1,
      llmCalls: 1, llmUsage: {}, byExtractor: {}, needsReview: 0,
      errors: [{ stage: 'llm', error: 'OpenAI 401: Incorrect API key provided: sk-proj-****abcd' }],
      unprocessed: [{ message: failing, reason: 'llm_error', error: 'OpenAI 401', attempts: 0 }],
    }),
  });

  const summary = await ingestEmail({}, deps);

  assert.equal(summary.status, 'partial');
  assert.equal(state.runs[0].status, 'partial');
  assert.doesNotMatch(JSON.stringify(state.runs[0].errors), /abcd/);
  // lastUid moves on, but the message that failed is still owed.
  assert.equal(state.checkpoint.folders.INBOX.lastUid, 50);
  assert.deepEqual(state.checkpoint.folders.INBOX.retry.map(r => r.uid), [49]);
  assert.equal(state.succeeded, false);
});

test('a retried message that succeeds comes off the retry list', async () => {
  const retried = llmMail({ uid: 49, retry: true });
  const { state, deps } = fakeJob({
    messages: [retried],
    cursor: { folders: { INBOX: { uidValidity: '1', lastUid: 50, retry: [{ uid: 49, attempts: 2 }] } } },
    pipeline: async ({ messages, priorAttempts }) => {
      assert.equal(priorAttempts(retried), 2);
      return { itemsSeen: messages.length, eventsCreated: 1, eventsUpdated: 0, eventsSkipped: 0, sourcesOnly: 0,
               llmCalls: 1, llmUsage: {}, byExtractor: {}, needsReview: 0,
               errors: [{ stage: 'merge', conflicts: [] }], unprocessed: [] };
    },
  });

  const summary = await ingestEmail({}, deps);
  assert.equal(summary.status, 'succeeded');           // a merge conflict is not a failure
  assert.equal(state.checkpoint.folders.INBOX.retry, undefined);
  assert.equal(state.succeeded, true);
});

test('a run row that cannot be opened fails that account, not the whole job', async () => {
  const { deps } = fakeJob({ messages: [], cursor: {}, pipeline: async () => { throw new Error('unreachable'); } });
  deps.db.startRun = async () => { throw new Error('startRun: connection refused'); };
  const summary = await ingestEmail({}, deps);
  assert.equal(summary.status, 'failed');
  assert.match(summary.accounts[0].error, /startRun/);
});

// ── Secrets and summaries ──────────────────────────────

test('redactSecrets removes API keys, masked or not', () => {
  const body = '{"error":{"message":"Incorrect API key provided: sk-proj-********************abcd. You can find"}}';
  assert.doesNotMatch(redactSecrets(body), /abcd/);
  assert.doesNotMatch(redactSecrets('key sk-live1234567890XYZ in use'), /1234567890/);
  assert.equal(redactSecrets('nothing here'), 'nothing here');
});

test('a summary whose prose failed is recognised as owing a rewrite', () => {
  assert.equal(proseFailedSummary({ summary: 'Saturday.\n\n(Prose generation failed: OpenAI 401: …)' }), true);
  assert.equal(proseFailedSummary({ summary: 'Saturday.', metadata: { prose_failed: true } }), true);
  assert.equal(proseFailedSummary({ summary: 'You had dinner at Bramble.', metadata: {} }), false);
});

test('jsonSafe strips what jsonb refuses and leaves everything else alone', async () => {
  const { jsonSafe } = await import('../ledger/db.js');
  const out = jsonSafe({ a: 'x\u0000y', b: ['ok \uD83D'], c: 'pair 😀', d: 4, e: null });
  assert.deepEqual(out, { a: 'xy', b: ['ok �'], c: 'pair 😀', d: 4, e: null });
});

test('an unparseable IMAP message becomes a stub carrying its envelope', async () => {
  const { parseFailureStub } = await import('../ledger/connectors/imap.js');
  const stub = parseFailureStub(
    { uid: 77, envelope: { messageId: '<x@y>', subject: 'Statement', date: new Date('2026-10-15T00:00:00Z'),
                           from: [{ name: 'Bank', address: 'Alerts@Bank.example' }] } },
    { key: 'acct' }, 'INBOX', new Error('boom'));
  assert.equal(stub.messageId, '<x@y>');
  assert.equal(stub.uid, 77);
  assert.equal(stub.from.address, 'alerts@bank.example');
  assert.equal(stub.parseError, 'boom');
});
