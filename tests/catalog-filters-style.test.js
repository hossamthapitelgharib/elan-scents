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
  const context = vm.createContext({ lang, F: selected ? { ind: selected } : {}, PERFUMES: [{ ind }], T: () => ({ indNone: 'none' }),
    IND: { ar: { featured: 'الأكثر تميزًا', rating: 'الأعلى تقييمًا', sales: 'الأكثر مبيعًا', views: 'الأكثر مشاهدة', searches: 'الأكثر بحثًا', demand: 'الأكثر طلبًا', topBrand: 'أشهر عطور كل براند' }, en: {} } });
  vm.runInContext(core.slice(start, end), context);
  return vm.runInContext('chips()', context);
}

test('filter chips are small outlined pills with a line icon, not big gold buttons', () => {
  const html = renderChips(['featured', 'rating', 'sales', 'views', 'searches', 'demand', 'topBrand']);
  assert.equal((html.match(/<button/g) || []).length, 7);
  assert.equal((html.match(/<svg/g) || []).length, 7, 'every chip has its own icon');
  assert.match(html, /class="chip"/);
  assert.doesNotMatch(html, /class="btn"|style=/, 'no inline sizing and no gold gradient button class');
  assert.match(html, /data-ind="rating"[^>]*aria-pressed="false"/);
  const chip = rule('.chip');
  assert.doesNotMatch(chip, /gradient|box-shadow/);
  assert.match(chip, /border:1px solid/);
  assert.ok(Number(chip.match(/height:(\d+)px/)[1]) <= 36, 'compact');
  assert.ok(Number(chip.match(/font-size:([\d.]+)px/)[1]) <= 13.5, 'compact text');
});

test('the selected chip is marked for the eye and for assistive technology', () => {
  assert.match(renderChips(['rating', 'sales'], 'ar', 'rating'), /class="chip on" data-ind="rating" aria-pressed="true"/);
  assert.match(rule('.chip.on'), /background:var\(--btn-gold\)/, 'the selected chip is the gold of the contact form\'s send button');
  assert.match(core, /classList\.toggle\('on',on\);b\.setAttribute\('aria-pressed'/);
});

test('with no ranking data the chips row says so instead of showing empty pills', () => {
  assert.match(renderChips([]), /class="empty">none</);
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
  const start = core.indexOf('var IND_SORT=');
  const end = core.indexOf('\n', core.indexOf('function ranked('));
  const lstart = core.indexOf('function list()');
  const lend = core.indexOf('\n', lstart);
  const context = vm.createContext({ F: Object.assign({ q: '', cat: '', br: '', st: '', oc: '', nt: '', min: '', max: '', sort: 0, sec: 'master' }, filters), PERFUMES: items, best: (p) => p.offers[0] });
  vm.runInContext(core.slice(start, end) + '\n' + core.slice(lstart, lend), context);
  return vm.runInContext('list()', context).map((x) => x.p.name);
}
const mk = (name, brand, o) => Object.assign({ name, brand, rel: 0, ts: 0, cats: [], occs: [], notes: [], ind: [], offers: [{ price: 100, avail: true, flags: ['master'] }] }, o);

test('on the Masterpieces page a chip ranks as well as filters: the highest figure comes first', () => {
  const items = [
    mk('low', 'A', { ind: ['sales', 'views', 'topBrand'], sales: 10, views: 250, rel: 10 }),
    mk('top', 'B', { ind: ['sales', 'views', 'topBrand'], sales: 100, views: 25, rel: 100 }),
    mk('mid', 'B', { ind: ['sales', 'views'], sales: 50, views: 90, rel: 50 }),
    mk('none', 'C', { ind: [], rel: 5 })
  ];
  assert.deepEqual(ranking({ ind: 'sales' }, items), ['top', 'mid', 'low'], 'best sellers: by sales, high to low');
  assert.deepEqual(ranking({ ind: 'views' }, items), ['low', 'mid', 'top'], 'most viewed: by views, high to low (a different order, so the button visibly does something)');
  assert.deepEqual(ranking({ ind: 'topBrand' }, items), ['top', 'low'], 'each brand\'s best seller, the best selling first');
  assert.deepEqual(ranking({}, items), ['top', 'mid', 'low', 'none'], 'with no chip the usual order is kept');
});

test('every chip names the figure it ranks by, and the ranking does not touch the other pages', () => {
  const m = core.match(/var IND_SORT=\{([^}]*)\}/)[1];
  for (const k of ['sales', 'views', 'searches', 'demand', 'rating', 'topBrand']) assert.match(m, new RegExp('\\b' + k + ':'), k + ' ranks by its own figure');
  assert.match(core, /\(x\.id=='master'\?chips\(\):filterPanel\(l\)\)\+'<div id="res" class="grid"><\/div>'/, 'the Masterpieces page shows the chips and no filter panel; every other list page keeps its filters');
});
