// The shop's mail client, run against a scripted fake SMTP server (in-memory streams: no network, no real addresses, no real password).
const test = require('node:test');
const assert = require('node:assert/strict');
const { sendMail, buildMessage, encodeHeader, validAddress, SmtpError } = require('../lib/smtp');

const enc = new TextEncoder();
const dec = new TextDecoder();

/* A server that answers like Gmail does. `script` overrides single answers; `silent` never speaks; `dropAfter` closes after that command. */
function fakeServer(script = {}) {
  const toServer = new TransformStream();
  const toClient = new TransformStream();
  const out = toClient.writable.getWriter();
  const input = toServer.readable.getReader();
  const state = { commands: [], data: '', closed: 0 };
  let buffer = '';
  const pull = async () => { const { done, value } = await input.read(); if (done) return false; buffer += dec.decode(value, { stream: true }); return true; };
  const line = async () => { for (;;) { const i = buffer.indexOf('\r\n'); if (i >= 0) { const l = buffer.slice(0, i); buffer = buffer.slice(i + 2); return l; } if (!(await pull())) return null; } };
  const say = (text) => out.write(enc.encode(text + '\r\n'));
  if (!script.silent) (async () => {
    await say(script.greeting || '220 smtp.example.invalid ESMTP ready');
    for (;;) {
      const command = await line();
      if (command === null) break;
      state.commands.push(command);
      if (command.startsWith('EHLO')) await say(script.ehlo || '250-smtp.example.invalid at your service\r\n250-AUTH PLAIN LOGIN\r\n250 8BITMIME');
      else if (command.startsWith('AUTH')) await say(script.auth || '235 2.7.0 Accepted');
      else if (command.startsWith('MAIL FROM')) await say(script.mail || '250 2.1.0 OK');
      else if (command.startsWith('RCPT TO')) await say(script.rcpt || '250 2.1.5 OK');
      else if (command === 'DATA') {
        await say('354 Go ahead');
        for (;;) { const i = buffer.indexOf('\r\n.\r\n'); if (i >= 0) { state.data = buffer.slice(0, i + 2); buffer = buffer.slice(i + 5); break; } if (!(await pull())) break; }
        await say(script.end || '250 2.0.0 OK queued');
      } else if (command === 'QUIT') { await say('221 2.0.0 closing'); break; }
      // Hang up, but keep reading so the client's next write is not held back (a real socket buffers or fails it).
      if (script.dropAfter && command.startsWith(script.dropAfter)) { await out.close(); while (await pull()) { buffer = ''; } break; }
    }
  })();
  return { state, open: async () => ({ readable: toClient.readable, writable: toServer.writable, close: () => { state.closed++; } }) };
}

const MAIL = {
  host: 'smtp.example.invalid', port: 465, user: 'shop@example.invalid', pass: 'app-password-for-tests',
  from: { name: 'Élan Scents', address: 'shop@example.invalid' }, to: 'buyer@example.invalid',
  subject: 'أهلًا بك في Élan Scents', text: 'أهلًا ومرحبًا بك', html: '<p dir="rtl">أهلًا ومرحبًا بك</p>', timeoutMs: 1500
};

function decodeMessage(raw) {
  const [head, ...rest] = raw.split('\r\n\r\n');
  const headers = {};
  for (const l of head.replace(/\r\n[ \t]+/g, ' ').split('\r\n')) { const i = l.indexOf(':'); headers[l.slice(0, i).toLowerCase()] = l.slice(i + 1).trim(); }
  const parts = rest.join('\r\n\r\n').split(/--elan_[a-z0-9]+(?:--)?\r\n?/).filter((p) => /base64/.test(p)).map((p) => {
    const body = p.split('\r\n\r\n')[1] || '';
    return Buffer.from(body.replace(/\s+/g, ''), 'base64').toString('utf8');
  });
  return { headers, parts };
}
// Whitespace between two encoded words is not part of the text; whitespace between an encoded word and plain text is (RFC 2047).
const word = (value) => value.replace(/\?=\s+=\?UTF-8\?B\?/g, '?==?UTF-8?B?').replace(/=\?UTF-8\?B\?([^?]+)\?=/g, (_, b) => Buffer.from(b, 'base64').toString('utf8'));

test('a message goes out in the right order and arrives intact: Arabic subject, sender name, text and HTML parts', async () => {
  const server = fakeServer();
  assert.deepEqual(await sendMail(MAIL, server.open), { ok: true });
  const c = server.state.commands;
  assert.deepEqual(c.map((x) => x.split(' ')[0]), ['EHLO', 'AUTH', 'MAIL', 'RCPT', 'DATA', 'QUIT']);
  assert.equal(c[1], 'AUTH PLAIN ' + Buffer.from('\0shop@example.invalid\0app-password-for-tests').toString('base64'));
  assert.equal(c[2], 'MAIL FROM:<shop@example.invalid>');
  assert.equal(c[3], 'RCPT TO:<buyer@example.invalid>');
  const mail = decodeMessage(server.state.data);
  assert.equal(word(mail.headers.subject), 'أهلًا بك في Élan Scents');
  assert.equal(word(mail.headers.from), 'Élan Scents <shop@example.invalid>');
  assert.equal(mail.headers.to, '<buyer@example.invalid>');
  assert.match(mail.headers['content-type'], /^multipart\/alternative/);
  assert.equal(mail.headers['auto-submitted'], 'auto-generated');
  assert.deepEqual(mail.parts, ['أهلًا ومرحبًا بك', '<p dir="rtl">أهلًا ومرحبًا بك</p>']);
  assert.equal(server.state.closed, 1, 'the connection is closed afterwards');
});

test('the password never appears in the message and never in an error', async () => {
  const ok = fakeServer();
  await sendMail(MAIL, ok.open);
  assert.equal(ok.state.data.includes('app-password-for-tests'), false);
  const bad = fakeServer({ auth: '535 5.7.8 Username and Password not accepted' });
  await assert.rejects(sendMail(MAIL, bad.open), (e) => {
    assert.equal(e.code, 'smtp_auth');
    assert.equal(JSON.stringify([e.message, e.reply, e.stack]).includes('app-password-for-tests'), false);
    return true;
  });
});

test('a refused login (Gmail 535) is smtp_auth, and nothing is sent after it', async () => {
  const server = fakeServer({ auth: '535 5.7.8 Username and Password not accepted' });
  await assert.rejects(sendMail(MAIL, server.open), (e) => e instanceof SmtpError && e.code === 'smtp_auth' && /535/.test(e.reply));
  assert.deepEqual(server.state.commands.map((x) => x.split(' ')[0]), ['EHLO', 'AUTH']);
  assert.equal(server.state.closed, 1);
});

test('a refused recipient or a refused message is smtp_rejected', async () => {
  await assert.rejects(sendMail(MAIL, fakeServer({ rcpt: '550 5.1.1 no such user' }).open), (e) => e.code === 'smtp_rejected');
  await assert.rejects(sendMail(MAIL, fakeServer({ end: '554 5.7.1 rejected as spam' }).open), (e) => e.code === 'smtp_rejected');
});

test('a server that cannot be reached, never answers, or hangs up is told apart', async () => {
  await assert.rejects(sendMail(MAIL, async () => { throw new Error('ECONNREFUSED'); }), (e) => e.code === 'smtp_connect');
  const silent = fakeServer({ silent: true });
  await assert.rejects(sendMail({ ...MAIL, timeoutMs: 60 }, silent.open), (e) => e.code === 'smtp_timeout');
  assert.equal(silent.state.closed, 1, 'a timed-out connection is closed');
  await assert.rejects(sendMail(MAIL, fakeServer({ dropAfter: 'EHLO' }).open), (e) => e.code === 'smtp_closed');
  await assert.rejects(sendMail(MAIL, fakeServer({ greeting: '421 4.3.2 service not available' }).open), (e) => e.code === 'smtp_connect');
});

test('settings that are missing are reported before any connection is made', async () => {
  let opened = 0;
  const open = async () => { opened++; };
  for (const field of ['host', 'port', 'user', 'pass']) await assert.rejects(sendMail({ ...MAIL, [field]: '' }, open), (e) => e.code === 'smtp_not_configured');
  assert.equal(opened, 0);
});

test('header and command injection through the subject, the name or an address is impossible', async () => {
  const server = fakeServer();
  await sendMail({ ...MAIL, subject: 'Hi\r\nBcc: victim@example.invalid', from: { name: 'Shop\r\nX-Evil: 1', address: 'shop@example.invalid' } }, server.open);
  const mail = decodeMessage(server.state.data);
  assert.equal(mail.headers.bcc, undefined);
  assert.equal(mail.headers['x-evil'], undefined);
  assert.equal(server.state.commands.filter((x) => x.startsWith('RCPT')).length, 1);
  for (const to of ['a@example.invalid\r\nRCPT TO:<b@example.invalid>', 'a b@example.invalid', '<a@example.invalid>', 'a@example.invalid,b@example.invalid', 'nobody', '']) {
    await assert.rejects(sendMail({ ...MAIL, to }, fakeServer().open), (e) => e.code === 'invalid_recipient', JSON.stringify(to));
  }
  await assert.rejects(sendMail({ ...MAIL, from: { name: 'x', address: 'bad address' } }, fakeServer().open), (e) => e.code === 'invalid_sender');
});

test('a body that contains an SMTP end-of-data marker or commands cannot end the message early', async () => {
  const server = fakeServer();
  await sendMail({ ...MAIL, text: 'line\r\n.\r\nQUIT\r\nMAIL FROM:<x@example.invalid>', html: '.\r\n.\r\n' }, server.open);
  assert.deepEqual(server.state.commands.map((x) => x.split(' ')[0]), ['EHLO', 'AUTH', 'MAIL', 'RCPT', 'DATA', 'QUIT']);
  assert.deepEqual(decodeMessage(server.state.data).parts[0], 'line\r\n.\r\nQUIT\r\nMAIL FROM:<x@example.invalid>');
});

test('encodeHeader keeps ASCII as is and splits long Arabic text into encoded words of at most 45 bytes', () => {
  assert.equal(encodeHeader('Hello'), 'Hello');
  const long = encodeHeader('أهلًا ومرحبًا بك شريك نجاح بمتجر Élan Scents ونتمنى لك رحلة تسويقية ممتعة');
  const words = long.split('\r\n ');
  assert.ok(words.length > 1);
  for (const w of words) { assert.match(w, /^=\?UTF-8\?B\?[A-Za-z0-9+/=]+\?=$/); assert.ok(w.length <= 75, w.length); }
  assert.equal(word(words.join('')), 'أهلًا ومرحبًا بك شريك نجاح بمتجر Élan Scents ونتمنى لك رحلة تسويقية ممتعة');
});

test('validAddress accepts ordinary addresses and refuses anything that could be more than one', () => {
  for (const a of ['a@example.invalid', 'first.last+tag@sub.example.invalid']) assert.equal(validAddress(a), true, a);
  for (const a of ['', 'a', 'a@b', '@example.invalid', 'a@@example.invalid', 'a@example.invalid ', 'a@example.invalid\n', 'a;b@example.invalid', '"a"@example.invalid']) assert.equal(validAddress(a), false, JSON.stringify(a));
});

test('buildMessage needs a valid sender and recipient', () => {
  assert.throws(() => buildMessage({ ...MAIL, to: 'x' }), /invalid_recipient/);
  assert.throws(() => buildMessage({ ...MAIL, from: { address: 'x' } }), /invalid_sender/);
});
