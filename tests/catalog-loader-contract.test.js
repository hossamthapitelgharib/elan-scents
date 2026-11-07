const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const root = path.join(__dirname, '..');
const core = fs.readFileSync(path.join(root, 'app-core.js'), 'utf8');
const migration = fs.readFileSync(path.join(root, 'supabase/migrations/20261105122843_catalog_data_foundation.sql'), 'utf8');
const filterMigration = fs.readFileSync(path.join(root, 'supabase/migrations/20261106215242_catalog_offer_single_source_and_filter_rpc.sql'), 'utf8');
const promotionScopeMigration = fs.readFileSync(path.join(root, 'supabase/migrations/20261107022440_catalog_promotion_owner_scope.sql'), 'utf8');
const promotionScopeRollback = fs.readFileSync(path.join(root, 'supabase/rollback/20261107022440_catalog_promotion_owner_scope.sql'), 'utf8');
const editorCatalog = fs.readFileSync(path.join(root, 'railway/editor-catalog.js'), 'utf8');

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
  assert.match(core, /CATALOG_TAXONOMY_KEYS=\{cats:\['men','women','unisex'\],occ:\['daytime','evening','work','date','gift'\],notes:\['amber','citrus','woody','oud','cardamom'\]\}/);
  assert.match(core, /CATALOG_KEYED_LABELS=\{ar:/);
  assert.match(core, /'col\|'\+s\[0\]\+'\|'\+key/);
  assert.doesNotMatch(core, /sec\(c\.id\)\[3\]\[c\.i\]/, 'taxonomy labels and card order never supply filter values');
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
    F: { q: '', cat: 'men', oc: 'work', nt: 'oud', br: '', st: '', size: '', min: '', max: '', ind: '', sec: '', sort: 0 },
    PERFUMES: [
      { id: 'size-a', name: 'matching', brand: 'B', gender: 'men', occasionKeys: ['work'], noteKeys: ['oud'], globalOffer: { price: 12, avail: true, flags: [] }, allEligibleOffers: [] },
      { id: 'size-b', name: 'wrong occasion', brand: 'B', gender: 'men', occasionKeys: ['date'], noteKeys: ['oud'], globalOffer: { price: 12, avail: true, flags: [] }, allEligibleOffers: [] },
      { id: 'size-c', name: 'wrong gender', brand: 'B', gender: 'women', occasionKeys: ['work'], noteKeys: ['oud'], globalOffer: { price: 12, avail: true, flags: [] }, allEligibleOffers: [] }
    ],
    IND_SORT: {}, globalOffer: (p) => p.globalOffer
  });
  vm.runInContext(source, context);
  assert.deepEqual(Array.from(vm.runInContext('list()', context), (row) => row.p.name), ['matching']);
});


test('size filter is available in the storefront and matches the exact unified product size', () => {
  assert.match(core, /sel\('size',l\.sz,CATALOG_SIZE_OPTIONS\.map/);
  assert.match(core, /Number\(p\.sizeMl\)===Number\(F\.size\)/);
  const start = core.indexOf('function list()');
  const end = core.indexOf('\n', start);
  const rankedStart = core.indexOf('function ranked(');
  const rankedEnd = core.indexOf('\n', rankedStart);
  const context = vm.createContext({
    F: { q: '', cat: '', br: '', st: '', oc: '', nt: '', size: '50', min: '', max: '', ind: '', sec: '', sort: 0 },
    PERFUMES: [
      { id: 'size-50', name: '50 ml', sizeMl: 50, globalOffer: { price: 100, avail: true, flags: [] } },
      { id: 'size-100', name: '100 ml', sizeMl: 100, globalOffer: { price: 90, avail: true, flags: [] } }
    ],
    IND_SORT: {}, globalOffer: (p) => p.globalOffer
  });
  vm.runInContext(core.slice(rankedStart, rankedEnd) + '\n' + core.slice(start, end), context);
  assert.deepEqual(Array.from(vm.runInContext('list()', context), (row) => row.p.id), ['size-50']);
});

test('store pages use the same selected global offer contract, not the removed p.offers alias', () => {
  assert.doesNotMatch(core, /PERFUMES\.forEach\(function\(p\)\{p\.offers\.forEach/);
  assert.match(core, /var offer=globalOffer\(p\);if\(offer&&su&&String\(offer\.storeId\)===String\(su\[2\]\)\)bs\[p\.brand\]=1/);
  assert.match(core, /function counts\(\).*if\(globalOffer\(p\)\)/);
});

test('active promotions are scoped to the same store as the canonical offer, with least-privilege SQL', () => {
  assert.match(core, /offers\?select=product_size_id,store_id&order=product_size_id\.asc,store_id\.asc/);
  assert.match(core, /var promoOwner=\{\},topB=\{\};d\[13\]\.forEach/);
  assert.match(core, /promoOwner\[String\(r\.product_size_id\)\+'\|'\+String\(r\.store_id\)\]\?\['offers'\]:\[\]/);
  assert.match(core, /is_new_arrival,is_catalog_bestseller,is_coming_soon/);
  assert.match(core, /d\[14\]\.forEach\(function\(r\)\{if\(!r\.product_size_id\|\|!r\.store_id/);
  assert.match(promotionScopeMigration, /GRANT SELECT \(store_id\) ON TABLE public\.offers TO anon, authenticated;/);
  assert.match(promotionScopeRollback, /REVOKE SELECT \(store_id\) ON TABLE public\.offers FROM anon, authenticated;/);
  assert.doesNotMatch(core, /offers\?select=[^'\n]*(discount_value|description|title)/);
});

test('globalOffer is the same eligible row for price, store, and cart/order IDs', () => {
  const loaderStart = core.indexOf('async function loadData(){');
  const loaderEnd = core.indexOf('\nvar FT=', loaderStart);
  const loader = core.slice(loaderStart, loaderEnd);
  assert.match(loader, /allEligibleOffers:allOffers\[k\]\|\|\[\],globalOffer:globalOffer/);
  assert.match(loader, /offersByStore:offersByStore/);
  assert.doesNotMatch(loader, /offers:allOffers/);
  assert.match(loader, /String\(x\.storeProductId\)===String\(o\.store_product_id\)&&String\(x\.storeId\)===String\(o\.store_id\)&&x\.price===\+o\.price/);
  assert.match(loader, /duplicate_catalog_platform_offer_size/);
  assert.match(loader, /catalog_platform_offer_mismatch/);
  assert.match(core, /function globalOffer\(p\)\{if\(!p\|\|!Object\.prototype\.hasOwnProperty\.call\(p,'globalOffer'\)\)return null/);
  const offerLine = core.split('\n').find((line) => line.startsWith('function globalOffer('));
  assert.match(core, /function best\(p\)\{return globalOffer\(p\)\}/, 'legacy callers only delegate to the explicit canonical helper');
  assert.doesNotMatch(offerLine, /p\.offers\b/, 'the ambiguous legacy offers alias is not used to select or display a price');
  assert.doesNotMatch(fs.readFileSync(path.join(root, 'design-layer.js'), 'utf8'), /offersByStore/, 'store offer map is verification-only');
  assert.doesNotMatch(loader, /platformOffer:o|platformOffers:|allOffers:allOffers/);
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

test('editor taxonomy filters are one service-only EXISTS RPC and compatibility selectors delegate to the platform view', () => {
  assert.match(editorCatalog, /rpc\/catalog_filter_product_sizes/);
  assert.doesNotMatch(editorCatalog, /productIdsFor|platformOffers\(/);
  assert.match(filterMigration, /public\.catalog_filter_product_sizes/);
  assert.match(filterMigration, /EXISTS \(\s*SELECT 1 FROM public\.product_categories/);
  assert.match(filterMigration, /EXISTS \(\s*SELECT 1 FROM public\.product_occasions/);
  assert.match(filterMigration, /EXISTS \(\s*SELECT 1 FROM public\.product_notes/);
  assert.match(filterMigration, /JOIN public\.catalog_platform_offers offer ON offer\.product_size_id = ps\.id/);
  assert.match(filterMigration, /FROM public\.catalog_platform_offers AS offer/);
  assert.match(filterMigration, /REVOKE ALL ON FUNCTION public\.catalog_filter_product_sizes/);
  assert.match(filterMigration, /TO service_role/);
  assert.match(filterMigration, /idx_products_published_gender_brand/);
});
