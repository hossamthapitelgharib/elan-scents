/* Owner's 2026-10-29 round: the arrow-only "browse the collection" pill, a shorter perfume card, the cart button that adds on one tap and removes
   on the next, the search frame, and the hero picture that must stay put and must not be cropped at the sides.
   Source checks for the CSS, and the real removeFromCart() from app-core.js in a small VM. */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const root = path.join(__dirname, '..');
const read = (file) => fs.readFileSync(path.join(root, file), 'utf8');
const core = read('app-core.js');
const app = read('app.js');
const html = read('index.html');
const base = read('style-3.css');
const top = read('style.css');

const oneLine = (start) => { const i = core.indexOf(start); assert.ok(i >= 0, start); return core.slice(i, core.indexOf('\n', i)); };
/* the LAST rule for a selector, the one that wins the cascade (a plain `.sub{` is also defined earlier in style-3.css) */
const rule = (css, selector) => { const i = Math.max(css.lastIndexOf('\n' + selector + '{'), css.lastIndexOf('\n' + selector + ' {')); assert.ok(i >= 0, selector); return css.slice(i + 1, css.indexOf('}', i) + 1); };

/* ---------- 3) the cart button: one tap adds, the next removes ---------- */

function cartHarness(cart) {
  const calls = { track: [], toasts: [], saved: 0 };
  const context = vm.createContext({
    lang: 'ar', CART: cart, calls,
    byId: (id) => (id === 'p1' ? { id: 'p1', pid: 'q1', offers: [] } : null),
    best: () => ({ storeProductId: 'sp1' }),
    trackGuestProduct: (...a) => calls.track.push(a),
    saveCart: () => { calls.saved++; },
    toast: (m) => calls.toasts.push(m)
  });
  vm.runInContext([oneLine('var LB='), oneLine('en:{home:'), oneLine('function removeFromCart')].join('\n'), context);
  return { context, calls, run: (src) => vm.runInContext(src, context) };
}

test('cart button: the second tap removes the perfume, tells the guest tracker, saves the cart and says so', () => {
  const h = cartHarness([{ sid: 'p1', q: 3 }, { sid: 'p2', q: 1 }]);
  h.run("removeFromCart('p1')");
  assert.deepEqual(JSON.parse(JSON.stringify(h.run('CART'))), [{ sid: 'p2', q: 1 }], 'only that perfume leaves the cart');
  assert.equal(h.calls.saved, 1);
  assert.deepEqual(JSON.parse(JSON.stringify(h.calls.track)), [['cart_remove', 'q1', 'p1', 'sp1', 3]], 'the whole quantity is reported as removed');
  assert.deepEqual(h.calls.toasts, ['أزيل من العربة']);
});

test('cart button: removing something that is not in the cart does nothing', () => {
  const h = cartHarness([{ sid: 'p2', q: 1 }]);
  h.run("removeFromCart('p1')");
  assert.equal(h.calls.saved, 0);
  assert.deepEqual(h.calls.toasts, []);
  assert.equal(h.run('CART.length'), 1);
});

test('cart button: only the card button toggles; the product page button and the qty box still add', () => {
  const click = core.slice(core.indexOf("var ad=e.target.closest('[data-add]')"));
  const branch = click.slice(0, click.indexOf("var cq=e.target.closest('[data-cq]')"));
  assert.match(branch, /if\(ad\.classList\.contains\('cartb'\)&&inCart\(ad\.dataset\.add\)\)\{removeFromCart\(ad\.dataset\.add\);return\}/, 'a .cartb that is already in the cart removes');
  assert.match(branch, /addToCart\(ad\.dataset\.add,qi\?\+qi\.value\|\|1:1\)/, 'everything else keeps adding');
  assert.match(core, /class="btn pdadd" data-add=/, 'the product page button is not a .cartb, so it keeps adding more');
});

test('cart button: the label of an added card says tap to remove, in Arabic and English', () => {
  const ar = core.match(/inCart:'([^']*)',removed:'([^']*)'/);
  assert.ok(ar, 'Arabic strings');
  assert.deepEqual([ar[1], ar[2]], ['في سلتك، اضغط لإزالته', 'أزيل من العربة']);
  const en = core.match(/inCart:'In your cart, tap to remove',removed:'Removed from cart'/);
  assert.ok(en, 'English strings');
  assert.doesNotMatch(core, /tap to add more|اضغط لإضافة المزيد/);
});

/* ---------- 2) a shorter perfume card, same width, same bottle picture ---------- */

test('perfume card: same width and same picture frame as before, only the body is shorter', () => {
  const card = rule(base, '.card.pf');
  assert.match(card, /flex:0 0 var\(--cw\);width:var\(--cw\);aspect-ratio:auto/, 'width unchanged, no forced tall ratio');
  assert.doesNotMatch(card, /1169/);
  assert.match(base, /:root\{--cw:45\.5vw;/, 'two cards per row, 45.5% wide, as before');
  assert.match(rule(base, '.card.pf .pim'), /aspect-ratio:541\/674;flex:none/, 'the bottle picture frame keeps its 541:674 ratio');
  assert.match(rule(base, '.card.pf .pim img'), /width:100%;height:100%;object-fit:cover/);
  assert.match(rule(base, '.card.pf .pbody'), /gap:2px;padding:6px 9px 6px/);
  assert.match(top, /\.card\.pf \{ flex: 0 0 var\(--cw\) !important; \}/, 'the phone rule still keeps the width');
});

test('perfume card: the body stays one block (name, brand and size together, footer at the bottom)', () => {
  assert.doesNotMatch(rule(base, '.card.pf h4'), /min-height/);
  assert.match(rule(base, '.card.pf .pfoot'), /margin-top:auto/);
  assert.match(rule(base, '.card.pf .pmeta'), /white-space:nowrap;overflow:hidden;text-overflow:ellipsis/, 'a long brand and size never add a line');
});

/* ---------- 1) the arrow-only pill in the perfume card's frame ---------- */

test('browse / explore pill: an arrow only, white, in the perfume card frame', () => {
  const sub = rule(base, '.sub');
  const card = rule(base, '.card.pf');
  const frame = card.match(/border:(1px solid #[0-9a-f]{6})/)[1];
  assert.ok(sub.includes('border:' + frame), 'the pill uses the same hairline as the perfume card: ' + frame);
  assert.match(sub, /width:46px;height:30px/);
  assert.match(sub, /border-radius:999px/);
  assert.match(sub, /background:#fff/);
  assert.match(sub, /color:#8a5e0c/);
  assert.match(sub, /font-size:0/, 'the words are hidden visually, kept for screen readers');
  assert.match(base, /\.sub:after\{content:'\\2192';font-size:17px;line-height:1\}\[dir=rtl\] \.sub:after\{content:'\\2190'\}/, 'arrow follows the reading direction');
  assert.match(base, /\.sub:empty\{display:none\}/, 'the empty one under Contact is not an empty pill');
  assert.match(base, /\.sub:hover\{border-color:#c8962a;/, 'gold hairline on hover like the card');
});

test('browse pill: the one under the hero wins over the small-screen .magic p size', () => {
  const hero = rule(top, '#intro .magic p.sub');
  assert.match(hero, /font-size: 0 !important/);
  assert.match(hero, /background: #fff !important/);
  assert.match(top, /\.magic p \{ font-size: 12px !important; \}/, 'the rule it has to beat is still there');
  assert.match(html, /<p class="sub" data-i="view"><\/p>/, 'the words are still in the markup');
});

/* ---------- 4) the search frame and its sign ---------- */

test('search: the frame is the perfume card frame and the sign is coloured like the cart button', () => {
  const card = rule(base, '.card.pf'), frame = card.match(/border:1px solid (#[0-9a-f]{6});border-radius:(\d+px)/);
  const box = rule(base, '#quickSearch');
  assert.ok(box.includes('border:1px solid ' + frame[1]) && box.includes('border-radius:' + frame[2]), 'same hairline and corners as the card');
  assert.match(box, /box-shadow:0 8px 18px rgba\(80,55,15,\.10\)/, 'the soft shadow the card gets on hover');
  assert.match(rule(base, '#quickSearchForm input'), /border:1px solid #efe9db/);
  assert.match(base, /#quickSearchForm input:focus\{border-color:#c8962a\}/);
  const cart = rule(base, '.cartb'), sign = rule(base, '#quickSearchForm button');
  for (const token of ['border:1px solid #e6dcc6', 'border-radius:50%', 'background:#fff', 'color:#a37e2c']) {
    assert.ok(cart.includes(token) && sign.includes(token), 'search sign and cart button share ' + token);
  }
  assert.match(base, /#quickSearchForm button:active\{background:#2b2418;color:#f6efe0;border-color:#2b2418\}/, 'same dark pressed state as the cart button');
  assert.match(base, /@media\(hover:hover\)\{#quickSearchForm button:hover\{background:#2b2418;color:#f6efe0;border-color:#2b2418\}\}/);
  assert.doesNotMatch(sign, /gradient/, 'no gold gradient any more');
});

test('search: the sign is the same magnifier drawing as the header, not a text glyph', () => {
  const form = html.slice(html.indexOf('<form id="quickSearchForm">'), html.indexOf('</form>', html.indexOf('<form id="quickSearchForm">')));
  assert.match(form, /<button type="submit" aria-label="search"><svg [^>]*><circle cx="11" cy="11" r="6"\/><path d="M16 16l4 4"\/><\/svg><\/button>/);
  assert.doesNotMatch(form, /⌕/);
});

/* ---------- 5) the hero picture stays and is not cropped at the sides ---------- */

test('hero picture: nothing writes the hero background or rotates its colours any more', () => {
  assert.doesNotMatch(app, /style\.background\s*=/, 'the old video wrapper used to set background:transparent every 8 seconds');
  assert.doesNotMatch(core, /e\.style\.background=h\.bg/);
  assert.doesNotMatch(core, /function hero\(/);
  assert.doesNotMatch(core, /setInterval\(function\(\)\{hi\+\+;hero\(\)\}/);
  assert.doesNotMatch(core + app, /window\.hero\s*=|\bHS\[/);
  assert.match(app, /window\.playHeroVideo=function/, 'the video player helper stays for a hero video');
});

test('hero picture: the hero is never taller than 9:16, so a 9:16 picture is not cropped left and right', () => {
  const heights = top.split('\n').filter((line) => /(^|[\s{;])(min-)?height\s*:.*--app-vh/.test(line));
  assert.ok(heights.length >= 5, 'the hero height rules are all still there: ' + heights.length);
  for (const line of heights) assert.match(line, /min\(calc\(var\(--app-vh, 1vh\) \* 100\), calc\(100vw \* 16 \/ 9\)\)/, line.trim());
  assert.doesNotMatch(top, /[^(]calc\(var\(--app-vh, 1vh\) \* 100\) !important/, 'no uncapped full-viewport hero height is left');
});
