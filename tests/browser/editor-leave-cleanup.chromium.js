'use strict';
/* Owner, 14 Nov 2026 (point 2): what the editor creates (a section, a brand, an occasion, a note) belongs to the editor session that created it.
   A SAVE makes it permanent, used or not; leaving WITHOUT a save (the exit button, closing the browser or the tab) removes it.
   Real Chromium; the server answers are stubbed and every call the editor page makes is recorded in order. The rules themselves run on the real database
   in tests/editor-cleanup-unsaved.test.sql. */
const test = require('node:test');
const assert = require('node:assert/strict');
const H = require('./harness.js');

const pw = H.loadPlaywright();
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

let browser, server;
test.before(async () => { server = await H.startServer(); browser = await pw.chromium.launch({ args: ['--no-sandbox'] }); });
test.after(async () => { if (browser) await browser.close(); if (server) await server.stop(); });

async function openEditor(opts) {
  opts = opts || {};
  const { context } = await H.openContext(browser, server, H.WIDTHS[2]);
  await H.loginAsOwner(context, server);
  const page = await context.newPage();
  const events = [], dialogs = [];
  const json = (route, body) => route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(body) });
  await page.route('**/api/editor-data', async (route) => {
    try {
      const req = route.request();
      if (req.method() !== 'POST') return await route.fallback();
      let body = {}; try { body = JSON.parse(req.postData() || '{}'); } catch (_) { /* not json */ }
      if (!/^cleanup\./.test(body.action || '')) return await route.fallback();
      events.push({ kind: 'data', action: body.action, session: body.session });
      return await json(route, { ok: true, removed: { sections: 0, brands: 0, occasions: 0, notes: 0 }, kept: 0 });
    } catch (_) { /* the page is gone */ }
  });
  await page.route('**/api/editor-logout', async (route) => { try { events.push({ kind: 'logout' }); return await json(route, { ok: true }); } catch (_) { /* gone */ } });
  await page.route('**/api/editor', async (route) => {
    try {
      const req = route.request();
      if (req.method() !== 'POST') return await route.fallback();
      let body = {}; try { body = JSON.parse(req.postData() || '{}'); } catch (_) { /* not json */ }
      if (body.action !== 'save') return await route.fallback();
      events.push({ kind: 'save' });
      return await json(route, { ok: true, revision: 'b'.repeat(40), committed: false });
    } catch (_) { /* gone */ }
  });
  /* a clean, published design, so that the editor is not read-only and a save can be confirmed */
  await page.route('**/api/editor?action=state', (r) => r.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ ok: true, revision: 'a'.repeat(40), design: { version: 1 }, branch: 'main' }) }));
  await page.route('**/design/home.json', (r) => r.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ version: 1 }) }));
  page.on('dialog', async (d) => { dialogs.push(d.message()); try { if (opts.dismiss) await d.dismiss(); else await d.accept(); } catch (_) { /* gone */ } });
  await page.goto(H.SITE + '/editor', { waitUntil: 'load' });
  await page.waitForFunction(() => /متصل بوضع التحرير/.test((document.getElementById('status') || {}).textContent || ''), null, { timeout: 30000 });
  return { context, page, events, dialogs };
}
const sessionOf = (page) => page.evaluate(() => window.elanLiveEditorBridge.getState().session);
const dataEvents = (events, action) => events.filter((e) => e.kind === 'data' && e.action === action);

test('the editor page has a session id of its own, a fresh one per page load', async () => {
  const a = await openEditor();
  try {
    const s = await sessionOf(a.page);
    assert.match(s, UUID, 'a UUID the server can accept');
  } finally { await a.context.close(); }
});

test('the exit button removes what this session created and never saved, BEFORE it logs out', async () => {
  const { context, page, events, dialogs } = await openEditor();
  try {
    const session = await sessionOf(page);
    await page.evaluate(() => window.elanLiveEditorBridge.request('element.create', { kind: 'text_block' }));   // something unsaved
    await page.waitForFunction(() => window.elanLiveEditorBridge.getState().dirty === true, null, { timeout: 8000 });
    await page.click('#editorLogout');
    await page.waitForTimeout(800);
    assert.ok(dialogs.some((m) => /هتتشال/.test(m)), 'the question says that what was created and not saved goes: ' + dialogs.join(' | '));
    const order = events.map((e) => e.kind + (e.action ? ':' + e.action : ''));
    const d = order.indexOf('data:cleanup.discard'), l = order.indexOf('logout');
    assert.ok(d !== -1 && l !== -1 && d < l, 'discard first, then logout: ' + order.join(', '));
    assert.equal(dataEvents(events, 'cleanup.discard')[0].session, session, 'for this very session');
    assert.equal(dataEvents(events, 'cleanup.keep').length, 0, 'and nothing was kept');
  } finally { await context.close(); }
});

test('saying no to the exit question changes nothing: no discard, no logout', async () => {
  const { context, page, events } = await openEditor({ dismiss: true });
  try {
    await page.evaluate(() => window.elanLiveEditorBridge.request('element.create', { kind: 'text_block' }));
    await page.waitForFunction(() => window.elanLiveEditorBridge.getState().dirty === true, null, { timeout: 8000 });
    await page.click('#editorLogout');
    await page.waitForTimeout(600);
    assert.deepEqual(events.map((e) => e.kind), [], 'nothing was sent: ' + JSON.stringify(events));
  } finally { await context.close(); }
});

test('closing the browser or the tab removes what this session created and never saved, once', async () => {
  const { context, page, events } = await openEditor();
  try {
    const session = await sessionOf(page);
    await page.evaluate(() => window.dispatchEvent(new PageTransitionEvent('pagehide', { persisted: true })));
    await page.waitForTimeout(300);
    assert.equal(dataEvents(events, 'cleanup.discard').length, 0, 'a page that goes into the back/forward cache may come back: nothing is removed');
    await page.evaluate(() => window.dispatchEvent(new PageTransitionEvent('pagehide', { persisted: false })));
    await page.waitForTimeout(500);
    const sent = dataEvents(events, 'cleanup.discard');
    assert.equal(sent.length, 1, 'the page is really gone: one discard ' + JSON.stringify(events));
    assert.equal(sent[0].session, session);
    await page.evaluate(() => window.dispatchEvent(new PageTransitionEvent('pagehide', { persisted: false })));
    await page.waitForTimeout(300);
    assert.equal(dataEvents(events, 'cleanup.discard').length, 1, 'and never twice');
  } finally { await context.close(); }
});

test('a successful save makes what the session created permanent, and sends no discard', async () => {
  const { context, page, events } = await openEditor();
  try {
    const session = await sessionOf(page);
    await page.evaluate(() => window.elanLiveEditorBridge.request('element.create', { kind: 'text_block' }));
    await page.waitForFunction(() => window.elanLiveEditorBridge.getState().dirty === true, null, { timeout: 8000 });
    await page.click('#save');
    await page.waitForFunction(() => /مفيش تغيير جديد للحفظ|تعذّر|فشل/.test(document.getElementById('status').textContent), null, { timeout: 15000 }).catch(async () => { throw new Error('status: ' + (await page.evaluate(() => document.getElementById('status').textContent)) + ' events: ' + JSON.stringify(events)); });
    const order = events.map((e) => e.kind + (e.action ? ':' + e.action : ''));
    assert.ok(order.indexOf('save') !== -1 && order.indexOf('data:cleanup.keep') > order.indexOf('save'), 'the keep follows the save: ' + order.join(', '));
    assert.equal(dataEvents(events, 'cleanup.keep')[0].session, session, 'for this session');
    assert.equal(dataEvents(events, 'cleanup.discard').length, 0, 'a save never discards');
    // leaving after the save: the discard that goes out finds nothing left to remove on the server (tested on the real database), the page does not need to know
    assert.ok(dataEvents(events, 'cleanup.run').length <= 1, 'the abandoned-tab sweep is asked for at most once per save');
  } finally { await context.close(); }
});
