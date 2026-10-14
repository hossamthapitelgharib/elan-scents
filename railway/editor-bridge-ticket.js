/* Short-lived, server-signed delegation from the authenticated editor host to its storefront iframe. */
const crypto = require('node:crypto');

const DEFAULT_EDITOR_ORIGIN = 'https://elan-editor-production-dc4e.up.railway.app';
const DEFAULT_STORE_ORIGIN = 'https://elan-site-production.up.railway.app';
const TTL_SECONDS = 10 * 60;

function normalizeOrigin(value) {
  try {
    const u = new URL(String(value || ''));
    if (u.protocol !== 'https:' || u.username || u.password || u.pathname !== '/' || u.search || u.hash) return '';
    return u.origin;
  } catch (_) { return ''; }
}

function signingSecret(env) {
  env = env || process.env;
  return String(env.SUPABASE_SERVICE_ROLE_KEY || env.SUPABASE_SECRET_KEY || '');
}

function editorOrigin(env) {
  env = env || process.env;
  return normalizeOrigin(env.ELAN_EDITOR_ORIGIN) || DEFAULT_EDITOR_ORIGIN;
}

function storeOrigin(env) {
  env = env || process.env;
  const explicit = normalizeOrigin(env.ELAN_STORE_ORIGIN);
  if (explicit) return explicit;
  const host = normalizeOrigin(String(env.RAILWAY_PUBLIC_DOMAIN || '').includes('://')
    ? env.RAILWAY_PUBLIC_DOMAIN
    : (env.RAILWAY_PUBLIC_DOMAIN ? 'https://' + env.RAILWAY_PUBLIC_DOMAIN : ''));
  if (host && host !== DEFAULT_EDITOR_ORIGIN) return host;
  const configured = normalizeOrigin(env.EDITOR_SITE_ORIGIN);
  if (configured && configured !== DEFAULT_EDITOR_ORIGIN) return configured;
  return DEFAULT_STORE_ORIGIN;
}

function issue(siteOrigin, env, now) {
  env = env || process.env;
  const secret = signingSecret(env);
  const aud = normalizeOrigin(siteOrigin);
  if (!secret || !aud) return '';
  const issuedAt = Math.floor((now === undefined ? Date.now() : now) / 1000);
  const claims = {
    v: 1,
    iss: editorOrigin(env),
    aud,
    sub: 'editor-bridge',
    role: 'platform_admin',
    iat: issuedAt,
    exp: issuedAt + TTL_SECONDS,
    nonce: crypto.randomBytes(16).toString('base64url')
  };
  const body = Buffer.from(JSON.stringify(claims)).toString('base64url');
  const signature = crypto.createHmac('sha256', secret).update(body).digest('base64url');
  return body + '.' + signature;
}

function verify(token, env, now) {
  env = env || process.env;
  if (typeof token !== 'string' || token.length > 2048 || !/^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/.test(token)) return null;
  const parts = token.split('.');
  const secret = signingSecret(env);
  if (!secret) return null;
  const expected = crypto.createHmac('sha256', secret).update(parts[0]).digest();
  let actual;
  try { actual = Buffer.from(parts[1], 'base64url'); } catch (_) { return null; }
  if (actual.length !== expected.length || !crypto.timingSafeEqual(actual, expected)) return null;
  let claims;
  try { claims = JSON.parse(Buffer.from(parts[0], 'base64url').toString('utf8')); } catch (_) { return null; }
  const nowSeconds = Math.floor((now === undefined ? Date.now() : now) / 1000);
  if (!claims || claims.v !== 1 || claims.role !== 'platform_admin' || claims.sub !== 'editor-bridge' ||
      claims.iss !== editorOrigin(env) || claims.aud !== storeOrigin(env) ||
      !Number.isInteger(claims.iat) || !Number.isInteger(claims.exp) ||
      claims.iat > nowSeconds + 30 || claims.exp <= nowSeconds || claims.exp <= claims.iat ||
      claims.exp - claims.iat > TTL_SECONDS || typeof claims.nonce !== 'string' || claims.nonce.length < 20) return null;
  return claims;
}

module.exports = { issue, verify, editorOrigin, storeOrigin, TTL_SECONDS, DEFAULT_EDITOR_ORIGIN, DEFAULT_STORE_ORIGIN };
