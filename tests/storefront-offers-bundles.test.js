// Bundles and offers in the storefront (owner rules of 2026-11-14/15 and the agreement of 2026-11-17): the page is «باقات وعروض».
// An OFFER is a promotional message from the store and never changes a price; the platform has NO discount concept (the word is gone from the storefront and a
// perfume is never tagged or ranked by one); a number a store types as "price before / after" is never read. A bundle shows its cheapest eligible offer and,
// until the order flow is ready, has no way to be bought. Everything a store wrote is escaped.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const core = fs.readFileSync(path.join(__dirname, '..', 'app-core.js'), 'utf8');
const start = core.indexOf('/* Bundles and offers');
const end = core.indexOf('\nfunction strip(id)', start);
const block = core.slice(start, end);
const escLine = core.split('\n').find((line) => line.startsWith('function esc('));

function sandbox({ lang = 'ar', F = { sec: '' }, offerFor = () => null } = {}) {
  const context = vm.createContext({ lang, F, platformEligibleOffer: offerFor, Math, Number, String, Date, isNaN, Object, Array });
  vm.runInContext(escLine + '\n' + block, context);
  return context;
}
const run = (context, code) => vm.runInContext(code, context);

// A bundle row has the STORE's own title and description and its pieces are plain text (brand, name, size in ml): no link to the perfume catalog.
const bundleRows = () => ({
  po: [
    { store_bundle_id: 'sb2', bundle_id: 'b2', store_id: 's2', store_name: 'متجر باء', title: 'باقة بقطعة إضافية', description: null, price: '450.00', currency: 'EGP', stock_quantity: 2 },
    { store_bundle_id: 'sb1', bundle_id: 'b1', store_id: 's1', store_name: 'متجر ألف', title: 'باقة <b>الهدايا</b>', description: 'السطر الأول\nالسطر الثاني <script>x</script>', price: '300.00', currency: 'EGP', stock_quantity: 5 },
    { store_bundle_id: 'sb3', bundle_id: 'b3', store_id: 's1', store_name: 'متجر ألف', title: 'نفدت', description: '', price: '100.00', currency: 'EGP', stock_quantity: 0 },
    { store_bundle_id: 'sb4', bundle_id: 'b4', store_id: 's1', store_name: 'متجر ألف', title: 'دولار', description: '', price: '90.00', currency: 'USD', stock_quantity: 4 },
    { store_bundle_id: 'sb5', bundle_id: 'b5', store_id: 's1', store_name: 'متجر ألف', title: 'بلا بنود', description: '', price: '80.00', currency: 'EGP', stock_quantity: 4 },
    { store_bundle_id: 'sb6', bundle_id: 'b1', store_id: 's2', store_name: 'متجر باء', title: 'عنوان متجر باء', description: 'وصف آخر', price: '250.00', currency: 'EGP', stock_quantity: 4 }
  ],
  pb: [
    { id: 'b1', brand_name: 'ماركة', name: 'اسم داخلي', has_extra_items: false },
    { id: 'b2', brand_name: null, name: 'باقة بقطعة إضافية (اسم المنصة)', has_extra_items: true },
    { id: 'b3', brand_name: 'ماركة', name: 'نفدت', has_extra_items: false },
    { id: 'b4', brand_name: 'ماركة', name: 'دولار', has_extra_items: false },
    { id: 'b5', brand_name: 'ماركة', name: 'بلا بنود', has_extra_items: false }
  ],
  pi: [
    { bundle_id: 'b1', quantity: 2, brand_name: 'ماركة', product_name: 'عطر <img src=x onerror=alert(1)>', size_ml: 100 },
    { bundle_id: 'b1', quantity: 1, brand_name: null, product_name: 'عطر ثان', size_ml: 30 },
    { bundle_id: 'b1', quantity: 1, brand_name: 'ماركة', product_name: '', size_ml: 5 },
    { bundle_id: 'b2', quantity: 3, brand_name: null, product_name: 'عطر ثالث', size_ml: null },
    { bundle_id: 'b3', quantity: 1, brand_name: null, product_name: 'x', size_ml: 1 },
    { bundle_id: 'b4', quantity: 1, brand_name: null, product_name: 'x', size_ml: 1 }
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

test('bundles: only real offers with pieces, one per bundle, cheapest first, no way to buy yet', () => {
  const c = sandbox();
  const { po, pb, pi } = bundleRows();
  c.__po = po; c.__pb = pb; c.__pi = pi;
  run(c, 'buildOfferData(__po,__pb,__pi,[])');
  assert.deepEqual(JSON.parse(run(c, 'JSON.stringify(BUNDLES.map(function(b){return[b.id,b.price,b.store]}))')), [['b1', 300, 'متجر ألف'], ['b2', 450, 'متجر باء']],
    'sold out, non-EGP, piece-less rows never show; the first (cheapest, as the database ordered it) offer per bundle wins');
  const html = run(c, 'BUNDLES.map(bundleCard).join("")');
  assert.doesNotMatch(html, /data-add|cartb|<button|data-go/, 'a bundle card has no cart button and goes nowhere until the order flow is ready');
  assert.match(html, /<b>2×<\/b> <span class="bbr">ماركة<\/span> عطر .* · 100 مل<\/li>/, 'a piece shows its quantity, brand, name and size exactly as the store listed it');
  assert.match(html, /<b>1×<\/b> عطر ثان · 30 مل<\/li>/, 'a piece with no brand shows no empty brand tag');
  assert.match(html, /<b>3×<\/b> عطر ثالث<\/li>/, 'a piece with no size leaves no dangling separator');
  assert.equal((html.match(/<li><b>/g) || []).length, 3, 'a piece with no name is skipped');
  assert.match(html, /bextra/, 'a package with extra pieces says so');
  assert.equal((html.match(/bextra/g) || []).length, 1, 'only the package that has extra pieces');
  assert.match(html, /<span class="price">300<small>EGP<\/small><\/span>/);
});

test('a bundle is shown with the store\'s OWN title and its FULL description, never a platform wording', () => {
  const c = sandbox();
  const { po, pb, pi } = bundleRows();
  c.__po = po; c.__pb = pb; c.__pi = pi;
  run(c, 'buildOfferData(__po,__pb,__pi,[])');
  const html = run(c, 'BUNDLES.map(bundleCard).join("")');
  assert.match(html, /<h4>باقة &lt;b&gt;الهدايا&lt;\/b&gt;<\/h4>/, 'the title is the store\'s, not the platform\'s internal name');
  assert.doesNotMatch(html, /اسم داخلي|عنوان متجر باء/, 'neither the platform name nor the title of a store whose offer is not shown');
  assert.match(html, /<h4>باقة بقطعة إضافية<\/h4>/);
  assert.match(html, /<details class="bdesc"><summary>تفاصيل الباقة كما كتبها المتجر<\/summary><div class="btext">السطر الأول\nالسطر الثاني &lt;script&gt;x&lt;\/script&gt;<\/div><\/details>/,
    'the description is kept whole, with its line breaks, escaped, behind one closed details block');
  assert.equal((html.match(/<details/g) || []).length, 1, 'a bundle whose store wrote no description has no details block');
  const noTitle = sandbox();
  noTitle.__po = [{ store_bundle_id: 'x', bundle_id: 'b1', store_id: 's1', store_name: 'متجر', title: null, description: null, price: '10', currency: 'EGP', stock_quantity: 1 }];
  noTitle.__pb = [pb[0]]; noTitle.__pi = [pi[0]];
  run(noTitle, 'buildOfferData(__po,__pb,__pi,[])');
  assert.match(run(noTitle, 'BUNDLES.map(bundleCard).join("")'), /<h4>اسم داخلي<\/h4>/, 'only if the offer carries no title at all does the card fall back to the bundle\'s own name');
});

test('everything a store wrote is escaped: bundle titles, descriptions, pieces, store names, messages', () => {
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

test('messages: a perfume shows the message of the store whose offer it shows, and nothing else', () => {
  const offer = { storeId: 's2', store: 'متجر باء', price: 80 };
  const c = sandbox({ offerFor: (p) => (p && p.id === 'z1' ? offer : null) });
  c.__om = [
    { offer_id: 'o1', store_id: 's1', store_name: 'متجر ألف', product_size_id: 'z1', title: 'عرض المتجر ألف', description: '', ends_at: null },
    { offer_id: 'o2', store_id: 's2', store_name: 'متجر باء', product_size_id: 'z1', title: 'هدية مع كل عبوة', description: 'غلاف هدايا', ends_at: null },
    { offer_id: 'o3', store_id: 's2', store_name: 'متجر باء', product_size_id: 'z1', title: 'شحن مجاني', description: '', ends_at: null },
    { offer_id: 'o4', store_id: 's2', store_name: 'متجر باء', product_size_id: 'z1', title: 'عينة مع الطلب', description: '', ends_at: null },
    { offer_id: 'o5', store_id: 's2', store_name: 'متجر باء', product_size_id: 'zz', title: 'عطر آخر', description: '', ends_at: null },
    { offer_id: 'o6', store_id: 's2', store_name: 'متجر باء', product_size_id: null, title: 'توصيل لكل المحافظات', description: '', ends_at: null },
    { offer_id: 'o7', store_id: null, store_name: '', product_size_id: 'z1', title: 'بلا متجر', description: '', ends_at: null },
    { offer_id: 'o8', store_id: 's2', store_name: 'متجر باء', product_size_id: 'z1', title: '', description: '', ends_at: null }
  ];
  run(c, 'buildOfferData([],[],[],__om)');
  assert.deepEqual(JSON.parse(run(c, 'JSON.stringify(offerMsgFor({id:"z1"}).map(function(m){return m.id}))')), ['o2', 'o3', 'o4'],
    'the other store\'s message is hidden, and a message with no store or no title is dropped');
  assert.equal(run(c, 'offerMsgFor({id:"nobody"}).length'), 0, 'a perfume with no offer shows no message');
  assert.equal(run(c, 'offerTag({id:"z1"})'), '<span class="otag">عرض</span>', 'every message is tagged «عرض», nothing else');
  assert.equal(run(c, 'offerTag({id:"nobody"})'), '');
  assert.match(run(c, 'offerNote({id:"z1"})'), /هدية مع كل عبوة<\/span> <small>غلاف هدايا<\/small>/);
  assert.equal((run(c, 'offerNote({id:"z1"})').match(/class="pdo"/g) || []).length, 3, 'the page shows the three messages of its store');
  assert.deepEqual(JSON.parse(run(c, 'JSON.stringify(OFFER_MSGS.store.map(function(m){return m.title}))')), ['توصيل لكل المحافظات'], 'a store-wide message has no perfume and is listed on the offers page');
  assert.doesNotMatch(run(c, 'offersExtra()'), /بلا متجر|عطر آخر/);
});

test('the word «خصم» is gone from the storefront: the page is «باقات وعروض» and no code path tags, sorts or reads a discount', () => {
  const code = block.slice(block.indexOf('*/') + 2);
  assert.doesNotMatch(code, /خصم|discount|otag-d/i, 'the offers block has no discount tag, sort or column');
  assert.doesNotMatch(core, /otag-d|ou\(\)\.discount|kind==='discount'/, 'the storefront never branches on a discount');
  const texts = fs.readFileSync(path.join(__dirname, '..', 'texts.js'), 'utf8');
  assert.doesNotMatch(texts, /عروض وخصومات|Offers & Discounts/, 'the old title is gone from both languages');
  assert.equal((texts.match(/باقات وعروض/g) || []).length, 2, 'the Arabic menu entry and the Arabic section title');
  assert.equal((texts.match(/Bundles & Offers/g) || []).length, 2, 'the English menu entry and the English section title');
  assert.doesNotMatch(fs.readFileSync(path.join(__dirname, '..', 'style-3.css'), 'utf8'), /\.otag-d/, 'the discount style is gone');
  assert.match(core, /catalog_offer_messages\?select=offer_id,store_id,store_name,product_size_id,title,description,ends_at/, 'the storefront no longer reads the kind column');
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

test('the English page says «ml» and the details label in English', () => {
  const c = sandbox({ lang: 'en' });
  const { po, pb, pi } = bundleRows();
  c.__po = po; c.__pb = pb; c.__pi = pi;
  run(c, 'buildOfferData(__po,__pb,__pi,[])');
  const html = run(c, 'BUNDLES.map(bundleCard).join("")');
  assert.match(html, / · 100 ml<\/li>/);
  assert.match(html, /<summary>The bundle details, as written by the store<\/summary>/);
});

test('the storefront asks for exactly the columns of the stand-alone bundle views and builds pieces without any catalog id', () => {
  const loader = core.slice(core.indexOf('async function loadData(){'), core.indexOf('\nvar FT=', core.indexOf('async function loadData(){')));
  assert.ok(loader.includes("ga('catalog_platform_bundle_offers?select=store_bundle_id,bundle_id,store_id,store_name,title,description,price,currency,stock_quantity,price_includes_tax,price_includes_shipping&order=bundle_id.asc')"));
  assert.ok(loader.includes("ga('public_bundles?select=id,brand_name,name,slug,has_extra_items&order=id.asc')"));
  assert.ok(loader.includes("ga('public_bundle_items?select=bundle_id,quantity,brand_name,product_name,size_ml&order=bundle_id.asc,product_name.asc,size_ml.asc')"));
  const line = block.split('\n').find((l) => l.startsWith('(pi||[]).forEach('));
  assert.ok(line, 'the piece-building line is found');
  assert.doesNotMatch(line, /product_size_id|size_label/, 'a piece has no link to the perfume catalog');
});
