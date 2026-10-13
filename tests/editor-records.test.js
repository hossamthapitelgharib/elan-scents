const test = require('node:test');
const assert = require('node:assert/strict');
const records = require('../railway/editor-records.js');

const ENV = { SUPABASE_URL: 'https://sb.example.test', SUPABASE_ANON_KEY: 'anon' };

function fakeDb(initial, opts) {
  const tables = { brands: (initial.brands || []).slice(), stores: (initial.stores || []).slice() };
  const calls = [];
  const real = global.fetch;
  global.fetch = async (url, o) => {
    url = String(url); const u = new URL(url);
    const m = /\/rest\/v1\/(brands|stores)$/.exec(u.pathname);
    if (!m) return real(url, o);
    const rows = tables[m[1]]; calls.push({ method: o.method, table: m[1], q: u.search, auth: o.headers.Authorization });
    const respond = (status, json) => ({ ok: status < 300, status, json: async () => json });
    if (o.method === 'POST') {
      if (opts && opts.rejectInsert) return respond(opts.rejectInsert, { message: 'denied' });
      const row = Object.assign({ id: 'id-' + (rows.length + 1) }, JSON.parse(o.body)); rows.push(row); return respond(201, [row]);
    }
    let list = rows;
    const nameQ = u.searchParams.get('name'), slugQ = u.searchParams.get('slug');
    if (nameQ) { const pat = decodeURIComponent(nameQ.replace(/^ilike\./, '')).replace(/\\([%*_\\])/g, '$1'); const star = pat.startsWith('*') && pat.endsWith('*'); const core = pat.replace(/^\*|\*$/g, '').toLowerCase(); list = rows.filter((r) => (star ? r.name.toLowerCase().includes(core) : r.name.toLowerCase() === core)); }
    if (slugQ) list = rows.filter((r) => r.slug === slugQ.replace(/^eq\./, ''));
    return respond(200, list);
  };
  return { tables, calls, restore: () => { global.fetch = real; } };
}

test('search finds existing brands by part of the name', async () => {
  const db = fakeDb({ brands: [{ id: 'b1', name: 'AMOUAGE', slug: 'amouage' }, { id: 'b2', name: 'Armaf', slug: 'armaf' }] });
  try {
    const r = await records.handle(ENV, 'tok', { action: 'search', kind: 'brand', q: 'amou' });
    assert.equal(r.status, 200);
    assert.deepEqual(r.body.matches.map((x) => x.name), ['AMOUAGE']);
    assert.equal(db.calls[0].auth, 'Bearer tok'); // the admin's own token, never a service key
  } finally { db.restore(); }
});

test('sync matches an existing record instead of duplicating it (case and spacing ignored)', async () => {
  const db = fakeDb({ brands: [{ id: 'b1', name: 'AMOUAGE', slug: 'amouage' }] });
  try {
    const r = await records.handle(ENV, 'tok', { action: 'sync', drafts: [{ kind: 'brand', name: '  amouage ' }] });
    assert.equal(r.status, 200);
    assert.equal(r.body.results[0].status, 'matched');
    assert.equal(db.calls.filter((c) => c.method === 'POST').length, 0);
  } finally { db.restore(); }
});

test('sync creates a new brand once, with a unique slug, and only the allowed columns', async () => {
  const db = fakeDb({ brands: [{ id: 'b1', name: 'Old', slug: 'new-brand' }] });
  try {
    const r = await records.handle(ENV, 'tok', { action: 'sync', drafts: [{ kind: 'brand', name: 'New Brand', image: '/assets/logos/new.webp', price: 999, is_active: false }] });
    assert.equal(r.status, 200);
    assert.equal(r.body.results[0].status, 'created');
    const row = db.tables.brands[1];
    assert.equal(row.slug, 'new-brand-2');
    assert.equal(row.official_logo_url, '/assets/logos/new.webp');
    assert.equal(row.price, undefined); assert.equal(row.is_active, undefined);
    const again = await records.handle(ENV, 'tok', { action: 'sync', drafts: [{ kind: 'brand', name: 'new brand' }] });
    assert.equal(again.body.results[0].status, 'matched'); assert.equal(db.tables.brands.length, 2);
  } finally { db.restore(); }
});

test('sync creates a store and keeps commission and status at the database defaults', async () => {
  const db = fakeDb({});
  try {
    const r = await records.handle(ENV, 'tok', { action: 'sync', drafts: [{ kind: 'store', name: 'متجر الندى' }] });
    assert.equal(r.status, 200);
    const row = db.tables.stores[0];
    assert.match(row.slug, /^x-[0-9a-f]+$/);
    assert.deepEqual(Object.keys(row).sort(), ['id', 'name', 'slug']);
  } finally { db.restore(); }
});

test('bad input is refused before any database write', async () => {
  const db = fakeDb({});
  try {
    for (const d of [{ kind: 'product', name: 'x y' }, { kind: 'brand', name: 'a' }, { kind: 'brand', name: '<script>alert(1)</script>' }, { kind: 'brand', name: 'Fine Name', image: 'https://evil.example/x.png' }, { kind: 'brand', name: 'Fine Name', image: '/assets/../secret' }]) {
      const r = await records.handle(ENV, 'tok', { action: 'sync', drafts: [d] });
      assert.equal(r.status, 400, JSON.stringify(d));
    }
    assert.equal((await records.handle(ENV, 'tok', { action: 'sync', drafts: [] })).status, 400);
    assert.equal(db.calls.filter((c) => c.method === 'POST').length, 0);
    assert.ok(records.imageOk('https://sb.example.test/storage/v1/object/public/site-media/a/b.webp', ENV));
  } finally { db.restore(); }
});

test('a database refusal stops the sync and is reported, not hidden', async () => {
  const db = fakeDb({}, { rejectInsert: 403 });
  try {
    const r = await records.handle(ENV, 'tok', { action: 'sync', drafts: [{ kind: 'brand', name: 'First One' }, { kind: 'brand', name: 'Second One' }] });
    assert.equal(r.status, 403); assert.equal(r.body.error, 'forbidden');
    assert.equal(db.calls.filter((c) => c.method === 'POST').length, 1);
  } finally { db.restore(); }
});
