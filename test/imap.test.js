// @ts-check
// ======================================================
// Tests for what the IMAP connector keeps from attachments.
//
// Zomato sends some orders with an empty body and the receipt only in
// attached PDFs (Order_ID_*.pdf, Order_Invoice*.pdf, User_Charge_Invoice*.pdf).
// Keeping nothing but calendar payloads left the rules with a subject alone.
//
// No network: raw RFC822 is built here and handed straight to toMessage().
// ======================================================

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { toMessage, pdfText, pdfAllowance } from '../ledger/connectors/imap.js';
import { extractDeterministic } from '../src/ledger/email.js';

const ACCOUNT = { key: 'test', user: 'me@example.com' };

/** A one-page PDF with each line drawn in Helvetica. Optionally "encrypted". */
function makePdf(lines, { encrypt = false } = {}) {
  const esc = (s) => s.replace(/[\\()]/g, m => `\\${m}`);
  const stream = `BT /F1 11 Tf 50 750 Td 14 TL ${lines.map(l => `(${esc(l)}) Tj T*`).join(' ')} ET`;
  const objects = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 5 0 R >> >> /Contents 4 0 R >>',
    `<< /Length ${stream.length} >>\nstream\n${stream}\nendstream`,
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',
  ];
  if (encrypt) {
    // Standard handler with a user password that is not empty: pdf.js
    // cannot open it without one.
    const hex32 = 'ab'.repeat(32);
    objects.push(`<< /Filter /Standard /V 1 /R 2 /O <${hex32}> /U <${hex32}> /P -4 >>`);
  }
  let out = '%PDF-1.4\n';
  const offsets = [];
  objects.forEach((body, i) => {
    offsets.push(out.length);
    out += `${i + 1} 0 obj\n${body}\nendobj\n`;
  });
  const xref = out.length;
  out += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  for (const o of offsets) out += `${String(o).padStart(10, '0')} 00000 n \n`;
  const extra = encrypt ? ` /Encrypt 6 0 R /ID [<${'01'.repeat(16)}> <${'01'.repeat(16)}>]` : '';
  out += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R${extra} >>\nstartxref\n${xref}\n%%EOF\n`;
  return Buffer.from(out, 'latin1');
}

/** A multipart/mixed message: a text body, then each attachment base64. */
function rawMail({ from, subject, text = '', attachments = [] }) {
  const b = 'BOUNDARY42';
  const parts = [
    `--${b}\r\nContent-Type: text/plain; charset=utf-8\r\n\r\n${text}\r\n`,
    ...attachments.map(a =>
      `--${b}\r\nContent-Type: ${a.contentType}; name="${a.filename}"\r\n`
      + `Content-Disposition: attachment; filename="${a.filename}"\r\n`
      + `Content-Transfer-Encoding: base64\r\n\r\n`
      + `${Buffer.from(a.content).toString('base64').replace(/.{76}/g, '$&\r\n')}\r\n`),
  ];
  return Buffer.from([
    `From: ${from}`,
    'To: me@example.com',
    `Subject: ${subject}`,
    'Date: Sun, 18 Oct 2026 20:15:00 +0530',
    'Message-ID: <t1@example.com>',
    'MIME-Version: 1.0',
    `Content-Type: multipart/mixed; boundary="${b}"`,
    '',
    `${parts.join('')}--${b}--\r\n`,
  ].join('\r\n'));
}

const ZOMATO_PDF_LINES = [
  'Order ID: 7012345678',
  'Restaurant: Nagarjuna',
  '1 X Cheese Masala Dosa',
  'Total paid: Rs. 349.00',
];

test('pdfText reads the text of a PDF', async () => {
  const text = await pdfText(makePdf(ZOMATO_PDF_LINES));
  assert.ok(text);
  assert.match(text, /Order ID: 7012345678/);
  assert.match(text, /Total paid: Rs\. 349\.00/);
});

test('a malformed, encrypted or empty PDF yields null instead of throwing', async () => {
  assert.equal(await pdfText(Buffer.from('%PDF-1.4\nthis is not a pdf at all')), null);
  assert.equal(await pdfText(Buffer.from('not even a header')), null);
  assert.equal(await pdfText(makePdf(['secret'], { encrypt: true })), null);
  assert.equal(await pdfText(Buffer.alloc(0)), null);
  assert.equal(await pdfText(undefined), null);
});

test('a Zomato mail with an empty body is read from its PDF attachments', async () => {
  const raw = rawMail({
    from: 'Zomato <noreply@zomato.com>',
    subject: 'Your Zomato order from Nagarjuna',
    attachments: [
      { filename: 'Order_ID_7012345678.pdf', contentType: 'application/pdf', content: makePdf(ZOMATO_PDF_LINES) },
      { filename: 'Order_Invoice_7012345678.pdf', contentType: 'application/pdf', content: makePdf(['Tax Invoice', 'Cheese Masala Dosa 1 299.00']) },
      { filename: 'User_Charge_Invoice_7012345678.pdf', contentType: 'application/octet-stream', content: makePdf(['Platform fee 10.00']) },
    ],
  });
  const message = await toMessage({ uid: 1, source: raw }, ACCOUNT, 'INBOX');

  assert.match(message.text, /Order ID: 7012345678/);
  assert.match(message.text, /Tax Invoice/);
  // Recognised by filename even when the type is generic.
  assert.match(message.text, /Platform fee/);
  // Text is kept; the PDF bytes are not.
  assert.equal(message.attachments.length, 3);
  for (const a of message.attachments) {
    assert.equal(a.content, null);
    assert.equal(typeof a.text, 'string');
  }

  const result = extractDeterministic(message, { selfAddresses: [ACCOUNT.user] });
  assert.equal(result.decision, 'extracted');
  const [food] = result.extractions;
  assert.equal(food.extracted_by, 'rules:food_delivery');
  assert.equal(food.data.amount, 349);
});

test('a body that is already there is not replaced by PDF text', async () => {
  const raw = rawMail({
    from: 'Zomato <noreply@zomato.com>',
    subject: 'Your Zomato order from Nagarjuna',
    text: 'Your order from Nagarjuna has been delivered. Total paid Rs. 120.00',
    attachments: [{ filename: 'Order_Invoice_1.pdf', contentType: 'application/pdf', content: makePdf(['Total paid: Rs. 999.00']) }],
  });
  const message = await toMessage({ uid: 2, source: raw }, ACCOUNT, 'INBOX');
  assert.doesNotMatch(message.text, /999/);
  assert.match(message.attachments[0].text, /999/);
});

test('a broken PDF does not fail the message', async () => {
  const raw = rawMail({
    from: 'Zomato <noreply@zomato.com>',
    subject: 'Your Zomato order from Nagarjuna',
    attachments: [
      { filename: 'Order_Invoice_bad.pdf', contentType: 'application/pdf', content: Buffer.from('%PDF-1.7 garbage') },
      { filename: 'Order_ID_locked.pdf', contentType: 'application/pdf', content: makePdf(['x'], { encrypt: true }) },
    ],
  });
  const message = await toMessage({ uid: 3, source: raw }, ACCOUNT, 'INBOX');
  assert.equal(message.subject, 'Your Zomato order from Nagarjuna');
  assert.equal(message.text.trim(), '');
  assert.deepEqual(message.attachments.map(a => a.text), [null, null]);
});

test('calendar attachments still keep their content and still extract', async () => {
  const ics = [
    'BEGIN:VCALENDAR', 'VERSION:2.0', 'BEGIN:VEVENT', 'UID:abc-123',
    'DTSTART:20261101T040000Z', 'DTEND:20261101T050000Z', 'SUMMARY:Dentist',
    'END:VEVENT', 'END:VCALENDAR',
  ].join('\r\n');
  const raw = rawMail({
    from: 'Calendar <calendar@example.com>',
    subject: 'Invitation: Dentist',
    text: 'You have been invited.',
    attachments: [
      { filename: 'invite.ics', contentType: 'text/calendar', content: ics },
      { filename: 'photo.png', contentType: 'image/png', content: 'not really a png' },
    ],
  });
  const message = await toMessage({ uid: 4, source: raw }, ACCOUNT, 'INBOX');

  const [cal, png] = message.attachments;
  assert.match(cal.content || '', /UID:abc-123/);
  assert.equal('text' in cal, false);
  assert.equal(png.content, null);
  assert.equal('text' in png, false);
  assert.equal(message.text.trim(), 'You have been invited.');

  const result = extractDeterministic(message, {});
  assert.equal(result.decision, 'extracted');
  assert.equal(result.extractions[0].dedupe_key, 'calendar:abc-123:single');
});

test('oversized mail is let through only when attached PDFs are the excess', () => {
  const KB = 1024;
  const max = 512 * KB;
  const pdfMax = 2048 * KB;
  const part = (type, size, filename) => ({
    type, size, ...(filename ? { dispositionParameters: { filename } } : {}),
  });
  // The real Zomato shape: a near-empty body and three invoices, 620,646 bytes.
  const zomato = {
    type: 'multipart/mixed',
    childNodes: [
      { type: 'multipart/alternative', childNodes: [part('text/plain', 200), part('text/html', 4 * KB)] },
      part('application/pdf', 210 * KB, 'Order_ID_7012345678.pdf'),
      part('application/pdf', 200 * KB, 'Order_Invoice_7012345678.pdf'),
      part('application/octet-stream', 190 * KB, 'User_Charge_Invoice_7012345678.pdf'),
    ],
  };
  assert.equal(pdfAllowance(zomato, 620_646, max, pdfMax), true);

  // Images are the excess: still too large.
  const newsletter = {
    type: 'multipart/related',
    childNodes: [part('text/html', 20 * KB), part('image/png', 580 * KB), part('application/pdf', 20 * KB, 'terms.pdf')],
  };
  assert.equal(pdfAllowance(newsletter, 620 * KB, max, pdfMax), false);

  // PDFs, but past the PDF ceiling.
  const huge = { type: 'multipart/mixed', childNodes: [part('text/plain', 1 * KB), part('application/pdf', 3000 * KB, 'a.pdf')] };
  assert.equal(pdfAllowance(huge, 3001 * KB, max, pdfMax), false);

  // No PDF at all, or no structure to judge by.
  assert.equal(pdfAllowance({ type: 'multipart/mixed', childNodes: [part('image/jpeg', 600 * KB)] }, 600 * KB, max, pdfMax), false);
  assert.equal(pdfAllowance(null, 600 * KB, max, pdfMax), false);
  assert.equal(pdfAllowance(zomato, undefined, max, pdfMax), false);
});
