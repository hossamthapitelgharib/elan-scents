/* Header and strip colours that follow the hero, the black tagline, no gold lines between sections, no empty pill under "Contact us",
   and the phone field on the right of the Arabic form. */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const root = path.join(__dirname, '..');
const read = (file) => fs.readFileSync(path.join(root, file), 'utf8');
const index = read('index.html');
const core = read('app-core.js');
const base = read('style-3.css');
const top = read('style.css');

function tone({ heroBottom, headerTop = 40, headerHeight = 54, hero = true, classes = [] }) {
  const set = new Set(classes), changes = [];
  const body = { classList: { contains: (c) => set.has(c), toggle: (c, on) => { changes.push(c); if (on) set.add(c); else set.delete(c); } } };
  const document = {
    body,
    getElementById: (id) => (id === 'hero' && hero ? { getBoundingClientRect: () => ({ bottom: heroBottom }) } : null),
    querySelector: (selector) => (selector === 'header' ? { getBoundingClientRect: () => ({ top: headerTop, height: headerHeight }) } : null),
  };
  const fn = core.match(/function hdTone\(\)\{[\s\S]*?\n(?=addEventListener)/)[0];
  vm.runInNewContext(fn + ';hdTone()', { document });
  return { set, changes };
}

test('the header turns gold when the hero ends under its middle, the strip when the hero ends under the strip', () => {
  // header middle = 40 + 27 = 67
  assert.deepEqual([...tone({ heroBottom: 600 }).set].sort(), ['bar-over', 'hd-over']);
  assert.deepEqual([...tone({ heroBottom: 80 }).set].sort(), ['bar-over', 'hd-over']);
  assert.deepEqual([...tone({ heroBottom: 50 }).set].sort(), ['bar-over'], 'header already below the hero, the strip still over it');
  assert.deepEqual([...tone({ heroBottom: 10 }).set], [], 'both below the hero: gold');
  assert.deepEqual([...tone({ heroBottom: -3000 }).set], [], 'far down the page and over the footer: gold');
});

test('no hero in the page (inner pages hide it) means gold, and nothing is touched when the state did not change', () => {
  assert.deepEqual([...tone({ hero: false, classes: ['hd-over', 'bar-over'] }).set].sort(), ['bar-over', 'hd-over'], 'no hero element at all: left as it was, never thrown');
  assert.deepEqual([...tone({ heroBottom: 0, classes: ['hd-over', 'bar-over'] }).set], [], 'a hidden hero reports 0: gold');
  assert.deepEqual(tone({ heroBottom: 600, classes: ['hd-over', 'bar-over'] }).changes, [], 'same state: no class write, so the observer cannot loop');
});

test('hdTone runs on scroll, resize, load and when the body class changes (inner page opens or closes)', () => {
  assert.match(core, /ly=y;hdTone\(\)\},\{passive:true\}\);addEventListener\('resize',hdTone\);addEventListener\('load',hdTone\);/);
  assert.match(core, /new MutationObserver\(hdTone\)\.observe\(document\.body,\{attributes:true,attributeFilter:\['class'\]\}\)/);
});

test('header icons, EN and the strip are white only with a hero that has media, and the gold gradient otherwise', () => {
  assert.match(index, /<linearGradient id="gh" gradientUnits="userSpaceOnUse"/);
  assert.match(base, /body:has\(#gh\) header \.ic svg\{stroke:url\(#gh\)\}/);
  assert.match(base, /body\.hd-over:not\(\.inner\):has\(#hero\[data-media\]\) header \.ic svg\{stroke:#fff\}/);
  assert.match(base, /body\.hd-over:not\(\.inner\):has\(#hero\[data-media\]\) header #lg\{[^}]*-webkit-text-fill-color:#fff/);
  assert.match(base, /body\.bar-over:not\(\.inner\):has\(#hero\[data-media\]\) #bar \.gold\{[^}]*-webkit-text-fill-color:#fff/);
  assert.match(base, /#lg\{background:linear-gradient\([^}]*background-clip:text/);
  const headerHtml = index.slice(index.indexOf('<header>'), index.indexOf('</header>'));
  assert.doesNotMatch(headerHtml, /url\(#gh\)/, 'the gradient comes from CSS so pages without #gh keep their currentColor icons');
});

test('the tagline is plain black in the header, the menu page and the About section', () => {
  const rule = base.match(/header \.logo small,#menu \.logo small,\.alogo \.logo small\{[^}]*\}/)[0];
  assert.match(rule, /color:#000!important/);
  assert.match(rule, /-webkit-text-fill-color:#000!important/);
  assert.match(rule, /background:none!important/);
  assert.match(rule, /filter:none!important/);
  assert.match(rule, /text-shadow:none!important/);
  assert.doesNotMatch(rule, /footer/);
});

test('no gold hairline before each section and no gold border on top of the footer', () => {
  assert.doesNotMatch(base + top, /section\+section:before/);
  for (const css of [base, top]) {
    for (const rule of css.match(/(?:^|\})\s*footer\s*\{[^}]*\}/g) || []) assert.doesNotMatch(rule, /border-top:\s*1px/, rule);
  }
});

test('the contact section has no empty pill under its title, and the phone field sits on the right', () => {
  const contact = index.slice(index.indexOf('<section id="contact">'), index.indexOf('</section>', index.indexOf('<section id="contact">')));
  assert.match(contact, /<h3 data-i="contactT"><\/h3>\s*<form/);
  assert.doesNotMatch(contact, /class="sub"/);
  assert.match(base, /\[dir=rtl\] input\[type=tel\]\{direction:ltr;text-align:right\}/);
});
