// ======================================================
// IMAP source connector.
//
// IMAP rather than the Gmail or Zoho APIs on purpose: one implementation
// covers every address you own, on any provider, with no OAuth app to
// register per vendor. The cost is that it needs an app-specific password —
// which is also its security story, since an app password is scoped to mail
// and revocable on its own.
//
// The connector is deliberately dumb. It knows how to find messages it has not
// seen and how to hand them over in a normalized shape; it knows nothing about
// events, extraction or the ledger. Another connector (calendar, a card API,
// Apple Health) only has to produce the same shape to reuse the whole pipeline
// behind it.
//
// Two properties that matter:
//   - The mailbox is opened READ-ONLY. Nothing is marked read, moved or
//     deleted. The ledger is an observer of your mail, not a participant.
//   - Envelopes are fetched before bodies, so mail that is obviously not an
//     event (newsletters, OTPs) never has its body downloaded at all.
// ======================================================

import { ImapFlow } from 'imapflow';
import { simpleParser } from 'mailparser';
import { extractText, getDocumentProxy } from 'unpdf';
import { htmlToText, triage } from '../../src/ledger/email.js';

/**
 * Fetch messages this account has not been seen before.
 *
 * `cursor` is opaque to the pipeline:
 *   { folders: { INBOX: { uidValidity, lastUid, retry?: [{ uid, attempts, … }] } } }
 * UIDVALIDITY changing means the server renumbered the mailbox, so the stored
 * UID is meaningless and the folder is re-scanned from the lookback window.
 *
 * `retry` lists UIDs at or below lastUid that an earlier run read but could
 * not finish (the job maintains it). They are fetched again on every run,
 * before anything new, until the job takes them off.
 *
 * Returns { messages, cursor, stats }. The cursor's lastUid only moves past
 * messages actually returned, so a crash costs a re-read, never a gap. A
 * message that fails to parse is returned as a stub with `parseError` set, so
 * the job can retry it and, eventually, record it — it never stalls the
 * folder behind it.
 */
export async function fetchNew(account, cursor = {}, options = {}) {
  const maxMessages = options.maxMessages ?? 200;
  const maxBytes = options.maxMessageBytes ?? 512 * 1024;
  // Mail over maxBytes is still read, up to this much, when what makes it big
  // is attached PDFs — a receipt sent only as invoices. See pdfAllowance().
  const maxPdfBytes = options.maxPdfMessageBytes ?? 2 * 1024 * 1024;
  const lookbackDays = options.lookbackDays ?? account.lookbackDays ?? 7;
  // A backfill deliberately ignores the checkpoint and rescans a date window.
  // Safe because ingestion is idempotent: everything already stored is matched
  // by its source id or its dedupe key and updated rather than duplicated.
  const ignoreCursor = Boolean(options.ignoreCursor);

  const client = new ImapFlow({
    host: account.host,
    port: account.port,
    secure: account.secure,
    auth: { user: account.user, pass: account.password },
    logger: false,
    // A stalled connection must not wedge a cron job until the next one.
    socketTimeout: options.socketTimeoutMs ?? 60_000,
  });

  // Without a listener, a dropped socket ("Connection not available") is an
  // uncaught 'error' event: the process dies, finishRun never runs, and the
  // run row stays `running` for ever. Record it instead; the command in
  // flight rejects on its own, and anything that slipped through is thrown
  // below so the run is marked failed and the checkpoint stays put.
  let connectionError = null;
  client.on('error', (err) => { connectionError = connectionError || err; });

  const messages = [];
  const nextCursor = { folders: { ...(cursor.folders || {}) } };
  const stats = {
    seen: 0, skippedBySubject: 0, skippedTooLarge: 0, allowedPdf: 0, fetchedBodies: 0, notReached: 0,
    retried: 0, retryMissing: {}, parseErrors: 0, vanished: 0,
  };

  await client.connect();
  try {
    for (const folder of account.folders) {
      if (messages.length >= maxMessages) break;
      if (connectionError) throw connectionError;

      let lock;
      try {
        lock = await client.getMailboxLock(folder, { readOnly: true });
      } catch (err) {
        if (connectionError) throw connectionError;
        stats[`error:${folder}`] = err.message;
        continue;
      }

      try {
        const uidValidity = String(client.mailbox.uidValidity);
        const stored = nextCursor.folders[folder] || {};
        const sameMailbox = stored.uidValidity === uidValidity;
        const resumable = !ignoreCursor && sameMailbox && Number.isFinite(Number(stored.lastUid));
        const lastUid = resumable ? Number(stored.lastUid) : 0;
        // A renumbered mailbox makes the stored retry UIDs meaningless too.
        const retryUids = sameMailbox
          ? [...new Set((stored.retry || []).map(r => Number(r.uid)).filter(Number.isFinite))]
          : [];

        // Which UIDs to look at. A fresh folder (or a renumbered one) starts
        // from a date window rather than the whole mailbox — the first run
        // should populate a useful ledger, not import a decade of mail.
        const byUid = new Map();
        if (resumable && lastUid > 0) {
          for await (const msg of client.fetch(`${lastUid + 1}:*`, { uid: true, envelope: true, size: true }, { uid: true })) {
            // A range whose start is past the highest UID still returns the
            // last message, per RFC 3501. Filter it out or every run
            // re-processes the newest mail forever.
            if (msg.uid > lastUid) byUid.set(msg.uid, msg);
          }
        } else {
          const since = new Date(Date.now() - lookbackDays * 86_400_000);
          const uids = await client.search({ since }, { uid: true });
          if (uids?.length) {
            for await (const msg of client.fetch(uids, { uid: true, envelope: true, size: true }, { uid: true })) {
              byUid.set(msg.uid, msg);
            }
          }
        }

        // The retry list: mail an earlier run read but could not finish.
        const wantedRetries = retryUids.filter(uid => !byUid.has(uid));
        if (wantedRetries.length) {
          const found = new Set();
          for await (const msg of client.fetch(wantedRetries, { uid: true, envelope: true, size: true }, { uid: true })) {
            byUid.set(msg.uid, msg);
            found.add(msg.uid);
          }
          // Deleted since: nothing left to retry.
          const missing = wantedRetries.filter(uid => !found.has(uid));
          if (missing.length) stats.retryMissing[folder] = missing;
        }

        const candidates = [...byUid.values()].sort((a, b) => a.uid - b.uid);
        const retrySet = new Set(retryUids);
        stats.seen += candidates.length;

        // Oversized mail whose size might be attached PDFs: ask the server
        // for its MIME structure (sizes only, no content) before deciding.
        const pdfAllowed = new Set();
        const oversized = candidates
          .filter(c => c.size > maxBytes && c.size <= maxPdfBytes)
          .map(c => c.uid);
        if (oversized.length) {
          for await (const msg of client.fetch(oversized, { uid: true, bodyStructure: true }, { uid: true })) {
            if (pdfAllowance(msg.bodyStructure, msg.size ?? byUid.get(msg.uid)?.size, maxBytes, maxPdfBytes)) {
              pdfAllowed.add(msg.uid);
            }
          }
        }

        // Cheap pass: reject on subject and size before downloading anything.
        const wanted = [];
        for (const candidate of candidates) {
          // The ceiling is per run, and candidates are in UID order, so what
          // gets dropped is the *newest* mail in the window. On a backfill that
          // is a silent hole: "--backfill-days 90" over a 2,000-message window
          // read June and July and stopped, and the events it was run to
          // repair kept their old shape. Count what was left so the run can
          // say so rather than reporting success.
          if (wanted.length + messages.length >= maxMessages) {
            stats.notReached = candidates.length - wanted.length;
            break;
          }

          if (candidate.size && candidate.size > maxBytes && !pdfAllowed.has(candidate.uid)) {
            stats.skippedTooLarge++;
            wanted.push({ uid: candidate.uid, skip: true });
            continue;
          }

          const envelopeVerdict = triage({
            subject: candidate.envelope?.subject || '',
            from: envelopeFrom(candidate),
            headers: {},
            text: candidate.envelope?.subject || '',
            html: '',
          }, { selfAddresses: [account.user] });

          // Only a verdict reachable from the subject and sender alone skips
          // the body — an OTP, a newsletter, a campaign. Anything else is read,
          // because the body is where the evidence usually is.
          if (envelopeVerdict.decision === 'reject'
              && ['never-an-event subject', 'promotional'].includes(envelopeVerdict.reason)) {
            stats.skippedBySubject++;
            wanted.push({ uid: candidate.uid, skip: true });
            continue;
          }

          if (pdfAllowed.has(candidate.uid)) stats.allowedPdf++;
          wanted.push({ uid: candidate.uid, skip: false });
        }

        const toFetch = wanted.filter(w => !w.skip).map(w => w.uid);
        const parsed = new Map();

        if (toFetch.length) {
          for await (const msg of client.fetch(toFetch, { uid: true, source: true }, { uid: true })) {
            stats.fetchedBodies++;
            try {
              parsed.set(msg.uid, await toMessage(msg, account, folder));
            } catch (err) {
              // Unparseable mail is handed over as a stub, so the job can
              // retry it and in the end record it as needs-review. Stopping
              // here instead stalled the folder for good behind one message
              // while every run still reported success.
              stats.parseErrors++;
              stats[`parse_error:${msg.uid}`] = err.message;
              parsed.set(msg.uid, parseFailureStub(byUid.get(msg.uid) || msg, account, folder, err));
            }
          }
        }

        // Advance the cursor strictly in UID order, past every message handed
        // over. A body that did not come back at all was deleted between the
        // two fetches: there is nothing left to read.
        let highest = lastUid;
        for (const item of wanted) {
          if (!item.skip) {
            const message = parsed.get(item.uid);
            if (message) {
              if (retrySet.has(item.uid)) { message.retry = true; stats.retried++; }
              messages.push(message);
            } else {
              stats.vanished++;
              if (retrySet.has(item.uid)) (stats.retryMissing[folder] ||= []).push(item.uid);
            }
          }
          highest = Math.max(highest, item.uid);
        }

        // Never move the checkpoint backwards. A backfill scans old mail and
        // would otherwise rewind the cursor, making the next forward run
        // re-read everything since. The retry list is carried over as it was;
        // the job, which knows what got processed, rewrites it.
        const previous = sameMailbox ? Number(stored.lastUid) || 0 : 0;
        nextCursor.folders[folder] = {
          uidValidity,
          lastUid: Math.max(highest, previous),
          ...(sameMailbox && stored.retry?.length ? { retry: stored.retry } : {}),
        };
      } finally {
        lock.release();
      }
    }
    if (connectionError) throw connectionError;
  } finally {
    try { await client.logout(); } catch { client.close(); }
  }

  return { messages, cursor: nextCursor, stats };
}

/**
 * Whether a message over the size limit is big only because of attached PDFs.
 * Everything that is not a PDF must still fit under `maxBytes`, and the whole
 * message under `maxPdfBytes`: a 600 KB Zomato mail of three invoices is read,
 * a 600 KB newsletter of images is not.
 */
export function pdfAllowance(structure, size, maxBytes, maxPdfBytes) {
  if (!structure || !Number.isFinite(size) || size > maxPdfBytes) return false;
  let pdfBytes = 0;
  const walk = (node) => {
    if (node.childNodes?.length) { node.childNodes.forEach(walk); return; }
    const name = node.dispositionParameters?.filename || node.parameters?.name || '';
    if (/^application\/pdf$/i.test(node.type || '') || /\.pdf$/i.test(name)) pdfBytes += Number(node.size) || 0;
  };
  walk(structure);
  return pdfBytes > 0 && size - pdfBytes <= maxBytes;
}

function envelopeFrom(candidate) {
  const from = candidate.envelope?.from?.[0];
  return from ? { name: from.name || null, address: (from.address || '').toLowerCase() } : null;
}

/**
 * What can be said about a message whose body would not parse: what the
 * envelope said, under the same fallback id toMessage() would use.
 */
export function parseFailureStub(envelopeMsg, account, folder, err) {
  const envelope = envelopeMsg?.envelope || {};
  return {
    messageId: envelope.messageId || `${account.key}:${folder}:${envelopeMsg.uid}`,
    accountKey: account.key,
    folder,
    uid: envelopeMsg.uid,
    date: envelope.date || new Date(),
    subject: envelope.subject || '',
    from: envelopeFrom(envelopeMsg),
    to: [],
    headers: {},
    text: '',
    html: '',
    attachments: [],
    parseError: String(err?.message || err || 'unparseable message').slice(0, 300),
  };
}

/** RFC822 → the shape every extractor in src/ledger/email.js expects. */
export async function toMessage(raw, account, folder) {
  // skipHtmlToText keeps mailparser away from html-to-text, whose deepmerge-ts
  // dependency has a stack-exhaustion bug on recursive object graphs — a
  // crafted email could otherwise kill the job. We already have a plain-text
  // converter that the LLM path uses, so this drops a dependency and a risk in
  // one move.
  const mail = await simpleParser(raw.source, {
    skipHtmlToText: true,
    skipTextToHtml: true,
    skipImageLinks: true,
  });
  const from = mail.from?.value?.[0] || null;

  const headers = {};
  if (mail.headers instanceof Map) {
    for (const [key, value] of mail.headers.entries()) {
      headers[key] = typeof value === 'string' ? value : JSON.stringify(value);
    }
  }

  const attachments = await Promise.all((mail.attachments || []).map(async a => {
    const kind = `${a.contentType || ''} ${a.filename || ''}`;
    return {
      filename: a.filename || null,
      contentType: a.contentType || null,
      // Only calendar payloads are kept; everything else would be a copy of
      // your mail sitting in memory for no reason.
      content: /calendar|\.ics$/i.test(kind) ? a.content?.toString('utf8') : null,
      // A PDF keeps its text, never its bytes.
      ...(/\bapplication\/pdf\b|\.pdf$/i.test(kind) ? { text: await pdfText(a.content) } : {}),
    };
  }));

  // Zomato sends some orders with an empty body and the receipt only in the
  // attached PDFs. The PDF text stands in for the body only when there is no
  // body: a receipt that already reads fine is left exactly as it was.
  const body = mail.text || htmlToText(mail.html) || '';
  const pdfBody = attachments.map(a => a.text).filter(Boolean).join('\n\n');

  return {
    messageId: mail.messageId || `${account.key}:${folder}:${raw.uid}`,
    accountKey: account.key,
    folder,
    uid: raw.uid,
    date: mail.date || new Date(),
    subject: mail.subject || '',
    from: from ? { name: from.name || null, address: (from.address || '').toLowerCase() } : null,
    to: (mail.to?.value || []).map(t => ({ name: t.name || null, address: (t.address || '').toLowerCase() })),
    headers,
    text: body.trim() ? body : pdfBody || body,
    html: mail.html || '',
    attachments,
  };
}

const PDF_TEXT_MAX_CHARS = 20_000;
const PDF_TIMEOUT_MS = 10_000;

/**
 * The text of a PDF attachment, or null. A malformed, encrypted or image-only
 * PDF yields null rather than throwing: one bad invoice must not turn the
 * whole message into a parse failure when its body may still be readable.
 */
export async function pdfText(content, { timeoutMs = PDF_TIMEOUT_MS } = {}) {
  if (!content?.length) return null;
  let doc = null;
  let timer;
  try {
    const work = (async () => {
      // A copy: pdf.js takes ownership of the buffer it is given.
      doc = await getDocumentProxy(new Uint8Array(content), {
        isEvalSupported: false,
        verbosity: 0,
      });
      const { text } = await extractText(doc, { mergePages: true });
      return text;
    })();
    work.catch(() => {});
    const text = await Promise.race([
      work,
      new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('pdf timeout')), timeoutMs); }),
    ]);
    const clean = String(text || '').replace(/[ \t]+/g, ' ').trim();
    return clean ? clean.slice(0, PDF_TEXT_MAX_CHARS) : null;
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
    try { await doc?.destroy(); } catch { /* already gone */ }
  }
}

export const connector = { id: 'imap', sourceType: 'email', fetchNew };
