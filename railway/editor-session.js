/* Server-side admin sessions. The browser holds an encrypted, browser-session cookie so a Railway
   restart does not strand an already-open editor iframe with a dead in-memory session. */
const crypto = require('node:crypto');
const { getContext, requireRoles } = require('../api/_auth.js');

const IDLE_MS = 2 * 60 * 60 * 1000;      // 2 hours without activity
const ABSOLUTE_MS = 10 * 60 * 60 * 1000; // 10 hours total
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
  const id = crypto.randomBytes(32).toString('hex');
  const now = Date.now();
  sessions.set(id, { token: j.access_token, refresh: j.refresh_token, expiresAt: now + (Number(j.expires_in) || 3600) * 1000, created: now, last: now, email: ctx.user.email || '' });
  const persistent = seal({ token: j.access_token, refresh: j.refresh_token, expiresAt: now + (Number(j.expires_in) || 3600) * 1000, created: now, email: ctx.user.email || '' });
  return { status: 200, id: persistent || id };
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
  const now = Date.now();
  sessions.set(id, { token: serviceKey, bypass: true, expiresAt: now + ABSOLUTE_MS, created: now, last: now, email: 'access-key' });
  return { status: 200, id };
}

async function get(id) {
  if (id && revoked.has(id)) return null;
  const s = id && (sessions.get(id) || unseal(id));
  if (!s) return null;
  const now = Date.now();
  const last = s.last || s.created;
  if (now - last > IDLE_MS || now - s.created > ABSOLUTE_MS) { sessions.delete(id); return null; }
  if (s.expiresAt - now < 60000 && s.refresh) {
    const { url, anon } = env();
    try {
      const r = await fetch(url + '/auth/v1/token?grant_type=refresh_token', { method: 'POST', headers: { apikey: anon, 'Content-Type': 'application/json' }, body: JSON.stringify({ refresh_token: s.refresh }) });
      const j = await r.json().catch(() => ({}));
      if (!r.ok || !j.access_token) { sessions.delete(id); return null; }
      s.token = j.access_token; s.refresh = j.refresh_token || s.refresh; s.expiresAt = now + (Number(j.expires_in) || 3600) * 1000;
    } catch (_) { return s.expiresAt > now ? (s.last = now, s) : null; }
  }
  s.last = now;
  return s;
}

function destroy(id) { if (id) revoked.add(id); sessions.delete(id); }
function parseCookie(header, name) {
  const m = new RegExp('(?:^|;\\s*)' + name + '=([A-Za-z0-9._~-]+)(?:;|$)').exec(header || '');
  return m ? m[1] : '';
}
function size() { return sessions.size; }

module.exports = { login, keyLogin, accessKeyEnabled, get, destroy, parseCookie, size };
