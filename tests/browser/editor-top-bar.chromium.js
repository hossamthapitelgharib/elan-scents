'use strict';
/* The scrolling bar at the very top of every page is an element of the editor (owner, 2026-11-08: "let me control the top bar from the editor, but not the header").
   Real Chromium, real editor: it can be selected by a click, its words edited and drawn again as a marquee, its colour and size changed, and hidden (the header
   under it then goes up); undo brings it back. The header and its buttons stay what they were: not editable elements. */
const test = require('node:test');
const assert = require('node:assert/strict');
const H = require('./harness.js');

const pw = H.loadPlaywright();
const LAPTOP = H.WIDTHS.find((w) => w.name === 'laptop') || H.WIDTHS[H.WIDTHS.length - 1];
const PHONE = H.WIDTHS.find((w) => w.name === 'phone') || H.WIDTHS[0];

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
    if (frame && !(await frame.evaluate(() => !!(window.ElanEditMode && document.getElementById('bar'))).catch(() => false))) frame = null;
    if (!frame) await page.waitForTimeout(250);
  }
  assert.ok(frame, 'the editor opened the storefront preview');
  await page.waitForTimeout(1500);
  return { context, page, frame };
}
const barState = (frame) => frame.evaluate(() => {
  const bar = document.getElementById('bar'), inner = document.getElementById('barT'), header = document.querySelector('header');
  const cs = getComputedStyle(inner);
  return { display: getComputedStyle(bar).display, text: inner.textContent, anim: cs.animationName, fill: cs.webkitTextFillColor, size: getComputedStyle(bar).fontSize,
    headerTop: Math.round(header.getBoundingClientRect().top), editable: inner.getAttribute('contenteditable') };
});

test('the top bar is an element: a click selects it, and the header is not an element', async () => {
  const { context, page, frame } = await openEditor(LAPTOP);
  try {
    const r = await frame.evaluate(() => {
      const els = window.ElanDesignLayer.elements(), bar = els.find((e) => e.id === 'top:bar'), hd = document.querySelector('header');
      const b = document.getElementById('bar').getBoundingClientRect();
      return { has: !!bar, kind: bar && bar.kind, header: els.some((e) => e.el === hd || hd.contains(e.el)), x: b.left + b.width / 2, y: b.top + b.height / 2, w: innerWidth };
    });
    assert.ok(r.has && r.kind === 'top-bar', 'the bar is listed as an element');
    assert.equal(r.header, false, 'nothing of the header is an element');
    const box = await page.locator('iframe').first().boundingBox(), k = box.width / r.w;
    await page.mouse.click(box.x + r.x * k, box.y + r.y * k);
    await page.waitForTimeout(400);
    const sel = await frame.evaluate(() => { const s = window.ElanEditMode.state().selected; return s && s.id; });
    assert.equal(sel, 'top:bar', 'clicking the bar selects the bar (it used to select the hero)');
  } finally { await context.close(); }
});

test('the bar: edit the words, colour, size, hide and undo', async () => {
  const { context, page, frame } = await openEditor(LAPTOP);
  try {
    const before = await barState(frame);
    assert.ok(before.anim && before.anim !== 'none', 'the bar scrolls');
    // the words
    await frame.evaluate(async () => { await window.ElanEditMode.execute('element.setText', { elementId: 'top:bar', text: 'عروض الأسبوع' }); });
    await page.waitForTimeout(500);
    let s = await barState(frame);
    assert.ok(s.text.startsWith('عروض الأسبوع') && s.text.split('عروض الأسبوع').length === 5, 'the new words are drawn four times in a row, as the site draws its own: ' + s.text);
    assert.notEqual(s.anim, 'none', 'and the bar still scrolls');
    // colour and size
    await frame.evaluate(async () => { await window.ElanEditMode.execute('element.format', { elementId: 'top:bar', style: { color: '#ff0000', fontSize: 20 } }); });
    await page.waitForTimeout(400);
    s = await barState(frame);
    assert.equal(s.fill, 'rgb(255, 0, 0)', 'the colour reaches the words (they are a gradient text of their own): ' + s.fill);
    assert.equal(s.size, '20px', 'the size is drawn even where the page fixes it with !important');
    // hide
    await frame.evaluate(async () => { await window.ElanEditMode.execute('element.archive', { elementId: 'top:bar' }); });
    await page.waitForTimeout(400);
    s = await barState(frame);
    assert.equal(s.display, 'none', 'the bar is hidden');
    assert.equal(s.headerTop, 0, 'the header goes up to the top when the bar is hidden');
    // undo three times (hide, style, text) brings the site's own bar back
    for (let i = 0; i < 3; i++) await frame.evaluate(async () => { await window.ElanEditMode.execute('history.undo', {}); });
    await page.waitForTimeout(500);
    s = await barState(frame);
    assert.equal(s.text, before.text, 'undo brings the site\'s own words back');
    assert.equal(s.display, before.display);
    assert.equal(s.headerTop, before.headerTop, 'the header is back where it was');
  } finally { await context.close(); }
});

test('the bar, on a phone: double-click edits one still copy of the words; Enter draws them as a marquee again; Esc leaves the site\'s own words', async () => {
  const { context, page, frame } = await openEditor(PHONE);
  try {
    const at = await frame.evaluate(() => { const b = document.getElementById('bar').getBoundingClientRect(); return { x: b.left + b.width / 2, y: b.top + b.height / 2, w: innerWidth, site: window.D.ar.bar.replace(/[\s•]+$/, ''), lang: document.documentElement.lang }; });
    const box = await page.locator('iframe').first().boundingBox(), k = box.width / at.w;
    const X = box.x + at.x * k, Y = box.y + at.y * k;
    const original = (await barState(frame)).text;
    // Esc: nothing changes
    await page.mouse.dblclick(X, Y); await page.waitForTimeout(400);
    let s = await barState(frame);
    assert.ok(s.editable, 'the words are open for typing');
    assert.equal(s.anim, 'none', 'and stand still while they are typed');
    assert.equal(s.text, at.site, 'one copy of the words, without the marquee\'s repeats or its bullet');
    await page.keyboard.press('Escape'); await page.waitForTimeout(300);
    s = await barState(frame);
    assert.equal(s.text, original, 'Esc leaves the words as they were');
    assert.notEqual(s.anim, 'none', 'and the bar scrolls again');
    assert.equal(s.editable, null);
    // Enter: the new words, as a marquee
    await page.mouse.dblclick(X, Y); await page.waitForTimeout(300);
    await page.keyboard.type('خصم نهاية الأسبوع'); await page.keyboard.press('Enter'); await page.waitForTimeout(500);
    s = await barState(frame);
    assert.equal(s.text.split('خصم نهاية الأسبوع').length, 5, 'the new words are drawn four times: ' + s.text);
    assert.notEqual(s.anim, 'none', 'and the bar scrolls again');
    assert.equal(s.editable, null);
  } finally { await context.close(); }
});
