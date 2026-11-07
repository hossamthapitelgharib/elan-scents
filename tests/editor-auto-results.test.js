const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const root = path.resolve(__dirname, '..');
const renderer = fs.readFileSync(path.join(root, 'design-layer.js'), 'utf8');
const storefront = fs.readFileSync(path.join(root, 'app-core.js'), 'utf8');

function designHelpers(perfumes) {
  const start = renderer.indexOf('function sameCatalogName(');
  const end = renderer.indexOf('function manualList(', start);
  assert.ok(start >= 0 && end > start, 'design catalog helpers are present');
  const context = vm.createContext({
    PERFUMES: perfumes, globalOffer: (p) => p.globalOffer,
    window: {},
    esc: (value) => String(value == null ? '' : value),
    nmOf: (_group, key) => String(key)
  });
  vm.runInContext(renderer.slice(start, end), context);
  return context;
}

function coreCatalog(perfumes, filters) {
  const offerLine = storefront.split('\n').find((line) => line.startsWith('function globalOffer('));
  const listLine = storefront.split('\n').find((line) => line.startsWith('function list()'));
  assert.ok(offerLine && listLine, 'storefront globalOffer and list functions are present');
  const context = vm.createContext({
    PERFUMES: perfumes, globalOffer: (p) => p.globalOffer,
    F: { q: '', cat: '', br: '', st: '', oc: '', nt: '', size: '', min: '', max: '', ind: '', sec: '', sort: 0, ...filters },
    globalOffer: (p) => p.globalOffer, ranked: (compare) => compare
  });
  vm.runInContext(offerLine + '\n' + listLine, context);
  return context;
}

test('automatic sections use the platform-selected offer and never choose a different store offer', () => {
  const selected = { store: 'Store A', storeId: 'store-a', storeProductId: 'sp-a', price: 100, avail: true, flags: [] };
  const otherStore = { store: 'Store B', storeId: 'store-b', storeProductId: 'sp-b', price: 50, avail: true, flags: [] };
  const product = {
    id: 'size-1', name: 'Perfume', brand: 'Brand', sizeMl: 50,
    globalOffer: selected,
    allEligibleOffers: [selected, otherStore],
    allEligibleOffers: [selected, otherStore]
  };
  const ctx = designHelpers([product]);
  assert.deepEqual(Array.from(vm.runInContext("autoList({ store: 'store-a' })", ctx), (row) => row.b.storeProductId), ['sp-a']);
  assert.deepEqual(Array.from(vm.runInContext("autoList({ store: 'store-a' })", ctx), (row) => row.b.storeProductId), ['sp-a'], 'store_id is accepted as the store filter value');
  assert.deepEqual(Array.from(vm.runInContext("autoList({ store: 'store-b' })", ctx)), [], 'a store does not receive an alternative offer when it does not own globalOffer');
  assert.deepEqual(Array.from(vm.runInContext("autoList({ store: 'store-a', min: 90, max: 100 })", ctx), (row) => [row.b.storeProductId, row.b.price]), [['sp-a', 100]]);
  assert.deepEqual(Array.from(vm.runInContext("autoList({ store: 'store-a', min: 101 })", ctx)), [], 'price ranges compare against the same globalOffer');
  assert.deepEqual(Array.from(vm.runInContext("autoList({ store: 'Store A' })", ctx)), [], 'store display labels are not filter IDs');
});

test('a product without an explicit globalOffer is not inferred from allEligibleOffers, even with one row', () => {
  const product = { id: 'size-2', name: 'Perfume', allEligibleOffers: [
    { store: 'Store A', storeProductId: 'sp-a', price: 100, avail: true },
    { store: 'Store B', storeProductId: 'sp-b', price: 50, avail: true }
  ] };
  const ctx = designHelpers([product]);
  assert.deepEqual(Array.from(vm.runInContext('autoList({})', ctx)), []);
  ctx.PERFUMES = [{ ...product, allEligibleOffers: [product.allEligibleOffers[0]] }];
  assert.deepEqual(Array.from(vm.runInContext('autoList({})', ctx)), [], 'a sole eligible row is not assumed to be the canonical selection');
});

test('automatic sections intersect gender, occasion, note, and size filters using stable keys', () => {
  const product = {
    id: 'size-3', name: 'Matching', brand: 'Brand', sizeMl: 100, gender: 'men',
    occasionKeys: ['work'], noteKeys: ['oud'],
    globalOffer: { store: 'Store A', storeProductId: 'sp-c', price: 150, avail: true, flags: [] },
    offers: [], allEligibleOffers: []
  };
  const ctx = designHelpers([product, {
    ...product, id: 'size-4', name: 'Wrong gender', gender: 'women',
    globalOffer: { ...product.globalOffer, storeProductId: 'sp-d' }
  }]);
  assert.deepEqual(Array.from(vm.runInContext("autoList({ cat: 'men', occ: 'work', note: 'oud', size_ml: 100 })", ctx), (row) => row.p.id), ['size-3']);
  assert.deepEqual(Array.from(vm.runInContext("autoList({ cat: 'men', occ: 'date', note: 'oud' })", ctx)), []);
  assert.deepEqual(Array.from(vm.runInContext("autoList({ cat: 'رجالي', occ: 'work', note: 'oud' })", ctx)), [], 'localized labels are not filter values');
});

test('storefront store and price filters are tied to globalOffer ownership and price', () => {
  const base = {
    name: 'Perfume', brand: 'Brand', gender: 'men', occasionKeys: ['work'], noteKeys: ['oud'],
    allEligibleOffers: [
      { store: 'Store A', storeId: 'store-a', storeProductId: 'sp-a', price: 100, avail: true, flags: [] },
      { store: 'Store B', storeId: 'store-b', storeProductId: 'sp-b', price: 50, avail: true, flags: [] }
    ],
    globalOffer: { store: 'Store A', storeId: 'store-a', storeProductId: 'sp-a', price: 100, avail: true, flags: [] }
  };
  const ctx = coreCatalog([{ ...base, id: 'size-1' }], { st: 'store-b', min: '', max: '' });
  assert.deepEqual(Array.from(vm.runInContext('list()', ctx)), [], 'a store filter matches the owner of globalOffer, not any eligible offer');
  ctx.F.st = 'store-a';
  ctx.F.min = '100';
  ctx.F.max = '100';
  assert.deepEqual(Array.from(vm.runInContext('list()', ctx), (row) => [row.b.storeProductId, row.b.price]), [['sp-a', 100]]);
});

test('size and taxonomy IDs/keys remain part of the loader contract', () => {
  assert.match(renderer, /Number\(p\.sizeMl\) !== Number\(f\.size_ml\)/);
  assert.match(renderer, /taxonomyMatches\(p, 'cats', f\.cat\)/);
  assert.match(renderer, /taxonomyMatches\(p, 'occ', f\.occ\)/);
  assert.match(renderer, /taxonomyMatches\(p, 'notes', f\.note\)/);
  assert.match(renderer, /return l;\s*\}/);
  assert.doesNotMatch(renderer, /return l\.slice\(0, Math\.max\(1, Math\.min\(24/);
  assert.match(storefront, /product_sizes\?select=id,size_label,size_ml,product_id&order=id\.asc/);
  assert.match(storefront, /categoryIds:categoryIds\[o\.product_id\]\|\|\[\]/);
  assert.match(storefront, /occasionKeys:occasionKeys\[o\.product_id\]\|\|\[\]/);
  assert.match(storefront, /noteIds:noteIds\[o\.product_id\]\|\|\[\]/);
});
