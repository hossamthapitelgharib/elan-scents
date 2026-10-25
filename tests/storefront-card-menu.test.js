/* The storefront menu order and sign-in entries, the compact perfume card, the product page that carries everything the card no longer shows,
   and the favourites that work without an account. The real functions from app-core.js run in a small VM. */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const root = path.join(__dirname, '..');
const read = (file) => fs.readFileSync(path.join(root, file), 'utf8');
const core = read('app-core.js');
const css = read('style-3.css');
const top = read('style.css');

const oneLine = (start) => { const i = core.indexOf(start); assert.ok(i >= 0, start); return core.slice(i, core.indexOf('\n', i)); };
const between = (start, end) => { const i = core.indexOf(start), j = core.indexOf(end, i); assert.ok(i >= 0 && j > i, start); return core.slice(i, j); };

function store() {
  const data = {};
  return { getItem: (k) => (k in data ? data[k] : null), setItem: (k, v) => { data[k] = String(v); }, removeItem: (k) => { delete data[k]; }, data };
}

function harness({ lang = 'ar', auth = null, perfumes = [] } = {}) {
  const menu = { innerHTML: '' }, favButtons = [], badge = { attrs: {}, setAttribute(k, v) { this.attrs[k] = String(v); } };
  const sheetBody = { innerHTML: '' };
  const sheetEl = { hidden: true, dataset: {} };
  const localStorage = store(), calls = [];
  const document = {
    getElementById: (id) => (id === 'menu' ? menu : id === 'sheet' ? sheetEl : id === 'sheetB' ? sheetBody : null),
    querySelector: (selector) => (selector === 'button[data-sheet="fav"]' ? badge : null),
    querySelectorAll: (selector) => (selector === '[data-fav]' ? favButtons : []),
    body: { classList: { add() {}, remove() {} } }
  };
  const context = vm.createContext({ document, localStorage, window: {}, lang, AUTH: auth, PERFUMES: perfumes, console,
    setTimeout: (fn) => { fn(); return 0; }, location: { reload: () => calls.push('reload') } });
  const texts = vm.runInContext(read('texts.js') + ';D', context);
  context.D = texts;
  const code = [
    oneLine('var XBTN='), oneLine('var LOGO='), oneLine('var LB='), oneLine('en:{home:'),
    oneLine('var CARTSVG='), oneLine('function ratingHTML'), oneLine('function byId'), oneLine('function nmOf'), oneLine('function sec('), oneLine('function T()'),
    oneLine('function taxNote'), oneLine('function best('), oneLine('function closeSheet'),
    between('var FAVS=[]', '\nvar SP_BY_ID='), between('function prodView', '\nfunction strip('),
    between('var MENU_ORDER=', 'function logoutNow'), oneLine('function logoutNow'),
    between('function sheet(k)', '\nfunction sendMsg')
  ].join('\n').replace(/^var LB=\{ar:/m, 'var LB={ar:');
  vm.runInContext(code.replace('var LB=', 'var LB='), context);
  return { context, menu, favButtons, badge, sheetBody, sheetEl, localStorage, calls, run: (src) => vm.runInContext(src, context) };
}

const sample = (extra = {}) => ({ id: 'p1', pid: 'q1', name: 'Club de Nuit Iconic', pn: 'Club de Nuit Iconic', brand: 'Armaf', sz: '105 مل', img: '/a.png', cats: [0], occs: [0, 1], notes: [0],
  rating: 4.3, sd: 'وصف قصير للعطر', desc: 'وصف كامل للعطر', comp: 'برغموت وعود', ind: [],
  offers: [{ store: 'Afnan Egypt', storeId: 's1', storeProductId: 'sp1', price: 1380, cur: 'EGP', avail: true, flags: [], stock: 12, tax: true, ship: false }], ...extra });

const labels = (html) => [...html.matchAll(/<a [^>]*>([^<]*)<\/a>/g)].map((m) => m[1]);

test('menu: MASTERPIECES sits right under Categories, in Arabic and English', () => {
  for (const lang of ['ar', 'en']) {
    const h = harness({ lang });
    h.run('buildMenu()');
    const list = labels(h.menu.innerHTML), t = h.context.D[lang].menu;
    const cats = list.indexOf(t[6]), master = list.indexOf(t[5]);
    assert.ok(cats > 0 && master === cats + 1, lang + ': MASTERPIECES must follow Categories directly: ' + list.join(' | '));
    assert.equal(list[master + 1], t[7], 'Occasions follows');
    assert.deepEqual(list.slice(0, 5), [t[1], t[2], t[3], t[4], t[6]], 'the entries before Categories keep their order');
  }
});

test('menu: signed out shows Create account then Sign in; signed in shows Sign out instead', () => {
  const out = harness();
  out.run('buildMenu()');
  const t = out.context.D.ar.menu, signedOut = labels(out.menu.innerHTML);
  assert.deepEqual(signedOut.slice(-2), [t[14], t[13]], 'Create account first, then Sign in');
  assert.match(out.menu.innerHTML, /<a data-sheet="signup">[^<]*<\/a><a data-sheet="login">/);
  assert.doesNotMatch(out.menu.innerHTML, /data-logout/);
  const inn = harness({ auth: { access_token: 'token', user: { id: 'u1' } } });
  inn.run('buildMenu()');
  const signedIn = labels(inn.menu.innerHTML);
  assert.equal(signedIn.at(-1), t[15]);
  assert.equal(t[15], 'تسجيل الخروج');
  assert.ok(!signedIn.includes(t[13]) && !signedIn.includes(t[14]), 'sign in / create account are hidden once signed in');
  assert.match(inn.menu.innerHTML, /<a data-logout>تسجيل الخروج<\/a>/);
  assert.equal(inn.context.D.en.menu[15], 'Sign Out');
});

test('menu follows the sign-in state after login, expiry and sign-in from another tab', () => {
  assert.match(core, /AUTH=d;try\{localStorage\.setItem\('elan_auth_session',JSON\.stringify\(d\)\)\}catch\(e\)\{\}buildMenu\(\);/);
  assert.match(core, /AUTH=null;buildMenu\(\);try\{toast\('انتهت جلسة الدخول/);
  assert.match(core, /catch\(_\)\{AUTH=null\}buildMenu\(\)\}\)/);
  assert.match(core, /var m=document\.getElementById\('menu'\);buildMenu\(\);/);
});

test('menu: sign out revokes the session, clears the cart cache and reloads, like the account page', async () => {
  const h = harness({ auth: { access_token: 't' } });
  const signOut = []; h.context.window.ElanAuth = { signOut: () => { signOut.push(1); return Promise.resolve(); } };
  h.context.ElanAuth = h.context.window.ElanAuth;
  h.context.window.GuestIdentity = { prepareLogout: () => Promise.resolve() };
  h.context.GuestIdentity = h.context.window.GuestIdentity;
  h.localStorage.setItem('elan_auth_session', '{}'); h.localStorage.setItem('elan_cart', '[]'); h.localStorage.setItem('elan_favs', '["p1"]'); h.localStorage.setItem('elan_orders', '[1]');
  h.run('logoutNow()');
  await new Promise((resolve) => setImmediate(resolve)); await new Promise((resolve) => setImmediate(resolve));
  assert.equal(signOut.length, 1);
  assert.equal(h.localStorage.getItem('elan_auth_session'), null);
  assert.equal(h.localStorage.getItem('elan_cart'), null);
  assert.equal(h.localStorage.getItem('elan_favs'), null, 'a shared device must not keep the previous person\'s favourites');
  assert.equal(h.localStorage.getItem('elan_orders'), '[1]', 'the orders copy is left alone');
  assert.deepEqual(h.calls, ['reload']);
  assert.match(core, /var lo=e\.target\.closest\('\[data-logout\]'\);if\(lo\)\{e\.preventDefault\(\);logoutNow\(\);return\}/);
});

test('card front shows only image, heart, name, brand, size, price and add to cart', () => {
  const h = harness({ perfumes: [sample()] });
  const html = h.run('pc({p:PERFUMES[0],b:best(PERFUMES[0])})');
  assert.match(html, /<img src="\/a\.png"/);
  assert.match(html, /class="favb" data-fav="p1" aria-pressed="false"/);
  assert.match(html, /<h4>Club de Nuit Iconic<\/h4>/);
  assert.match(html, /<span>Armaf<\/span><span>105 مل<\/span>/);
  assert.match(html, /<span class="price">1380<small>EGP<\/small><\/span>/);
  assert.match(html, /<button type="button" class="cartb" data-add="p1" aria-label="أضف إلى العربة">/);
  assert.match(html, /data-go="prod\|p1"/);
  for (const gone of ['class="rating"', 'class="sd"', 'class="tgs"', 'class="tg"', 'Afnan Egypt', 'class="vd"', 'عرض التفاصيل', 'وصف قصير', 'نهاري', 'رجالي']) assert.ok(!html.includes(gone), gone + ' belongs on the product page');
  assert.equal((html.match(/<button/g) || []).length, 2, 'only the heart and the cart button');
});

test('card for a product with no offer shows the soon label and no cart button', () => {
  const h = harness({ perfumes: [sample({ offers: [] })] });
  const html = h.run('pc({p:PERFUMES[0],b:null})');
  assert.match(html, /class="st"/);
  assert.doesNotMatch(html, /cartb|class="price"/);
  assert.match(html, /data-fav="p1"/, 'it can still be favourited');
});

test('product page carries what the card dropped, plus buying controls and the heart', () => {
  const h = harness({ perfumes: [sample()] });
  const html = h.run("prodView({sid:'p1'},LB[lang],T())");
  for (const part of ['Club de Nuit Iconic', 'Armaf', '105 مل', 'class="rating"', 'Afnan Egypt', 'يُباع لدى', 'وصف قصير للعطر', 'وصف كامل للعطر', 'برغموت وعود', 'السعر شامل الضريبة', 'المتاح حاليًا: 12']) assert.ok(html.includes(part), part);
  assert.match(html, /data-fav="p1"/);
  assert.match(html, /<input id="qty" type="number" min="1" value="1" max="12">/);
  assert.match(html, /<button class="btn pdadd" data-add="p1" data-q="qty">/);
  assert.match(html, /<dl class="pdl">/);
});

test('product page without a store row does not draw an empty details box', () => {
  const h = harness({ perfumes: [sample({ cats: [], occs: [], offers: [] })] });
  assert.doesNotMatch(h.run("prodView({sid:'p1'},LB[lang],T())"), /<dl/);
});

test('favourites: toggling saves on the device, updates every heart and the header counter', () => {
  const h = harness({ perfumes: [sample(), sample({ id: 'p2', pid: 'q2' })] });
  const heart = { dataset: { fav: 'p1' }, cls: new Set(), attrs: {}, classList: { toggle(c, on) { on ? heart.cls.add(c) : heart.cls.delete(c); } }, setAttribute(k, v) { heart.attrs[k] = v; } };
  h.favButtons.push(heart);
  h.run("toggleFav('p1')");
  assert.deepEqual(JSON.parse(h.localStorage.getItem('elan_favs')), ['p1']);
  assert.equal(heart.attrs['aria-pressed'], 'true');
  assert.ok(heart.cls.has('on'));
  assert.equal(heart.attrs['aria-label'], 'إزالة من المفضلة');
  assert.equal(h.badge.attrs['data-n'], '1');
  h.run("toggleFav('p2')");
  assert.equal(h.badge.attrs['data-n'], '2');
  h.run("toggleFav('p1')");
  assert.deepEqual(JSON.parse(h.localStorage.getItem('elan_favs')), ['p2']);
  assert.equal(heart.attrs['aria-pressed'], 'false');
  assert.equal(heart.attrs['aria-label'], 'أضف إلى المفضلة');
});

test('favourites sheet lists the saved perfumes as compact cards and says so when empty', () => {
  const h = harness({ perfumes: [sample(), sample({ id: 'p2', pid: 'q2', name: 'Asad', pn: 'Asad' })] });
  h.run("sheet('fav')");
  assert.match(h.sheetBody.innerHTML, /لم تضف عطورًا للمفضلة بعد/);
  h.run("toggleFav('p2');sheet('fav')");
  assert.match(h.sheetBody.innerHTML, /class="grid fav-grid"/);
  assert.match(h.sheetBody.innerHTML, /<h4>Asad<\/h4>/);
  assert.doesNotMatch(h.sheetBody.innerHTML, /Club de Nuit/);
  assert.equal(h.sheetEl.dataset.kind, 'fav');
  assert.match(core, /if\(g\.closest\('#sheet'\)\)closeSheet\(\);go\(g\.dataset\.go\)/, 'opening a card from the sheet closes the sheet');
});

test('favourites never reach the cloud and stay out of the editor preview', () => {
  assert.match(core, /if\(!window\.ELAN_EDITOR_PREVIEW\)try\{FAVS=JSON\.parse/);
  assert.match(core, /function saveFavs\(\)\{if\(!window\.ELAN_EDITOR_PREVIEW\)try\{localStorage\.setItem\('elan_favs'/);
  assert.doesNotMatch(between('var FAVS=[]', 'function pc('), /fetch\(|GuestIdentity|trackGuest/);
});

test('card CSS is compact, calm and image-first: about half the old footprint', () => {
  const card = css.match(/\.card\.pf\{[^}]*\}/)[0];
  assert.ok(Number(card.match(/flex:0 0 (\d+)px/)[1]) <= 140, 'narrow tile in strips');
  assert.doesNotMatch(card, /gradient/);
  assert.match(card, /box-shadow:none/);
  assert.match(css, /\.card\.pf \.pim\{[^}]*aspect-ratio:1\/1/);
  assert.match(top, /\.card\.pf \{ flex: 0 0 116px !important; \}/);
  assert.doesNotMatch(css, /\.card\.pf \.pim\{height:150px/);
  const cart = css.match(/\.cartb\{[^}]*\}/)[0];
  assert.doesNotMatch(cart, /gradient|box-shadow/);
  assert.match(css, /\.favb\.on\{color:#b04a3f\}/);
  assert.ok(Number(css.match(/\.grid\.rel-grid\{grid-template-columns:repeat\((\d)/)[1]) >= 3, 'three or more cards per row on phones');
  for (const grid of ['#res.grid', '.grid.section-perfume-grid', '.grid.fav-grid', '.grid.rel-grid']) assert.ok(css.includes(grid), grid);
});

test('product page CSS keeps Arabic letters joined (no letter-spacing on Arabic headings and buttons)', () => {
  const page = css.slice(css.indexOf('.pd{max-width'), css.indexOf('.pdrel{'));
  const plain = page.replace(/\[dir=ltr\][^}]*\}/g, '');
  assert.doesNotMatch(plain, /letter-spacing/);
  assert.match(css, /\.pdadd\{[^}]*background:#2b2418/);
});
