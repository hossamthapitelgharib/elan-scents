'use strict';
/* Dragging the corner makes an element bigger or smaller by saved relative sizes only (owner, 2026-11-10): «ربع العرض», «نص العرض»… of the room the element has,
   with the element's own shape kept, resting on the saved size nearest to the pointer; no free sizes and no Shift. The rule is pure geometry. */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs'), path = require('node:path');
const G = require('../editor/editor-geometry.js');

test('the saved relative sizes are shares of the room, smallest first, each with a name and a width', () => {
  const steps = G.widthSteps(390);
  assert.deepEqual(steps.map((s) => s.pct), [15, 20, 25, 33, 40, 50, 60, 67, 75, 80, 90, 100], '10% would be 39 px, under the smallest an element may be, so it is left out');
  assert.deepEqual(steps.map((s) => s.w), [59, 78, 98, 129, 156, 195, 234, 261, 293, 312, 351, 390]);
  assert.equal(steps.find((s) => s.pct === 50).name, 'نص العرض'); assert.equal(steps.find((s) => s.pct === 100).name, 'العرض كامل'); assert.equal(steps.find((s) => s.pct === 25).name, 'ربع العرض');
  steps.forEach((s) => assert.ok(s.name && s.w >= G.MIN_WIDTH && s.w <= G.MAX_SIZE));
  for (let i = 1; i < steps.length; i++) assert.ok(steps[i].w > steps[i - 1].w, 'strictly growing');
  assert.deepEqual(G.widthSteps(0), []); assert.deepEqual(G.widthSteps(undefined), []);
  assert.ok(G.widthSteps(1200).some((s) => s.w === 600), 'a wider room has its own widths');
});

test('the corner rests on the saved size nearest to the pointer and keeps the element shape (never a free size)', () => {
  const at = (want) => G.snapStep(360, 250, 390, want);
  assert.deepEqual(at(200), { w: 195, h: 135, pct: 50, name: 'نص العرض' });
  assert.equal(at(190).pct, 50, 'near a step: on it'); assert.equal(at(214).pct, 50); assert.equal(at(216).pct, 60, 'past the middle to the next: the next one');
  assert.equal(at(5000).pct, 100, 'pulled far: the biggest, the whole width');
  assert.equal(at(1).pct, 15, 'pushed in far: the smallest');
  for (let want = 30; want < 600; want += 7) {
    const s = at(want), room = G.widthSteps(390).map((x) => x.w);
    assert.ok(room.includes(s.w), 'always a saved width: ' + want + ' -> ' + s.w);
    assert.ok(Math.abs(s.w / s.h - 360 / 250) < 0.06, 'the shape of the element stays: ' + JSON.stringify(s));
  }
  // pulling on goes up the ladder one saved size at a time and back down the same way
  const up = [], down = [];
  for (let want = 60; want <= 400; want += 4) { const p = at(want).pct; if (up[up.length - 1] !== p) up.push(p); }
  for (let want = 400; want >= 60; want -= 4) { const p = at(want).pct; if (down[down.length - 1] !== p) down.push(p); }
  assert.deepEqual(up, [15, 20, 25, 33, 40, 50, 60, 67, 75, 80, 90, 100], 'every saved size is reached on the way up: ' + up);
  assert.deepEqual(down, up.slice().reverse(), 'and on the way down');
});

test('a very flat or very tall element stays inside the limits on every step; nothing to step through leaves it as it is', () => {
  [[728, 90], [90, 728], [4000, 40], [300, 300]].forEach(([w, h]) => G.widthSteps(390).forEach((st) => {
    const s = G.snapStep(w, h, 390, st.w);
    if (s) assert.ok(s.w >= G.MIN_WIDTH && s.h >= G.MIN_HEIGHT && s.w <= G.MAX_SIZE && s.h <= G.MAX_SIZE, [w, h, st.w, JSON.stringify(s)].join(' '));
  }));
  assert.equal(G.snapStep(0, 0, 390, 100), null, 'an element with no size: nothing to step');
  assert.equal(G.snapStep(300, 200, 0, 100), null, 'no room known: nothing to step');
});

test('the page side uses it: saved sizes only, the size beside the pointer, no Shift handling', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'edit-mode.js'), 'utf8');
  assert.match(src, /Geometry\.snapStep\(/);
  assert.match(src, /class="eo-size"/);
  assert.match(src, /Geometry\.ratioName\(w, h\)/, 'the label names the common shape');
  assert.match(src, /function endGesture\(g\) \{\s*hideSize\(\);/, 'the label goes away when the drag ends');
  assert.doesNotMatch(src, /shiftChanged|resizeKeepingShape/, 'no Shift lock: the ladder keeps the shape by itself');
  assert.doesNotMatch(src, /Shift لتثبيت/);
});
