'use strict';
/* Editor speed budget (the last open "?" of docs/editor-spec-status.ar.md): how long the editor takes to open, what one edit costs on a page with many elements,
   and how smooth a drag is. Real Chromium, the real editor on the local store. The budgets are deliberately generous (a shared CI machine is slow and noisy):
   they catch an edit that became ten times slower, not a few milliseconds. The measured numbers are printed so they can be read in the run's log. */
const test = require('node:test');
const assert = require('node:assert/strict');
const H = require('./harness.js');

const pw = H.loadPlaywright();
const LAPTOP = H.WIDTHS.find((w) => w.name === 'laptop') || H.WIDTHS[H.WIDTHS.length - 1];
const PHONE = H.WIDTHS.find((w) => w.name === 'phone') || H.WIDTHS[0];
/* measured here (2026-11-09, 40 new elements): open 0.5-0.7 s, create 12 ms, move 10 ms, undo 11 ms, worst frame of a drag 22 ms; the budgets are a few times looser than a slow CI machine needs */
const BUDGET = { openMs: 6000, createAvgMs: 250, nudgeMs: 300, undoMs: 300, worstFrameMs: 400, blocks: 40 };

let browser, server;
test.before(async () => { server = await H.startServer(); browser = await pw.chromium.launch({ args: ['--no-sandbox'] }); });
test.after(async () => { if (browser) await browser.close(); if (server) await server.stop(); });

async function openEditor(size) {
  const { context } = await H.openContext(browser, server, size);
  await H.loginAsOwner(context, server);
  const page = await context.newPage();
  const started = Date.now();
  await page.goto(H.SITE + '/editor', { waitUntil: 'load' });
  let frame = null;
  for (let i = 0; i < 300 && !frame; i++) {
    frame = page.frames().find((f) => f.url().includes('elan_editor=1')) || null;
    if (frame && !(await frame.evaluate(() => !!(window.ElanEditMode && window.ElanEditTools && document.getElementById('bar') && window.ElanEditMode.state().design)).catch(() => false))) frame = null;
    if (!frame) await page.waitForTimeout(100);
  }
  assert.ok(frame, 'the editor opened the storefront preview with its design loaded');
  return { context, page, frame, openMs: Date.now() - started };
}

async function measure(size, label) {
  const { context, page, frame, openMs } = await openEditor(size);
  try {
    const out = await frame.evaluate(async (count) => {
      const mode = window.ElanEditMode, now = () => performance.now(), ids = [];
      const timeIt = async (fn) => { const t = now(); await fn(); return now() - t; };
      const creates = [];
      for (let i = 0; i < count; i++) {
        creates.push(await timeIt(async () => { const made = await mode.execute('tool.run', { id: 'create_text_block', size: { w: 300, h: 120 } }); ids.push(made.elementId); }));
      }
      const last = ids[ids.length - 1];
      const nudge = await timeIt(() => mode.execute('element.move', { elementId: last, dx: 12, dy: 8 }));
      const resize = await timeIt(() => mode.execute('element.resize', { elementId: last, size: { w: 336, h: 280 } }));
      const undo = await timeIt(() => mode.execute('history.undo', {}));
      return { creates, nudge, resize, undo, blocks: mode.state().design.blocks.length, painted: window.ElanDesignLayer.elements().length };
    }, BUDGET.blocks);
    /* a drag of the corner handle, frame by frame: the worst gap between two frames is what the owner feels as a stutter */
    await frame.evaluate(() => { const last = window.ElanEditMode.state().design.blocks.slice(-1)[0]; return window.ElanEditMode.execute('element.select', { elementId: last.id }); });
    await frame.evaluate(() => { const handleHost = document.querySelector('.eo-h'); handleHost.scrollIntoView({ block: 'center' }); });
    let handle = null;
    for (let i = 0; i < 40; i++) {
      const now = await frame.evaluate(() => { const r = document.querySelector('.eo-h').getBoundingClientRect(); return { x: r.left + r.width / 2, y: r.top + r.height / 2 }; });
      if (handle && Math.abs(now.y - handle.y) < 0.5 && Math.abs(now.x - handle.x) < 0.5) { handle = now; break; }
      handle = now; await page.waitForTimeout(150);
    }
    await frame.evaluate(() => { window.__gaps = []; let last = performance.now(); window.__raf = true; (function tick() { const t = performance.now(); window.__gaps.push(t - last); last = t; if (window.__raf) requestAnimationFrame(tick); })(); });
    const box = await page.locator('iframe').first().boundingBox(), k = box.width / (await frame.evaluate(() => innerWidth));
    await page.mouse.move(box.x + handle.x * k, box.y + handle.y * k);
    await page.mouse.down();
    await page.mouse.move(box.x + (handle.x + 60) * k, box.y + (handle.y + 40) * k, { steps: 30 });
    await page.mouse.up();
    await page.waitForTimeout(300);
    const gaps = await frame.evaluate(() => { window.__raf = false; return window.__gaps.slice(1); });
    const avg = (a) => a.reduce((s, x) => s + x, 0) / a.length;
    const result = { label, openMs, createAvgMs: Math.round(avg(out.creates)), createWorstMs: Math.round(Math.max(...out.creates)), nudgeMs: Math.round(out.nudge), resizeMs: Math.round(out.resize), undoMs: Math.round(out.undo), worstFrameMs: Math.round(Math.max(...gaps)), frames: gaps.length, blocks: out.blocks, painted: out.painted };
    console.log('PERF ' + JSON.stringify(result));
    return { result, out };
  } finally { await context.close(); }
}

for (const [label, size] of [['laptop', LAPTOP], ['phone', PHONE]]) {
  test('the editor stays fast with ' + BUDGET.blocks + ' new elements on a page (' + label + ')', async () => {
    const { result, out } = await measure(size, label);
    assert.ok(out.blocks >= BUDGET.blocks, 'all the elements were created: ' + out.blocks);
    assert.ok(out.painted >= BUDGET.blocks, 'and drawn on the page: ' + out.painted);
    assert.ok(result.openMs < BUDGET.openMs, 'opens in under ' + BUDGET.openMs + ' ms: ' + result.openMs);
    assert.ok(result.createAvgMs < BUDGET.createAvgMs, 'creating one element (even with many on the page) is under ' + BUDGET.createAvgMs + ' ms on average: ' + result.createAvgMs);
    assert.ok(result.nudgeMs < BUDGET.nudgeMs, 'moving one is under ' + BUDGET.nudgeMs + ' ms: ' + result.nudgeMs);
    assert.ok(result.undoMs < BUDGET.undoMs, 'undo is under ' + BUDGET.undoMs + ' ms: ' + result.undoMs);
    assert.ok(result.worstFrameMs < BUDGET.worstFrameMs, 'a drag never freezes the page for ' + BUDGET.worstFrameMs + ' ms: ' + result.worstFrameMs);
  });
}
