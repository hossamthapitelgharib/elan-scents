'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { watch } = require('../scripts/site-watch.js');

const SITE = 'https://shop.example.invalid';
const DB = 'https://db.example.invalid';
const KEY = 'public-anon-key-for-tests';

/* A fake shop: every URL has a handler; `overrides` replaces some. Records every request it gets. */
function fakeFetch(overrides, seen) {
  const handlers = Object.assign({
    [SITE + '/health']: () => ({ status: 200, text: 'ok' }),
    [SITE + '/']: () => ({ status: 200, text: '<html lang="ar"></html>' }),
    [SITE + '/api/config']: () => ({ status: 200, text: JSON.stringify({ url: DB, key: KEY }) }),
    [DB + '/rest/v1/products?select=id&limit=1']: () => ({ status: 200, text: '[{"id":"1"}]' })
  }, overrides);
  return async (url, init) => {
    (seen || []).push({ url: String(url), init });
    const handler = handlers[String(url)];
    if (!handler) return { status: 404, text: async () => '{}' };
    const answer = await handler(init);
    return { status: answer.status, text: async () => answer.text };
  };
}
const noPause = async () => {};

test('a healthy shop passes all four questions', async () => {
  const outcome = await watch(SITE, { fetch: fakeFetch({}), pause: noPause });
  assert.equal(outcome.ok, true);
  assert.equal(outcome.results.length, 4);
  assert.ok(outcome.results.every((r) => r.ok));
});

test('the database read uses the public key from the site config and nothing else', async () => {
  const seen = [];
  await watch(SITE, { fetch: fakeFetch({}, seen), pause: noPause });
  const read = seen.find((r) => r.url.startsWith(DB));
  assert.ok(read, 'the database was asked');
  assert.equal(read.init.headers.apikey, KEY);
  assert.equal(read.init.headers.Authorization, 'Bearer ' + KEY);
  assert.equal((read.init.method || 'GET'), 'GET', 'a read, never a write');
  for (const r of seen) assert.ok(r.url.startsWith(SITE) || r.url.startsWith(DB), 'only the shop and its own database are asked: ' + r.url);
});

test('a dead database fails the watch and names the question', async () => {
  const outcome = await watch(SITE, { fetch: fakeFetch({ [DB + '/rest/v1/products?select=id&limit=1']: () => ({ status: 503, text: '{}' }) }), pause: noPause });
  assert.equal(outcome.ok, false);
  const failed = outcome.results.filter((r) => !r.ok);
  assert.deepEqual(failed.map((r) => r.name), ['the database answers a public read']);
  assert.equal(failed[0].detail, '503');
});

test('a Worker that is down fails the watch', async () => {
  const outcome = await watch(SITE, { fetch: fakeFetch({ [SITE + '/health']: () => ({ status: 500, text: 'boom' }) }), pause: noPause });
  assert.equal(outcome.ok, false);
  assert.equal(outcome.results[0].ok, false);
});

test('a network error is a failed question, not a crash', async () => {
  const outcome = await watch(SITE, { fetch: async () => { throw new Error('connect ECONNREFUSED'); }, pause: noPause });
  assert.equal(outcome.ok, false);
  assert.ok(outcome.results.every((r) => !r.ok));
  assert.match(outcome.results[0].detail, /ECONNREFUSED/);
});

test('a config without a public key stops the database question without asking a made-up address', async () => {
  const seen = [];
  const outcome = await watch(SITE, { fetch: fakeFetch({ [SITE + '/api/config']: () => ({ status: 200, text: JSON.stringify({ url: DB }) }) }, seen), pause: noPause });
  assert.equal(outcome.ok, false);
  assert.equal(seen.filter((r) => r.url.startsWith(DB)).length, 0);
  assert.equal(outcome.results[3].detail, 'skipped: no public config');
});

test('a database address that is not https is never used', async () => {
  const seen = [];
  const outcome = await watch(SITE, { fetch: fakeFetch({ [SITE + '/api/config']: () => ({ status: 200, text: JSON.stringify({ url: 'http://db.example.invalid', key: KEY }) }) }, seen), pause: noPause });
  assert.equal(outcome.ok, false);
  assert.equal(seen.filter((r) => r.url.startsWith('http://')).length, 0);
});

test('one slow second does not count: each question is asked a second time before it fails', async () => {
  let calls = 0;
  const outcome = await watch(SITE, {
    fetch: fakeFetch({ [SITE + '/health']: () => { calls += 1; return calls === 1 ? { status: 502, text: '' } : { status: 200, text: 'ok' }; } }),
    pause: noPause
  });
  assert.equal(calls, 2);
  assert.equal(outcome.ok, true);
});

test('a question that keeps failing is asked exactly twice', async () => {
  let calls = 0;
  const outcome = await watch(SITE, { fetch: fakeFetch({ [SITE + '/health']: () => { calls += 1; return { status: 500, text: '' }; } }), pause: noPause });
  assert.equal(calls, 2);
  assert.equal(outcome.ok, false);
});

test('the report never contains the public key', async () => {
  const outcome = await watch(SITE, { fetch: fakeFetch({ [DB + '/rest/v1/products?select=id&limit=1']: () => ({ status: 401, text: '{"key":"' + KEY + '"}' }) }), pause: noPause });
  assert.equal(JSON.stringify(outcome).includes(KEY), false);
});

/* The workflow that runs it. */
const workflow = fs.readFileSync(path.join(__dirname, '..', '.github', 'workflows', 'site-watch.yml'), 'utf8');

test('the workflow runs on a schedule and by hand and runs the watch script', () => {
  assert.match(workflow, /^\s*schedule:\s*\n\s*- cron: '[^']+'/m);
  assert.match(workflow, /workflow_dispatch:/);
  assert.match(workflow, /node scripts\/site-watch\.js "\$SITE_URL"/);
});

test('the workflow may write issues and nothing else, and uses no secret', () => {
  assert.match(workflow, /permissions:\s*\n\s*contents: read\s*\n\s*issues: write/);
  assert.equal(/secrets\./.test(workflow), false, 'the watch uses only the automatic token');
  assert.match(workflow, /GH_TOKEN: \$\{\{ github\.token \}\}/);
});

test('the workflow opens one issue when the shop is down, closes it when it is back, and fails the run', () => {
  assert.match(workflow, /steps\.watch\.outcome == 'failure'[\s\S]*gh issue create[\s\S]*--label site-down/);
  assert.match(workflow, /gh issue list --label site-down --state open/);
  assert.match(workflow, /steps\.watch\.outcome == 'success'[\s\S]*gh issue close/);
  assert.match(workflow, /Fail the run when the shop is not answering[\s\S]*exit 1/);
  assert.match(workflow, /continue-on-error: true/);
});

test('the watch step keeps the failure of the script even though its output goes through tee (pipefail)', () => {
  const step = workflow.slice(workflow.indexOf('- name: Ask the shop'), workflow.indexOf('- name: Open an issue'));
  assert.match(step, /\n\s+shell: bash\n/, 'shell: bash runs with -eo pipefail; the default shell does not, and tee would turn a failing watch into a green step');
  assert.match(step, /node scripts\/site-watch\.js "\$SITE_URL" \| tee watch\.txt/);
});
