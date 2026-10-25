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
  assert.match(css, /\.chip\.on\{[^}]*background:#2b2418/);
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
  assert.match(css, /@media\(min-width:1000px\)\{#res\.grid,[^{]*\{grid-template-columns:repeat\(6/);
});
