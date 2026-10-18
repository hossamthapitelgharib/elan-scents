/* Server-side admin sessions. The browser holds an encrypted, browser-session cookie so a Railway
   restart does not strand an already-open editor iframe with a dead in-memory session. */
const crypto = require('node:crypto');
const { getContext, requireRoles } = require('../api/_auth.js');

const IDLE_MS = 2 * 60 * 60 * 1000;      // 2 hours without activity (an open editor tab counts as activity, see editor-guard.js)
const ABSOLUTE_MS = 10 * 60 * 60 * 1000; // 10 hours total
const RENEW_AFTER_MS = 5 * 60 * 1000;    // hand the browser a fresh cookie once the stored "last used" time is this old
const REFRESH_MARGIN_MS = 60 * 1000;     // refresh the Supabase token this long before it expires
const REFRESH_MEMO_MS = 2 * 60 * 1000;   // how long a refresh result is reused for requests that still carry the old cookie
const MAX_REVOKED = 5000;
let clock = () => Date.now();             // replaced only by tests
const sessions = new Map();
const attempts = new Map();
const revoked = new Set();

function env() { return { url: process.env.SUPABASE_URL, anon: process.env.SUPABASE_ANON_KEY }; }

function tooManyAttempts(ip) {
  const now = Date.now();
  const list = (attempts.get(ip) || []).filter((t) => now - t < 15 * 60 * 1000);
  attempts.set(ip, list);
  return list.length >= 10;
}
function noteAttempt(ip) { const l = attempts.get(ip) || []; l.push(Date.now()); attempts.set(ip, l); }

function secret() { return process.env.EDITOR_SESSION_SECRET || process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_SECRET_KEY || ''; }
function key() { const value = secret(); return value ? crypto.createHash('sha256').update(value).digest() : null; }
function seal(value) {
  const k = key(); if (!k) return null;
  const iv = crypto.randomBytes(12), cipher = crypto.createCipheriv('aes-256-gcm', k, iv);
  const body = Buffer.concat([cipher.update(JSON.stringify(value), 'utf8'), cipher.final()]);
  return 'v1.' + Buffer.concat([iv, cipher.getAuthTag(), body]).toString('base64url');
}
function unseal(value) {
  if (!value || !value.startsWith('v1.')) return null;
  try {
    const raw = Buffer.from(value.slice(3), 'base64url');
    const decipher = crypto.createDecipheriv('aes-256-gcm', key(), raw.subarray(0, 12));
    decipher.setAuthTag(raw.subarray(12, 28));
    return JSON.parse(Buffer.concat([decipher.update(raw.subarray(28)), decipher.final()]).toString('utf8'));
  } catch (_) { return null; }
}

async function login(email, password, ip) {
  const { url, anon } = env();
  if (!url || !anon) return { status: 503, error: 'supabase_service_configuration_missing' };
  if (tooManyAttempts(ip)) return { status: 429, error: 'too_many_attempts' };
  if (typeof email !== 'string' || typeof password !== 'string' || email.length > 200 || password.length > 200) return { status: 400, error: 'invalid_request' };
  noteAttempt(ip);
  let r;
  try {
    r = await fetch(url + '/auth/v1/token?grant_type=password', {
      method: 'POST', headers: { apikey: anon, 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: email.trim(), password })
    });
  } catch (_) { return { status: 502, error: 'auth_unreachable' }; }
  const j = await r.json().catch(() => ({}));
  if (!r.ok || !j.access_token) return { status: 401, error: 'invalid_credentials' };
  let ctx;
  try {
    ctx = requireRoles(await getContext({ headers: { authorization: 'Bearer ' + j.access_token } }, { strictProfile: true }), ['platform_admin']);
  } catch (_) {
    return { status: 502, error: 'role_check_failed' };
  }
  if (ctx.error) {
    if (ctx.status === 403) return { status: 403, error: 'forbidden' };
    if (ctx.status === 503) return { status: 503, error: ctx.error };
    return { status: 502, error: 'role_check_failed' };
  }
  const now = clock();
  const state = { sid: crypto.randomBytes(16).toString('hex'), token: j.access_token, refresh: j.refresh_token, expiresAt: now + (Number(j.expires_in) || 3600) * 1000, created: now, last: now, email: ctx.user.email || '' };
  const persistent = seal(state);
  if (persistent) return { status: 200, id: persistent };
  // No secret to seal a cookie with: fall back to a server-memory session.
  const id = crypto.randomBytes(32).toString('hex');
  sessions.set(id, state);
  return { status: 200, id };
}

/* TEMPORARY owner access without email/password, only while the owner turns it on in Railway:
   EDITOR_AUTH_BYPASS=1 AND a secret phrase in EDITOR_ACCESS_KEY (at least 16 characters).
   The owner opens /editor?key=<phrase> once. The session lives in server memory only. */
function accessKeyEnabled() { return process.env.EDITOR_AUTH_BYPASS === '1' && String(process.env.EDITOR_ACCESS_KEY || '').length >= 16; }
function keyLogin(given, ip) {
  if (!accessKeyEnabled()) return { status: 404, error: 'not_enabled' };
  if (tooManyAttempts(ip)) return { status: 429, error: 'too_many_attempts' };
  noteAttempt(ip);
  const a = crypto.createHash('sha256').update(String(given || '')).digest();
  const b = crypto.createHash('sha256').update(String(process.env.EDITOR_ACCESS_KEY)).digest();
  if (!crypto.timingSafeEqual(a, b)) return { status: 401, error: 'invalid_key' };
  const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_SECRET_KEY || '';
  if (!serviceKey) return { status: 503, error: 'supabase_service_configuration_missing' };
  const id = crypto.randomBytes(32).toString('hex');
  const now = clock();
  sessions.set(id, { token: serviceKey, bypass: true, expiresAt: now + ABSOLUTE_MS, created: now, last: now, email: 'access-key' });
  return { status: 200, id };
}

/* Supabase rotates refresh tokens: each one works once, and again only for a few seconds. Because the browser
   cookie is the only place the token lives, every request that still carries the old cookie (a second tab, a
   request already in flight, a slow response) must get the SAME refreshed pair instead of triggering another
   refresh that Supabase rejects. Results are kept briefly, keyed by a hash of the old refresh token. */
const refreshes = new Map();
function refreshTokens(refreshToken) {
  const t = clock();
  for (const [k, v] of refreshes) if (t - v.at > REFRESH_MEMO_MS) refreshes.delete(k);
  const memoKey = crypto.createHash('sha256').update(refreshToken).digest('hex');
  let entry = refreshes.get(memoKey);
  if (!entry) {
    entry = { at: t, promise: requestRefresh(refreshToken, t) };
    refreshes.set(memoKey, entry);
    entry.promise.then((r) => { if (!r.ok) refreshes.delete(memoKey); });
  }
  return entry.promise;
}
async function requestRefresh(refreshToken, startedAt) {
  const { url, anon } = env();
  try {
    const r = await fetch(url + '/auth/v1/token?grant_type=refresh_token', { method: 'POST', headers: { apikey: anon, 'Content-Type': 'application/json' }, body: JSON.stringify({ refresh_token: refreshToken }) });
    const j = await r.json().catch(() => ({}));
    if (!r.ok || !j.access_token) return { ok: false };
    return { ok: true, token: j.access_token, refresh: j.refresh_token || refreshToken, expiresAt: startedAt + (Number(j.expires_in) || 3600) * 1000 };
  } catch (_) { return { ok: false, network: true }; }
}

function revoke(key) {
  if (!key) return;
  revoked.add(key);
  if (revoked.size > MAX_REVOKED) revoked.delete(revoked.values().next().value); // oldest first; entries only matter until the session would expire anyway
}

/* Returns the session, or null. For cookie sessions the result may carry `renewed`: a fresh cookie value the caller
   must send back (it holds the rotated tokens and the new "last used" time). */
async function get(id) {
  if (!id || revoked.has(id)) return null;
  const memory = sessions.get(id);
  const s = memory || unseal(id);
  if (!s) return null;
  if (s.sid && revoked.has(s.sid)) return null;
  const now = clock();
  const last = s.last || s.created;
  if (now - last > IDLE_MS || now - s.created > ABSOLUTE_MS) { sessions.delete(id); return null; }
  let renew = !memory && now - last > RENEW_AFTER_MS;
  if (s.expiresAt - now < REFRESH_MARGIN_MS && s.refresh && !s.bypass) {
    const r = await refreshTokens(s.refresh);
    if (r.ok) { s.token = r.token; s.refresh = r.refresh; s.expiresAt = r.expiresAt; renew = !memory; }
    else if (r.network) { if (s.expiresAt <= now) return null; /* still valid: keep working while Supabase is unreachable */ }
    else { sessions.delete(id); return null; }
  }
  s.last = now;
  if (renew) s.renewed = seal({ sid: s.sid, token: s.token, refresh: s.refresh, expiresAt: s.expiresAt, created: s.created, last: s.last, email: s.email });
  return s;
}

function destroy(id) {
  if (!id) return;
  const s = sessions.get(id) || unseal(id);
  if (s && s.sid) revoke(s.sid);
  revoke(id);
  sessions.delete(id);
}
function parseCookie(header, name) {
  const m = new RegExp('(?:^|;\\s*)' + name + '=([A-Za-z0-9._~-]+)(?:;|$)').exec(header || '');
  return m ? m[1] : '';
}
function size() { return sessions.size; }

module.exports = { login, keyLogin, accessKeyEnabled, get, destroy, parseCookie, size, __setClock(fn) { clock = fn || (() => Date.now()); } };
