/* Server-side admin sessions. Memory only: a restart logs everyone out, and there is no "remember me".
   The browser only ever holds an opaque random id in a session cookie (no Max-Age). */
const crypto = require('node:crypto');
const { getContext, requireRoles } = require('../api/_auth.js');

const IDLE_MS = 2 * 60 * 60 * 1000;      // 2 hours without activity
const ABSOLUTE_MS = 10 * 60 * 60 * 1000; // 10 hours total
const sessions = new Map();
const attempts = new Map();

function env() { return { url: process.env.SUPABASE_URL, anon: process.env.SUPABASE_ANON_KEY }; }

function tooManyAttempts(ip) {
  const now = Date.now();
  const list = (attempts.get(ip) || []).filter((t) => now - t < 15 * 60 * 1000);
  attempts.set(ip, list);
  return list.length >= 10;
}
function noteAttempt(ip) { const l = attempts.get(ip) || []; l.push(Date.now()); attempts.set(ip, l); }

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
  const ctx = requireRoles(await getContext({ headers: { authorization: 'Bearer ' + j.access_token } }), ['platform_admin']);
  if (ctx.error) return { status: ctx.status === 403 ? 403 : 401, error: ctx.status === 403 ? 'forbidden' : 'invalid_credentials' };
  const id = crypto.randomBytes(32).toString('hex');
  const now = Date.now();
  sessions.set(id, { token: j.access_token, refresh: j.refresh_token, expiresAt: now + (Number(j.expires_in) || 3600) * 1000, created: now, last: now, email: ctx.user.email || '' });
  return { status: 200, id };
}

async function get(id) {
  const s = id && sessions.get(id);
  if (!s) return null;
  const now = Date.now();
  if (now - s.last > IDLE_MS || now - s.created > ABSOLUTE_MS) { sessions.delete(id); return null; }
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

function destroy(id) { sessions.delete(id); }
function parseCookie(header, name) {
  const m = new RegExp('(?:^|;\\s*)' + name + '=([a-f0-9]{64})(?:;|$)').exec(header || '');
  return m ? m[1] : '';
}
function size() { return sessions.size; }

module.exports = { login, get, destroy, parseCookie, size };
