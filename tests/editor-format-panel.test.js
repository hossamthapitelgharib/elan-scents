const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const ED = require('../design-schema.js');
const read = (f) => fs.readFileSync(path.join(__dirname, '..', f), 'utf8');

test('every font offered in the format panel is accepted by the design schema', () => {
  const page = read('editor/elan-editor.html');
  const m = page.match(/const fontDefinitions=(\[\[.*?\]\]);/s);
  assert.ok(m, 'font list present');
  const names = [...m[1].matchAll(/'([^']+)'/g)].map((x) => x[1]).filter((n) => !['عربي', 'إنجليزي', 'خطوط الجهاز'].includes(n));
  assert.ok(names.length >= 25);
  for (const n of names) assert.ok(ED.FONTS.includes(n), n + ' must be a valid design font');
  const ok = ED.normalize({ version: 1, edits: { all: { 'about:p1': { style: { fontFamily: 'Cairo' } } } } }, { strict: true });
  assert.equal(ok.ok, true);
});

test('format apply only sends what the owner changed and opens with the real values', () => {
  const page = read('editor/elan-editor.html');
  assert.match(page, /liveFormatInit/);
  assert.match(page, /if\(col!==init\.color\)style\.color=col/);
  assert.match(page, /if\(bgv!==init\.background\)style\.background=bgv/);
  assert.doesNotMatch(page, /const fonts=\['Tahoma','Arial','Georgia','Times New Roman','Verdana'\];const style/);
  assert.match(read('edit-mode.js'), /,\\s\*0\\\)\$\/\.test\(c\) \? '' :/);
});

test('the storefront loads an extra web font only when a saved design uses it', () => {
  const layer = read('design-layer.js');
  assert.match(layer, /function ensureFont\(name\)/);
  assert.match(layer, /ED\.WEB_FONTS\.indexOf\(name\) === -1/);
});

test('the library button opens the archive and image library in live mode', () => {
  const page = read('editor/elan-editor.html');
  assert.match(page, /\['library',\(\)=>openLiveLibrary\(\)\]/);
  assert.match(page, /runLive\('archive\.restore'/);
});

test('a click only selects; the open chip enters a page and coming back restores the spot', () => {
  const edit = read('edit-mode.js');
  assert.match(edit, /class="eo-open"/);
  assert.match(edit, /if \(g\.mode === 'click'\) return;/);
  assert.match(edit, /trail\.push\(\{ y: Math\.round\(scrollY\), id: e\.id, depth: depthNow\(\) \}\)/);
  assert.match(edit, /function restoreFrom\(point\)/);
  assert.match(edit, /tagEl\.textContent = e\.name \|\| e\.id/);
});
