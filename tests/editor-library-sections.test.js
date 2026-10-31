/* Owner's 2026-10-30 library round: the library window has the twelve section tabs, an explicit "load from Supabase" button and an explicit
   "sync changes" button, and the old browser-only library moves to the cloud safely (merge only, read back to confirm, never delete the local
   copy by itself). The model runs for real here, and the transfer runs against the REAL server handler (railway/editor-data.js) with a fake
   Supabase, so what the browser sends is what the server accepts. */
const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const editorData = require('../railway/editor-data.js');

const source = fs.readFileSync(path.join(__dirname, '..', 'editor', 'editor-live-library.js'), 'utf8');
const win = {};
vm.runInContext(source, vm.createContext({ window: win, File, atob, console }));
const model = win.ElanLibraryModel;
const plain = (v) => JSON.parse(JSON.stringify(v)); // the model runs in a VM, so its arrays have another realm's prototype
const sha256 = async (text) => crypto.createHash('sha256').update(String(text)).digest('hex');
const PNG = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==';

function storageOf(initial) {
  const map = new Map(Object.entries(initial || {}));
  return { getItem: (k) => (map.has(k) ? map.get(k) : null), setItem: (k, v) => { map.set(k, String(v)); }, removeItem: (k) => { map.delete(k); }, map };
}
const localState = (extra) => JSON.stringify({ items: [{ id: 'title', type: 'text', text: 'عنوان' }], archive: [], media: [], savedElements: [], ...extra });

/* ---------- the twelve sections ---------- */

test('the library has exactly the owner\'s twelve sections, in his order and wording', () => {
  assert.deepEqual(plain(model.CATEGORIES.map((c) => c[1])), ['سيكشن', 'براند', 'متجر', 'عطر', 'بانر', 'نص', 'هيرو', 'صورة', 'فيديو', 'مناسبة', 'نوتة عطرية', 'كتلة نصية']);
  assert.deepEqual(plain(model.CATEGORIES.map((c) => c[0])), ['section', 'brand', 'store', 'perfume', 'banner', 'text', 'hero', 'image', 'video', 'occasion', 'note', 'text_block']);
});

test('an item lands in its section by saved category, then kind, then the kind or type of the block inside it', () => {
  const c = model.categoryOf;
  assert.equal(c({ category: 'perfume' }), 'perfume');
  assert.equal(c({ category: 'general', kind: 'perfume-card' }), 'perfume', 'a card kind written the way the editor saves it');
  assert.equal(c({ kind: 'brand-card' }), 'brand');
  assert.equal(c({ kind: 'text-block' }), 'text_block');
  assert.equal(c({ kind: 'product-card' }), 'perfume');
  assert.equal(c({ payload: { type: 'banner' } }), 'banner');
  assert.equal(c({ payload: { format: 'elan-element-v1', element: { type: 'text' } } }), 'text', 'an exported element file');
  assert.equal(c({ category: 'general', type: 'image' }), 'image', 'a media row: general falls back to its type');
  assert.equal(c({ category: 'general', type: 'video' }), 'video');
  assert.equal(c({ category: 'hero', type: 'image' }), 'hero');
  assert.equal(c({ kind: 'occasion' }), 'occasion');
  assert.equal(c({ category: 'note' }), 'note');
  assert.equal(c({ type: 'smart' }), 'other', 'unknown things are never lost, they sit under "الكل" and "أخرى"');
  assert.equal(c(null), 'other');
});

test('archived page elements are placed by their id', () => {
  const c = model.categoryOfElementId;
  assert.deepEqual(plain(['hero', 'sec:offers:title', 'brand:armaf', 'store:afnan', 'prod:p1', 'col:occ:2', 'col:notes:1', 'footer'].map(c)), ['hero', 'section', 'brand', 'store', 'perfume', 'occasion', 'note', 'other']);
});

/* ---------- pieces of the transfer ---------- */

test('embedded pictures are swapped for addresses everywhere inside an item, and a failed swap stops that item', async () => {
  const seen = [];
  const out = await model.replaceDataUrls({ name: 'x', mediaSrc: PNG, nested: { list: [PNG, 'https://a/b.png', 5] } }, async (u) => { seen.push(u); return 'https://cdn/x.png'; });
  assert.deepEqual(JSON.parse(JSON.stringify(out)), { name: 'x', mediaSrc: 'https://cdn/x.png', nested: { list: ['https://cdn/x.png', 'https://a/b.png', 5] } });
  assert.equal(seen.length, 2);
  await assert.rejects(model.replaceDataUrls({ a: PNG }, async () => { throw new Error('upload_failed'); }), /upload_failed/);
});

test('a data URL becomes a real file of the right type', () => {
  const file = model.dataUrlToFile(PNG, 'dot.png');
  assert.equal(file.type, 'image/png');
  assert.equal(file.name, 'dot.png');
  assert.ok(file.size > 20);
  assert.throws(() => model.dataUrlToFile('not a data url', 'x'), /data_url_invalid/);
});

test('saves are split under the server limit; one row that is too big alone is reported, never cut', () => {
  const big = (n) => ({ name: 'n', kind: 'k', category: null, payload: { pad: 'x'.repeat(n) } });
  const plan = model.planBatches([], [big(300), big(300), big(300), big(900)], 700);
  assert.equal(plan.tooLarge.length, 1);
  assert.deepEqual(plain(plan.batches.map((b) => b.savedElements.length)), [1, 1, 1], 'each row of ~330 chars needs its own batch under a 700 limit with two already there');
  const roomy = model.planBatches([{ element_id: 'a', kind: 'k', name: null, payload: {} }], [big(10), big(10)], 100000);
  assert.equal(roomy.batches.length, 1);
  assert.equal(roomy.batches[0].archive.length, 1);
});

test('the local library is read from the old editor state and nothing else', () => {
  const none = model.readLocalLibrary(storageOf({}));
  assert.equal(none.present, false);
  assert.equal(model.readLocalLibrary(storageOf({ [model.LOCAL_STORAGE_KEY]: '{broken' })).present, false, 'a damaged note is not an error');
  const some = model.readLocalLibrary(storageOf({ [model.LOCAL_STORAGE_KEY]: localState({ savedElements: [{ id: 's1', type: 'text', text: 'مرحبا' }], media: [{ name: 'a.png', src: PNG, type: 'image', category: 'image' }] }) }));
  assert.equal(some.present, true);
  assert.equal(some.saved.length, 1);
  assert.equal(some.media.length, 1);
});

/* ---------- the transfer against the real server handler ---------- */

function cloud() {
  const previous = { fetch: global.fetch, url: process.env.SUPABASE_URL, key: process.env.SUPABASE_SERVICE_ROLE_KEY };
  process.env.SUPABASE_URL = 'https://supabase.test';
  process.env.SUPABASE_SERVICE_ROLE_KEY = 'test-service-role';
  const tables = { media_library: [], editor_archive: [], editor_saved_elements: [] };
  const calls = [];
  let nextId = 1;
  const clone = (v) => JSON.parse(JSON.stringify(v));
  const ok = (data) => ({ ok: true, status: 200, json: async () => data });
  global.fetch = async (url, options = {}) => {
    const parsed = new URL(url), table = parsed.pathname.split('/').pop(), method = options.method || 'GET';
    calls.push({ table, method });
    if (method === 'GET') return ok(clone(tables[table]));
    if (method === 'POST') {
      const inserted = JSON.parse(options.body).map((row) => ({ id: '00000000-0000-4000-8000-' + String(nextId++).padStart(12, '0'), created_at: '2026-10-30T00:00:00.000Z', ...row }));
      tables[table].push(...inserted);
      return ok(clone(inserted));
    }
    if (method === 'PATCH') {
      const id = (parsed.searchParams.get('id') || '').slice(3);
      const row = tables[table].find((x) => x.id === id);
      Object.assign(row, JSON.parse(options.body));
      return ok([clone(row)]);
    }
    return { ok: false, status: 405, json: async () => ({}) };
  };
  async function invoke(method, { query = {}, body = {} } = {}) {
    const res = { statusCode: 200, body: null, setHeader() { return this; }, status(code) { this.statusCode = code; return this; }, json(value) { this.body = value; return this; } };
    await editorData({ method, query, body, headers: {}, __editorKeyAdmin: true }, res);
    return res;
  }
  const provider = {
    getLibrary: async () => { const r = await invoke('GET', { query: { action: 'library' } }); if (r.statusCode !== 200) throw new Error(r.body.error); return r.body.library; },
    saveLibrary: async (library, expectedRevision) => { const r = await invoke('POST', { body: { action: 'library.save', library, expectedRevision } }); if (r.statusCode !== 200) throw new Error(r.body.error); return r.body; }
  };
  const uploads = [];
  const uploadFile = async (file) => {
    uploads.push(file.name);
    const url = 'https://supabase.test/storage/v1/object/public/editor-media/' + String(uploads.length) + '-' + file.name;
    tables.media_library.push({ id: '00000000-0000-4000-9000-' + String(uploads.length).padStart(12, '0'), file_url: url, file_type: file.type.split('/')[0], title: file.name, category: 'general', created_at: '2026-10-30T00:00:00.000Z' });
    return url;
  };
  const restore = () => { global.fetch = previous.fetch; if (previous.url === undefined) delete process.env.SUPABASE_URL; else process.env.SUPABASE_URL = previous.url; if (previous.key === undefined) delete process.env.SUPABASE_SERVICE_ROLE_KEY; else process.env.SUPABASE_SERVICE_ROLE_KEY = previous.key; };
  return { tables, calls, provider, uploadFile, uploads, restore };
}

const oldLibrary = () => localState({
  savedElements: [{ id: 'sv1', type: 'card', kind: 'brand', text: 'أرماف', mediaSrc: PNG, mediaType: 'image' }, { id: 'sv2', type: 'text', text: 'عرض الشتاء' }],
  archive: [{ id: 'ar1', type: 'section', text: 'سيكشن قديم' }],
  media: [{ name: 'bottle.png', src: PNG, type: 'image', category: 'perfume' }]
});

test('the transfer moves saved elements, archived elements and media to the cloud, reads it back, and deletes nothing', async () => {
  const c = cloud();
  try {
    const storage = storageOf({ [model.LOCAL_STORAGE_KEY]: oldLibrary() });
    const report = await model.syncLocal({ provider: c.provider, storage, uploadFile: c.uploadFile, sha256 });
    assert.equal(report.verified, true, JSON.stringify(report));
    assert.equal(report.failed.length, 0);
    assert.equal(report.sent, 3, 'two saved elements and one archived element');
    assert.equal(c.tables.editor_saved_elements.length, 2);
    assert.equal(c.tables.editor_archive.length, 1);
    assert.equal(c.uploads.length, 1, 'the same picture (in the media list and inside the brand card) is uploaded once');
    const brand = c.tables.editor_saved_elements.find((r) => r.name === 'أرماف');
    assert.equal(brand.category, 'brand');
    assert.match(brand.payload.mediaSrc, /^https:\/\/supabase\.test\/storage\//, 'the embedded picture became an address');
    assert.ok(!JSON.stringify(c.tables).includes('data:image'), 'no data URL reaches the cloud');
    assert.equal(c.tables.editor_archive[0].element_id, 'legacy-local:ar1', 'old ids cannot overwrite an element of the real page');
    assert.equal(c.calls.some((x) => x.method === 'DELETE'), false);
    assert.ok(storage.getItem(model.LOCAL_STORAGE_KEY).includes('sv1'), 'the local copy is untouched');
  } finally { c.restore(); }
});

test('running the transfer again changes nothing, and the library box then reports nothing pending', async () => {
  const c = cloud();
  try {
    const storage = storageOf({ [model.LOCAL_STORAGE_KEY]: oldLibrary() });
    const deps = { provider: c.provider, storage, uploadFile: c.uploadFile, sha256 };
    await model.syncLocal(deps);
    const rows = JSON.stringify(c.tables);
    const second = await model.syncLocal(deps);
    assert.equal(second.verified, true);
    assert.equal(second.sent, 0);
    assert.equal(second.alreadyThere, 3);
    assert.equal(JSON.stringify(c.tables), rows, 'no row was added or changed');
    assert.equal(c.uploads.length, 1, 'no second upload');
    const info = await model.describeLocal(model.readLocalLibrary(storage), await c.provider.getLibrary(), storage, sha256);
    assert.equal(info.pending, 0);
    assert.deepEqual(plain([info.saved, info.archive, info.media]), [2, 1, 1]);
  } finally { c.restore(); }
});

test('before the transfer the box counts what is still missing from the cloud', async () => {
  const c = cloud();
  try {
    const storage = storageOf({ [model.LOCAL_STORAGE_KEY]: oldLibrary() });
    const info = await model.describeLocal(model.readLocalLibrary(storage), await c.provider.getLibrary(), storage, sha256);
    assert.deepEqual(plain([info.pendingSaved, info.pendingArchive, info.pendingMedia, info.pending]), [2, 1, 1, 4]);
  } finally { c.restore(); }
});

test('a failed upload is reported, that item is not sent, the transfer is not "verified", and the local copy stays', async () => {
  const c = cloud();
  try {
    const storage = storageOf({ [model.LOCAL_STORAGE_KEY]: oldLibrary() });
    const report = await model.syncLocal({ provider: c.provider, storage, sha256, uploadFile: async () => { throw new Error('upload_failed'); } });
    assert.equal(report.verified, false);
    assert.ok(report.failed.some((f) => f.what === 'media'));
    assert.ok(report.failed.some((f) => f.what === 'saved' && f.name === 'أرماف'), 'the card with the picture is not stored half-broken');
    assert.equal(c.tables.editor_saved_elements.length, 1, 'only the item that needed no upload went');
    assert.equal(c.calls.some((x) => x.method === 'DELETE'), false);
    const info = await model.describeLocal(model.readLocalLibrary(storage), await c.provider.getLibrary(), storage, sha256);
    assert.ok(info.pending > 0, 'so the local delete stays locked');
  } finally { c.restore(); }
});

test('a library that changed while the transfer runs is re-read and the save is retried once', async () => {
  const c = cloud();
  try {
    const storage = storageOf({ [model.LOCAL_STORAGE_KEY]: localState({ savedElements: [{ id: 'sv2', type: 'text', text: 'عرض الشتاء' }] }) });
    let first = true;
    const provider = { ...c.provider, saveLibrary: async (library, revision) => {
      if (first) { first = false; await c.provider.saveLibrary({ archive: [], savedElements: [{ name: 'أضافه جهاز آخر', kind: 'text', category: 'text', payload: { type: 'text' } }] }, revision); }
      return c.provider.saveLibrary(library, revision);
    } };
    const report = await model.syncLocal({ provider, storage, uploadFile: c.uploadFile, sha256 });
    assert.equal(report.verified, true, JSON.stringify(report));
    assert.equal(c.tables.editor_saved_elements.length, 2, 'the other device\'s element is kept and ours is added');
  } finally { c.restore(); }
});

test('with no old library there is nothing to do, and nothing is called', async () => {
  const c = cloud();
  try {
    const report = await model.syncLocal({ provider: c.provider, storage: storageOf({}), uploadFile: c.uploadFile, sha256 });
    assert.equal(report.nothingToDo, true);
    assert.equal(c.calls.length, 0);
  } finally { c.restore(); }
});

test('the local copy is emptied only by clearLocalLibrary, and the rest of the old editor state stays', () => {
  const storage = storageOf({ [model.LOCAL_STORAGE_KEY]: oldLibrary() });
  assert.equal(model.clearLocalLibrary(storage), true);
  const state = JSON.parse(storage.getItem(model.LOCAL_STORAGE_KEY));
  assert.deepEqual([state.savedElements, state.archive, state.media], [[], [], []]);
  assert.equal(state.items.length, 1, 'the canvas items of the old editor are not touched');
  assert.equal(model.clearLocalLibrary(storageOf({})), false);
});

/* ---------- the window ---------- */

test('the library window has the two explicit buttons, the tabs, and the local box with a guarded delete', () => {
  assert.match(source, /'تحميل المكتبة من سابابيس'/);
  assert.match(source, /'مزامنة التغييرات'/);
  assert.match(source, /dataset\.libAction = 'load'/);
  assert.match(source, /dataset\.libAction = 'sync'/);
  assert.match(source, /'الكل'/);
  assert.match(source, /data-lib-tabs|dataset\.libTabs/);
  assert.match(source, /drop\.disabled = info\.pending > 0/, 'the delete stays locked until everything is confirmed in the cloud');
  assert.match(source, /window\.confirm\(/, 'and still asks first');
  assert.match(source, /تنزيل نسخة احتياطية/);
  assert.doesNotMatch(source, /innerHTML|insertAdjacentHTML/);
  assert.doesNotMatch(source, /saveLive\s*\(|publishLive\s*\(|page\.save/, 'the library never saves or publishes the page');
  const media = fs.readFileSync(path.join(__dirname, '..', 'editor', 'editor-media.js'), 'utf8');
  assert.match(media, /window\.elanUploadMediaFile = function/);
});

test('rows of every list are tagged with their section so a tab can filter them', () => {
  assert.equal((source.match(/\.dataset\.cat = /g) || []).length, 4, 'media rows, saved elements, page archive and cloud archive');
  assert.match(source, /categoryOfElementId\(item\.id\)/);
});
