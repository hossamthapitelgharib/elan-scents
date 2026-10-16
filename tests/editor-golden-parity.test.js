const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const geometry = require('../editor/editor-geometry.js');
const golden = require('./fixtures/elan-original-tools-golden.json');

const root = path.resolve(__dirname, '..');

test('editor drag follows the original recorded mouse delta and clamps at the top-left edge', () => {
  const drag = golden.mouse.drag;
  const moved = geometry.move(
    { left: drag.before.x, top: drag.before.y },
    { dx: 0, dy: 0 },
    { x: drag.dx, y: drag.dy }
  );
  assert.equal(moved.dx, drag.dx);
  assert.equal(moved.dy, drag.dy);

  const clamped = geometry.move(
    { left: 100, top: 100 },
    { dx: 0, dy: 0 },
    { x: -500, y: -500 }
  );
  assert.equal(100 + clamped.dx, 0);
  assert.equal(100 + clamped.dy, 0);
});

test('editor resize keeps the original 40 by 30 minimum and stays within schema limits', () => {
  const tooSmall = geometry.resize(40, 30, -250, -250);
  assert.equal(tooSmall.w, 40);
  assert.equal(tooSmall.h, 30);

  const tooLarge = geometry.resize(3900, 3900, 500, 500);
  assert.equal(tooLarge.w, geometry.MAX_SIZE);
  assert.equal(tooLarge.h, geometry.MAX_SIZE);
  assert.equal(golden.mouse.handle_box.w, 13);
  assert.equal(golden.mouse.handle_box.h, 13);
});

test('live editor loads and uses the tested geometry with direct pointer dragging', () => {
  const editMode = fs.readFileSync(path.join(root, 'edit-mode.js'), 'utf8');
  const boot = fs.readFileSync(path.join(root, 'edit-boot.js'), 'utf8');
  assert.match(boot, /\/editor\/editor-geometry\.js/);
  assert.ok(boot.indexOf('/editor/editor-geometry.js') < boot.indexOf('/edit-mode.js'));
  assert.match(editMode, /var e, mode = 'move'/);
  assert.match(editMode, /Geometry\.move\(g\.r, g\.b/);
  assert.match(editMode, /Geometry\.resize\(g\.r\.width, g\.r\.height/);
  assert.doesNotMatch(editMode, /registerTool\(\{ id: 'move'/);
  assert.ok(editMode.includes(String.raw`replace(/\r\n?/g, '\n')`));
});
