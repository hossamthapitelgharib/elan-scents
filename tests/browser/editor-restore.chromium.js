'use strict';
/* «استرجاع النسخة السابقة» (owner, 2026-11-08): a button of its own next to Save, and every button of the editor's header the same small size in one row.
   Real Chromium on the phone, tablet and laptop windows; the server answers (/api/editor) are stubbed, the click, the dialogs and the editor's reaction are real. */
const test = require('node:test');
const assert = require('node:assert/strict');
const H = require('./harness.js');

const pw = H.loadPlaywright();
const sha = (c) => c.repeat(40);

let browser, server;
test.before(async () => { server = await H.startServer(); browser = await pw.chromium.launch({ args: ['--no-sandbox'] }); });
test.after(async () => { if (browser) await browser.close(); if (server) await server.stop(); });

async function openEditor(size, answers) {
  const { context } = await H.openContext(browser, server, size);
  await H.loginAsOwner(context, server);
  const page = await context.newPage();
  const posted = [];
  // a request still in flight when the window is closed at the end of a test must not surface as an unhandled rejection
  await page.route('**/api/editor', async (route) => {
    try {
      const req = route.request();
      if (req.method() !== 'POST') return await route.fallback();
      let body = {}; try { body = JSON.parse(req.postData() || '{}'); } catch (_) { /* not json */ }
      posted.push(body);
      const answer = answers && answers[body.action];
      if (!answer) return await route.fallback();
      return await route.fulfill({ status: answer.status || 200, contentType: 'application/json', body: JSON.stringify(answer.body) });
    } catch (_) { /* the page is gone */ }
  });
  const dialogs = [];
  page.on('dialog', async (d) => { dialogs.push(d.message()); try { if (answers && answers.dismiss) await d.dismiss(); else await d.accept(); } catch (_) { /* the page is gone */ } });
  await page.goto(H.SITE + '/editor', { waitUntil: 'load' });
  await page.waitForFunction(() => /متصل بوضع التحرير/.test((document.getElementById('status') || {}).textContent || ''), null, { timeout: 30000 });
  return { context, page, posted, dialogs };
}
const statusText = (page) => page.evaluate(() => document.getElementById('status').textContent);

for (const size of H.WIDTHS) {
  test('header buttons on ' + size.name + ': six of the same small size in one row, the restore button between Save and the library with a look of its own', async () => {
    const { context, page } = await openEditor(size);
    try {
      const r = await page.evaluate(() => {
        const ids = ['undo', 'redo', 'save', 'restorePrev', 'library', 'editorLogout'];
        const boxes = ids.map((id) => { const b = document.getElementById(id), r = b.getBoundingClientRect(); return { id, top: Math.round(r.top), w: Math.round(r.width), h: Math.round(r.height), bg: getComputedStyle(b).backgroundColor, bw: getComputedStyle(b).borderTopStyle }; });
        const order = Array.from(document.querySelectorAll('#editorHeaderActions>button')).map((b) => b.id);
        return { boxes, order, label: document.querySelector('#restorePrev .lbl').textContent.trim(), aria: document.getElementById('restorePrev').getAttribute('aria-label'), overflowX: document.documentElement.scrollWidth > innerWidth };
      });
      assert.deepEqual(r.order, ['undo', 'redo', 'save', 'restorePrev', 'library', 'editorLogout'], 'restore sits right after Save');
      assert.ok(r.boxes.every((b) => Math.abs(b.top - r.boxes[0].top) <= 2), 'one row: ' + JSON.stringify(r.boxes));
      assert.ok(r.boxes.every((b) => Math.abs(b.w - r.boxes[0].w) <= 2 && b.h === r.boxes[0].h), 'the same size: ' + JSON.stringify(r.boxes));
      assert.ok(r.boxes[0].h <= 40 && r.boxes[0].w <= 60, 'small: ' + r.boxes[0].w + 'x' + r.boxes[0].h);
      const restore = r.boxes[3];
      assert.ok(r.boxes.filter((b) => b.id !== 'restorePrev').every((b) => b.bg !== restore.bg), 'its own colour');
      assert.equal(restore.bw, 'dashed', 'and its own border');
      assert.equal(r.label, 'استرجاع النسخة السابقة');
      assert.equal(r.aria, 'استرجاع النسخة السابقة');
      assert.equal(r.overflowX, false, 'the page does not scroll sideways because of the row');
    } finally { await context.close(); }
  });
}

test('restore: it names the previous version, asks, then writes it and waits for the site to publish it', async () => {
  const { context, page, posted, dialogs } = await openEditor(H.WIDTHS[0], {
    previous: { body: { ok: true, current: { revision: sha('1') }, previous: { commit: sha('2'), date: '2026-11-07T09:00:00Z', message: 'design: update home page (editor)' }, branch: 'main' } },
    restore: { body: { ok: true, committed: true, revision: sha('3'), commit: sha('4'), restoredFrom: { commit: sha('2') } } },
    status: { body: { ok: true, published: true, revision: sha('3') } }
  });
  try {
    await page.click('#restorePrev');
    await page.waitForFunction(() => /تم النشر على الموقع/.test(document.getElementById('status').textContent), null, { timeout: 30000 });
    const asked = dialogs.find((m) => /هرجّع الموقع لنسخة/.test(m));
    assert.ok(asked && /2026|٢٠٢٦/.test(asked), 'the question shows the date of the version: ' + asked);
    assert.match(asked, /تاني بترجّعها/, 'and says that pressing it again brings back the replaced version');
    const sent = posted.filter((b) => b.action === 'restore')[0];
    assert.ok(sent, 'the restore request was sent');
    assert.equal(sent.restoreFrom, sha('2'));
    assert.equal(sent.expectedRevision, sha('1'), 'what the server named is what is restored, from the file state it showed');
    assert.match(sent.requestId, /^[A-Za-z0-9_-]{8,64}$/);
    assert.ok(posted.some((b) => b.action === 'status' && b.revision === sha('3')), 'it waits for the site to serve the restored file');
  } finally { await context.close(); }
});

test('restore: saying no, and having no earlier version, write nothing', async () => {
  let r = await openEditor(H.WIDTHS[0], {
    dismiss: true,
    previous: { body: { ok: true, current: { revision: sha('1') }, previous: { commit: sha('2'), date: '2026-11-07T09:00:00Z', message: 'x' } } }
  });
  try {
    await r.page.click('#restorePrev');
    await r.page.waitForFunction(() => /اتلغى الاسترجاع/.test(document.getElementById('status').textContent), null, { timeout: 15000 });
    assert.ok(!r.posted.some((b) => b.action === 'restore'), 'cancelled: nothing written');
  } finally { await r.context.close(); }
  r = await openEditor(H.WIDTHS[0], { previous: { status: 404, body: { ok: false, error: 'no_previous_version' } } });
  try {
    await r.page.click('#restorePrev');
    await r.page.waitForFunction(() => /مفيش نسخة سابقة/.test(document.getElementById('status').textContent), null, { timeout: 15000 });
    assert.ok(!r.posted.some((b) => b.action === 'restore'));
    assert.ok(!(await statusText(r.page)).includes('undefined'));
  } finally { await r.context.close(); }
});
