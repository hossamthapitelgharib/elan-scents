const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const root = path.join(__dirname, '..');
const read = (file) => fs.readFileSync(path.join(root, file), 'utf8');
const core = read('app-core.js');
const css = read('style-3.css');
const rule = (selector) => {
  const found = css.match(new RegExp('(?:^|\\n)' + selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '\\{[^}]*\\}'));
  assert.ok(found, selector + ' must be styled');
  return found[0];
};

// Runs the real chips() from app-core.js with a tiny catalog.
function renderChips(ind, lang = 'ar', selected) {
  const start = core.indexOf('var CHIPICON=');
  const end = core.indexOf('\n', core.indexOf('function chips()'));
  const indSource = core.match(/var IND=\{ar:\{[^\n]*\}\};/)[0]; // the real labels, both languages
  const context = vm.createContext({ lang, F: selected ? { ind: selected } : {}, PERFUMES: [{ ind }], T: () => ({ indNone: 'none' }) });
  vm.runInContext(indSource + '\n' + core.slice(start, end), context);
  return vm.runInContext('chips()', context);
}

test('filter chips are small outlined pills with a line icon, not big gold buttons', () => {
  const html = renderChips(['rated', 'sales', 'views', 'searches']);
  assert.equal((html.match(/<button/g) || []).length, 4);
  assert.equal((html.match(/<svg/g) || []).length, 4, 'every chip has its own icon');
  assert.match(html, /class="chip"/);
  assert.doesNotMatch(html, /class="btn"|style=/, 'no inline sizing and no gold gradient button class');
  assert.match(html, /data-ind="sales"[^>]*aria-pressed="false"/);
  const chip = rule('.chip');
  assert.doesNotMatch(chip, /gradient|box-shadow/);
  assert.match(chip, /border:1px solid/);
  assert.ok(Number(chip.match(/height:(\d+)px/)[1]) <= 36, 'compact');
  assert.ok(Number(chip.match(/font-size:([\d.]+)px/)[1]) <= 13.5, 'compact text');
});

test('the selected chip is marked for the eye and for assistive technology', () => {
  assert.match(renderChips(['rated', 'sales'], 'ar', 'sales'), /class="chip on" data-ind="sales" aria-pressed="true"/);
  assert.match(rule('.chip.on'), /background:var\(--btn-gold\)/, 'the selected chip is the gold of the contact form\'s send button');
  assert.match(core, /classList\.toggle\('on',on\);b\.setAttribute\('aria-pressed'/);
});

test('the four ranking buttons are always there, in the agreed order, whatever the data says', () => {
  const keys = (html) => [...html.matchAll(/data-ind="([^"]+)"/g)].map((m) => m[1]);
  assert.deepEqual(keys(renderChips([])), ['rated', 'sales', 'views', 'searches'], 'no data at all: the same four buttons');
  assert.deepEqual(keys(renderChips(['sales'])), ['rated', 'sales', 'views', 'searches'], 'some data: still the same four');
  assert.doesNotMatch(renderChips(['featured', 'rating', 'demand', 'topBrand']), /data-ind="(featured|rating|demand|topBrand)"/, 'no other button');
  assert.doesNotMatch(renderChips([]), /class="empty"/, 'no «indicators appear when available» message instead of the buttons');
  assert.match(renderChips([], 'en'), /Most rated[\s\S]*Best sellers[\s\S]*Most viewed[\s\S]*Most searched/);
  assert.match(renderChips([]), /الأكثر تقييمًا[\s\S]*الأكثر مبيعًا[\s\S]*الأكثر مشاهدة[\s\S]*الأكثر بحثًا/, 'the fourth button is «الأكثر تقييمًا» (it was «أشهر عطور كل براند»)');
  assert.doesNotMatch(core, /topBrand|أشهر عطور كل براند|Top of each brand/, 'the old fourth button is gone everywhere');
});

test('a ranking with no perfumes says so; it never hides its button', () => {
  assert.match(core, /\(F\.ind\?l\.noneInd:l\.none\)/, 'results() uses the ranking message when a button is selected');
  assert.match(core, /noneInd:'لا توجد عطور في هذا التصنيف حاليًا'/);
  assert.match(core, /noneInd:'No perfumes in this ranking yet'/);
});

test('the filter panel has its own quiet styling: compact header, line icons, styled fields', () => {
  assert.match(core, /class="filter-ico"/);
  assert.match(core, /class="filter-chev"/);
  assert.match(core, /data-filter-reset/);
  for (const selector of ['.filter-panel', '.filter-head', '.filter-body', '.filter-grid', '.filter-chev']) rule(selector);
  assert.match(css, /\.filter-panel input,\.filter-panel select\{[^}]*height:40px/);
  assert.match(css, /\.filter-panel select\{[^}]*appearance|\.filter-panel select\{[^}]*background-image/);
  assert.doesNotMatch(rule('.filter-panel'), /box-shadow|gradient/);
  assert.match(css, /\[dir=rtl\] \.filter-panel select\{background-position:left/);
  assert.match(css, /\[dir=ltr\] \.filter-panel select\{background-position:right/);
  assert.match(css, /\.filter-panel\[open\] \.filter-chev/);
});

test('the old unused filter styles are gone and the product grid keeps stretching its cards', () => {
  assert.doesNotMatch(css, /\.flt-head|\.filter-field|\.filter-count|\.filter-reset/);
  assert.match(css, /#res\.grid\{align-items:stretch\}/);
  assert.match(css, /@media\(min-width:680px\)\{#res\.grid,[^{]*\{grid-template-columns:repeat\(auto-fill,var\(--cw\)\)/, 'wide screens keep one fixed card width');
});

test('the selected chip and the contact form\'s «إرسال» button are the very same gold', () => {
  const root = css.match(/:root\{[^}]*\}/)[0];
  const gold = root.match(/--btn-gold:([^;]+(?:\)[^;]*)?);--btn-shadow/);
  assert.ok(gold, 'one shared gradient is declared on :root');
  assert.match(rule('.btn'), /background:var\(--btn-gold\)/);
  assert.match(rule('.chip.on'), /background:var\(--btn-gold\)/);
  assert.match(rule('.chip.on'), /color:#fff/, 'white text like the send button');
  assert.match(rule('.chip.on svg'), /color:#fff/, 'and a white icon');
  assert.doesNotMatch(css, /\.chip\.on\{[^}]*#2b2418/, 'the dark brown selected state is gone');
});

// Runs the real list()/ranked() from app-core.js over a small catalog.
function ranking(filters, items) {
  const chipsList = core.match(/var MASTER_CHIPS=\[[^\]]*\];/)[0];
  const start = core.indexOf('function ranked(');
  const end = core.indexOf('\n', start);
  const lstart = core.indexOf('function list()');
  const lend = core.indexOf('\n', lstart);
  const context = vm.createContext({ F: Object.assign({ q: '', cat: '', br: '', st: '', oc: '', nt: '', size: '', min: '', max: '', sort: 0, sec: 'master' }, filters), PERFUMES: items, globalOffer: (p) => p.globalOffer });
  vm.runInContext(chipsList + '\n' + core.slice(start, end) + '\n' + core.slice(lstart, lend), context);
  return vm.runInContext('list()', context).map((x) => x.p.name);
}
const mk = (name, brand, o) => Object.assign({ name, brand, sizeMl: 50, rel: 0, ts: 0, cats: [], occs: [], notes: [], ind: [], globalOffer: { price: 100, avail: true, flags: ['master'] } }, o);

test('the customer filter panel exposes the available product sizes', () => {
  assert.match(core, /sel\('size',l\.sz,CATALOG_SIZE_OPTIONS\.map/);
  assert.match(core, /CATALOG_SIZE_OPTIONS=Array\.from\(new Set\(PERFUMES\.map/);
  assert.match(core, /F\.size===''\|\|Number\(p\.sizeMl\)===Number\(F\.size\)/);
  assert.match(core, /sz:'الحجم'/);
  assert.match(core, /sz:'Size'/);
});

test('on the Masterpieces page a chip ranks as well as filters: rank 1 comes first', () => {
  // rk = the rank the database gives each perfume per button (1 = first); a perfume outside a button has no rank there
  const items = [
    mk('low', 'A', { ind: ['sales', 'views', 'rated'], rk: { sales: 3, views: 1, rated: 2 }, rel: 10 }),
    mk('top', 'B', { ind: ['sales', 'views', 'rated'], rk: { sales: 1, views: 3, rated: 1 }, rel: 100 }),
    mk('mid', 'B', { ind: ['sales', 'views'], rk: { sales: 2, views: 2 }, rel: 50 }),
    mk('none', 'C', { ind: [], rk: {}, rel: 5 })
  ];
  assert.deepEqual(ranking({ ind: 'sales' }, items), ['top', 'mid', 'low'], 'best sellers: rank 1 first');
  assert.deepEqual(ranking({ ind: 'views' }, items), ['low', 'mid', 'top'], 'most viewed: a different order, so the button visibly does something');
  assert.deepEqual(ranking({ ind: 'rated' }, items), ['top', 'low'], 'most rated: only the perfumes that have a rating rank, best first');
  assert.deepEqual(ranking({ ind: 'searches' }, items), [], 'nobody has a search rank: an empty ranking, not everybody');
  assert.deepEqual(ranking({}, items), ['top', 'mid', 'low', 'none'], 'with no chip the usual order is kept');
  const tie = [mk('b-tie', 'A', { ind: ['sales'], rk: { sales: 1 }, rel: 1 }), mk('a-tie', 'A', { ind: ['sales'], rk: { sales: 1 }, rel: 9 })];
  assert.deepEqual(ranking({ ind: 'sales' }, tie), ['a-tie', 'b-tie'], 'equal ranks fall back to the usual order');
});

test('the four tags and the ranks come from the database ranking view, never from a number typed in a table', () => {
  assert.doesNotMatch(core, /IND_SORT/, 'no per-chip figure map any more');
  assert.match(core, /ga\('storefront_product_rankings\?select=product_id,sales_rank,views_rank,searches_rank,rating_rank&order=product_id\.asc'\)\.catch\(/, 'loaded from the rankings view; a failure there must not take the catalog down');
  assert.match(core, /d\[15\]\.forEach\(function\(r\)\{rk\[r\.product_id\]=\{sales:r\.sales_rank,views:r\.views_rank,searches:r\.searches_rank,rated:r\.rating_rank\}\}\)/);
  assert.match(core, /var indOf=function\(p\)\{var r=rk\[p\.id\]\|\|\{\},a=\[\];MASTER_CHIPS\.forEach\(function\(k\)\{if\(r\[k\]!=null\)a\.push\(k\)\}\);return a\};/);
  // the real indOf over a small ranking table
  const chipsList = core.match(/var MASTER_CHIPS=\[[^\]]*\];/)[0];
  const indOfSrc = core.match(/var indOf=function\(p\)\{[^\n]*?return a\};/)[0];
  const context = vm.createContext({ rk: { p1: { sales: 1, views: null, searches: undefined, rated: 4 }, p2: {} } });
  vm.runInContext(chipsList + indOfSrc, context);
  const tags = (id) => Array.from(vm.runInContext('indOf({id:' + JSON.stringify(id) + '})', context));
  assert.deepEqual(tags('p1'), ['rated', 'sales'], 'only the buttons the perfume has a rank in');
  assert.deepEqual(tags('p2'), [], 'a perfume without any rank is in no button');
  assert.deepEqual(tags('nobody'), [], 'and neither is one the ranking has never heard of');
  assert.doesNotMatch(indOfSrc, /sales_count|views_count|search_count|request_count|average_rating/, 'the seed figures of public_products decide nothing about the buttons');
});

test('every chip ranks by its own database rank, and the ranking does not touch the other pages', () => {
  assert.match(core, /var MASTER_CHIPS=\['rated','sales','views','searches'\];/);
  assert.match(core, /function ranked\(by\)\{var k=MASTER_CHIPS\.indexOf\(F\.ind\)>-1\?F\.ind:'';return k\?function\(a,b\)\{return\(\(\(a\.p\.rk\|\|\{\}\)\[k\]\|\|1e9\)-\(\(b\.p\.rk\|\|\{\}\)\[k\]\|\|1e9\)\)\|\|by\(a,b\)\}:by\}/);
  assert.match(core, /\(x\.id=='master'\?chips\(\):filterPanel\(l\)\)\+'<div id="res" class="grid"><\/div>'/, 'the Masterpieces page shows the chips and no filter panel; every other list page keeps its filters');
});
