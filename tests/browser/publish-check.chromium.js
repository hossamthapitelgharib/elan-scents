'use strict';
/* Owner, 2026-11-13: before publishing, the editor warns about a smart section that would show NO perfumes to visitors
   (a brand card whose brand has no products, a store card for a store that is not active, a filter nothing matches), in plain words,
   and lets the owner decide. What is judged is the page itself: the cards a section really holds, so the warning can never disagree with what a visitor sees. */
const test = require('node:test');
const assert = require('node:assert/strict');
const H = require('./harness.js');

const pw = H.loadPlaywright();
let browser, server;
test.before(async () => { server = await H.startServer(); browser = await pw.chromium.launch({ args: ['--no-sandbox'] }); });
test.after(async () => { if (browser) await browser.close(); if (server) await server.stop(); });

const smart = (id, ref) => ({ id, type: 'smart', ref });
const DESIGN = { version: 1, order: ['brands', 'offers', 'x-brand', 'x-store', 'x-plain', 'x-hid', 'new', 'cats', 'master', 'notes', 'occ', 'soon', 'stores'], blocks: [smart('x-brand', 'x-r1'), smart('x-store', 'x-r2'), smart('x-plain', 'x-r3'), smart('x-hid', 'x-r4')] };
const DEFS = {
  'x-r1': { id: 'u1', name: 'عطور ديور', selection_mode: 'auto', filters: { brand: 'Dior' } },
  'x-r2': { id: 'u2', name: 'متجر جديد', selection_mode: 'auto', filters: { store: '11111111-1111-4111-8111-111111111111' } },
  'x-r3': { id: 'u3', name: 'سيكشن عادي', selection_mode: 'auto', filters: { occ: 'wedding' } },
  'x-r4': { id: 'u4', name: 'مخفي', selection_mode: 'auto', filters: { brand: 'Gone' } }
};

async function openEditor() {
  const { context } = await H.openContext(browser, server, H.WIDTHS[0]);
  await H.loginAsOwner(context, server);
  const page = await context.newPage();
  await page.route('**/design/home.json', (r) => r.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(DESIGN) }));
  await page.route('**/api/editor?action=state', (r) => r.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ ok: true, revision: 'a'.repeat(40), design: DESIGN, branch: 'main' }) }));
  const cors = { 'access-control-allow-origin': '*', 'access-control-allow-headers': '*', 'access-control-allow-methods': '*', 'access-control-expose-headers': '*' };
  await page.route('**/rest/v1/editor_sections*', (r) => {
    if (r.request().method() === 'OPTIONS') return r.fulfill({ status: 204, headers: cors });
    const ref = decodeURIComponent((/element_id=eq\.([^&]+)/.exec(r.request().url()) || [])[1] || '');
    return r.fulfill({ status: 200, contentType: 'application/json', headers: cors, body: JSON.stringify(DEFS[ref] ? [DEFS[ref]] : []) });
  });
  await page.goto(H.SITE + '/editor', { waitUntil: 'load' });
  let frame = null;
  for (let i = 0; i < 80 && !frame; i++) {
    frame = page.frames().find((f) => f.url().includes('elan_editor=1')) || null;
    if (frame && !(await frame.evaluate(() => !!(window.ElanEditMode && document.querySelector('.elan-smart .section-perfume-grid'))).catch(() => false))) frame = null;
    if (!frame) await page.waitForTimeout(250);
  }
  assert.ok(frame, 'the editor opened the storefront preview with the smart sections painted');
  await page.waitForTimeout(500);
  return { context, page, frame };
}
const check = (frame) => frame.evaluate(async () => JSON.parse(JSON.stringify(await window.ElanEditMode.execute('page.check', {}))));

test('an empty brand card, an empty store card and an empty filtered section are reported with their own reason; a hidden one is not', async () => {
  const { context, frame } = await openEditor();
  try {
    await frame.evaluate(() => { const n = document.querySelector('[data-elan-id="x-hid"]'); n.style.setProperty('display', 'none', 'important'); });
    const r = await check(frame);
    const byId = Object.fromEntries(r.warnings.map((w) => [w.id, w]));
    assert.deepEqual(Object.keys(byId).sort(), ['x-brand', 'x-plain', 'x-store'], 'three warnings, the hidden section is left alone: ' + JSON.stringify(r));
    assert.equal(byId['x-brand'].name, 'عطور ديور');
    assert.match(byId['x-brand'].text, /البراند ده مفيهوش منتجات/);
    assert.match(byId['x-store'].text, /المتجر ده/);
    assert.match(byId['x-store'].text, /مش مفعّل/);
    assert.match(byId['x-plain'].text, /الفلتر/);
  } finally { await context.close(); }
});

test('a section that holds cards is not reported, and one that is still loading is never called empty', async () => {
  const { context, frame } = await openEditor();
  try {
    await frame.evaluate(() => {
      document.querySelector('[data-elan-id="x-brand"] .section-perfume-grid').appendChild(document.createElement('div'));
      document.querySelector('[data-elan-id="x-store"] .section-perfume-grid').remove();
    });
    const ids = (await check(frame)).warnings.map((w) => w.id).sort();
    assert.deepEqual(ids, ['x-hid', 'x-plain'], 'only the sections that are really empty: ' + ids);
  } finally { await context.close(); }
});

test('the save button asks before publishing, lists the sections by name, and publishes nothing when the owner says no', async () => {
  const { context, page } = await openEditor();
  const saves = [];
  await page.route('**/api/editor', (r) => { const b = r.request().postDataJSON && r.request().postDataJSON(); if (b && b.action === 'save') saves.push(b); return r.continue(); });
  try {
    const dialogs = [];
    page.on('dialog', async (d) => { dialogs.push(d.message()); await d.dismiss(); });
    await page.click('#save');
    for (let i = 0; i < 40 && !dialogs.length; i++) await page.waitForTimeout(150);
    assert.equal(dialogs.length, 1, 'one question before the publish');
    assert.match(dialogs[0], /عطور ديور/);
    assert.match(dialogs[0], /البراند ده مفيهوش منتجات/);
    assert.match(dialogs[0], /أكمّل الرفع برضه/);
    await page.waitForTimeout(600);
    assert.equal(saves.length, 0, 'saying no sent nothing to the server');
    assert.match(await page.locator('#status').innerText().catch(() => ''), /اتلغى الرفع|الرفع/, 'the status says the publish was cancelled');
  } finally { await context.close(); }
});

test('on the plain storefront a smart section (brand card, store card, new section) really appears for a visitor', async () => {
  /* 2026-11-14: two functions both named `paint` made every smart section throw and be removed, so none ever reached a visitor. */
  const { context } = await H.openContext(browser, server, H.WIDTHS[0]);
  const page = await context.newPage();
  const cors = { 'access-control-allow-origin': '*', 'access-control-allow-headers': '*', 'access-control-allow-methods': '*', 'access-control-expose-headers': '*' };
  await page.route('**/design/home.json', (r) => r.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(DESIGN) }));
  await page.route('**/rest/v1/editor_sections*', (r) => {
    if (r.request().method() === 'OPTIONS') return r.fulfill({ status: 204, headers: cors });
    const ref = decodeURIComponent((/element_id=eq\.([^&]+)/.exec(r.request().url()) || [])[1] || '');
    return r.fulfill({ status: 200, contentType: 'application/json', headers: cors, body: JSON.stringify(DEFS[ref] ? [DEFS[ref]] : []) });
  });
  try {
    await page.goto(H.SITE + '/', { waitUntil: 'load' });
    await page.waitForSelector('.elan-smart .section-perfume-grid', { timeout: 15000 });
    const names = await page.$$eval('.elan-smart h3', (n) => n.map((x) => x.textContent));
    assert.ok(names.includes('عطور ديور'), 'the brand card is on the page with its own name: ' + names);
    assert.equal(names.length, 4, 'all four smart sections are painted: ' + names);
  } finally { await context.close(); }
});
