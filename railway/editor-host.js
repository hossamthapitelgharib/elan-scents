/* Élan Scents — owner editor on the same site (same origin as the storefront).
   "/editor" shows a login page; after an admin login it serves the original editor page, which opens
   this same site inside it. The editor page is never a public file. Sessions live in server memory only. */
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const sessions = require('./editor-session.js');
const media = require('./editor-media.js');
const bridgeTickets = require('./editor-bridge-ticket.js');
const { clientIp } = require('../lib/rate-limit.js');

const ROOT = path.resolve(__dirname, '..');
const COOKIE = 'elan_sess';
const LOGIN_FILES = { '/editor-login.js': 'text/javascript; charset=utf-8', '/editor-login.css': 'text/css; charset=utf-8', '/editor-guard.js': 'text/javascript; charset=utf-8', '/editor-media.js': 'text/javascript; charset=utf-8' };

function editorSiteOrigin() {
  let selfOrigin = '';
  try {
    const host = String(process.env.RAILWAY_PUBLIC_DOMAIN || '').trim();
    if (host) selfOrigin = new URL(host.includes('://') ? host : 'https://' + host).origin;
  } catch (_) { selfOrigin = ''; }
  try {
    const u = new URL(String(process.env.EDITOR_SITE_ORIGIN || ''));
    if (u.protocol === 'https:' && !u.username && !u.password && u.pathname === '/' && !u.search && !u.hash && (!selfOrigin || u.origin !== selfOrigin)) return u.origin;
  } catch (_) { /* use the known production storefront */ }
  return 'https://elan-site-production.up.railway.app';
}

function sha(s) { return "'sha256-" + crypto.createHash('sha256').update(s, 'utf8').digest('base64') + "'"; }

let PAGE = null;
function buildPage() {
  let html = fs.readFileSync(path.join(ROOT, 'editor', 'elan-editor.html'), 'utf8');
  const siteOrigin = editorSiteOrigin();
  html = html.replace('</head>', '<script>window.ELAN_EDITOR_SITE_ORIGIN=' + JSON.stringify(siteOrigin) + ';</script></head>');
  html = html.replace('</body>', '<script src="/editor-guard.js"></script><script src="/editor-media.js"></script><script src="/editor/editor-live-library.js?v=20261016-01"></script></body>');
  const hashes = [];
  html.replace(/<script>([\s\S]*?)<\/script>/g, (_, code) => { hashes.push(sha(code)); return ''; });
  const handlers = [];
  html.replace(/\son[a-z]+="([^"]*)"/g, (_, code) => { handlers.push(sha(code.replace(/&quot;/g, '"').replace(/&#39;/g, "'"))); return ''; });
  const csp = [
    "default-src 'self'",
    "script-src 'self' " + hashes.join(' ') + (handlers.length ? " 'unsafe-hashes' " + handlers.join(' ') : ''),
    "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com",
    "font-src 'self' https://fonts.gstatic.com data:",
    "img-src 'self' data: blob: https:",
    "media-src 'self' blob: https:",
    "connect-src 'self'",
    "frame-src 'self' " + siteOrigin,
    "frame-ancestors 'none'", "base-uri 'none'", "form-action 'self'", "object-src 'none'"
  ].join('; ');
  return { html, csp };
}

function secure(req) { return (req.headers['x-forwarded-proto'] || '') === 'https' || process.env.NODE_ENV === 'production'; }
function setCookie(req, res, value, clear) {
  const parts = [COOKIE + '=' + value, 'Path=/', 'HttpOnly', 'SameSite=Strict'];
  if (secure(req)) parts.push('Secure');
  if (clear) parts.push('Max-Age=0'); // otherwise a browser-session cookie: no "remember me"
  res.setHeader('Set-Cookie', parts.join('; '));
}
/* When the session handed back a renewed cookie (rotated Supabase tokens, new "last used" time), send it on this response. */
function renewCookie(req, res, session) {
  if (session && session.renewed && !res.headersSent) setCookie(req, res, session.renewed, false);
}
function sameOrigin(req) {
  const o = req.headers.origin;
  if (!o) return true;
  try { return new URL(o).host === (req.headers['x-forwarded-host'] || req.headers.host); } catch (_) { return false; }
}
function ip(req) { return clientIp(req); }
function json(res, status, body) { res.statusCode = status; res.setHeader('Content-Type', 'application/json; charset=utf-8'); res.setHeader('Cache-Control', 'no-store'); res.end(JSON.stringify(body)); }
function sendFile(res, file, type, extra) {
  fs.readFile(file, (err, data) => {
    if (err) { res.statusCode = 404; return res.end('Not found'); }
    res.statusCode = 200; res.setHeader('Content-Type', type); res.setHeader('Cache-Control', 'no-store');
    Object.keys(extra || {}).forEach((k) => res.setHeader(k, extra[k]));
    res.end(data);
  });
}
function readJson(req) {
  return new Promise((resolve) => {
    let size = 0; const chunks = [];
    req.on('data', (c) => { size += c.length; if (size > 20000) { resolve(null); req.destroy(); } else chunks.push(c); });
    req.on('end', () => { try { resolve(JSON.parse(Buffer.concat(chunks).toString('utf8'))); } catch (_) { resolve(null); } });
    req.on('error', () => resolve(null));
  });
}

function readRaw(req, limit) {
  return new Promise((resolve) => {
    let size = 0; const chunks = []; let done = false;
    req.on('data', (c) => { if (done) return; size += c.length; if (size > limit) { done = true; resolve(null); } else chunks.push(c); });
    req.on('end', () => { if (!done) resolve(Buffer.concat(chunks)); });
    req.on('error', () => { if (!done) resolve(null); });
  });
}

/* Lets the existing /api/editor handler see the admin as signed in when the browser holds a valid session. */
async function attachSession(req, res) {
  const s = await sessions.get(sessions.parseCookie(req.headers.cookie, COOKIE));
  if (res) renewCookie(req, res, s);
  if (s) req.headers.authorization = 'Bearer ' + s.token;
  if (s && s.bypass === true) req.__editorKeyAdmin = true; // server-side flag only; never read from the client
  return !!s;
}

function attachBridgeTicket(req) {
  if (!bridgeTickets.verify(req.headers['x-elan-editor-ticket'])) return false;
  req.__editorKeyAdmin = true; // set only after verifying the server signature, origin, audience and expiry
  return true;
}

/* Returns true when the request was handled here. */
async function handle(req, res, pathname) {
  const sid = sessions.parseCookie(req.headers.cookie, COOKIE);

  if (pathname === '/api/editor-login') {
    if (req.method !== 'POST' || !sameOrigin(req)) return json(res, 403, { ok: false, error: 'forbidden' }), true;
    const body = await readJson(req);
    if (!body || typeof body !== 'object') return json(res, 400, { ok: false, error: 'invalid_request' }), true;
    const r = await sessions.login(body.email, body.password, ip(req));
    if (r.error) return json(res, r.status, { ok: false, error: r.error }), true;
    setCookie(req, res, r.id, false);
    return json(res, 200, { ok: true }), true;
  }
  if (pathname === '/api/editor-logout') {
    if (req.method !== 'POST' || !sameOrigin(req)) return json(res, 403, { ok: false, error: 'forbidden' }), true;
    sessions.destroy(sid); setCookie(req, res, '', true);
    return json(res, 200, { ok: true }), true;
  }
  if (pathname === '/api/editor-media') {
    const s = await sessions.get(sid);
    if (!s) return json(res, 401, { ok: false, error: 'unauthorized' }), true;
    renewCookie(req, res, s);
    if (req.method !== 'GET') return json(res, 405, { ok: false, error: 'method_not_allowed' }), true;
    const r = await media.list(s, new URL(req.url, 'http://x').searchParams.get('offset'));
    return (r.error ? json(res, r.status, { ok: false, error: r.error }) : json(res, 200, { ok: true, items: r.items })), true;
  }
  if (pathname === '/api/editor-upload') {
    const s = await sessions.get(sid);
    if (!s) return json(res, 401, { ok: false, error: 'unauthorized' }), true;
    renewCookie(req, res, s);
    if (req.method !== 'POST' || !sameOrigin(req)) return json(res, 403, { ok: false, error: 'forbidden' }), true;
    const type = String(req.headers['content-type'] || '').split(';')[0].trim().toLowerCase();
    const buf = await readRaw(req, media.MAX_VIDEO_BYTES + 1);
    if (!buf) return json(res, 413, { ok: false, error: 'file_too_large' }), true;
    let name = ''; try { name = decodeURIComponent(String(req.headers['x-file-name'] || '')); } catch (_) { name = ''; }
    const r = await media.upload(s, buf, type, name);
    return (r.error ? json(res, r.status, { ok: false, error: r.error }) : json(res, 200, { ok: true, url: r.url })), true;
  }
  if (pathname === '/api/editor-session') {
    const s = await sessions.get(sid);
    const delegated = bridgeTickets.verify(req.headers['x-elan-editor-ticket']);
    renewCookie(req, res, s);
    return (s || delegated ? json(res, 200, { ok: true }) : json(res, 401, { ok: false, error: 'unauthorized' })), true;
  }
  if (pathname === '/api/editor-bridge-ticket') {
    if (req.method !== 'POST' || !sameOrigin(req)) return json(res, 403, { ok: false, error: 'forbidden' }), true;
    const s = await sessions.get(sid);
    if (!s) return json(res, 401, { ok: false, error: 'unauthorized' }), true;
    renewCookie(req, res, s);
    const ticket = bridgeTickets.issue(editorSiteOrigin());
    if (!ticket) return json(res, 503, { ok: false, error: 'bridge_ticket_unavailable' }), true;
    return json(res, 200, { ok: true, ticket, expiresIn: bridgeTickets.TTL_SECONDS }), true;
  }

  if (pathname === '/editor' || pathname === '/editor/') {
    if (req.method !== 'GET' && req.method !== 'HEAD') return false;
    const keyGiven = new URL(req.url, 'http://x').searchParams.get('key');
    if (keyGiven !== null && sessions.accessKeyEnabled()) {
      const r = sessions.keyLogin(keyGiven, ip(req));
      if (!r.error) {
        setCookie(req, res, r.id, false);
        res.statusCode = 302; res.setHeader('Location', '/editor'); res.setHeader('Cache-Control', 'no-store'); res.setHeader('Referrer-Policy', 'no-referrer');
        res.end();
        return true;
      }
    }
    const s = await sessions.get(sid);
    if (s) {
      renewCookie(req, res, s);
      PAGE = PAGE || buildPage();
      res.statusCode = 200;
      res.setHeader('Content-Type', 'text/html; charset=utf-8');
      res.setHeader('Cache-Control', 'no-store');
      res.setHeader('Content-Security-Policy', PAGE.csp);
      res.setHeader('X-Frame-Options', 'DENY'); res.setHeader('X-Content-Type-Options', 'nosniff'); res.setHeader('Referrer-Policy', 'no-referrer');
      res.end(req.method === 'HEAD' ? '' : PAGE.html);
      return true;
    }
    sendFile(res, path.join(ROOT, 'editor', 'login.html'), 'text/html; charset=utf-8', {
      'Content-Security-Policy': "default-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'",
      'X-Frame-Options': 'DENY', 'X-Content-Type-Options': 'nosniff'
    });
    return true;
  }

  if (LOGIN_FILES[pathname] && (req.method === 'GET' || req.method === 'HEAD')) {
    if (pathname === '/editor-guard.js' && !(await sessions.get(sid))) { res.statusCode = 404; res.end('Not found'); return true; }
    sendFile(res, path.join(ROOT, 'editor', pathname.slice(1)), LOGIN_FILES[pathname]);
    return true;
  }
  return false;
}

module.exports = { handle, attachSession, attachBridgeTicket, buildPage, editorSiteOrigin, bridgeTickets };
