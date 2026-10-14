const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const read = (f) => fs.readFileSync(path.join(__dirname, '..', f), 'utf8');

test('about, contact and every footer part are editable elements with stable ids', () => {
  const layer = read('design-layer.js');
  for (const id of ["'about:p'", "'footer'", "'footer:logo'", "'footer:cols'", "'footer:bar'", "'footer:credit'", "'footer:h'", "'footer:l'", "'footer:b'", "'contact:title'"]) {
    assert.ok(layer.includes('add(' + id), id + ' must be registered');
  }
  assert.match(layer, /e\.kind === 'title' \|\| e\.kind === 'text-area'/);
});

test('edit mode knows the new element kinds', () => {
  const mode = read('edit-mode.js');
  assert.match(mode, /'text-area': 'text', group: 'section', 'image-el': 'image'/);
});
