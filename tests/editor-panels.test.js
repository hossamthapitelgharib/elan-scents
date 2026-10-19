const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const root = path.resolve(__dirname, '..');
const read = (file) => fs.readFileSync(path.join(root, file), 'utf8');
const panels = require('../edit-panels.js');

test('the approved panels load with edit mode only, before edit-mode.js, and never for customers', () => {
  const boot = read('edit-boot.js');
  const order = ['/elan-host-bridge.js', '/editor/editor-geometry.js', '/edit-panels.js', '/edit-mode.js'].map((name) => boot.indexOf("'" + name + "'"));
  assert.ok(order.every((i) => i >= 0), 'every script is listed');
  assert.deepEqual(order.slice().sort((a, b) => a - b), order, 'panels are installed before edit mode asks the bridge to start');
  assert.match(boot, /elan_editor/);
  assert.match(boot, /window\.parent === window/);
  for (const page of ['index.html']) assert.doesNotMatch(read(page), /edit-panels\.js/);
});

test('the panels file only talks to the admin data endpoint with the delegated ticket and never uses native dialogs or storage', () => {
  const source = read('edit-panels.js');
  assert.doesNotMatch(source, /localStorage|sessionStorage|document\.cookie/);
  assert.doesNotMatch(source, /\bprompt\(|\bconfirm\(|\balert\(/);
  assert.doesNotMatch(source, /innerHTML|insertAdjacentHTML|eval\(/);
  const urls = source.match(/fetch\('[^']+'/g) || [];
  assert.deepEqual(urls, ["fetch('/api/editor-data'"]);
  assert.match(source, /headers\['X-Elan-Editor-Ticket'\] = ticket/);
  assert.match(source, /getElementById\('elan-eo-root'\)/, 'the panel lives inside edit mode\'s own overlay so its page-blocking listeners treat it as editor UI');
  assert.match(source, /root\.ElanEditMode\.execute\('element\.create', \{ kind: 'smart'/);
  assert.match(source, /ui\.openCreatePanel/);
});

test('only the run() of the six creation tools is replaced; the menu order and every other tool stay as they are', () => {
  const source = read('edit-panels.js');
  assert.match(source, /\^create_\(section\|brand\|store\|perfume\|occasion\|note\)\$/);
  assert.doesNotMatch(source, /ElanEditTools\.register|registerTool/);
  const mode = read('edit-mode.js');
  for (const id of ['create_section', 'create_brand', 'create_store', 'create_perfume', 'create_occasion', 'create_note']) assert.match(mode, new RegExp(id));
});

test('panel copy matches the approved designs', () => {
  const source = read('edit-panels.js');
  for (const text of [
    'إنشاء سيكشن', 'إنشاء كارت عطر', 'إنشاء كارت براند', 'إنشاء كارت متجر', 'إنشاء كارت مناسبة', 'إنشاء كارت نوتة عطرية',
    'اسم السيكشن', 'الغرض من السيكشن', 'اختيار العطور', 'توقيت السيكشن', 'اختيار عطور محددة', 'تلقائي حسب الفلاتر',
    'العطور الناتجة عن الفلترة', 'إضافة العناصر', 'حفظ السيكشن', 'حفظ كروت العطور', 'تشغيل التوقيت',
    'بداية ونهاية محددتان', 'مدة من أول حفظ للسيكشن', 'البداية، توقيت مصر', 'النهاية، توقيت مصر', '✓ تمت الإضافة'
  ]) assert.ok(source.includes(text), text);
});

test('Cairo times are converted to the exact UTC instant, in winter and summer time', () => {
  assert.equal(panels.cairoUTC('2026-01-15T10:00'), '2026-01-15T08:00:00.000Z');
  for (const local of ['2026-01-15T10:00', '2026-07-15T10:00', '2026-10-20T09:30', '2026-04-23T23:45']) {
    assert.equal(panels.localCairo(panels.cairoUTC(local)), local);
  }
  assert.equal(panels.cairoUTC(''), null);
  assert.throws(() => panels.cairoUTC('not a date'));
});

test('timer settings become the server timer object, and bad values are refused', () => {
  assert.deepEqual(panels.timerPayload({ enabled: false, mode: 'duration', count: 5 }), { mode: 'none' });
  assert.deepEqual(panels.timerPayload({ enabled: true, mode: 'duration', count: '36', unit: 'hours' }), { mode: 'duration', duration_hours: 36 });
  assert.deepEqual(panels.timerPayload({ enabled: true, mode: 'duration', count: '2', unit: 'days' }), { mode: 'duration', duration_hours: 48 });
  assert.deepEqual(panels.timerPayload({ enabled: true, mode: 'dates', start: '2026-01-15T10:00', end: '2026-01-20T10:00' }), { mode: 'window', starts_at: '2026-01-15T08:00:00.000Z', ends_at: '2026-01-20T08:00:00.000Z' });
  for (const bad of [
    { enabled: true, mode: 'duration', count: '0', unit: 'hours' }, { enabled: true, mode: 'duration', count: '1.5', unit: 'hours' }, { enabled: true, mode: 'duration', count: '', unit: 'days' },
    { enabled: true, mode: 'dates', start: '', end: '2026-01-20T10:00' }, { enabled: true, mode: 'dates', start: '2026-01-20T10:00', end: '2026-01-15T10:00' }
  ]) assert.throws(() => panels.timerPayload(bad), JSON.stringify(bad));
});

test('filters: record ids go to the catalogue lookup, names are what the storefront section stores', () => {
  const built = panels.buildFilters(
    { brand: 'b-1', store: '', category: 'c-1', occasion: '', note: 'n-1', size: '100', min: '100', max: '500' },
    { brand: 'Atelier', category: 'Oriental', note: 'Oud', size: '100 ml' }
  );
  assert.deepEqual(built.provider, { brand_id: 'b-1', category_id: 'c-1', note_id: 'n-1', size_ml: 100, price_min: 100, price_max: 500 });
  assert.deepEqual(built.saved, { brand: 'Atelier', cat: 'Oriental', note: 'Oud', size_ml: 100, min: 100, max: 500 });
  assert.deepEqual(panels.buildFilters({}, {}), { provider: {}, saved: {} });
  assert.throws(() => panels.buildFilters({ min: '500', max: '100' }, {}));
  assert.throws(() => panels.buildFilters({ min: '-1' }, {}));
  assert.throws(() => panels.buildFilters({ max: 'abc' }, {}));
});

test('the saved section body matches what /api/editor-data accepts', () => {
  const filters = { provider: {}, saved: { brand: 'Atelier' } };
  const manual = panels.sectionBody({ name: 'N', purpose: 'P', mode: 'manual', filters, picks: [{ productSizeId: 'a' }, { productSizeId: 'b' }], timer: { mode: 'none' } });
  assert.deepEqual(manual, { name: 'N', purpose: 'P', selection_mode: 'manual', filters: { brand: 'Atelier' }, product_size_ids: ['a', 'b'], timer: { mode: 'none' } });
  const automatic = panels.sectionBody({ name: 'N', purpose: 'P', mode: 'automatic', filters, picks: [{ productSizeId: 'a' }], timer: { mode: 'none' } });
  assert.equal(automatic.selection_mode, 'auto');
  assert.deepEqual(automatic.product_size_ids, [], 'an automatic section never carries manual items');
});

test('the railway host serves the panels file to the editor iframe', { skip: !fs.existsSync(path.join(root, 'railway/server.js')) }, async () => {
  const server = require('../railway/server.js');
  const port = await new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve(server.address().port)));
  try {
    const res = await fetch('http://127.0.0.1:' + port + '/edit-panels.js');
    assert.equal(res.status, 200);
    assert.match(await res.text(), /approved creation panels/);
  } finally { server.close(); }
});
