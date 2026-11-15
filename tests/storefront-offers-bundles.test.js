// Offers (promotional messages), explicit discounts and bundles in the storefront (owner rules of 2026-11-14/15).
// An OFFER is a promotional message from the store and never changes a price; a DISCOUNT is an explicit declaration by the store (offers.kind, written by the
// server only); a number a store types as "price before / after" is never read. A bundle shows its cheapest eligible offer and, until the order flow is ready,
// has no way to be bought. Everything a store wrote is escaped.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const core = fs.readFileSync(path.join(__dirname, '..', 'app-core.js'), 'utf8');
const start = core.indexOf('/* Offers, explicit discounts and bundles');
const end = core.indexOf('\nfunction strip(id)', start);
const block = core.slice(start, end);
const escLine = core.split('\n').find((line) => line.startsWith('function esc('));

function sandbox({ lang = 'ar', F = { sec: '' }, offerFor = () => null } = {}) {
  const context = vm.createContext({ lang, F, platformEligibleOffer: offerFor, Math, Number, String, Date, isNaN, Object, Array });
  vm.runInContext(escLine + '\n' + block, context);
  return context;
}
const run = (context, code) => vm.runInContext(code, context);

const bundleRows = () => ({
  po: [
    { store_bundle_id: 'sb2', bundle_id: 'b2', store_id: 's2', store_name: 'متجر باء', price: '450.00', currency: 'EGP', stock_quantity: 2 },
    { store_bundle_id: 'sb1', bundle_id: 'b1', store_id: 's1', store_name: 'متجر ألف', price: '300.00', currency: 'EGP', stock_quantity: 5 },
    { store_bundle_id: 'sb3', bundle_id: 'b3', store_id: 's1', store_name: 'متجر ألف', price: '100.00', currency: 'EGP', stock_quantity: 0 },
    { store_bundle_id: 'sb4', bundle_id: 'b4', store_id: 's1', store_name: 'متجر ألف', price: '90.00', currency: 'USD', stock_quantity: 4 },
    { store_bundle_id: 'sb5', bundle_id: 'b5', store_id: 's1', store_name: 'متجر ألف', price: '80.00', currency: 'EGP', stock_quantity: 4 },
    { store_bundle_id: 'sb6', bundle_id: 'b1', store_id: 's2', store_name: 'متجر باء', price: '250.00', currency: 'EGP', stock_quantity: 4 }
  ],
  pb: [
    { id: 'b1', brand_name: 'ماركة', name: 'باقة <b>الهدايا</b>', has_extra_items: false },
    { id: 'b2', brand_name: null, name: 'باقة بقطعة إضافية', has_extra_items: true },
    { id: 'b3', brand_name: 'ماركة', name: 'نفدت', has_extra_items: false },
    { id: 'b4', brand_name: 'ماركة', name: 'دولار', has_extra_items: false },
    { id: 'b5', brand_name: 'ماركة', name: 'بلا بنود', has_extra_items: false }
  ],
  pi: [
    { bundle_id: 'b1', product_size_id: 'z1', quantity: 2, product_name: 'عطر <img src=x onerror=alert(1)>', size_label: '100 مل' },
    { bundle_id: 'b1', product_size_id: 'z2', quantity: 1, product_name: 'عطر ثان', size_label: '50 مل' },
    { bundle_id: 'b2', product_size_id: 'z1', quantity: 3, product_name: 'عطر ثالث', size_label: '' },
    { bundle_id: 'b3', product_size_id: 'z1', quantity: 1, product_name: 'x', size_label: '1' },
    { bundle_id: 'b4', product_size_id: 'z1', quantity: 1, product_name: 'x', size_label: '1' }
  ]
});

test('the block is the only place the storefront reads offers, bundles and discounts, and never touches a number a store typed', () => {
  assert.ok(block.length > 1000, 'the offers block is found between prodView and strip');
  assert.doesNotMatch(block, /discount_value|discount_type|discount_percentage|original_price|compare_at/, 'a claimed old price or discount number is never read');
  const loader = core.slice(core.indexOf('async function loadData(){'), core.indexOf('\nvar FT=', core.indexOf('async function loadData(){')));
  assert.doesNotMatch(loader, /original_price|discount_percentage|discount_value|discount_type/, 'the loader never asks for them');
  for (const view of ['catalog_platform_bundle_offers', 'public_bundles', 'public_bundle_items', 'catalog_offer_messages']) {
    assert.match(loader, new RegExp("ga\\('" + view + "\\?select=[^']*'\\)\\.catch\\(function\\(e\\)\\{console\\.error\\('[a-z_]+_unavailable',e&&e\\.message\\);return\\[\\]\\}\\)"), view + ' is requested and a failure leaves the page working');
  }
  assert.match(loader, /buildOfferData\(d\[17\],d\[18\],d\[19\],d\[20\]\)/);
  assert.match(core, /h\+=\(x\.id=='soon'\?'':x\.id=='master'\?chips\(\):filterPanel\(l\)\)\+'<div id="res" class="grid"><\/div>'\+\(x\.id=='offers'\?offersExtra\(\):''\)/, 'the bundles and store messages sit below the perfumes of «عروض وخصومات» only');
});

test('bundles: only real offers with items, one per bundle, cheapest first, no way to buy yet', () => {
  const c = sandbox();
  const { po, pb, pi } = bundleRows();
  c.__po = po; c.__pb = pb; c.__pi = pi;
  run(c, 'buildOfferData(__po,__pb,__pi,[])');
  assert.deepEqual(JSON.parse(run(c, 'JSON.stringify(BUNDLES.map(function(b){return[b.id,b.price,b.store]}))')), [['b1', 300, 'متجر ألف'], ['b2', 450, 'متجر باء']],
    'sold out, non-EGP, item-less rows never show; the first (cheapest, as the database ordered it) offer per bundle wins');
  const html = run(c, 'BUNDLES.map(bundleCard).join("")');
  assert.doesNotMatch(html, /data-add|cartb|<button|data-go/, 'a bundle card has no cart button and goes nowhere until the order flow is ready');
  assert.match(html, /<b>2×<\/b>/);
  assert.match(html, /<b>3×<\/b> عطر ثالث<\/li>/, 'an empty size label leaves no dangling separator');
  assert.match(html, /bextra/, 'a package with extra pieces says so');
  assert.equal((html.match(/bextra/g) || []).length, 1, 'only the package that has extra pieces');
  assert.match(html, /<span class="price">300<small>EGP<\/small><\/span>/);
});

test('everything a store wrote is escaped: bundle names, item names, store names, messages', () => {
  const c = sandbox({ offerFor: () => ({ storeId: 's1' }) });
  const { po, pb, pi } = bundleRows();
  c.__po = po; c.__pb = pb; c.__pi = pi;
  c.__om = [
    { offer_id: 'o1', store_id: 's1', store_name: 'متجر <script>x</script>', product_size_id: null, kind: 'offer', title: '<img src=x onerror=alert(1)>', description: '<b>x</b>', ends_at: null },
    { offer_id: 'o2', store_id: 's1', store_name: 'متجر ألف', product_size_id: 'z1', kind: 'offer', title: '"><svg onload=alert(1)>', description: '', ends_at: null }
  ];
  run(c, 'buildOfferData(__po,__pb,__pi,__om)');
  const all = run(c, 'BUNDLES.map(bundleCard).join("")+offersExtra()+offerNote({id:"z1"})');
  assert.doesNotMatch(all, /<img|<script|<svg|<b>الهدايا|<b>x<\/b>/, 'no markup from a store survives');
  assert.match(all, /&lt;img src=x onerror=alert\(1\)&gt;/);
});

test('messages: a perfume shows the message of the store whose offer it shows, discounts first, and nothing else', () => {
  const offer = { storeId: 's2', store: 'متجر باء', price: 80 };
  const c = sandbox({ offerFor: (p) => (p && p.id === 'z1' ? offer : null) });
  c.__om = [
    { offer_id: 'o1', store_id: 's1', store_name: 'متجر ألف', product_size_id: 'z1', kind: 'discount', title: 'خصم المتجر ألف', description: '', ends_at: null },
    { offer_id: 'o2', store_id: 's2', store_name: 'متجر باء', product_size_id: 'z1', kind: 'offer', title: 'هدية مع كل عبوة', description: 'غلاف هدايا', ends_at: null },
    { offer_id: 'o3', store_id: 's2', store_name: 'متجر باء', product_size_id: 'z1', kind: 'discount', title: 'خصم المتجر باء', description: '', ends_at: null },
    { offer_id: 'o4', store_id: 's2', store_name: 'متجر باء', product_size_id: 'z1', kind: 'sale', title: 'نوع غريب', description: '', ends_at: null },
    { offer_id: 'o5', store_id: 's2', store_name: 'متجر باء', product_size_id: 'zz', kind: 'offer', title: 'عطر آخر', description: '', ends_at: null },
    { offer_id: 'o6', store_id: 's2', store_name: 'متجر باء', product_size_id: null, kind: 'offer', title: 'شحن مجاني', description: '', ends_at: null },
    { offer_id: 'o7', store_id: null, store_name: '', product_size_id: 'z1', kind: 'offer', title: 'بلا متجر', description: '', ends_at: null },
    { offer_id: 'o8', store_id: 's2', store_name: 'متجر باء', product_size_id: 'z1', kind: 'offer', title: '', description: '', ends_at: null }
  ];
  run(c, 'buildOfferData([],[],[],__om)');
  assert.deepEqual(JSON.parse(run(c, 'JSON.stringify(offerMsgFor({id:"z1"}).map(function(m){return[m.id,m.kind]}))')), [['o3', 'discount'], ['o2', 'offer'], ['o4', 'offer']],
    'the other store\'s message is hidden, the discount comes first, an unknown kind is only an offer');
  assert.equal(run(c, 'offerMsgFor({id:"nobody"}).length'), 0, 'a perfume with no offer shows no message');
  assert.match(run(c, 'offerTag({id:"z1"})'), /otag otag-d">خصم</, 'an explicit discount is tagged «خصم» with no percentage');
  assert.equal(run(c, 'offerTag({id:"nobody"})'), '');
  assert.match(run(c, 'offerNote({id:"z1"})'), /هدية مع كل عبوة<\/span> <small>غلاف هدايا<\/small>/);
  assert.equal((run(c, 'offerNote({id:"z1"})').match(/class="pdo"/g) || []).length, 3, 'the page shows the three messages of its store');
  assert.deepEqual(JSON.parse(run(c, 'JSON.stringify(OFFER_MSGS.store.map(function(m){return m.title}))')), ['شحن مجاني'], 'a store-wide message has no perfume and is listed on the offers page');
  assert.doesNotMatch(run(c, 'offersExtra()'), /بلا متجر|عطر آخر/);
});

test('the card carries the message text only on the offers page; the tag shows everywhere', () => {
  const offer = { storeId: 's2', store: 'متجر باء', price: 80 };
  const msgs = [{ offer_id: 'o2', store_id: 's2', store_name: 'متجر باء', product_size_id: 'z1', kind: 'offer', title: 'هدية مع كل عبوة', description: '', ends_at: null }];
  const home = sandbox({ F: { sec: '' }, offerFor: () => offer });
  home.__om = msgs; run(home, 'buildOfferData([],[],[],__om)');
  assert.match(run(home, 'offerTag({id:"z1"})'), /otag/);
  assert.equal(run(home, 'offerLine({id:"z1"})'), '');
  const page = sandbox({ F: { sec: 'offers' }, offerFor: () => offer });
  page.__om = msgs; run(page, 'buildOfferData([],[],[],__om)');
  assert.equal(run(page, 'offerLine({id:"z1"})'), '<p class="pmsg">هدية مع كل عبوة</p>');
  const bare = vm.createContext({ lang: 'ar', platformEligibleOffer: () => offer, Math, Number, String, Date, isNaN, Object, Array });
  vm.runInContext(escLine + '\n' + block, bare);
  assert.equal(vm.runInContext('offerLine({id:"z1"})', bare), '', 'with no filter state at all the line is simply absent');
});

test('the end date is shown as day/month, and the English page speaks English', () => {
  const c = sandbox({ lang: 'en' });
  c.__om = [{ offer_id: 'o1', store_id: 's1', store_name: 'Store', product_size_id: null, kind: 'offer', title: 'Free shipping', description: '', ends_at: '2026-12-24T10:00:00Z' }];
  run(c, 'buildOfferData([],[],[],__om)');
  const html = run(c, 'offersExtra()');
  assert.match(html, /<h4 class="pdh osec">Store offers<\/h4>/);
  assert.match(html, /<h4 class="pdh osec">Bundles<\/h4>/);
  assert.match(html, /No bundles available right now/);
  assert.match(html, /Until 24\/12/);
});

test('with no data at all the offers page still renders (nothing breaks when the new views are unavailable)', () => {
  const c = sandbox();
  run(c, 'buildOfferData(undefined,undefined,undefined,undefined)');
  assert.equal(run(c, 'BUNDLES.length'), 0);
  assert.match(run(c, 'offersExtra()'), /لا توجد باقات متاحة الآن/);
  assert.doesNotMatch(run(c, 'offersExtra()'), /osec">عروض المتاجر/, 'no store-message heading when there is no message');
});
