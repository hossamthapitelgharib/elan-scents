/* Élan Scents — owner editor on the same site (same origin as the storefront).
   "/editor" shows a login page; after an admin login it serves the original editor page, which opens
   this same site inside it. The editor page is never a public file. Sessions live in server memory only. */
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const sessions = require('./editor-session.js');

const ROOT = path.resolve(__dirname, '..');
const COOKIE = 'elan_sess';
const LOGIN_FILES = { '/editor-login.js': 'text/javascript; charset=utf-8', '/editor-login.css': 'text/css; charset=utf-8', '/editor-guard.js': 'text/javascript; charset=utf-8' };

function sha(s) { return "'sha256-" + crypto.createHash('sha256').update(s, 'utf8').digest('base64') + "'"; }

let PAGE = null;
function buildPage() {
  let html = fs.readFileSync(path.join(ROOT, 'editor', 'elan-editor.html'), 'utf8');
  html = html.replace('</body>', '<script src="/editor-guard.js"></script></body>');
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
    "frame-src 'self'",
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
function sameOrigin(req) {
  const o = req.headers.origin;
  if (!o) return true;
  try { return new URL(o).host === (req.headers['x-forwarded-host'] || req.headers.host); } catch (_) { return false; }
}
function ip(req) { return String(req.headers['x-forwarded-for'] || req.socket.remoteAddress || '').split(',')[0].trim() || 'unknown'; }
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

/* Lets the existing /api/editor handler see the admin as signed in when the browser holds a valid session. */
async function attachSession(req) {
  const s = await sessions.get(sessions.parseCookie(req.headers.cookie, COOKIE));
  if (s) req.headers.authorization = 'Bearer ' + s.token;
  return !!s;
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
  if (pathname === '/api/editor-session') {
    const s = await sessions.get(sid);
    return (s ? json(res, 200, { ok: true }) : json(res, 401, { ok: false, error: 'unauthorized' })), true;
  }

  if (pathname === '/editor' || pathname === '/editor/') {
    if (req.method !== 'GET' && req.method !== 'HEAD') return false;
    const s = await sessions.get(sid);
    if (s) {
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

module.exports = { handle, attachSession, buildPage };
