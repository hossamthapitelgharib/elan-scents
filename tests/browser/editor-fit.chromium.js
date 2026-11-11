'use strict';
/* Owner, 2026-11-11, in real Chromium and the real editor:
   1. the hero takes «أبعاد العناصر» and the stepped corner drag like every other element;
   2. a picture or a video in an element that is resized is shown whole (never cut, never stretched) and fills the whole frame: what the frame's shape leaves over is the same
      picture blurred, and «نفس شكل الصورة» makes the frame the picture's own shape, so nothing is left over;
   3. when an element's size changes everything around it moves aside by itself (the page lays itself out again), also inside a grid. */
const test = require('node:test');
const assert = require('node:assert/strict');
const H = require('./harness.js');
const G = require('../../editor/editor-geometry.js');

const pw = H.loadPlaywright();
const PHONE = H.WIDTHS.find((w) => w.name === 'phone') || H.WIDTHS[0];
const LAPTOP = H.WIDTHS.find((w) => w.name === 'laptop') || H.WIDTHS[H.WIDTHS.length - 1];
const PICTURE = 'https://sbgdtuqfrnfeggkwqtrw.supabase.co/storage/v1/object/public/site-media/fit-2to1.png';

let browser, server;
test.before(async () => { server = await H.startServer(); browser = await pw.chromium.launch({ args: ['--no-sandbox'] }); });
test.after(async () => { if (browser) await browser.close(); if (server) await server.stop(); });

async function openEditor(size) {
  const { context } = await H.openContext(browser, server, size);
  await H.loginAsOwner(context, server);
  const page = await context.newPage();
  await page.goto(H.SITE + '/editor', { waitUntil: 'load' });
  let frame = null;
  for (let i = 0; i < 80 && !frame; i++) {
    frame = page.frames().find((f) => f.url().includes('elan_editor=1')) || null;
    if (frame && !(await frame.evaluate(() => !!(window.ElanEditMode && window.ElanEditTools && document.getElementById('bar'))).catch(() => false))) frame = null;
    if (!frame) await page.waitForTimeout(250);
  }
  assert.ok(frame, 'the editor opened the storefront preview');
  await page.waitForTimeout(1500);
  return { context, page, frame };
}
/* a picture twice as wide as it is tall (400x200), drawn in the page and served for the library address */
async function servePicture(context, page) {
  const b64 = await page.evaluate(() => { const c = document.createElement('canvas'); c.width = 400; c.height = 200; const g = c.getContext('2d'); g.fillStyle = '#c8962a'; g.fillRect(0, 0, 400, 200); g.fillStyle = '#29251c'; g.fillRect(20, 20, 360, 160); return c.toDataURL('image/png').split(',')[1]; });
  await context.route('**/storage/v1/object/public/site-media/fit-2to1.png', (route) => route.fulfill({ status: 200, contentType: 'image/png', body: Buffer.from(b64, 'base64') }));
}
async function openMenu(page, frame, id) {
  const tools = await frame.evaluate((elementId) => { const info = elementId ? window.ElanEditMode.state().selected : null; return window.ElanEditTools.menu(info); }, id || null);
  await page.evaluate(({ tools: list, elementId }) => { showLiveMenu({ element: elementId ? { id: elementId, tools: list } : null, tools: list, x: 60, y: 120 }); }, { tools, elementId: id || null });
  return tools;
}
const select = (frame, id) => frame.evaluate(async (elementId) => { await window.ElanEditMode.execute('element.select', { elementId }); }, id);
const menuItem = (page, text) => page.locator('#menu button', { hasText: text });
const chooser = (page) => page.locator('#elanSizeDlg');
const shapeButton = (page, ratio) => page.locator('#elanSizeDlg .grid button').filter({ has: page.locator('.dim', { hasText: new RegExp('^' + ratio + '$') }) });
async function chooseShape(page, frame, id, ratio) {
  await select(frame, id); await openMenu(page, frame, id);
  await menuItem(page, 'أبعاد العناصر').click();
  await chooser(page).waitFor({ state: 'visible', timeout: 10000 });
  if (ratio === 'same') await page.locator('#elanSizeDlg button.same').click(); else if (ratio === 'auto') await page.locator('#elanSizeDlg button.auto').click(); else await shapeButton(page, ratio).click();
  await chooser(page).waitFor({ state: 'detached', timeout: 10000 });
  await page.waitForTimeout(500);
}
const rectOf = (frame, sel) => frame.evaluate((s) => { const r = document.querySelector(s).getBoundingClientRect(); return { left: r.left, top: r.top, right: r.right, bottom: r.bottom, w: r.width, h: r.height }; }, sel);
const savedOf = (frame, id) => frame.evaluate((elementId) => { const st = window.ElanEditMode.state(), e = (st.design.edits || {})[st.device]; return e && e[elementId] ? JSON.parse(JSON.stringify(e[elementId])) : null; }, id);

test('the hero takes «أبعاد العناصر»: it becomes the chosen shape (the stylesheet no longer holds its height) and everything under it moves up; automatic gives its own size back (phone)', async () => {
  const { context, page, frame } = await openEditor(PHONE);
  try {
    const hero0 = await rectOf(frame, '#hero'), intro0 = await rectOf(frame, '#intro');
    assert.ok(Math.abs(intro0.top - hero0.bottom) < 40, 'the title sits right under the hero: ' + JSON.stringify([hero0, intro0]));
    await chooseShape(page, frame, 'hero', '1:1');
    const sq = await rectOf(frame, '#hero'), intro1 = await rectOf(frame, '#intro');
    assert.ok(Math.abs(sq.w - sq.h) <= 1, 'a square hero: ' + JSON.stringify(sq));
    assert.ok(Math.abs(sq.w - hero0.w) <= 1, 'with the width it had');
    assert.ok(intro1.top < intro0.top - 100 && Math.abs(intro1.top - sq.bottom) < 40, 'the title moved up with it: ' + JSON.stringify([intro0.top, intro1.top, sq.bottom]));
    await chooseShape(page, frame, 'hero', '16:9');
    const wide = await rectOf(frame, '#hero');
    assert.ok(Math.abs(wide.h - wide.w * 9 / 16) <= 1.5 && wide.h < 420, 'a 16:9 band, shorter than the stylesheet\'s 420px minimum: ' + JSON.stringify(wide));
    await chooseShape(page, frame, 'hero', 'auto');
    const back = await rectOf(frame, '#hero');
    assert.ok(Math.abs(back.h - hero0.h) <= 1, 'the hero\'s own height is back: ' + JSON.stringify([back, hero0]));
    assert.equal(await savedOf(frame, 'hero'), null, 'and nothing stays saved for it');
  } finally { await context.close(); }
});

test('the hero goes by the saved relative sizes with the corner handle too: the handle sits on the corner that moves (bottom-left on an Arabic page), pulling gives a named size and the hero keeps its shape (phone)', async () => {
  const { context, page, frame } = await openEditor(PHONE);
  try {
    await chooseShape(page, frame, 'hero', '16:9');
    await select(frame, 'hero');
    await page.waitForTimeout(500);
    const handle = await frame.evaluate(() => { const h = document.querySelector('.eo-h'), b = document.querySelector('.eo-box'), hr = h.getBoundingClientRect(), br = b.getBoundingClientRect(); return { attr: h.getAttribute('data-h'), onLeft: hr.left < br.left + br.width / 2, inScreen: hr.left >= 0 && hr.right <= innerWidth, x: hr.left + hr.width / 2, y: hr.top + hr.height / 2 }; });
    assert.equal(handle.attr, 'sw', 'the corner that moves');
    assert.ok(handle.onLeft && handle.inScreen, 'on the left, fully on the screen: ' + JSON.stringify(handle));
    const start = await rectOf(frame, '#hero'), intro0 = await rectOf(frame, '#intro');
    const box = await page.locator('iframe').first().boundingBox(), k = box.width / (await frame.evaluate(() => innerWidth));
    await page.mouse.move(box.x + handle.x * k, box.y + handle.y * k); await page.mouse.down();
    for (let x = 0; x <= 150; x += 5) await page.mouse.move(box.x + (handle.x + x) * k, box.y + (handle.y - x * start.h / start.w) * k);   // up and to the right: smaller
    await page.waitForTimeout(150);
    const label = await frame.evaluate(() => { const l = document.querySelector('.eo-size'); return { text: l.textContent, shown: getComputedStyle(l).display !== 'none' }; });
    const mid = await rectOf(frame, '#hero'), intro1 = await rectOf(frame, '#intro');
    await page.mouse.up(); await page.waitForTimeout(300);
    assert.ok(label.shown && G.STEPS.some((s) => label.text.startsWith(s.name)), 'a named saved size beside the pointer: ' + JSON.stringify(label));
    assert.ok(mid.w < start.w - 20 && Math.abs(mid.w / mid.h - start.w / start.h) < 0.06, 'smaller, same shape: ' + JSON.stringify([start, mid]));
    assert.ok(Math.abs(mid.right - start.right) <= 1, 'it stays where the page put it (the start side does not move): ' + JSON.stringify([start, mid]));
    assert.ok(Math.abs(intro1.top - mid.bottom) < 40 && intro1.top < intro0.top, 'and what is under it follows: ' + JSON.stringify([intro0.top, intro1.top, mid.bottom]));
    const done = await rectOf(frame, '#hero'), saved = await savedOf(frame, 'hero');
    assert.ok(Math.abs(saved.w - done.w) <= 1 && Math.abs(saved.h - done.h) <= 1, 'saved as it is: ' + JSON.stringify([saved, done]));
    assert.equal(await frame.evaluate(() => /elan-fit|transform/.test(document.getElementById('hero').getAttribute('style') || '')), false, 'nothing of the drag is left on the element but the saved size');
    await frame.evaluate(async () => { await window.ElanEditMode.execute('history.undo', {}); });
    await page.waitForTimeout(300);
    assert.ok(Math.abs((await rectOf(frame, '#hero')).w - start.w) <= 1, 'one undo step gives the size before the drag back');
  } finally { await context.close(); }
});

test('a picture in a resized element is shown whole and fills the frame: contain over its own blurred copy, and «نفس شكل الصورة» leaves nothing over (phone)', async () => {
  const { context, page, frame } = await openEditor(PHONE);
  try {
    await servePicture(context, page);
    const made = await frame.evaluate(async (src) => (await window.ElanEditMode.execute('element.create', { kind: 'image', src })).elementId, PICTURE);
    await page.waitForTimeout(900);
    const sel = '[data-elan-id="' + made + '"]';
    await frame.waitForFunction((s) => { const i = document.querySelector(s + ' img'); return i && i.complete && i.naturalWidth > 0; }, sel, { timeout: 10000 });
    const natural = await rectOf(frame, sel + ' img');
    assert.ok(Math.abs(natural.w / natural.h - 2) < 0.1, 'a 2:1 picture shown in its own shape to begin with: ' + JSON.stringify(natural));
    assert.equal(await frame.locator(sel + ' .elan-fit-back').count(), 0, 'nothing is added to an element that was not resized');

    await chooseShape(page, frame, made, '1:1');
    const sq = await rectOf(frame, sel);
    assert.ok(Math.abs(sq.w - sq.h) <= 1, 'the block is a square now: ' + JSON.stringify(sq));
    const fit = await frame.evaluate((s) => {
      const root = document.querySelector(s), img = root.querySelector('img'), back = root.querySelector('.elan-fit-back'), rr = root.getBoundingClientRect(), ir = img.getBoundingClientRect(), cs = getComputedStyle(img);
      const br = back && back.getBoundingClientRect(), bs = back && getComputedStyle(back);
      return { fit: cs.objectFit, imgW: ir.width, imgH: ir.height, frameW: rr.width, frameH: rr.height, imgLeft: ir.left - rr.left, imgTop: ir.top - rr.top,
        back: !!back, backUrl: back && back.style.backgroundImage, backBlur: bs && bs.filter, backSize: bs && bs.backgroundSize, backCovers: !!br && br.left <= rr.left && br.top <= rr.top && br.right >= rr.right && br.bottom >= rr.bottom,
        natW: img.naturalWidth, natH: img.naturalHeight, padding: getComputedStyle(root).paddingLeft };
    }, sel);
    assert.equal(fit.fit, 'contain', 'shown whole: not cut (cover) and not stretched (fill)');
    assert.ok(Math.abs(fit.imgW - fit.frameW) <= 1 && Math.abs(fit.imgH - fit.frameH) <= 1 && fit.padding === '0px', 'the picture\'s box is the whole frame: ' + JSON.stringify(fit));
    assert.ok(fit.back && fit.backUrl.includes('fit-2to1.png') && /blur/.test(fit.backBlur) && fit.backSize === 'cover' && fit.backCovers, 'and what its shape leaves over is the same picture blurred, covering the frame: ' + JSON.stringify(fit));
    const drawn = fit.imgW / (fit.natW / fit.natH);   // contain: the drawn height of a picture 2:1 in a square frame
    assert.ok(drawn < fit.imgH && Math.abs(drawn - fit.imgW / 2) <= 0.5, 'the drawn picture keeps its own 2:1 shape (' + Math.round(drawn) + ' high in a ' + Math.round(fit.frameH) + ' frame)');

    await chooseShape(page, frame, made, 'same');
    const same = await rectOf(frame, sel);
    assert.ok(Math.abs(same.w / same.h - 2) < 0.02, '«نفس شكل الصورة»: the frame is the picture\'s own shape: ' + JSON.stringify(same));
    assert.equal(await frame.locator(sel + ' .elan-fit-back').count(), 0, 'so nothing is left over and no blurred copy is needed');
    assert.equal(await frame.evaluate((s) => getComputedStyle(document.querySelector(s + ' img')).objectFit, sel), 'contain');

    await chooseShape(page, frame, made, 'auto');
    assert.equal(await frame.locator(sel + ' [class*="elan-fit"]').count(), 0, 'back to its own size: all of it is taken off again');
    assert.equal(await frame.evaluate((s) => document.querySelector(s).hasAttribute('data-elan-fit'), sel), false);
  } finally { await context.close(); }
});

test('«نفس شكل الصورة» is in the dimensions window only for an element that has a picture; a banner\'s background picture is fitted the same way (phone)', async () => {
  const { context, page, frame } = await openEditor(PHONE);
  try {
    await servePicture(context, page);
    const plain = await frame.evaluate(async () => (await window.ElanEditMode.execute('element.create', { kind: 'text_block' })).elementId);
    await select(frame, plain); await openMenu(page, frame, plain);
    await menuItem(page, 'أبعاد العناصر').click();
    await chooser(page).waitFor({ state: 'visible', timeout: 10000 });
    assert.equal(await page.locator('#elanSizeDlg button.same').count(), 0, 'a text block has no picture: no such choice');
    await page.keyboard.press('Escape');
    await chooser(page).waitFor({ state: 'detached', timeout: 10000 });

    const banner = await frame.evaluate(async (src) => (await window.ElanEditMode.execute('element.create', { kind: 'banner', image: src })).elementId, PICTURE);
    await frame.waitForFunction((id) => { const e = window.ElanDesignLayer.elements().find((x) => x.id === id); return !!(e && window.ElanDesignLayer.mediaSize(e)); }, banner, { timeout: 10000 });   // the picture's own size arrives with the picture
    await select(frame, banner); await openMenu(page, frame, banner);
    await menuItem(page, 'أبعاد العناصر').click();
    await chooser(page).waitFor({ state: 'visible', timeout: 10000 });
    assert.equal((await page.locator('#elanSizeDlg button.same').textContent()).trim(), 'نفس شكل الصورة');
    assert.equal(await page.locator('#elanSizeDlg .grid button').first().getAttribute('class').then((c) => /same/.test(c)), true, 'it is the first choice');
    await shapeButton(page, '4:3').click();
    await chooser(page).waitFor({ state: 'detached', timeout: 10000 });
    await page.waitForTimeout(500);
    const sel = '[data-elan-id="' + banner + '"]';
    const got = await frame.evaluate((s) => {
      const root = document.querySelector(s), front = root.querySelector('.elan-fit-front'), back = root.querySelector('.elan-fit-back'), cs = getComputedStyle(root);
      return { bg: cs.backgroundImage, front: !!front, frontSize: front && getComputedStyle(front).backgroundSize, back: !!back, frontUrl: front && front.style.backgroundImage };
    }, sel);
    assert.equal(got.bg, 'none', 'the cropped (cover) background of the banner is replaced');
    assert.ok(got.front && got.frontSize === 'contain' && got.frontUrl.includes('fit-2to1.png'), 'by the whole picture: ' + JSON.stringify(got));
    assert.ok(got.back, 'over a blurred copy that fills what the 4:3 frame leaves around a 2:1 picture');
    await chooseShape(page, frame, banner, 'same');
    const same = await rectOf(frame, sel);
    assert.ok(Math.abs(same.w / same.h - 2) < 0.02, 'the banner takes the picture\'s shape: ' + JSON.stringify(same));
    assert.equal(await frame.locator(sel + ' .elan-fit-back').count(), 0, 'and needs no blurred copy');
  } finally { await context.close(); }
});

test('a video in a resized element is shown whole and gets a blurred twin behind it only when the frame is not its shape', async () => {
  const { context, page, frame } = await openEditor(PHONE);
  try {
    const out = await frame.evaluate(async () => {
      const L = window.ElanDesignLayer, host = document.createElement('div');
      host.className = 'elan-block elan-image'; host.setAttribute('data-elan-id', 'probe-video');
      const v = document.createElement('video'); v.setAttribute('src', '/assets/none.mp4'); host.appendChild(v);
      document.getElementById('main').appendChild(host);
      Object.defineProperty(v, 'videoWidth', { value: 640 }); Object.defineProperty(v, 'videoHeight', { value: 360 }); Object.defineProperty(v, 'readyState', { value: 1 });
      const entry = { id: 'probe-video', kind: 'block', el: host };
      L.liveSize(entry, 300, 300);
      const mismatch = { fit: getComputedStyle(v).objectFit, twins: host.querySelectorAll('video.elan-fit-back').length, twinFit: getComputedStyle(host.querySelector('video.elan-fit-back') || v).objectFit };
      L.endLive(entry);
      const off = { twins: host.querySelectorAll('.elan-fit-back').length };
      L.liveSize(entry, 320, 180);
      const matched = { twins: host.querySelectorAll('video.elan-fit-back').length, fit: getComputedStyle(v).objectFit };
      L.endLive(entry); host.remove();
      return { mismatch, off, matched };
    });
    assert.equal(out.mismatch.fit, 'contain'); assert.equal(out.mismatch.twins, 1, 'a 16:9 video in a square frame has a blurred twin behind it'); assert.equal(out.mismatch.twinFit, 'cover');
    assert.equal(out.off.twins, 0, 'it is all taken off again');
    assert.equal(out.matched.twins, 0, 'a frame of the video\'s own shape needs none'); assert.equal(out.matched.fit, 'contain');
  } finally { await context.close(); }
});

test('the others make room: a card that gets bigger moves the cards after it in a strip, and in a grid it takes the cells it needs so the rest flow around it', async () => {
  const { context, page, frame } = await openEditor(PHONE);
  try {
    const out = await frame.evaluate(() => {
      const L = window.ElanDesignLayer, box = document.createElement('div');
      box.style.cssText = 'position:relative;z-index:5;background:#fff;padding:8px;direction:rtl';
      box.innerHTML = '<div class="strip" id="t-strip">' + [0, 1, 2].map((i) => '<div class="card" style="flex:none;width:100px;height:90px" id="s' + i + '">' + i + '</div>').join('') + '</div>' +
        '<div class="grid" id="t-grid" style="display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:10px;width:300px">' + [0, 1, 2, 3].map((i) => '<div class="card" style="width:auto;height:60px" id="g' + i + '">' + i + '</div>').join('') + '</div>';
      document.body.appendChild(box);
      const r = (id) => { const b = document.getElementById(id).getBoundingClientRect(); return { l: b.left, r: b.right, t: b.top, b: b.bottom, w: b.width, h: b.height }; };
      const overlap = (a, b) => a.l < b.r - 0.5 && b.l < a.r - 0.5 && a.t < b.b - 0.5 && b.t < a.b - 0.5;
      const s1 = r('s1'), s2 = r('s2');
      L.liveSize({ id: 's0', kind: 'card', el: document.getElementById('s0') }, 160, 120);
      const strip = { s0: r('s0'), s1: r('s1'), s2: r('s2'), moved: Math.abs(r('s1').l - s1.l) + Math.abs(r('s2').l - s2.l) };
      strip.overlap = overlap(strip.s0, strip.s1) || overlap(strip.s1, strip.s2) || overlap(strip.s0, strip.s2);
      const g1 = r('g1'), g3 = r('g3');
      L.liveSize({ id: 'g0', kind: 'card', el: document.getElementById('g0') }, 300, 120);
      const grid = { g0: r('g0'), g1: r('g1'), g2: r('g2'), g3: r('g3'), span: document.getElementById('g0').style.gridColumn, g1Before: g1, g3Before: g3 };
      grid.overlap = ['g0', 'g1', 'g2', 'g3'].some((a, i, all) => all.slice(i + 1).some((b) => overlap(grid[a], grid[b])));
      L.liveSize({ id: 'g0', kind: 'card', el: document.getElementById('g0') }, 120, 60);
      const small = { span: document.getElementById('g0').style.gridColumn };
      box.remove();
      return { strip, grid, small };
    });
    assert.equal(out.strip.overlap, false, 'no card in the strip lies over another: ' + JSON.stringify(out.strip));
    assert.ok(out.strip.moved >= 55, 'the two cards after the bigger one moved aside by itself (60px more room): ' + out.strip.moved);
    assert.equal(out.grid.span, 'span 2', 'a card as wide as the grid takes both cells');
    assert.equal(out.grid.overlap, false, 'nothing in the grid is covered: ' + JSON.stringify(out.grid));
    assert.ok(out.grid.g1.t >= out.grid.g0.b - 0.5, 'the card that was beside it goes on under it');
    assert.equal(out.small.span, 'span 1', 'a card that fits one cell takes one');
  } finally { await context.close(); }
});
