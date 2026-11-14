'use strict';
/* Two functions with the same name in one script scope silently replace each other: the LAST one wins everywhere, even for calls written above it.
   design-layer.js had `paint(root, name, list)` (smart sections) and `paint(entry, ed)` (edits). Every smart section call ran the edit painter, threw inside a promise,
   and the catch removed the section: new sections, brand cards and store cards never appeared to visitors (found 2026-11-14). Nothing failed loudly.
   This guard reads the browser scripts that wrap everything in one function and fails when a name is declared twice at that top level. */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.join(__dirname, '..');
const FILES = ['design-layer.js', 'design-schema.js', 'edit-mode.js', 'elan-host-bridge.js', 'edit-boot.js', 'editor/editor-geometry.js', 'app-core.js', 'app.js'];

function topLevelDuplicates(text) {
  const seen = new Map(); const dups = [];
  text.split('\n').forEach((line, i) => {
    const m = /^ {2}(?:async )?function\s+([A-Za-z_$][\w$]*)\s*\(/.exec(line);
    if (!m) return;
    if (seen.has(m[1])) dups.push(m[1] + ' (lines ' + seen.get(m[1]) + ' and ' + (i + 1) + ')'); else seen.set(m[1], i + 1);
  });
  return dups;
}

for (const f of FILES) {
  test('no function name is declared twice at the top of ' + f, () => {
    const file = path.join(root, f);
    if (!fs.existsSync(file)) return;
    assert.deepEqual(topLevelDuplicates(fs.readFileSync(file, 'utf8')), []);
  });
}

test('the guard itself catches the collision that hid every smart section', () => {
  const bad = 'x\n  function paint(root, name, list) {\n  }\n  function paint(entry, ed) {\n  }\n';
  assert.deepEqual(topLevelDuplicates(bad), ['paint (lines 2 and 4)']);
});
