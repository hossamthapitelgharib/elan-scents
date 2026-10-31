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
  assert.deepEqual(Object.keys(body).sort(), ['key', 'url'], 'only the two public values');
});
