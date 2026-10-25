const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.join(__dirname, '..');
const read = (file) => fs.readFileSync(path.join(root, file), 'utf8');
const index = read('index.html');
const base = read('style-3.css');
const top = read('style.css');
const headerHtml = index.slice(index.indexOf('<header>'), index.indexOf('</header>'));
const px = (text, pattern) => Number((text.match(pattern) || [])[1]);

test('the strip text above the header is flat gold with no 3D look', () => {
  const rule = base.match(/#bar \.gold\{[^}]*\}/)[0];
  assert.doesNotMatch(rule, /gradient/);
  assert.match(rule, /filter:none/);
  assert.match(rule, /text-shadow:none/);
  assert.match(rule, /-webkit-text-fill-color:#[0-9a-f]{6}/);
  assert.equal(rule.match(/[^-]color:(#[0-9a-f]{6})/)[1], rule.match(/-webkit-text-fill-color:(#[0-9a-f]{6})/)[1], 'one solid colour, no transparent fill');
  assert.doesNotMatch(top, /#bar[^{]*\.gold[^{]*\{[^}]*gradient/);
});

test('header icons and the language button are flat: no gradient stroke, shadow or filter', () => {
  const svgs = headerHtml.match(/<svg[^>]*>/g) || [];
  assert.equal(svgs.length, 5, 'menu, notifications, search, favourites and cart icons');
  for (const svg of svgs) assert.match(svg, /stroke="currentColor"/);
  assert.doesNotMatch(headerHtml, /url\(#gg\)/);
  assert.match(base, /\.ic button\{[^}]*color:var\(--gold2\)/);
  for (const css of [base, top]) {
    for (const rule of css.match(/[^{}]*(?:header \.ic|\.ic button|#lg)[^{}]*\{[^}]*\}/g) || []) {
      assert.doesNotMatch(rule, /drop-shadow|text-shadow:\s*[^n\s;]|box-shadow|filter:\s*[^n\s;]/, rule);
    }
  }
  const pulse = base.match(/@keyframes cartPulse\{[^@]*\}\}/)[0];
  assert.doesNotMatch(pulse, /drop-shadow|filter/);
});

test('the logo keeps its own gold effect while the rest of the header is flat', () => {
  assert.match(base, /\.gold\{[^}]*filter:drop-shadow/);
  assert.match(headerHtml, /<b class="gold en">/);
  assert.match(base, /\.logo small\{[^}]*filter:drop-shadow/);
});

test('header icons and the language button are bigger than before and the logo box is not squeezed', () => {
  const phone = top.slice(top.indexOf('@media (max-width: 960px)'));
  assert.ok(px(phone, /header \.ic svg \{ width: (\d+)px/) >= 22);
  assert.ok(px(top, /@media \(max-width: 480px\) \{[\s\S]*?header \.ic svg \{ width: (\d+)px/) >= 22);
  assert.ok(px(base, /header \.ic svg\{width:(\d+)px/) >= 22);
  assert.ok(px(phone, /#lg \{ font-size: (\d+)px/) >= 12);
  assert.ok(px(base, /#lg\{font-size:(\d+)px/) >= 13);
  // The extra icon size moves into the icon itself on phones, so the logo and its tagline keep their room.
  assert.match(phone, /header \.ic button \{ padding: 0 !important; \}/);
});

test('menu items are slightly larger than the old 13px, while the menu logo and tagline are untouched', () => {
  const rules = top.match(/#menu a:not\(\.mlogo\) \{[^}]*\}/g);
  assert.equal(rules.length, 2, 'base rule and phone rule');
  for (const rule of rules) assert.ok(px(rule, /font-size: (\d+)px/) >= 14, rule);
  assert.doesNotMatch(rules.join('\n'), /mlogo[^)]/);
  assert.match(base, /#menu a\.mlogo \.logo>div b\{font-size:32px!important\}/);
  assert.match(base, /#menu a\.mlogo \.logo small\{[^}]*font-size:6\.5px!important/);
});

test('the strip above the header is a little darker and a little larger than the first flat version', () => {
  const lum = (hex) => [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16) / 255).map((c) => (c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4)).reduce((sum, c, i) => sum + c * [0.2126, 0.7152, 0.0722][i], 0);
  const colour = base.match(/#bar \.gold\{[^}]*-webkit-text-fill-color:(#[0-9a-f]{6})/)[1];
  assert.ok(lum(colour) < lum('#c8962a'), 'darker than the brand gold used for the icons');
  assert.ok(lum(colour) > lum('#8a5e0c'), 'still gold, not brown');
  assert.ok(px(base, /#bar\{[^}]*font-size:([\d.]+)px/) >= 14);
  assert.ok(px(top, /#bar \{[^}]*font-size: ([\d.]+)px/) >= 13);
});
