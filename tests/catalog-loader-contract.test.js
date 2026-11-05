const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const root = path.join(__dirname, '..');
const core = fs.readFileSync(path.join(root, 'app-core.js'), 'utf8');
const migration = fs.readFileSync(path.join(root, 'supabase/migrations/20261105122843_catalog_data_foundation.sql'), 'utf8');

test('loader requests global and eligible offer views, gender, and stable taxonomy keys', () => {
  assert.match(core, /public_products\?select=[^'\n]*\bgender\b/);
  assert.match(core, /catalog_platform_offers\?select=product_size_id,product_id,store_product_id,store_id,store_name,price,currency/);
  assert.match(core, /catalog_eligible_offers\?select=product_size_id,product_id,store_product_id,store_id,store_name,price,currency/);
  for (const table of ['categories', 'occasions', 'aromatic_notes']) {
    assert.match(core, new RegExp(table + '\\?select=id,key,name'));
  }
});

test('taxonomy records preserve UUIDs and stable keys; labels are not used as filter values', () => {
  for (const field of ['categoryIds', 'occasionIds', 'noteIds', 'categoryKeys', 'occasionKeys', 'noteKeys']) {
    assert.match(core, new RegExp(field + ':'));
  }
  assert.match(core, /gender:p\.gender\|\|null/);
  assert.match(core, /v:r\.key,l:l/);
  assert.doesNotMatch(core, /function idx\s*\(/, 'taxonomy relations are not converted to text-array positions');
  assert.match(migration, /categories_key_unique/);
  assert.match(migration, /occasions_key_unique/);
  assert.match(migration, /aromatic_notes_key_unique/);
});

test('gender, occasion, and note filters use stable values with AND across dimensions', () => {
  assert.match(core, /String\(p\.gender\|\|''\)===String\(F\.cat\)/);
  assert.match(core, /p\.occasionKeys\|\|\[\]/);
  assert.match(core, /p\.noteKeys\|\|\[\]/);
  const start = core.indexOf('function list()');
  const end = core.indexOf('\n', start);
  const rankedStart = core.indexOf('function ranked(');
  const rankedEnd = core.indexOf('\n', rankedStart);
  const source = core.slice(rankedStart, rankedEnd) + '\n' + core.slice(start, end);
  const context = vm.createContext({
    F: { q: '', cat: 'men', oc: 'work', nt: 'oud', br: '', st: '', min: '', max: '', ind: '', sec: '', sort: 0 },
    PERFUMES: [
      { id: 'size-a', name: 'matching', brand: 'B', gender: 'men', occasionKeys: ['work'], noteKeys: ['oud'], offers: [{ price: 12, avail: true, flags: [] }] },
      { id: 'size-b', name: 'wrong occasion', brand: 'B', gender: 'men', occasionKeys: ['date'], noteKeys: ['oud'], offers: [{ price: 12, avail: true, flags: [] }] },
      { id: 'size-c', name: 'wrong gender', brand: 'B', gender: 'women', occasionKeys: ['work'], noteKeys: ['oud'], offers: [{ price: 12, avail: true, flags: [] }] }
    ],
    IND_SORT: {}, best: (p) => p.offers[0]
  });
  vm.runInContext(source, context);
  assert.deepEqual(Array.from(vm.runInContext('list()', context), (row) => row.p.name), ['matching']);
});

test('the selected global offer row supplies price and store_product_id without a composite-ID lookup', () => {
  const loaderStart = core.indexOf('async function loadData(){');
  const loaderEnd = core.indexOf('\nvar FT=', loaderStart);
  const loader = core.slice(loaderStart, loaderEnd);
  assert.match(loader, /platformOffer:o/);
  assert.match(loader, /storeProductId:o\.store_product_id\|\|''/);
  assert.match(loader, /price:\+o\.price/);
  assert.match(loader, /allEligibleOffers:allOffers\[o\.product_size_id\]\|\|\[\]/);
  assert.doesNotMatch(loader, /sp\[o\.store_id\+'\|'\+o\.product_size_id\]/);
  assert.doesNotMatch(loader, /store_id\s*\+\s*['"]\|['"]\s*\+\s*product_size_id/);
});

test('the database contract treats NULL stock as unknown-but-eligible and uses deterministic stable tie breakers', () => {
  assert.match(migration, /stock_quantity IS NULL OR sp\.stock_quantity > 0/);
  assert.match(migration, /currency = 'EGP'/);
  assert.match(migration, /offer\.store_id ASC,\s*offer\.store_product_id ASC/);
  assert.match(migration, /store_products_currency_egp_check/);
  assert.match(migration, /store_product_id uuid/);
});
