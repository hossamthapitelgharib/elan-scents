'use strict';
/* Owner, 14 Nov 2026 (point 2): what the editor creates belongs to the editor session that created it.
   A SAVE makes it permanent (nothing ever removes it, used or not); leaving WITHOUT a save removes it; only a session that never said goodbye is swept, after 3 days.
   The server remembers what the editor creates and the session that made it; the rules run on the real database in tests/editor-cleanup-unsaved.test.sql.
   These tests pin the server side and the wiring of the editor page (the behaviour of the page itself: tests/browser/editor-leave-cleanup.chromium.js). */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const editorData = require('../railway/editor-data.js');
const editor = require('../railway/editor.js');

const SECTION_ID = '30000000-0000-4000-8000-000000000003';
const BRAND_ID = '40000000-0000-4000-8000-000000000004';
const OLD_BRAND_ID = '50000000-0000-4000-8000-000000000005';
const SESSION = '9f1c2d3e-4b5a-4c6d-8e7f-0a1b2c3d4e5f';
const root = path.join(__dirname, '..');
const read = (f) => fs.readFileSync(path.join(root, f), 'utf8');

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
const ok = (v) => ({ ok: true, status: 200, json: async () => v });

/* ---------- remembering what the editor creates, with the session that created it ---------- */
test('a new brand is remembered with its session, an existing one is not, and a store is never remembered', withEnv(async () => {
  const remembered = [];
  const existing = [{ id: OLD_BRAND_ID, name: 'Dior', slug: 'dior' }];
  global.fetch = async (url, o = {}) => {
    const u = new URL(url); const table = u.pathname.split('/').pop(); const m = o.method || 'GET';
    if (table === 'editor_created_records' && m === 'POST') { remembered.push(JSON.parse(o.body)[0]); return { ok: true, status: 201, json: async () => null }; }
    if (table === 'brands' && m === 'GET') return ok(existing);
    if (table === 'brands' && m === 'POST') return { ok: true, status: 201, json: async () => [{ id: BRAND_ID, name: 'Gissah', slug: 'gissah' }] };
    if (table === 'stores' && m === 'GET') return ok([]);
    if (table === 'stores' && m === 'POST') return { ok: true, status: 201, json: async () => [{ id: '60000000-0000-4000-8000-000000000006', name: 'S', slug: 's', status: 'inactive' }] };
    return { ok: false, status: 404, json: async () => ({}) };
  };
  assert.equal((await call({ action: 'catalog.create', kind: 'brand', name: 'Dior', session: SESSION })).body.created, false);
  assert.deepEqual(remembered, [], 'an existing brand is not the editor\'s creation');
  assert.equal((await call({ action: 'catalog.create', kind: 'brand', name: 'Gissah', session: SESSION })).body.created, true);
  assert.deepEqual(remembered, [{ kind: 'brand', record_id: BRAND_ID, session_id: SESSION }]);
  assert.equal((await call({ action: 'catalog.create', kind: 'store', name: 'S', session: SESSION })).body.created, true);
  assert.equal(remembered.length, 1, 'a store has dependants that cascade, so it is never cleaned up automatically');
}));

test('a session that is missing or is not a UUID is remembered as no session (only the 3-day sweep can ever remove it)', withEnv(async () => {
  const remembered = [];
  global.fetch = async (url, o = {}) => {
    const u = new URL(url); const table = u.pathname.split('/').pop(); const m = o.method || 'GET';
    if (table === 'editor_created_records' && m === 'POST') { remembered.push(JSON.parse(o.body)[0]); return { ok: true, status: 201, json: async () => null }; }
    if (table === 'brands' && m === 'GET') return ok([]);
    if (table === 'brands' && m === 'POST') return { ok: true, status: 201, json: async () => [{ id: BRAND_ID, name: 'Gissah', slug: 'gissah' }] };
    return { ok: false, status: 404, json: async () => ({}) };
  };
  await call({ action: 'catalog.create', kind: 'brand', name: 'Gissah' });
  await call({ action: 'catalog.create', kind: 'brand', name: 'Gissah', session: 'not-a-uuid' });
  await call({ action: 'catalog.create', kind: 'brand', name: 'Gissah', session: { $ne: null } });
  assert.deepEqual(remembered.map((r) => r.session_id), [null, null, null]);
}));

test('a new section is remembered, with its session, the moment it is created', withEnv(async () => {
  const remembered = [];
  global.fetch = async (url, o = {}) => {
    const u = new URL(url); const table = u.pathname.split('/').pop(); const m = o.method || 'GET';
    if (table === 'editor_sections' && m === 'POST') return { ok: true, status: 201, json: async () => [{ id: SECTION_ID, ...JSON.parse(o.body)[0] }] };
    if (table === 'editor_created_records' && m === 'POST') { remembered.push(JSON.parse(o.body)[0]); return { ok: true, status: 201, json: async () => null }; }
    return { ok: false, status: 404, json: async () => ({}) };
  };
  const res = await call({ action: 'section.create', session: SESSION.toUpperCase(), section: { name: 'عطور ديور', purpose: 'brand', selection_mode: 'auto', filters: { brand: 'Dior' } } });
  assert.equal(res.statusCode, 200);
  assert.deepEqual(remembered, [{ kind: 'section', record_id: SECTION_ID, session_id: SESSION }]);
}));

test('if remembering fails the creation still succeeds (the record is just never cleaned up)', withEnv(async () => {
  global.fetch = async (url, o = {}) => {
    const u = new URL(url); const table = u.pathname.split('/').pop(); const m = o.method || 'GET';
    if (table === 'editor_created_records') return { ok: false, status: 500, json: async () => ({ message: 'down' }) };
    if (table === 'brands' && m === 'GET') return ok([]);
    if (table === 'brands' && m === 'POST') return { ok: true, status: 201, json: async () => [{ id: BRAND_ID, name: 'Gissah', slug: 'gissah' }] };
    return { ok: false, status: 404, json: async () => ({}) };
  };
  const res = await call({ action: 'catalog.create', kind: 'brand', name: 'Gissah', session: SESSION });
  assert.equal(res.statusCode, 200);
  assert.equal(res.body.created, true);
}));

/* ---------- a save: what the session created is permanent ---------- */
test('cleanup.keep makes this session\'s creations permanent: one database call with the session, nothing from the browser but the session', withEnv(async () => {
  const sent = [];
  global.fetch = async (url, o = {}) => { sent.push({ path: new URL(url).pathname, body: JSON.parse(o.body || 'null') }); return ok(3); };
  const res = await call({ action: 'cleanup.keep', session: SESSION, p_session: 'x', keep: ['x-a'], p_keep_refs: ['x-a'] });
  assert.equal(res.statusCode, 200);
  assert.deepEqual(res.body, { ok: true, kept: 3 });
  assert.deepEqual(sent, [{ path: '/rest/v1/rpc/editor_keep_created', body: { p_session: SESSION } }]);
}));

test('cleanup.keep and cleanup.discard refuse a missing or malformed session and touch nothing', withEnv(async () => {
  let calls = 0;
  global.fetch = async () => { calls++; return ok([]); };
  for (const action of ['cleanup.keep', 'cleanup.discard']) {
    for (const session of [undefined, '', 'x', 'short-session-id', 12345, ['a'], { a: 1 }, SESSION + 'x']) {
      const res = await call({ action, session });
      assert.equal(res.statusCode, 400, action + ' ' + JSON.stringify(session));
      assert.equal(res.body.error, 'invalid_session');
    }
  }
  assert.equal(calls, 0);
}));

/* ---------- leaving without a save: what the session created is removed ---------- */
test('cleanup.discard asks first whether this session made anything: if not, it neither reads the design nor removes anything', withEnv(async () => {
  let design = 0, rpc = 0, query = null;
  editor.internals.currentDesignText = async () => { design++; return JSON.stringify({ version: 1 }); };
  global.fetch = async (url) => { const u = new URL(url); if (u.pathname.includes('/rpc/')) rpc++; else query = u.pathname + u.search; return ok([]); };
  const res = await call({ action: 'cleanup.discard', session: SESSION });
  assert.equal(res.statusCode, 200);
  assert.deepEqual(res.body.removed, { sections: 0, brands: 0, occasions: 0, notes: 0 });
  assert.equal(design, 0, 'the design was not read');
  assert.equal(rpc, 0, 'nothing was removed');
  assert.match(query, /editor_created_records\?select=record_id&session_id=eq\.9f1c2d3e-4b5a-4c6d-8e7f-0a1b2c3d4e5f&limit=1/);
}));

test('cleanup.discard removes what this session created, keeping what the SAVED design uses on every page (the list comes from the saved file, never from the browser)', withEnv(async () => {
  const design = { version: 1, blocks: [{ id: 'x-a', type: 'smart', ref: 'x-sec1' }, { id: 'x-b', type: 'banner' }],
    pages: { offers: { blocks: [{ id: 'x-c', type: 'smart', ref: 'x-sec2' }] } } };
  editor.internals.currentDesignText = async () => JSON.stringify(design);
  let sent = null;
  global.fetch = async (url, o = {}) => {
    const u = new URL(url);
    if (u.pathname.endsWith('/editor_created_records')) return ok([{ record_id: SECTION_ID }]);
    if (u.pathname.endsWith('/rpc/editor_cleanup_unsaved')) { sent = JSON.parse(o.body); return ok({ sections: 1, brands: 1, occasions: 0, notes: 0 }); }
    return { ok: false, status: 404, json: async () => ({}) };
  };
  const res = await call({ action: 'cleanup.discard', session: SESSION, keep: ['x-from-the-browser'], p_keep_refs: ['x-from-the-browser'] });
  assert.equal(res.statusCode, 200);
  assert.deepEqual(Object.keys(sent).sort(), ['p_keep_refs', 'p_session']);
  assert.deepEqual(sent.p_keep_refs.sort(), ['x-sec1', 'x-sec2']);
  assert.equal(sent.p_session, SESSION);
  assert.deepEqual(res.body.removed, { sections: 1, brands: 1, occasions: 0, notes: 0 });
}));

test('when the design cannot be read, or is not a design, nothing is removed (by a discard or by the sweep)', withEnv(async () => {
  let rpc = 0;
  global.fetch = async (url) => { const u = new URL(url); if (u.pathname.includes('/rpc/')) { rpc++; return ok({}); } return ok([{ record_id: SECTION_ID }]); };
  for (const text of [null, '', '   ', 'not json', '[]', '{}', '{"blocks":[]}']) {
    editor.internals.currentDesignText = async () => text;
    for (const body of [{ action: 'cleanup.run' }, { action: 'cleanup.discard', session: SESSION }]) {
      const res = await call(body);
      assert.equal(res.statusCode, 200, String(text));
      assert.equal(res.body.skipped, 'design_unreadable', body.action + ' skipped for: ' + JSON.stringify(text));
    }
  }
  editor.internals.currentDesignText = async () => { throw new Error('github down'); };
  assert.equal((await call({ action: 'cleanup.run' })).body.skipped, 'design_unreadable');
  assert.equal((await call({ action: 'cleanup.discard', session: SESSION })).body.skipped, 'design_unreadable');
  assert.equal(rpc, 0, 'the database was never asked to remove anything');
}));

/* ---------- the sweep for sessions that never said goodbye ---------- */
test('the sweep (cleanup.run) keeps exactly the sections the SAVED design uses, takes nothing from the browser, and names no session and no grace period', withEnv(async () => {
  const design = { version: 1, blocks: [{ id: 'x-a', type: 'smart', ref: 'x-sec1' }], pages: { offers: { blocks: [{ id: 'x-c', type: 'smart', ref: 'x-sec2' }] } } };
  editor.internals.currentDesignText = async () => JSON.stringify(design);
  let sent = null;
  global.fetch = async (url, o = {}) => {
    if (new URL(url).pathname.endsWith('/rpc/editor_cleanup_unsaved')) { sent = JSON.parse(o.body); return ok({ sections: 2, brands: 1, occasions: 0, notes: 0 }); }
    return { ok: false, status: 404, json: async () => ({}) };
  };
  const res = await call({ action: 'cleanup.run', keep: ['x-from-the-browser'], p_keep_refs: ['x-from-the-browser'], session: SESSION, p_grace: '1 minute' });
  assert.equal(res.statusCode, 200);
  assert.deepEqual(sent.p_keep_refs.sort(), ['x-sec1', 'x-sec2']);
  assert.deepEqual(Object.keys(sent), ['p_keep_refs'], 'no grace period or session is taken from the request');
  assert.deepEqual(res.body.removed, { sections: 2, brands: 1, occasions: 0, notes: 0 });
}));

test('a design with no smart sections still runs, with an empty keep list', withEnv(async () => {
  editor.internals.currentDesignText = async () => JSON.stringify({ version: 1, blocks: [] });
  let sent = null;
  global.fetch = async (url, o = {}) => { if (new URL(url).pathname.includes('/rpc/')) sent = JSON.parse(o.body); return ok({ sections: 0, brands: 0, occasions: 0, notes: 0 }); };
  assert.equal((await call({ action: 'cleanup.run' })).statusCode, 200);
  assert.deepEqual(sent, { p_keep_refs: [] });
}));

test('only the owner account can run any of them, and only with POST', withEnv(async () => {
  global.fetch = async () => { throw new Error('no network expected'); };
  for (const action of ['cleanup.run', 'cleanup.keep', 'cleanup.discard']) {
    const res = makeRes();
    await editorData({ method: 'GET', query: { action, session: SESSION }, headers: {}, __editorKeyAdmin: true }, res);
    assert.equal(res.statusCode, 400, action + ': a GET is an unknown action');
    const anon = makeRes();
    await editorData({ method: 'POST', query: {}, body: { action, session: SESSION }, headers: {} }, anon);
    assert.ok(anon.statusCode === 401 || anon.statusCode === 403, action + ': no session, no cleanup: ' + anon.statusCode);
  }
}));

/* ---------- the wiring of the pages ---------- */
test('the editor page keeps after a save (awaiting it, for the session that saved), and never lets a failure block saving or leaving', () => {
  const html = read('editor/elan-editor.html');
  assert.match(html, /function editorDataPost\(body,keep\)\{try\{return fetch\('\/api\/editor-data'.*keepalive:!!keep.*\.catch\(\(\)=>null\)/s);
  assert.match(html, /async function keepCreated\(session\)\{if\(!session\)return;for\(let i=0;i<2;i\+\+\)\{const r=await editorDataPost\(\{action:'cleanup\.keep',session\}\);if\(r&&r\.ok\)break;\}editorDataPost\(\{action:'cleanup\.run'\}\);\}/);
  const save = html.slice(html.indexOf('async function saveLive()'), html.indexOf('async function refreshLive()'));
  assert.match(save, /const savingSession=bridgeSession;/);
  assert.match(save, /bridgeDirty=false;await keepCreated\(savingSession\);/);
  assert.doesNotMatch(save, /discardCreated/, 'a save never discards');
});

test('the exit button discards BEFORE logging out; closing the tab or reloading the page without saving discards too', () => {
  const html = read('editor/elan-editor.html');
  const logout = html.slice(html.indexOf('logoutBtn.onclick='), html.indexOf("location.replace('/editor');};") + 30);
  assert.match(logout, /confirm\('.*هتتشال.*'\)/, 'the question says what goes');
  assert.ok(logout.indexOf('discardCreated(bridgeSession)') !== -1 && logout.indexOf('discardCreated(bridgeSession)') < logout.indexOf("fetch('/api/editor-logout'"), 'discard first, then logout (the session cookie dies with the logout)');
  assert.match(logout, /setTimeout\(r,4000\)/, 'a slow server never keeps the owner from leaving');
  assert.match(html, /window\.addEventListener\('pagehide',e=>\{if\(e\.persisted\|\|leavingEditor\)return;leavingEditor=true;discardCreated\(bridgeSession\);\}\);/);
  assert.match(html, /function discardCreated\(session\)\{return session\?editorDataPost\(\{action:'cleanup\.discard',session\},true\):Promise\.resolve\(null\);\}/, 'a keepalive request, so it still goes out while the page closes');
  const reopen = html.slice(html.indexOf('openLive.onclick=async()=>'), html.indexOf('bridgeSession=crypto.randomUUID();') + 40);
  assert.match(reopen, /if\(bridgeSession\)discardCreated\(bridgeSession\);bridgeSession=crypto\.randomUUID\(\);/, 'loading the page again (and losing the unsaved changes) ends the old session');
  assert.match(html, /getState:\(\)=>\(\{connected:bridgeReady,revision:bridgeRevision,dirty:bridgeDirty,session:bridgeSession\}\)/);
});

test('every create call carries the editor session: the creation panels, the in-page tools, and the bridge hands it to the page', () => {
  assert.match(read('editor/editor-live-create.js'), /JSON\.stringify\(Object\.assign\(\{ action: action, session: editorSession\(\) \}, payload \|\| \{\}\)\)/);
  assert.match(read('editor/editor-live-create.js'), /function editorSession\(\) \{ var live = root\.elanLiveEditorBridge, s = live && typeof live\.getState === 'function' \? live\.getState\(\)\.session : ''; return s \|\| undefined; \}/);
  assert.match(read('edit-mode.js'), /Object\.assign\(\{ action: action, session: bridgeSession \|\| undefined \}, payload \|\| \{\}\)/);
  assert.match(read('edit-mode.js'), /bridgeSession = context && typeof context\.session === 'string' \? context\.session : bridgeSession;/);
  assert.match(read('elan-host-bridge.js'), /const context=\{origin:e\.origin,ticket:session\.ticket,session:session\.id\};/);
});

test('the cleanup migrations and their rollbacks exist with the versions the database registered', () => {
  const first = read('supabase/migrations/20261114122256_editor_cleanup_unsaved.sql');
  assert.match(first, /create table public\.editor_created_records/);
  assert.ok(fs.existsSync(path.join(root, 'supabase/rollback/20261114122256_editor_cleanup_unsaved.sql')));
  const sql = read('supabase/migrations/20261115065036_editor_cleanup_by_session.sql');
  assert.match(sql, /add column session_id text/);
  assert.match(sql, /revoke all on function public\.editor_cleanup_unsaved\(text\[\], interval, text\) from public, anon, authenticated/);
  assert.match(sql, /grant execute on function public\.editor_cleanup_unsaved\(text\[\], interval, text\) to service_role/);
  assert.match(sql, /revoke all on function public\.editor_keep_created\(text\) from public, anon, authenticated/);
  assert.match(sql, /grant execute on function public\.editor_keep_created\(text\) to service_role/);
  assert.match(sql, /p_grace interval default interval '3 days'/);
  assert.doesNotMatch(sql, /public\.stores/, 'stores are never removed automatically (they cascade to products and offers)');
  assert.ok(fs.existsSync(path.join(root, 'supabase/rollback/20261115065036_editor_cleanup_by_session.sql')));
});
