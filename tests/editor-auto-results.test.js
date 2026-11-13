const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const root = path.resolve(__dirname, '..');
const renderer = fs.readFileSync(path.join(root, 'design-layer.js'), 'utf8');
const storefront = fs.readFileSync(path.join(root, 'app-core.js'), 'utf8');

function designHelpers(perfumes, announcements) {
  const start = renderer.indexOf('function sameCatalogName(');
  const end = renderer.indexOf('function manualList(', start);
  assert.ok(start >= 0 && end > start, 'design catalog helpers are present');
  const context = vm.createContext({
    PERFUMES: perfumes, platformEligibleOffer: (p) => p.platformEligibleOffer,
    ...(announcements ? { ANNOUNCEMENTS: announcements } : {}),
    window: {},
    esc: (value) => String(value == null ? '' : value),
    nmOf: (_group, key) => String(key)
  });
  vm.runInContext(renderer.slice(start, end), context);
  return context;
}

function coreCatalog(perfumes, filters, announcements) {
  const offerLine = storefront.split('\n').find((line) => line.startsWith('function platformEligibleOffer('));
  const listLine = storefront.split('\n').find((line) => line.startsWith('function list()'));
  assert.ok(offerLine && listLine, 'storefront platformEligibleOffer and list functions are present');
  const context = vm.createContext({
    PERFUMES: perfumes, ANNOUNCEMENTS: announcements || [], platformEligibleOffer: (p) => p.platformEligibleOffer,
    F: { q: '', cat: '', br: '', st: '', oc: '', nt: '', size: '', min: '', max: '', ind: '', sec: '', sort: 0, ...filters },
    platformEligibleOffer: (p) => p.platformEligibleOffer, ranked: (compare) => compare
  });
  vm.runInContext(offerLine + '\n' + listLine, context);
  return context;
}

test('automatic sections use the platform-selected offer and never choose a different store offer', () => {
  const selected = { store: 'Store A', storeId: 'store-a', storeProductId: 'sp-a', price: 100, avail: true, flags: [] };
  const otherStore = { store: 'Store B', storeId: 'store-b', storeProductId: 'sp-b', price: 50, avail: true, flags: [] };
  const product = {
    id: 'size-1', name: 'Perfume', brand: 'Brand', sizeMl: 50,
    platformEligibleOffer: selected,
    allEligibleOffers: [selected, otherStore],
    allEligibleOffers: [selected, otherStore]
  };
  const ctx = designHelpers([product]);
  assert.deepEqual(Array.from(vm.runInContext("autoList({ store: 'store-a' })", ctx), (row) => row.b.storeProductId), ['sp-a']);
  assert.deepEqual(Array.from(vm.runInContext("autoList({ store: 'store-a' })", ctx), (row) => row.b.storeProductId), ['sp-a'], 'store_id is accepted as the store filter value');
  assert.deepEqual(Array.from(vm.runInContext("autoList({ store: 'store-b' })", ctx)), [], 'a store does not receive an alternative offer when it does not own platformEligibleOffer');
  assert.deepEqual(Array.from(vm.runInContext("autoList({ store: 'store-a', min: 90, max: 100 })", ctx), (row) => [row.b.storeProductId, row.b.price]), [['sp-a', 100]]);
  assert.deepEqual(Array.from(vm.runInContext("autoList({ store: 'store-a', min: 101 })", ctx)), [], 'price ranges compare against the same platformEligibleOffer');
  assert.deepEqual(Array.from(vm.runInContext("autoList({ store: 'Store A' })", ctx)), [], 'store display labels are not filter IDs');
});

test('a product without an explicit platformEligibleOffer is not inferred from allEligibleOffers, even with one row', () => {
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
    platformEligibleOffer: { store: 'Store A', storeProductId: 'sp-c', price: 150, avail: true, flags: [] },
    offers: [], allEligibleOffers: []
  };
  const ctx = designHelpers([product, {
    ...product, id: 'size-4', name: 'Wrong gender', gender: 'women',
    platformEligibleOffer: { ...product.platformEligibleOffer, storeProductId: 'sp-d' }
  }]);
  assert.deepEqual(Array.from(vm.runInContext("autoList({ cat: 'men', occ: 'work', note: 'oud', size_ml: 100 })", ctx), (row) => row.p.id), ['size-3']);
  assert.deepEqual(Array.from(vm.runInContext("autoList({ cat: 'men', occ: 'date', note: 'oud' })", ctx)), []);
  assert.deepEqual(Array.from(vm.runInContext("autoList({ cat: 'رجالي', occ: 'work', note: 'oud' })", ctx)), [], 'localized labels are not filter values');
});

test('storefront store and price filters are tied to platformEligibleOffer ownership and price', () => {
  const base = {
    name: 'Perfume', brand: 'Brand', gender: 'men', occasionKeys: ['work'], noteKeys: ['oud'],
    allEligibleOffers: [
      { store: 'Store A', storeId: 'store-a', storeProductId: 'sp-a', price: 100, avail: true, flags: [] },
      { store: 'Store B', storeId: 'store-b', storeProductId: 'sp-b', price: 50, avail: true, flags: [] }
    ],
    platformEligibleOffer: { store: 'Store A', storeId: 'store-a', storeProductId: 'sp-a', price: 100, avail: true, flags: [] }
  };
  const ctx = coreCatalog([{ ...base, id: 'size-1' }], { st: 'store-b', min: '', max: '' });
  assert.deepEqual(Array.from(vm.runInContext('list()', ctx)), [], 'a store filter matches the owner of platformEligibleOffer, not any eligible offer');
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

const announced = (id, extra = {}) => ({ id, name: 'Soon ' + id, brand: 'Brand', sizeMl: 50, announcement: true, announcedById: 'store-a', platformEligibleOffer: null, allEligibleOffers: [], ...extra });
const sale = { id: 'sale-1', name: 'On sale', brand: 'Brand', sizeMl: 50, platformEligibleOffer: { store: 'Store A', storeId: 'store-a', storeProductId: 'sp-a', price: 100, avail: true, flags: ['soon'] } };

test('«قريبًا» in an automatic section lists the announcements: no offer needed, never a sale offer, a price bound leaves it out', () => {
  const ctx = designHelpers([sale], [announced('a1'), announced('a2', { announcedById: 'store-b', sizeMl: 100, brand: 'Other' })]);
  const ids = (f) => Array.from(vm.runInContext('autoList(' + JSON.stringify(f) + ')', ctx), (row) => [row.p.id, row.b]);
  assert.deepEqual(ids({ flag: 'soon' }), [['a1', null], ['a2', null]], 'both announcements, with no offer; the sale offer is not one');
  assert.deepEqual(ids({ flag: 'soon', store: 'store-b' }), [['a2', null]], 'the store filter is the announcing store');
  assert.deepEqual(ids({ flag: 'soon', brand: 'Brand' }), [['a1', null]]);
  assert.deepEqual(ids({ flag: 'soon', size_ml: 100 }), [['a2', null]]);
  assert.deepEqual(ids({ flag: 'soon', min: 1 }), [], 'an announcement has no price, so a price range cannot include it');
  assert.deepEqual(ids({ flag: 'soon', max: 500 }), []);
  assert.deepEqual(Array.from(vm.runInContext("autoList({})", ctx), (row) => row.p.id), ['sale-1'], 'a plain section lists only what is on sale');
  assert.deepEqual(Array.from(vm.runInContext("autoList({ flag: 'soon' })", designHelpers([sale]))), [], 'with no announcement the section is empty');
});

test('the storefront «قريبًا» page lists announcements and applies the page filters without needing an offer', () => {
  const rows = [announced('a1'), announced('a2', { announcedById: 'store-b', brand: 'Other', sizeMl: 100 })];
  const ids = (filters) => Array.from(vm.runInContext('list()', coreCatalog([sale], { sec: 'soon', ...filters }, rows)), (x) => [x.p.id, x.b]);
  assert.deepEqual(ids({}), [['a1', null], ['a2', null]].sort(), 'the sale perfume with a "soon" flag on its offer is not listed here');
  assert.deepEqual(ids({ st: 'store-b' }), [['a2', null]]);
  assert.deepEqual(ids({ br: 'Brand' }), [['a1', null]]);
  assert.deepEqual(ids({ size: '100' }), [['a2', null]]);
  assert.deepEqual(ids({ min: '10' }), [], 'a price bound leaves announcements out');
  assert.deepEqual(Array.from(vm.runInContext('list()', coreCatalog([sale], { sec: '' }, rows)), (x) => x.p.id), ['sale-1'], 'the full catalog is still only what is on sale');
});
