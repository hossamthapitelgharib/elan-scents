#!/usr/bin/env node
/* Élan Scents — check of the LIVE site (Cloudflare Worker) from the outside.
   Usage: node scripts/live-check.js https://elan-scents.hossamthapitelgharib.workers.dev
   It sends a few harmless requests and tells which secrets the Worker has: the answers of the API differ when a secret is missing
   (503) and when it is there (401), so nothing secret is ever read or printed. Run by .github/workflows/live-check.yml.
   Exit code 1 only when something the site needs is wrong; a webhook secret that is unset on purpose is just a notice. */
'use strict';

const REQUIRED = 'required';
const INFO = 'info';

async function probe(base, fetchImpl) {
  const doFetch = fetchImpl || fetch;
  const root = String(base).replace(/\/+$/, '');
  const results = [];
  const add = (name, kind, ok, detail) => results.push({ name, kind, ok: Boolean(ok), detail: String(detail) });
  const call = async (path, init) => {
    try {
      const r = await doFetch(root + path, Object.assign({ redirect: 'manual' }, init));
      let text = '';
      try { text = await r.text(); } catch (_) { /* body not needed */ }
      return { status: r.status, text, headers: r.headers };
    } catch (e) { return { status: 0, text: '', headers: new Map(), error: String(e && e.message) }; }
  };
  const jsonOf = (text) => { try { return JSON.parse(text); } catch (_) { return {}; } };

  const health = await call('/health');
  add('/health answers ok', REQUIRED, health.status === 200 && health.text === 'ok', health.status + (health.error ? ' ' + health.error : ''));

  const cfg = await call('/api/config');
  const cfgBody = jsonOf(cfg.text);
  add('/api/config gives the public Supabase address and key', REQUIRED, cfg.status === 200 && /^https:\/\//.test(cfgBody.url || '') && Boolean(cfgBody.key), cfg.status);

  const home = await call('/');
  add('the storefront page is served', REQUIRED, home.status === 200 && /<html/i.test(home.text), home.status);

  // Without a token the auth helper answers 503 when SUPABASE_SERVICE_ROLE_KEY is missing and 401 when it is set.
  const orders = await call('/api/customer-orders');
  const ordersBody = jsonOf(orders.text);
  add('SUPABASE_SERVICE_ROLE_KEY is set on the Worker', REQUIRED, orders.status === 401, orders.status === 503 ? 'missing (' + (ordersBody.error || '503') + ')' : orders.status);

  // The shared webhook secret: 503 = not set (intended until the first store is connected), 401 = set and the wrong one was refused.
  const hook = await call('/api/store-order-status', { method: 'POST', headers: { 'content-type': 'application/json', 'x-store-webhook-secret': 'not-the-secret' }, body: '{}' });
  add('STORE_ORDER_WEBHOOK_SECRET', INFO, hook.status === 401 || hook.status === 503, hook.status === 503 ? 'not set (webhooks are refused with 503, safe)' : hook.status === 401 ? 'set (a wrong secret is refused)' : 'unexpected ' + hook.status);

  const editor = await call('/editor');
  add('the owner editor login page is served', REQUIRED, editor.status === 200 && editor.headers.get('x-frame-options') === 'DENY', editor.status);
  const state = await call('/api/editor?action=state');
  add('the editor API refuses a caller without a session', REQUIRED, state.status === 401, state.status);

  const video = await call('/assets/hero.mp4', { headers: { range: 'bytes=0-99' } });
  add('the hero video answers a Range request with 206 (Safari needs it)', REQUIRED, video.status === 206, video.status);

  return results;
}

function summarize(results) {
  const failed = results.filter((r) => !r.ok && r.kind === REQUIRED);
  return { failed, ok: failed.length === 0 };
}

async function main() {
  const base = process.argv[2];
  if (!/^https:\/\/[\w.-]+(:\d+)?\/?$/.test(base || '')) { console.log('usage: node scripts/live-check.js https://<site>'); process.exit(2); }
  const results = await probe(base);
  for (const r of results) {
    console.log((r.ok ? 'ok   ' : (r.kind === INFO ? 'note ' : 'FAIL ')) + r.name + ' -> ' + r.detail);
    if (r.kind === INFO || !r.ok) console.log('::' + (r.ok || r.kind === INFO ? 'notice' : 'error') + ' title=Live site check::' + (r.name + ' -> ' + r.detail).replace(/[\r\n]+/g, ' ').slice(0, 300));
  }
  const summary = summarize(results);
  console.log('\n' + (summary.ok ? 'live site check passed' : summary.failed.length + ' required check(s) failed'));
  process.exit(summary.ok ? 0 : 1);
}

if (require.main === module) main();

module.exports = { probe, summarize };
