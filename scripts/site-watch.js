#!/usr/bin/env node
/* Élan Scents — the scheduled "is the shop alive" watch. Run by .github/workflows/site-watch.yml every few hours.
   Usage: node scripts/site-watch.js https://elan-scents.hossamthapitelgharib.workers.dev
   It asks four small questions from the outside and sends nothing secret:
     1. /health answers "ok" (the Worker is up),
     2. the storefront page is served,
     3. /api/config gives the public Supabase address and key,
     4. one public read of the database (a single product id) with that public key answers 200 and a list.
   The last one is the point: it proves the database is awake and answering, and a few real reads a day are what keeps a
   Free-plan Supabase project from being paused for inactivity. Each question is asked twice before it counts as a failure,
   so one slow second does not wake anybody up. Exit code 1 when anything still fails (the workflow then opens an issue). */
'use strict';

const ATTEMPTS = 2;
const PAUSE_MS = 8000;
const TIMEOUT_MS = 20000;

const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function watch(base, options) {
  const doFetch = (options && options.fetch) || fetch;
  const pause = (options && options.pause) || wait;
  const root = String(base).replace(/\/+$/, '');
  const results = [];

  // One request; never throws. A request that takes longer than TIMEOUT_MS counts as no answer.
  async function call(url, init) {
    try {
      const response = await doFetch(url, Object.assign({ redirect: 'manual', signal: AbortSignal.timeout(TIMEOUT_MS) }, init));
      let text = '';
      try { text = await response.text(); } catch (_) { /* body not needed */ }
      return { status: response.status, text };
    } catch (error) {
      return { status: 0, text: '', error: String((error && error.message) || error).slice(0, 120) };
    }
  }
  const jsonOf = (text) => { try { return JSON.parse(text); } catch (_) { return null; } };

  // Asks a question up to ATTEMPTS times; `ask` returns { ok, detail }.
  async function check(name, ask) {
    let last = { ok: false, detail: 'no answer' };
    for (let attempt = 1; attempt <= ATTEMPTS; attempt += 1) {
      last = await ask();
      if (last.ok) break;
      if (attempt < ATTEMPTS) await pause(PAUSE_MS);
    }
    results.push({ name, ok: Boolean(last.ok), detail: String(last.detail) });
    return last;
  }
  const statusDetail = (r) => String(r.status) + (r.error ? ' ' + r.error : '');

  await check('the Worker answers /health', async () => {
    const r = await call(root + '/health');
    return { ok: r.status === 200 && r.text === 'ok', detail: statusDetail(r) };
  });

  await check('the storefront page is served', async () => {
    const r = await call(root + '/');
    return { ok: r.status === 200 && /<html/i.test(r.text), detail: statusDetail(r) };
  });

  let publicConfig = null;
  await check('/api/config gives the public Supabase address and key', async () => {
    const r = await call(root + '/api/config');
    const body = jsonOf(r.text) || {};
    const ok = r.status === 200 && /^https:\/\/[\w.-]+\/?$/.test(body.url || '') && typeof body.key === 'string' && body.key.length > 0;
    if (ok) publicConfig = { url: body.url.replace(/\/+$/, ''), key: body.key };
    return { ok, detail: statusDetail(r) };
  });

  await check('the database answers a public read', async () => {
    if (!publicConfig) return { ok: false, detail: 'skipped: no public config' };
    const r = await call(publicConfig.url + '/rest/v1/products?select=id&limit=1', {
      headers: { apikey: publicConfig.key, Authorization: 'Bearer ' + publicConfig.key, Accept: 'application/json' }
    });
    const body = jsonOf(r.text);
    return { ok: r.status === 200 && Array.isArray(body), detail: statusDetail(r) };
  });

  return { results, ok: results.every((r) => r.ok) };
}

async function main() {
  const base = process.argv[2];
  if (!/^https:\/\/[\w.-]+(:\d+)?\/?$/.test(base || '')) { console.log('usage: node scripts/site-watch.js https://<site>'); process.exit(2); }
  const outcome = await watch(base);
  for (const r of outcome.results) console.log((r.ok ? 'ok   ' : 'FAIL ') + r.name + ' -> ' + r.detail);
  console.log('\n' + (outcome.ok ? 'the shop is alive' : 'the shop is NOT answering as it should'));
  process.exit(outcome.ok ? 0 : 1);
}

if (require.main === module) main();

module.exports = { watch };
