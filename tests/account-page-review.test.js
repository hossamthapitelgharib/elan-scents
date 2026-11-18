'use strict';
/* The orders page review (scripts/account-page-review.js + .github/workflows/account-page-review.yml) opens the published page from a GitHub runner.
   It must stay a read-only review: no secret, no write to the live site, a made-up session and made-up answers only. */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.join(__dirname, '..');
const script = fs.readFileSync(path.join(root, 'scripts/account-page-review.js'), 'utf8');
const workflow = fs.readFileSync(path.join(root, '.github/workflows/account-page-review.yml'), 'utf8');

test('the review reads no secret and needs no key: only the site address', () => {
  assert.doesNotMatch(script, /process\.env\.[A-Z_]*(KEY|SECRET|TOKEN|PASSWORD)/);
  assert.doesNotMatch(workflow, /secrets\./);
  assert.match(workflow, /permissions:\s*\n\s*contents: read/);
});

test('signed in, every /api and database call is answered by the browser itself, and writes are counted', () => {
  assert.match(script, /startsWith\('\/api\/'\)[\s\S]{0,120}\/api\/config/, 'the site\'s own api is answered by the made-up server (except the public config)');
  assert.match(script, /\*\*\/\*\.supabase\.co\/\*\*/, 'the database is answered by the made-up server');
  assert.match(script, /seen\.writes\+\+/, 'a write is counted');
  assert.match(script, /review-made-up-token/, 'the session is made up');
});

test('it covers the states the page can show, on a phone and a laptop', () => {
  for (const status of ['awaiting_store_confirmation', 'store_confirmed', 'processing', 'shipped', 'delivered', 'store_rejected', 'store_cancelled']) assert.match(script, new RegExp(status));
  assert.match(script, /width: 390/);
  assert.match(script, /width: 1280/);
});

test('the screenshots can be read back from the log', () => {
  assert.match(script, /IMG\|/);
  assert.match(script, /--decode/);
  assert.match(workflow, /upload-artifact/);
});
