'use strict';
/* Owner, 13 Nov 2026: a section or brand created in the editor but never saved must not stay in the database.
   The server remembers what the editor creates and, after every save, asks the database to remove what the SAVED design never used
   (the rules themselves are tested on the real database in tests/editor-cleanup-unsaved.test.sql). These tests pin the server side. */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const editorData = require('../railway/editor-data.js');
const editor = require('../railway/editor.js');

const SECTION_ID = '30000000-0000-4000-8000-000000000003';
const BRAND_ID = '40000000-0000-4000-8000-000000000004';
const OLD_BRAND_ID = '50000000-0000-4000-8000-000000000005';
const root = path.join(__dirname, '..');

function makeRes() {
  return { statusCode: 200, headers: {}, body: null, status(c) { this.statusCode = c; return this; }, setHeader(n, v) { this.headers[n.toLowerCase()] = v; return this; }, json(v) { this.body = v; return this; } };
}

function withEnv(fn) {
  return async () => {
    const prev = { fetch: global.fetch, url: process.env.SUPABASE_URL, key: process.env.SUPABASE_SERVICE_ROLE_KEY, text: editor.internals.currentDesignText };
    process.env.SUPABASE_URL = 'https://supabase.test';
    process.env.SUPABASE_SERVICE_ROLE_KEY = 'test-service-role';
    try { await fn(); } finally {
      global.fetch = prev.fetch; editor.internals.currentDesignText = prev.text;
      if (prev.url === undefined) delete process.env.SUPABASE_URL; else process.env.SUPABASE_URL = prev.url;
      if (prev.key === undefined) delete process.env.SUPABASE_SERVICE_ROLE_KEY; else process.env.SUPABASE_SERVICE_ROLE_KEY = prev.key;
    }
  };
}

async function call(body) {
  const res = makeRes();
  await editorData({ method: 'POST', query: {}, body, headers: {}, __editorKeyAdmin: true }, res);
  return res;
}

test('a new brand is remembered, an existing one is not, and a store is never remembered', withEnv(async () => {
  const remembered = [];
  const existing = [{ id: OLD_BRAND_ID, name: 'Dior', slug: 'dior' }];
  global.fetch = async (url, o = {}) => {
    const u = new URL(url); const table = u.pathname.split('/').pop(); const m = o.method || 'GET';
    if (table === 'editor_created_records' && m === 'POST') { remembered.push(JSON.parse(o.body)[0]); return { ok: true, status: 201, json: async () => null }; }
    if (table === 'brands' && m === 'GET') return { ok: true, status: 200, json: async () => existing };
    if (table === 'brands' && m === 'POST') return { ok: true, status: 201, json: async () => [{ id: BRAND_ID, name: 'Gissah', slug: 'gissah' }] };
    if (table === 'stores' && m === 'GET') return { ok: true, status: 200, json: async () => [] };
    if (table === 'stores' && m === 'POST') return { ok: true, status: 201, json: async () => [{ id: '60000000-0000-4000-8000-000000000006', name: 'S', slug: 's', status: 'inactive' }] };
    return { ok: false, status: 404, json: async () => ({}) };
  };
  assert.equal((await call({ action: 'catalog.create', kind: 'brand', name: 'Dior' })).body.created, false);
  assert.deepEqual(remembered, [], 'an existing brand is not the editor\'s creation');
  assert.equal((await call({ action: 'catalog.create', kind: 'brand', name: 'Gissah' })).body.created, true);
  assert.deepEqual(remembered, [{ kind: 'brand', record_id: BRAND_ID }]);
  assert.equal((await call({ action: 'catalog.create', kind: 'store', name: 'S' })).body.created, true);
  assert.equal(remembered.length, 1, 'a store has dependants that cascade, so it is never cleaned up automatically');
}));

test('a new section is remembered the moment it is created', withEnv(async () => {
  const remembered = [];
  global.fetch = async (url, o = {}) => {
    const u = new URL(url); const table = u.pathname.split('/').pop(); const m = o.method || 'GET';
    if (table === 'editor_sections' && m === 'POST') return { ok: true, status: 201, json: async () => [{ id: SECTION_ID, ...JSON.parse(o.body)[0] }] };
    if (table === 'editor_created_records' && m === 'POST') { remembered.push(JSON.parse(o.body)[0]); return { ok: true, status: 201, json: async () => null }; }
    return { ok: false, status: 404, json: async () => ({}) };
  };
  const res = await call({ action: 'section.create', section: { name: 'عطور ديور', purpose: 'brand', selection_mode: 'auto', filters: { brand: 'Dior' } } });
  assert.equal(res.statusCode, 200);
  assert.deepEqual(remembered, [{ kind: 'section', record_id: SECTION_ID }]);
}));

test('if remembering fails the creation still succeeds (the record is just never cleaned up)', withEnv(async () => {
  global.fetch = async (url, o = {}) => {
    const u = new URL(url); const table = u.pathname.split('/').pop(); const m = o.method || 'GET';
    if (table === 'editor_created_records') return { ok: false, status: 500, json: async () => ({ message: 'down' }) };
    if (table === 'brands' && m === 'GET') return { ok: true, status: 200, json: async () => [] };
    if (table === 'brands' && m === 'POST') return { ok: true, status: 201, json: async () => [{ id: BRAND_ID, name: 'Gissah', slug: 'gissah' }] };
    return { ok: false, status: 404, json: async () => ({}) };
  };
  const res = await call({ action: 'catalog.create', kind: 'brand', name: 'Gissah' });
  assert.equal(res.statusCode, 200);
  assert.equal(res.body.created, true);
}));

test('the cleanup keeps exactly the sections the SAVED design uses, on every page, and nothing comes from the browser', withEnv(async () => {
  const design = { version: 1, blocks: [{ id: 'x-a', type: 'smart', ref: 'x-sec1' }, { id: 'x-b', type: 'banner' }],
    pages: { offers: { blocks: [{ id: 'x-c', type: 'smart', ref: 'x-sec2' }] } } };
  editor.internals.currentDesignText = async () => JSON.stringify(design);
  let sent = null;
  global.fetch = async (url, o = {}) => {
    const u = new URL(url);
    if (u.pathname.endsWith('/rpc/editor_cleanup_unsaved')) { sent = JSON.parse(o.body); return { ok: true, status: 200, json: async () => ({ sections: 2, brands: 1, occasions: 0, notes: 0 }) }; }
    return { ok: false, status: 404, json: async () => ({}) };
  };
  const res = await call({ action: 'cleanup.run', keep: ['x-from-the-browser'], p_keep_refs: ['x-from-the-browser'] });
  assert.equal(res.statusCode, 200);
  assert.deepEqual(sent.p_keep_refs.sort(), ['x-sec1', 'x-sec2']);
  assert.deepEqual(Object.keys(sent), ['p_keep_refs'], 'no grace period or anything else is taken from the request');
  assert.deepEqual(res.body.removed, { sections: 2, brands: 1, occasions: 0, notes: 0 });
}));

test('when the design cannot be read, or is not a design, nothing is cleaned up', withEnv(async () => {
  let rpc = 0;
  global.fetch = async (url) => { if (new URL(url).pathname.includes('/rpc/')) rpc++; return { ok: true, status: 200, json: async () => ({}) }; };
  for (const text of [null, '', '   ', 'not json', '[]', '{}', '{"blocks":[]}']) {
    editor.internals.currentDesignText = async () => text;
    const res = await call({ action: 'cleanup.run' });
    assert.equal(res.statusCode, 200, String(text));
    assert.equal(res.body.skipped, 'design_unreadable', 'skipped for: ' + JSON.stringify(text));
  }
  editor.internals.currentDesignText = async () => { throw new Error('github down'); };
  assert.equal((await call({ action: 'cleanup.run' })).body.skipped, 'design_unreadable');
  assert.equal(rpc, 0, 'the database was never asked to remove anything');
}));

test('a design with no smart sections still runs the cleanup, with an empty keep list', withEnv(async () => {
  editor.internals.currentDesignText = async () => JSON.stringify({ version: 1, blocks: [] });
  let sent = null;
  global.fetch = async (url, o = {}) => { if (new URL(url).pathname.includes('/rpc/')) sent = JSON.parse(o.body); return { ok: true, status: 200, json: async () => ({ sections: 0, brands: 0, occasions: 0, notes: 0 }) }; };
  assert.equal((await call({ action: 'cleanup.run' })).statusCode, 200);
  assert.deepEqual(sent, { p_keep_refs: [] });
}));

test('only the owner account can run it, and only with POST', withEnv(async () => {
  global.fetch = async () => { throw new Error('no network expected'); };
  const res = makeRes();
  await editorData({ method: 'GET', query: { action: 'cleanup.run' }, headers: {}, __editorKeyAdmin: true }, res);
  assert.equal(res.statusCode, 400, 'a GET is an unknown action');
  const anon = makeRes();
  await editorData({ method: 'POST', query: {}, body: { action: 'cleanup.run' }, headers: {} }, anon);
  assert.ok(anon.statusCode === 401 || anon.statusCode === 403, 'no session, no cleanup: ' + anon.statusCode);
}));

test('the editor page asks for the cleanup after a save and never waits for it', () => {
  const html = fs.readFileSync(path.join(root, 'editor/elan-editor.html'), 'utf8');
  assert.match(html, /function cleanupUnsaved\(\)\{try\{fetch\('\/api\/editor-data'.*cleanup\.run.*\.catch\(\(\)=>\{\}\)/s);
  const save = html.slice(html.indexOf('async function saveLive()'), html.indexOf('async function refreshLive()'));
  assert.match(save, /bridgeDirty=false;cleanupUnsaved\(\);/);
  assert.doesNotMatch(save, /await cleanupUnsaved/);
});

test('the cleanup migration and its rollback exist with the version the database registered', () => {
  const sql = fs.readFileSync(path.join(root, 'supabase/migrations/20261114122256_editor_cleanup_unsaved.sql'), 'utf8');
  assert.match(sql, /create table public\.editor_created_records/);
  assert.match(sql, /revoke all on function public\.editor_cleanup_unsaved\(text\[\], interval\) from public, anon, authenticated/);
  assert.match(sql, /grant execute on function public\.editor_cleanup_unsaved\(text\[\], interval\) to service_role/);
  assert.doesNotMatch(sql, /public\.stores/, 'stores are never removed automatically (they cascade to products and offers)');
  assert.ok(fs.existsSync(path.join(root, 'supabase/rollback/20261114122256_editor_cleanup_unsaved.sql')));
});
