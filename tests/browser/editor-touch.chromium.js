'use strict';
/* Touch in the editor, in a real Chromium with a real touch screen (CDP touch events), on a phone-sized window.
   2026-11-08 (owner's full sweep): a finger swiping along a card strip («شريط العرض») did not scroll it inside the editor, though it does on
   the plain storefront. Two causes: the first pointer-move of a card drag set the strip to overflow:visible (nothing left to pan), and when the
   browser then took the finger for a scroll (pointercancel) the editor called a full repaint, which re-renders the page and sends the strip
   back to its start. A mouse drag still frees the card from the strip; a touch swipe scrolls. */
const test = require('node:test');
const assert = require('node:assert/strict');
const H = require('./harness.js');

const pw = H.loadPlaywright();
const PHONE = H.WIDTHS.find((w) => w.name === 'phone') || H.WIDTHS[0];

let browser, server;
test.before(async () => {
  server = await H.startServer();
  browser = await pw.chromium.launch({ args: ['--no-sandbox'] });
});
test.after(async () => { if (browser) await browser.close(); if (server) await server.stop(); });

async function openEditorFrame(touch) {
  const origNew = browser.newContext.bind(browser);
  const { context } = await (async () => {
    browser.newContext = (o) => origNew(Object.assign({}, o, touch ? { hasTouch: true, isMobile: true } : {}));
    try { return await H.openContext(browser, server, PHONE); } finally { browser.newContext = origNew; }
  })();
  await H.loginAsOwner(context, server);
  const page = await context.newPage();
  await page.goto(H.SITE + '/editor', { waitUntil: 'load' });
  let frame = null;
  for (let i = 0; i < 80 && !frame; i++) {
    frame = page.frames().find((f) => f.url().includes('elan_editor=1')) || null;
    if (frame && !(await frame.evaluate(() => !!(window.ElanEditMode && document.getElementById('hero'))).catch(() => false))) frame = null;
    if (!frame) await page.waitForTimeout(250);
  }
  assert.ok(frame, 'the editor opened the storefront preview');
  await page.waitForTimeout(1500);
  return { context, page, frame };
}

/* Brings the first strip that really overflows to the middle of the screen; returns where a finger/mouse can touch a card of it. */
async function aimAtStrip(frame) {
  return frame.evaluate(() => {
    const cand = Array.from(document.querySelectorAll('.strip')).find((e) => e.scrollWidth > e.clientWidth + 30 && e.querySelector('.card'));
    window.__stripIdx = Array.from(document.querySelectorAll('.strip')).indexOf(cand);
    document.documentElement.style.scrollBehavior = 'auto';
    window.scrollTo({ top: Math.max(0, scrollY + cand.getBoundingClientRect().top - 260), behavior: 'instant' });
    const c = cand.querySelector('.card').getBoundingClientRect();
    return { x: c.left + c.width / 2, y: c.top + c.height / 2, w: innerWidth };
  });
}
const stripState = (frame) => frame.evaluate(() => {
  const st = document.querySelectorAll('.strip')[window.__stripIdx], card = st && st.querySelector('.card');
  return { connected: !!st, scroll: st ? Math.round(st.scrollLeft) : null, overflow: st ? (st.style.overflow || '') : null, cardStyle: card ? (card.getAttribute('style') || '') : null };
});

test('touch: swiping along a card strip inside the editor scrolls it, without re-rendering the page or leaving the card shifted', async () => {
  const { context, page, frame } = await openEditorFrame(true);
  try {
    const at = await aimAtStrip(frame);
    await page.waitForTimeout(500);
    await frame.evaluate(() => { window.__renders = 0; const r = window.render; window.render = function () { window.__renders++; return r.apply(this, arguments); }; });
    const box = await page.locator('iframe').first().boundingBox(), k = box.width / at.w;
    const X = box.x + at.x * k, Y = box.y + at.y * k;
    const cdp = await context.newCDPSession(page);
    const touch = (type, x, y) => cdp.send('Input.dispatchTouchEvent', { type, touchPoints: type === 'touchEnd' ? [] : [{ x, y, id: 1 }] });
    const before = await stripState(frame);
    await touch('touchStart', X, Y);
    for (let i = 1; i <= 20; i++) { await page.waitForTimeout(16); await touch('touchMove', X + 14 * i, Y); }
    await touch('touchEnd');
    await page.waitForTimeout(900);
    const after = await stripState(frame);
    assert.ok(after.connected, 'the strip is still the one on the page');
    assert.ok(Math.abs(after.scroll - before.scroll) >= 100, 'the strip moved sideways under the finger (was ' + before.scroll + ', now ' + after.scroll + ')');
    assert.equal(await frame.evaluate(() => window.__renders), 0, 'a swipe that only scrolls must not re-render the page (it resets the strip)');
    assert.equal(after.overflow, '', 'the strip keeps its own overflow during a finger swipe');
    assert.equal(after.cardStyle, before.cardStyle, 'the card is back exactly as it was after the browser took the swipe for a scroll');
  } finally { await context.close(); }
});

test('mouse: dragging a card out of its strip still frees it from the strip while the button is down, and restores the strip after', async () => {
  const { context, page, frame } = await openEditorFrame(false);
  try {
    const at = await aimAtStrip(frame);
    await page.waitForTimeout(500);
    const box = await page.locator('iframe').first().boundingBox(), k = box.width / at.w;
    const X = box.x + at.x * k, Y = box.y + at.y * k;
    await page.mouse.move(X, Y); await page.mouse.down();
    await page.mouse.move(X + 14, Y + 6, { steps: 3 }); await page.mouse.move(X + 40, Y + 12, { steps: 4 });
    const during = await stripState(frame);
    assert.equal(during.overflow, 'visible', 'while the card is dragged the strip does not clip it');
    await page.mouse.up(); await page.waitForTimeout(400);
    const after = await stripState(frame);
    assert.notEqual(after.overflow, 'visible', 'after the drop the strip clips and scrolls again');
  } finally { await context.close(); }
});
