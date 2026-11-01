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

test('the Turnstile site key in wrangler.jsonc is the public one: a site key, never a secret key', () => {
  const text = require('node:fs').readFileSync(require('node:path').join(__dirname, '..', 'wrangler.jsonc'), 'utf8');
  const match = text.match(/"TURNSTILE_SITE_KEY"\s*:\s*"([^"]*)"/);
  assert.ok(match, 'the Worker has a TURNSTILE_SITE_KEY variable');
  assert.match(match[1], /^0x4[A-Za-z0-9_-]{10,}$/, 'a Turnstile site key starts with 0x4 (secret keys start with 0x4 too, which is why the secret is never written here: it is set only in Supabase and Cloudflare)');
  assert.equal(/TURNSTILE_SECRET|CAPTCHA_SECRET/i.test(text), false, 'no Turnstile secret in the repository');
});
