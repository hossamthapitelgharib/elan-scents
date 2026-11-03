'use strict';
/* A small SMTP client for the shop's own mailbox (Gmail, implicit TLS on port 465, AUTH PLAIN). It runs on Cloudflare Workers
   (outbound TCP from cloudflare:sockets) and on Node (tls), so the same code serves the Worker and `npm start`.
   Nothing here logs or returns the password; an error carries a short code (smtp_connect, smtp_auth, smtp_rejected, smtp_timeout, ...).
   The caller chooses the recipient: this module only refuses addresses and header text that could smuggle in extra headers or commands. */

const DEFAULT_TIMEOUT_MS = 12000;
const ADDRESS = /^[^\s<>@"',;:\\]{1,64}@[^\s<>@"',;:\\]{1,255}\.[^\s<>@"',;:\\]{2,63}$/;

class SmtpError extends Error {
  constructor(code, reply) {
    super(code);
    this.name = 'SmtpError';
    this.code = code;
    if (reply) this.reply = String(reply).slice(0, 200);
  }
}

const b64 = (text) => Buffer.from(String(text), 'utf8').toString('base64');
const clean = (text) => String(text == null ? '' : text).replace(/[\r\n\0]+/g, ' ').trim();

function validAddress(value) {
  const text = String(value || '');
  return text.length <= 254 && ADDRESS.test(text);
}

/* RFC 2047 «encoded words» for a header value that is not plain ASCII. Each word holds at most 45 bytes (the line limit is 75). */
function encodeHeader(value) {
  const text = clean(value);
  if (/^[\x20-\x7E]*$/.test(text)) return text;
  const words = [];
  let current = '';
  for (const character of Array.from(text)) {
    if (Buffer.byteLength(current + character, 'utf8') > 45) { words.push(current); current = ''; }
    current += character;
  }
  if (current) words.push(current);
  return words.map((word) => `=?UTF-8?B?${b64(word)}?=`).join('\r\n ');
}

const wrap64 = (text) => b64(text).replace(/.{1,76}/g, '$&\r\n').trimEnd();

/* A multipart/alternative message (plain text and HTML), both base64 so that Arabic and long lines survive every relay. */
function buildMessage({ from, to, subject, text, html, date = new Date(), messageId, boundary }) {
  if (!validAddress(from && from.address)) throw new SmtpError('invalid_sender');
  if (!validAddress(to)) throw new SmtpError('invalid_recipient');
  const domain = from.address.split('@')[1];
  const id = messageId || `${Date.now().toString(36)}.${Math.random().toString(36).slice(2, 12)}@${domain}`;
  const edge = boundary || `elan_${Math.random().toString(36).slice(2, 14)}`;
  const name = clean(from.name);
  const sender = name ? `${encodeHeader(name)} <${from.address}>` : from.address;
  const parts = [
    `From: ${sender}`,
    `To: <${to}>`,
    `Subject: ${encodeHeader(subject)}`,
    `Date: ${date.toUTCString().replace('GMT', '+0000')}`,
    `Message-ID: <${id}>`,
    'MIME-Version: 1.0',
    'Auto-Submitted: auto-generated',
    `Content-Type: multipart/alternative; boundary="${edge}"`,
    '',
    `--${edge}`,
    'Content-Type: text/plain; charset=UTF-8',
    'Content-Transfer-Encoding: base64',
    '',
    wrap64(text || ''),
    `--${edge}`,
    'Content-Type: text/html; charset=UTF-8',
    'Content-Transfer-Encoding: base64',
    '',
    wrap64(html || ''),
    `--${edge}--`,
    ''
  ];
  return parts.join('\r\n');
}

/* Replies arrive as lines; «250-…» continues, «250 …» ends. */
function replyReader(readable) {
  const reader = readable.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  return {
    async next() {
      const lines = [];
      for (;;) {
        let index;
        while ((index = buffer.indexOf('\n')) >= 0) {
          const line = buffer.slice(0, index).replace(/\r$/, '');
          buffer = buffer.slice(index + 1);
          if (!line) continue;
          lines.push(line);
          const match = /^(\d{3})([ -])/.exec(line);
          if (match && match[2] === ' ') return { code: Number(match[1]), text: lines.join('\n') };
          if (!match) return { code: 0, text: lines.join('\n') };
        }
        const { done, value } = await reader.read();
        if (done) throw new SmtpError('smtp_closed', lines.join('\n'));
        buffer += decoder.decode(value, { stream: true });
      }
    },
    release() { try { reader.releaseLock(); } catch (_) {} }
  };
}

async function openSocket({ host, port }) {
  let connect = null;
  try { ({ connect } = await import('cloudflare:sockets')); } catch (_) { connect = null; }
  if (typeof connect === 'function') {
    const socket = connect({ hostname: host, port }, { secureTransport: 'on', allowHalfOpen: false });
    await socket.opened;
    return { readable: socket.readable, writable: socket.writable, close: () => { try { socket.close(); } catch (_) {} } };
  }
  const tls = require('node:tls');
  const { Readable, Writable } = require('node:stream');
  return new Promise((resolve, reject) => {
    const socket = tls.connect({ host, port, servername: host });
    socket.once('secureConnect', () => resolve({ readable: Readable.toWeb(socket), writable: Writable.toWeb(socket), close: () => socket.destroy() }));
    socket.once('error', reject);
  });
}

/* options: { host, port, user, pass, from: { name, address }, to, subject, text, html, hello?, timeoutMs? }
   open: how to reach the server ({ host, port }) => { readable, writable, close } (tests pass a fake). */
async function sendMail(options, open = openSocket) {
  const { host, port, user, pass } = options;
  if (!host || !port || !user || !pass) throw new SmtpError('smtp_not_configured');
  const message = buildMessage(options);
  const timeoutMs = options.timeoutMs || DEFAULT_TIMEOUT_MS;
  let socket = null;
  let timer = null;
  const timeout = new Promise((_, reject) => { timer = setTimeout(() => reject(new SmtpError('smtp_timeout')), timeoutMs); });

  const session = (async () => {
    try { socket = await open({ host, port }); }
    catch (_) { throw new SmtpError('smtp_connect'); }
    const replies = replyReader(socket.readable);
    const writer = socket.writable.getWriter();
    const encoder = new TextEncoder();
    const say = (line) => writer.write(encoder.encode(line + '\r\n'));
    const expect = async (codes, failure) => {
      const reply = await replies.next();
      if (!codes.includes(reply.code)) throw new SmtpError(failure, reply.text);
      return reply;
    };
    await expect([220], 'smtp_connect');
    await say(`EHLO ${clean(options.hello) || 'elan-scents'}`);
    await expect([250], 'smtp_rejected');
    await say('AUTH PLAIN ' + b64(`\0${user}\0${pass}`));
    await expect([235], 'smtp_auth');
    await say(`MAIL FROM:<${options.from.address}>`);
    await expect([250], 'smtp_rejected');
    await say(`RCPT TO:<${options.to}>`);
    await expect([250, 251], 'smtp_rejected');
    await say('DATA');
    await expect([354], 'smtp_rejected');
    // A line that starts with a dot gets one more (dot-stuffing), so the message can never end the data early.
    await say(message.replace(/^\./gm, '..') + '\r\n.');
    await expect([250], 'smtp_rejected');
    try { await say('QUIT'); } catch (_) {}
    return { ok: true };
  })();

  try { return await Promise.race([session, timeout]); }
  finally {
    clearTimeout(timer);
    session.catch(() => {});
    if (socket && typeof socket.close === 'function') socket.close();
  }
}

module.exports = { sendMail, buildMessage, encodeHeader, validAddress, openSocket, SmtpError };
