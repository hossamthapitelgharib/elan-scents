'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const handler = require('../api/config.js');

test('/api/config is cacheable by the browser for five minutes as well as by the edge', () => {
  const headers = {};
  let body = null, status = 0;
  const res = { setHeader: (k, v) => { headers[k] = v; }, status(code) { status = code; return this; }, json(b) { body = b; return this; } };
  process.env.SUPABASE_URL = 'https://example.supabase.co';
  process.env.SUPABASE_ANON_KEY = 'public-anon-key';
  handler({}, res);
  assert.equal(status, 200);
  assert.match(headers['Cache-Control'], /\bmax-age=300\b/, 'browser cache');
  assert.match(headers['Cache-Control'], /\bs-maxage=300\b/, 'edge cache');
  assert.deepEqual(Object.keys(body).sort(), ['key', 'turnstile_site_key', 'url'], 'only public values: the database address and key, and the Turnstile site key');
});

function configWith(siteKey) {
  const saved = process.env.TURNSTILE_SITE_KEY;
  if (siteKey === undefined) delete process.env.TURNSTILE_SITE_KEY; else process.env.TURNSTILE_SITE_KEY = siteKey;
  let body = null;
  try { handler({}, { setHeader() {}, status() { return this; }, json(b) { body = b; return this; } }); }
  finally { if (saved === undefined) delete process.env.TURNSTILE_SITE_KEY; else process.env.TURNSTILE_SITE_KEY = saved; }
  return body;
}

test('/api/config hands the browser the Turnstile site key when one is set, and an empty string (no check) when not', () => {
  assert.equal(configWith('0x4AAAAAAtest-public-site-key').turnstile_site_key, '0x4AAAAAAtest-public-site-key');
  assert.equal(configWith(undefined).turnstile_site_key, '');
});

test('wrangler.jsonc never holds a Turnstile secret, and a TURNSTILE_SITE_KEY it sets is a site key', () => {
  const text = require('node:fs').readFileSync(require('node:path').join(__dirname, '..', 'wrangler.jsonc'), 'utf8');
  assert.equal(/TURNSTILE_SECRET|CAPTCHA_SECRET/i.test(text), false, 'no Turnstile secret in the repository (it lives only in Supabase and Cloudflare)');
  const match = text.match(/^\s*"TURNSTILE_SITE_KEY"\s*:\s*"([^"]*)"/m);
  // The check is switched off by setting the variable to "" (leaving it out would not do: keep_vars keeps what an earlier deploy created).
  assert.ok(match, 'the variable is named, so a deploy can never keep an old value');
  if (match[1]) assert.match(match[1], /^0x4[A-Za-z0-9_-]{10,}$/, 'when it is set it is a key of the shape Cloudflare gives out');
});
