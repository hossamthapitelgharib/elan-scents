'use strict';
/* The editor's creation panels and library window, in a real Chromium, against the owner's ORIGINAL editor file.
   tests/fixtures/elan-original-panels-golden.json holds what the original file draws for each panel (scripts/capture-original-panels.js
   writes it); here the live editor opens the same panels with the same lists and every drawn element must sit in the same place
   with the same type, colours, spacing and borders (the owner asked for the original's colours too, 2026-11-02). */
const test = require('node:test');
const assert = require('node:assert/strict');
const H = require('./harness.js');
const F = require('./panel-fidelity.js');
const golden = require('../fixtures/elan-original-panels-golden.json');

const pw = H.loadPlaywright();
const WINDOW = { width: 1366, height: 860 };            // what the original was captured in
const REVISION = 'a'.repeat(64);

let browser, server;
test.before(async () => { server = await H.startServer(); browser = await pw.chromium.launch({ args: ['--no-sandbox'] }); });
test.after(async () => { if (browser) await browser.close(); if (server) await server.stop(); });

/* The editor, with /api/editor-data answered from the same lists the original panels were given. */
async function openEditor(size, cloud) {
  const { context, problems } = await H.openContext(browser, server, size || WINDOW);
  const calls = [], deleted = [], uploads = [], saves = [];
  const lib = cloud || { media: [], archive: [], savedElements: [] };
  await context.route('**/api/editor-data*', async (route) => {
    const request = route.request(); let body = {};
    try { body = JSON.parse(request.postData() || '{}'); } catch (_) { body = {}; }
    const action = body.action || new URL(request.url()).searchParams.get('action');
    calls.push(action);
    const json = (o) => route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(o) });
    if (action === 'options') return json({ ok: true, options: F.OPTIONS });
    if (action === 'perfumes') return json({ ok: true, rows: F.PERFUMES });
    if (action === 'library' && lib.fail) return json({ ok: false, error: 'سابابيس لا يردّ' });
    if (action === 'library') return json({ ok: true, library: { media: lib.media, archive: lib.archive, savedElements: lib.savedElements, revision: REVISION } });
    if (action === 'library.delete') {
      deleted.push({ kind: body.kind, id: body.id });
      const list = { archive: 'archive', saved: 'savedElements', media: 'media' }[body.kind];
      lib[list] = lib[list].filter((x) => x.id !== body.id);
      return json({ ok: true, kind: body.kind, id: body.id, file: body.kind === 'media' ? 'removed' : 'none', keptBecause: [], revision: REVISION });
    }
    if (action === 'library.save') {
      saves.push(body.library);
      (body.library.savedElements || []).forEach((row) => lib.savedElements.push(Object.assign({ id: '00000000-0000-4000-8000-00000000ff0' + lib.savedElements.length }, row)));
      return json({ ok: true, revision: REVISION });
    }
    return json({ ok: false, error: 'not_expected_in_this_test' });
  });
  await context.route('**/api/editor-upload', async (route) => {
    const request = route.request();
    uploads.push({ folder: request.headers()['x-media-category'] || null, type: request.headers()['content-type'] });
    await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ ok: true, url: 'https://sbgdtuqfrnfeggkwqtrw.supabase.co/storage/v1/object/public/site-media/uploads/2026/aaaaaaaaaaaaaaaaaaaa.png' }) });
  });
  await context.route('**/api/editor-media*', (route) => route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ ok: true, items: F.MEDIA.map((m) => ({ kind: m.kind, url: m.url, title: m.title })) }) }));
  await H.loginAsOwner(context, server);
  const errors = []; const page = await context.newPage(); H.watchErrors(page, errors);
  await page.goto(H.SITE + '/editor', { waitUntil: 'load' });
  let frame = null;
  for (let i = 0; i < 80 && !frame; i++) {
    frame = page.frames().find((f) => f.url().includes('elan_editor=1')) || null;
    if (frame && !(await frame.evaluate(() => !!(window.ElanEditMode && document.getElementById('hero'))).catch(() => false))) frame = null;
    if (!frame) await page.waitForTimeout(250);
  }
  assert.ok(frame, 'the platform loaded inside the editor');
  await page.waitForTimeout(1500);
  return { context, page, frame, errors, problems, calls, deleted, uploads, saves, lib };
}

/* Right click inside a section of the platform and read the tools menu. */
async function openMenu(page, frame) {
  const target = await frame.evaluate(() => {
    const e = window.ElanDesignLayer.elements().find((x) => x.kind === 'section' && x.id.startsWith('sec:') && x.el.getBoundingClientRect().height > 80);
    const top = e.el.getBoundingClientRect().top;
    document.documentElement.style.scrollBehavior = 'auto'; window.scrollTo({ top: Math.max(0, scrollY + top - 120), behavior: 'instant' });
    const r = e.el.getBoundingClientRect(); return { x: r.left + 30, y: r.top + 30 };
  });
  await page.waitForTimeout(300);
  const box = await page.locator('iframe').first().boundingBox();
  const k = box.width / 390;
  await page.mouse.click(box.x + target.x * k, box.y + target.y * k, { button: 'right' });
  await page.waitForTimeout(400);
}
async function chooseTool(page, frame, re) {
  await openMenu(page, frame);
  const labels = await page.evaluate(() => Array.from(document.getElementById('menu').children).map((b) => b.textContent));
  const at = labels.findIndex((t) => re.test(t));
  assert.ok(at >= 0, 'the menu has ' + re + ': ' + labels.join(' | '));
  await page.locator('#menu > *').nth(at).click();
  await page.waitForTimeout(900);
}
const closeDialogs = (page) => page.evaluate(() => document.querySelectorAll('dialog[open]').forEach((d) => d.close()));
const shape = (page, selector) => page.evaluate(F.describePanel, { selector, props: F.PROPS });
const isAi = (e) => /الذكاء الاصطناعي/.test(e.text);
/* The original's row under the library window's «إغلاق» (load from the cloud, sync, the AI button and the connection line) was removed
   on the owner's order: none of it did anything the window does not already do by itself. */
const libraryFiller = (name) => {
  const rows = golden.panels[name], close = rows.findIndex((e) => e.tag === 'button' && e.text === 'إغلاق');
  assert.ok(close > 0, name + ': the original has a close button');
  return (e) => rows.indexOf(e) > close ? 'tail' : isAi(e);
};
const isAiStacked = (e) => isAi(e) ? 'stack' : false;      // in the source dialog the AI choice is one of a stack of buttons
function same(live, name, drop, looseText) {
  assert.ok(live, name + ' is open');
  const problems = F.compare(live, golden.panels[name], { x: 4, w: 4, y: 2, h: 2 }, drop, looseText);
  assert.deepEqual(problems.slice(0, 12), [], name + ' differs from the original in ' + problems.length + ' places');
}

test('section panel: the same as the original (manual, automatic, with the timer)', async () => {
  const { context, page, frame, errors } = await openEditor();
  try {
    await chooseTool(page, frame, /إنشاء سيكشن/);
    const host = await page.evaluate(() => ({ inHost: !!document.querySelector('dialog.sectionPanelClean[open]'), inFrame: !!document.querySelector('iframe') }));
    assert.ok(host.inHost, 'the panel is a dialog of the editor window itself, not of the platform inside it');
    await page.waitForTimeout(500);
    same(await shape(page, 'dialog.sectionPanelClean[open]'), 'section-manual');
    await page.evaluate(() => { const s = document.querySelector('dialog.sectionPanelClean fieldset select'); s.value = 'automatic'; s.dispatchEvent(new Event('change')); });
    await page.waitForTimeout(400);
    same(await shape(page, 'dialog.sectionPanelClean[open]'), 'section-automatic');
    await page.evaluate(() => { const c = document.querySelector('dialog.sectionPanelClean .toggle input'); c.checked = true; c.dispatchEvent(new Event('change')); });
    await page.waitForTimeout(300);
    same(await shape(page, 'dialog.sectionPanelClean[open]'), 'section-automatic-timer');
    assert.deepEqual(errors, []);
  } finally { await context.close(); }
});

test('text format panel (font, colour, size): the same as the original', async () => {
  const { context, page, frame } = await openEditor();
  try {
    await chooseTool(page, frame, /تنسيق النص/);
    assert.ok(await page.evaluate(() => !!document.querySelector('#format[open]')), 'the format panel is open in the editor window');
    /* the panel shows the chosen element's own values: give every control the value the original's panel had. Only the colour boxes
       are told (their chips redraw on that); the preview is then redrawn once, as the original does when it opens. */
    await page.evaluate((controls) => {
      Array.from(document.querySelectorAll('#format input, #format select')).forEach((input, i) => {
        const c = controls[i]; if (!c) return;
        if (c.type === 'checkbox') input.checked = c.checked; else input.value = c.value;
        if (c.type === 'color') { input.dispatchEvent(new Event('input', { bubbles: true })); input.dispatchEvent(new Event('change', { bubbles: true })); }
      });
      if (typeof updatePanelPreview === 'function') updatePanelPreview();
    }, golden.formatControls);
    await page.waitForTimeout(300);
    same(await shape(page, '#format[open]'), 'format', null, ['Élan Scents']);
  } finally { await context.close(); }
});

test('perfume card panel: the same as the original', async () => {
  const { context, page, frame } = await openEditor();
  try {
    await chooseTool(page, frame, /إنشاء كارت عطر/);
    await page.waitForTimeout(500);
    same(await shape(page, 'dialog.sectionPanelClean[open]'), 'perfume-manual');
  } finally { await context.close(); }
});

test('brand card panel: the same as the original', async () => {
  const { context, page, frame } = await openEditor();
  try {
    await chooseTool(page, frame, /إنشاء كارت براند/);
    same(await shape(page, 'dialog[open]'), 'brand');
  } finally { await context.close(); }
});

test('store card panel: the same as the original', async () => {
  const { context, page, frame } = await openEditor();
  try {
    await chooseTool(page, frame, /إنشاء كارت متجر/);
    same(await shape(page, 'dialog[open]'), 'store');
  } finally { await context.close(); }
});

test('the picture / video source dialog (banner and image creation): the same as the original, without the AI choice', async () => {
  const { context, page, frame, errors } = await openEditor();
  try {
    await chooseTool(page, frame, /إنشاء صورة أو فيديو/);
    await page.waitForSelector('#elanMediaDlg[open]');
    same(await shape(page, '#elanMediaDlg[open]'), 'media-source', isAiStacked);
    await page.locator('#elanMediaDlg button', { hasText: 'من مكتبة سابابيس' }).click(); await page.waitForTimeout(700);
    same(await shape(page, '#elanMediaDlg[open]'), 'media-library', isAiStacked);
    assert.deepEqual(errors, []);
  } finally { await context.close(); }
});

test('library window: the same layout as the original, with the cloud library behind it and nothing from the AI', async () => {
  const { context, page, calls, errors } = await openEditor();
  try {
    /* the original was captured on an empty page: this platform's own archived blocks would add an "others" folder */
    await page.evaluate(() => { const live = window.elanLiveEditorBridge, real = live.request; live.request = (action, payload) => action === 'page.getState' ? Promise.resolve({ archive: [], design: { blocks: [] }, selected: null }) : real.call(live, action, payload); });
    await page.click('#library'); await page.waitForTimeout(900);
    assert.ok(calls.includes('library'), 'the window reads the cloud library');
    same(await shape(page, '#libraryDialog'), 'library-archive-section', libraryFiller('library-archive-section'));
    await page.locator('#libraryDialog button', { hasText: 'الميديا والعناصر المحفوظة' }).first().click(); await page.waitForTimeout(250);
    await page.locator('#libraryDialog button', { hasText: 'صورة' }).first().click(); await page.waitForTimeout(250);
    same(await shape(page, '#libraryDialog'), 'library-saved-image', libraryFiller('library-saved-image'));
    const words = await page.evaluate(() => document.getElementById('libraryDialog').innerText);
    assert.ok(!/الذكاء الاصطناعي|AI/.test(words), 'no AI picture or video in the library window: ' + words);
    assert.deepEqual(errors, []);
  } finally { await context.close(); }
});

/* The original window gives every row a red «حذف نهائي» beside its action. The cloud library deletes the row in Supabase after a confirm. */
test('library window rows: each has a red «حذف نهائي» like the original, and it deletes just that cloud row after a confirm', async () => {
  const IMG = 'https://sbgdtuqfrnfeggkwqtrw.supabase.co/storage/v1/object/public/site-media/x.png';
  const ids = { a1: '00000000-0000-4000-8000-000000000001', a2: '00000000-0000-4000-8000-000000000002', s1: '00000000-0000-4000-8000-000000000003', m1: '00000000-0000-4000-8000-000000000004' };
  const cloud = {
    archive: [{ id: ids.a1, element_id: 'el1', kind: 'banner', name: 'بانر العروض', payload: { type: 'banner', text: 'عروض' } }, { id: ids.a2, element_id: 'el2', kind: 'banner', name: 'بانر ثان', payload: { type: 'banner', text: 'ثان' } }],
    savedElements: [{ id: ids.s1, name: 'عنوان محفوظ', kind: 'text', category: 'text', payload: { type: 'text', text: 'نص' } }],
    media: [{ id: ids.m1, name: 'صورة 1.png', src: IMG, type: 'image', category: 'image' }]
  };
  const { context, page, deleted, errors } = await openEditor(undefined, cloud);
  try {
    await page.evaluate(() => { const live = window.elanLiveEditorBridge, real = live.request; live.request = (action, payload) => action === 'page.getState' ? Promise.resolve({ archive: [{ id: 'page-only', name: 'عنصر على الصفحة فقط' }], design: { blocks: [] }, selected: null }) : real.call(live, action, payload); });
    await page.click('#library'); await page.waitForTimeout(900);
    const rows = () => page.evaluate(() => Array.from(document.querySelectorAll('#libraryDialog [data-lib-list] > div')).map((r) => {
      const b = Array.from(r.querySelectorAll('button')).map((x) => ({ text: x.textContent, disabled: x.disabled, color: getComputedStyle(x).color }));
      return { name: r.querySelector('span').textContent, buttons: b };
    }));
    const del = (row) => row.buttons.find((b) => b.text === 'حذف نهائي');

    await page.locator('#libraryDialog button', { hasText: /^بانر/ }).first().click(); await page.waitForTimeout(250);
    let list = await rows();
    assert.deepEqual(list.map((r) => r.name), ['بانر العروض', 'بانر ثان']);
    list.forEach((r) => { assert.ok(del(r), r.name + ' has «حذف نهائي»'); assert.equal(del(r).color, 'rgb(160, 34, 34)', 'in the original red'); assert.equal(del(r).disabled, false); });
    assert.deepEqual(list[0].buttons.map((b) => b.text), ['استرجاع', 'حذف نهائي'], 'the action first, then the delete, as in the original');

    /* refusing the confirm deletes nothing */
    page.once('dialog', (d) => d.dismiss());
    await page.locator('#libraryDialog [data-lib-action="delete"]').first().click(); await page.waitForTimeout(400);
    assert.deepEqual(deleted, [], 'a cancelled confirm sends nothing');

    /* accepting deletes that one row, and the window shows the rest */
    let asked = '';
    page.once('dialog', (d) => { asked = d.message(); d.accept(); });
    await page.locator('#libraryDialog [data-lib-action="delete"]').first().click(); await page.waitForTimeout(900);
    assert.match(asked, /نهائيًا/); assert.match(asked, /لن تُحذف/);
    assert.deepEqual(deleted, [{ kind: 'archive', id: ids.a1 }]);
    list = await rows();
    assert.deepEqual(list.map((r) => r.name), ['بانر ثان'], 'only the asked row went');
    assert.match(await page.locator('#libraryDialog [data-cloud-message]').innerText(), /حُذف العنصر المؤرشف نهائيًا/);

    /* saved elements and media rows carry it too */
    await page.locator('#libraryDialog button', { hasText: 'الميديا والعناصر المحفوظة' }).first().click(); await page.waitForTimeout(250);
    await page.locator('#libraryDialog button', { hasText: /^نص \(/ }).first().click(); await page.waitForTimeout(250);
    list = await rows(); assert.equal(list.length, 1); assert.ok(del(list[0]));
    await page.locator('#libraryDialog button', { hasText: /^صورة \(/ }).first().click(); await page.waitForTimeout(250);
    page.once('dialog', (d) => d.accept());
    await page.locator('#libraryDialog [data-lib-action="delete"]').first().click(); await page.waitForTimeout(900);
    assert.deepEqual(deleted[1], { kind: 'media', id: ids.m1 });
    assert.match(await page.locator('#libraryDialog [data-cloud-message]').innerText(), /ومن التخزين/, 'a media delete says the file went from storage too');
    assert.deepEqual(await rows(), []);

    /* an element that is only archived on the page has no cloud row: the button is there, off */
    await page.locator('#libraryDialog button', { hasText: 'العناصر المحذوفة' }).first().click(); await page.waitForTimeout(250);
    assert.equal(await page.locator('#libraryDialog [data-lib-cat="other"]').count(), 1, 'the page-only element sits in the others folder');
    await page.locator('#libraryDialog [data-lib-cat="other"]').click(); await page.waitForTimeout(250);
    const pageOnly = (await rows()).find((r) => r.name === 'عنصر على الصفحة فقط');
    assert.ok(pageOnly, 'the page-only archived element is listed');
    assert.equal(del(pageOnly).disabled, true, 'a page-only archived element cannot be deleted from the cloud');
    assert.deepEqual(errors, []);
  } finally { await context.close(); }
});

/* The owner: what is shown must be of use to him. The window reads the cloud when it opens and again after each action, so it has no
   «load from the cloud» button, no always-on «sync» button and no sentence of counts. A button appears only when it has work to do. */
test('library window: nothing that is only filler; a retry button only when the cloud could not be read; a move button only for an old browser library', async () => {
  const cloud = { media: [], archive: [], savedElements: [] };
  const { context, page, saves, errors } = await openEditor(undefined, cloud);
  try {
    await page.click('#library'); await page.waitForTimeout(900);
    const dialog = page.locator('#libraryDialog');
    const words = await dialog.innerText();
    assert.ok(!/تحميل المكتبة من سابابيس|مزامنة التغييرات|تم تحميل المكتبة|وسائط: \d/.test(words), 'no load/sync buttons and no counts sentence: ' + words);
    assert.equal(await dialog.locator('[data-lib-action="load"], [data-lib-action="sync"], [data-lib-action="retry"]').count(), 0, 'no button without work to do');
    assert.equal(await dialog.locator('[data-cloud-message]:not([hidden])').count(), 0, 'no status line while nothing happened');
    assert.equal(await dialog.locator('[data-lib-local]').count(), 0, 'no old-library box when this browser holds none');

    /* the cloud cannot be read: the reason and one retry button; a retry loads it */
    cloud.fail = true;
    await page.evaluate(() => window.openLiveLibrary()); await page.waitForTimeout(700);
    assert.match(await dialog.locator('[data-cloud-message]').innerText(), /تعذر تحميل المكتبة: سابابيس لا يردّ/);
    assert.equal(await dialog.locator('[data-lib-action="retry"]').count(), 1, 'a retry button when the cloud could not be read');
    cloud.fail = false;
    await dialog.locator('[data-lib-action="retry"]').click(); await page.waitForTimeout(900);
    assert.equal(await dialog.locator('[data-lib-action="retry"]').count(), 0, 'the retry button goes once the library is loaded');
    assert.equal(await dialog.locator('[data-cloud-message]:not([hidden])').count(), 0, 'and so does the failure line');

    /* an old browser-only library that still has something to move: the box offers the move, and moving it is a merge-only save */
    await page.evaluate(() => localStorage.setItem('elan-fresh-editor-v1', JSON.stringify({ savedElements: [{ name: 'عنصر قديم', kind: 'text', type: 'text', text: 'نص قديم' }], archive: [], media: [] })));
    await page.evaluate(() => window.openLiveLibrary()); await page.waitForTimeout(900);
    assert.equal(await dialog.locator('[data-lib-local]').count(), 1, 'the old-library box shows while this browser holds one');
    const move = dialog.locator('[data-lib-local] [data-lib-action="sync"]');
    assert.equal(await move.count(), 1, 'the move button is in that box');
    assert.equal((await move.innerText()).trim(), 'نقلها إلى سابابيس');
    await move.click(); await page.waitForTimeout(1500);
    assert.ok(saves.length >= 1 && saves.some((x) => (x.savedElements || []).length), 'the old element was sent to the cloud');
    assert.match(await dialog.locator('[data-cloud-message]').innerText(), /نُقل \d+ عنصر إلى سابابيس/, 'and the outcome is told');
    assert.deepEqual(errors, []);
  } finally { await context.close(); }
});

/* The original window has «رفع ملف وحفظه في …» in every folder. Here a picture, a video or an element file uploaded from a folder is kept in that folder. */
test('library upload is in every folder, and what is uploaded lands in the folder it came from', async () => {
  const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==', 'base64');
  const { context, page, uploads, saves, lib, errors } = await openEditor(undefined, { media: [], archive: [], savedElements: [] });
  try {
    await page.evaluate(() => { const live = window.elanLiveEditorBridge, real = live.request; live.request = (action, payload) => action === 'page.getState' ? Promise.resolve({ archive: [], design: { blocks: [] }, selected: null }) : real.call(live, action, payload); });
    await page.click('#library'); await page.waitForTimeout(900);
    await page.locator('#libraryDialog button', { hasText: 'الميديا والعناصر المحفوظة' }).first().click(); await page.waitForTimeout(250);
    for (const key of ['section', 'brand', 'store', 'perfume', 'banner', 'text', 'hero', 'image', 'video', 'occasion', 'note', 'text_block']) {
      await page.locator('#libraryDialog [data-lib-cat="' + key + '"]').click(); await page.waitForTimeout(150);
      assert.equal(await page.locator('#libraryDialog [data-lib-action="upload"]').count(), 1, 'the folder ' + key + ' has the upload button');
      assert.match(await page.locator('#libraryDialog [data-lib-action="upload"]').innerText(), /^رفع ملف وحفظه في /);
    }
    /* a picture sent from «براند» */
    await page.locator('#libraryDialog [data-lib-cat="brand"]').click(); await page.waitForTimeout(150);
    await page.locator('#libraryDialog input[type="file"]').setInputFiles({ name: 'logo.png', mimeType: 'image/png', buffer: PNG });
    await page.waitForTimeout(1200);
    assert.deepEqual(uploads.map((u) => u.folder), ['brand'], 'the server is told the folder');
    assert.match(await page.locator('#libraryDialog [data-cloud-message]').innerText(), /داخل «براند»/);
    /* an element file from «بانر» is kept as a saved element of that folder */
    await page.locator('#libraryDialog [data-lib-cat="banner"]').click(); await page.waitForTimeout(150);
    const element = { format: 'elan-element-v1', element: { id: 'b1', type: 'banner', kind: 'banner', text: 'عرض' } };
    await page.locator('#libraryDialog input[type="file"]').setInputFiles({ name: 'عرض.json', mimeType: 'application/json', buffer: Buffer.from(JSON.stringify(element)) });
    await page.waitForTimeout(1200);
    assert.equal(saves.length, 1);
    assert.equal(saves[0].savedElements[0].category, 'banner');
    assert.equal(saves[0].savedElements[0].name, 'عرض');
    assert.deepEqual(saves[0].archive, []);
    assert.equal(lib.savedElements.length, 1);
    /* a file that is not an element file is refused and nothing is saved */
    await page.locator('#libraryDialog [data-lib-cat="banner"]').click(); await page.waitForTimeout(150);
    await page.locator('#libraryDialog input[type="file"]').setInputFiles({ name: 'x.json', mimeType: 'application/json', buffer: Buffer.from('{"hello":1}') });
    await page.waitForTimeout(800);
    assert.equal(saves.length, 1, 'nothing more was saved');
    assert.match(await page.locator('#libraryDialog [data-cloud-message]').innerText(), /مش ملف عنصر/);
    assert.deepEqual(errors, []);
  } finally { await context.close(); }
});

for (const width of [390, 411]) {
  test('phone window ' + width + 'px: the platform inside the editor fills the whole screen', async () => {
    const { context, page } = await openEditor({ width, height: 844 });
    try {
      const box = await page.locator('iframe').first().boundingBox();
      assert.ok(box.width >= width - 2 && box.width <= width + 2, 'the platform is ' + box.width + 'px wide in a ' + width + 'px window');
      assert.ok(box.x >= -1 && box.x <= 1, 'and starts at the left edge: ' + box.x);
    } finally { await context.close(); }
  });
}
