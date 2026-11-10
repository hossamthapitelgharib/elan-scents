'use strict';
/* Dragging the corner handle with Shift held keeps the shape of the element (owner suggestion, 2026-11-09). The rule is pure geometry. */
const test = require('node:test');
const assert = require('node:assert/strict');
const G = require('../editor/editor-geometry.js');

const ratio = (s) => s.w / s.h;

test('without Shift the corner is free: width and height follow the pointer on their own', () => {
  assert.deepEqual(G.resize(300, 100, 50, 10), { w: 350, h: 110 });
});

test('with Shift the shape stays: the side pulled further (in proportion to its own size) decides and the other follows', () => {
  // wider by 50% but taller by 10%: the width wins, so the height grows 50% too
  assert.deepEqual(G.resizeKeepingShape(300, 100, 150, 10), { w: 450, h: 150 });
  // taller by 100% and wider by 10%: the height wins
  assert.deepEqual(G.resizeKeepingShape(300, 100, 30, 100), { w: 600, h: 200 });
  // pulling back in works the same way
  assert.deepEqual(G.resizeKeepingShape(400, 200, -100, -10), { w: 300, h: 150 });
  // no movement, no change
  assert.deepEqual(G.resizeKeepingShape(321, 123, 0, 0), { w: 321, h: 123 });
});

test('the shape is kept (to the pixel rounding) for many drags', () => {
  for (const [w, h] of [[300, 250], [728, 90], [1080, 1920], [336, 280], [101, 77]]) {
    for (const dx of [-60, -7, 0, 13, 90, 400]) for (const dy of [-40, 0, 5, 60, 300]) {
      const s = G.resizeKeepingShape(w, h, dx, dy);
      assert.ok(s.w >= G.MIN_WIDTH && s.h >= G.MIN_HEIGHT && s.w <= G.MAX_SIZE && s.h <= G.MAX_SIZE, 'inside the limits: ' + JSON.stringify([w, h, dx, dy, s]));
      const tolerance = 0.5 / Math.min(s.w, s.h) * 2 + 0.01;   // rounding a side to a whole pixel moves the ratio by at most this
      assert.ok(Math.abs(ratio(s) / (w / h) - 1) <= tolerance + 1 / Math.min(s.w, s.h), 'shape kept: ' + JSON.stringify([w, h, dx, dy, s]));
    }
  }
});

test('with Shift a drag past a limit stops the whole element at that limit, it never squashes one side', () => {
  const small = G.resizeKeepingShape(400, 200, -390, -190);       // would be 10 x 10
  assert.ok(small.w >= G.MIN_WIDTH && small.h >= G.MIN_HEIGHT);
  assert.ok(Math.abs(ratio(small) - 2) < 0.05, 'still 2:1: ' + JSON.stringify(small));
  const huge = G.resizeKeepingShape(1000, 500, 9000, 9000);
  assert.ok(huge.w <= G.MAX_SIZE && huge.h <= G.MAX_SIZE);
  assert.deepEqual(huge, { w: 4000, h: 2000 }, 'the longer side meets the limit first and the shape stays');
  const tall = G.resizeKeepingShape(100, 400, 9000, 9000);
  assert.deepEqual(tall, { w: 1000, h: 4000 });
});

test('a shape too long to fit both limits, or a missing size, falls back to the free rule instead of failing', () => {
  assert.deepEqual(G.resizeKeepingShape(0, 0, 50, 50), G.resize(0, 0, 50, 50));
  assert.deepEqual(G.resizeKeepingShape(undefined, undefined, 10, 10), G.resize(undefined, undefined, 10, 10));
  const long = G.resizeKeepingShape(4000, 20, 100, 100);            // 200:1 cannot keep 40x30 and 4000 together
  assert.ok(long.w <= G.MAX_SIZE && long.h >= G.MIN_HEIGHT);
});

test('the page side uses it: Shift on a corner, the live size label, and a Shift press in the middle of a drag', () => {
  const fs = require('node:fs'), path = require('node:path');
  const src = fs.readFileSync(path.join(__dirname, '..', 'edit-mode.js'), 'utf8');
  assert.match(src, /Geometry\.resizeKeepingShape/);
  assert.match(src, /ev\.shiftKey/);
  assert.match(src, /class="eo-size"/);
  assert.match(src, /Geometry\.ratioName\(w, h\)/, 'the label names the common shape');
  assert.match(src, /addEventListener\('keydown', shiftChanged/);
  assert.match(src, /addEventListener\('keyup', shiftChanged/);
  assert.match(src, /function endGesture\(g\) \{\s*hideSize\(\);/, 'the label goes away when the drag ends');
});
