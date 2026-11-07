const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.resolve(__dirname, '..');
const editor = fs.readFileSync(path.join(root, 'editor/elan-editor.html'), 'utf8');
const catalog = fs.readFileSync(path.join(root, 'railway/editor-catalog.js'), 'utf8');

test('editor exposes the gender filter and the server accepts its canonical values', () => {
  assert.match(editor, /\['gender','النوع','genders'\]/);
  assert.match(catalog, /raw\.gender/);
  assert.match(catalog, /\['men', 'women', 'unisex'\]/);
});
