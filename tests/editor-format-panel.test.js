const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const ED = require('../design-schema.js');
const { designBrowser, liveUI, plain } = require('./browser-fixture');
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
  assert.match(page, /liveFormatInitial/);
  assert.match(page, /if\(document\.getElementById\('color'\)\.value!==init\.color\)/);
  assert.match(page, /if\(document\.getElementById\('bg'\)\.value!==init\.bg\)/);
  assert.doesNotMatch(page, /const fonts=\['Tahoma','Arial','Georgia','Times New Roman','Verdana'\];const style/);
  const ui = liveUI();
  ui.context.selectedLive = { id: 'hero:magic', style: { fontFamily: 'Cairo', fontSize: 31, color: '#123456', background: '', align: 'center', effect: 'gold' } };
  ui.run('openLiveFormat()');
  assert.equal(ui.document.getElementById('font').value, 'Cairo');
  assert.equal(Number(ui.document.getElementById('size').value), 31);
  assert.equal(ui.document.getElementById('color').value, '#123456');
  assert.equal(ui.document.getElementById('bg').value, '#ffffff', 'transparent background has a plain white UI placeholder (never a cream one), not a saved colour');
  ui.document.getElementById('apply').click();
  assert.equal(ui.calls.length, 0, 'opening and applying without changes must not overwrite computed styles');
  ui.run('openLiveFormat()');
  ui.document.getElementById('color').value = '#abcdef';
  ui.document.getElementById('apply').click();
  assert.deepEqual(plain(ui.calls.at(-1)), ['element.format', { elementId: 'hero:magic', style: { color: '#abcdef' } }]);
  ui.run('openLiveFormat()');
  ui.document.getElementById('bg').value = '#010203';
  ui.document.getElementById('font').value = 'Inter';
  ui.document.getElementById('size').value = '999';
  ui.document.getElementById('apply').click();
  assert.deepEqual(plain(ui.calls.at(-1)[1].style), { fontSize: 120, background: '#010203', fontFamily: 'Inter' });
});

test('the storefront loads an extra web font only when a saved design uses it', () => {
  const layer = read('design-layer.js');
  assert.match(layer, /function loadFont\(name\)/);
  assert.match(layer, /ED\.WEB_FONTS\.indexOf\(name\) === -1/);
  const b = designBrowser();
  const fontLinks = () => b.document.head.querySelectorAll('link').filter((l) => String(l.href || '').startsWith('https://fonts.googleapis.com/'));
  b.layer.set({ version: 1 });
  assert.equal(fontLinks().length, 0);
  const design = { version: 1, edits: { all: { 'hero:magic': { style: { fontFamily: 'Cairo' } }, hero: { style: { fontFamily: 'Tahoma' } } } } };
  b.layer.set(design); b.layer.applyEdits();
  assert.equal(fontLinks().length, 1, 'load each used web font once; never load device fonts');
  assert.match(fontLinks()[0].href, /family=Cairo:wght@400;700/);
  assert.match(b.document.getElementById('hero').querySelector('.magic').style.fontFamily, /Cairo/);
});

test('the library button opens the archive and image library in live mode', async () => {
  const page = read('editor/elan-editor.html');
  assert.match(page, /\['library',\(\)=>runLive\('library\.open'\)\]/);
  assert.match(page, /result\?\.openLibrary===true/);
  assert.match(page, /runLive\('archive\.restore'/);
  const ui = liveUI();
  ui.document.getElementById('library').click();
  await new Promise((resolve) => setImmediate(resolve));
  const dlg = ui.document.getElementById('liveLibrary');
  assert.equal(dlg.open, true);
  assert.ok(ui.calls.some(([a]) => a === 'library.open'));
  const restore = dlg.querySelectorAll('button').find((b) => b.textContent.startsWith('استعادة:'));
  await restore.click();
  assert.ok(ui.calls.some(([a, p]) => a === 'archive.restore' && p.elementId === 'hero'));
  ui.context.selectedLive = { id: 'hero' };
  ui.window.elanPickMedia = async () => '/assets/hero-poster.jpg';
  await dlg.querySelectorAll('button').find((b) => b.textContent.startsWith('اختيار صورة')).click();
  assert.ok(ui.calls.some(([a, p]) => a === 'element.setMedia' && p.src === '/assets/hero-poster.jpg' && p.elementId === 'hero'));
  assert.equal(ui.document.getElementById('liveLibrary'), null, 'closed dialogs must not accumulate');
  const request = ui.context.requestLive;
  ui.context.requestLive = async (action, payload) => { if (action === 'element.setMedia') throw new Error('refused'); return request(action, payload); };
  await ui.run("runLive('library.open')");
  const failed = ui.document.getElementById('liveLibrary');
  await failed.querySelectorAll('button').find((b) => b.textContent.startsWith('اختيار صورة')).click();
  assert.equal(failed.open, true, 'a refused replacement must not look successful');
  assert.match(failed.textContent, /لم يتم تأكيد استبدال الصورة/);
});

test('a click only selects; the open chip enters a page and coming back restores the spot', () => {
  const edit = read('edit-mode.js');
  assert.match(edit, /class="eo-open"/);
  assert.match(edit, /if \(!g\.moved\) return;/);
  assert.match(edit, /Geometry\.move\(g\.r, g\.b/);
  assert.match(edit, /trail\.push\(\{ y: Math\.round\(scrollY\), id: e\.id, depth: depthNow\(\) \}\)/);
  assert.match(edit, /function restoreFrom\(point\)/);
  assert.match(edit, /tagEl\.textContent = e\.name \|\| e\.id/);
});
