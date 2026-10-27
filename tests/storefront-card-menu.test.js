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
  const menu = { innerHTML: '' }, favButtons = [], cartButtons = [], badge = { attrs: {}, setAttribute(k, v) { this.attrs[k] = String(v); } };
  const sheetBody = { innerHTML: '' };
  const sheetEl = { hidden: true, dataset: {} };
  const localStorage = store(), calls = [];
  const document = {
    getElementById: (id) => (id === 'menu' ? menu : id === 'sheet' ? sheetEl : id === 'sheetB' ? sheetBody : null),
    querySelector: (selector) => (selector === 'button[data-sheet="fav"]' ? badge : null),
    querySelectorAll: (selector) => (selector === '[data-fav]' ? favButtons : selector === '.cartb[data-add]' ? cartButtons : []),
    body: { classList: { add() {}, remove() {} } }
  };
  const context = vm.createContext({ document, localStorage, window: {}, lang, AUTH: auth, PERFUMES: perfumes, console,
    setTimeout: (fn) => { fn(); return 0; }, location: { reload: () => calls.push('reload') } });
  const texts = vm.runInContext(read('texts.js') + ';D', context);
  context.D = texts;
  const code = [
    oneLine('var XBTN='), oneLine('var LOGO='), oneLine('var LB='), oneLine('en:{home:'),
    oneLine('var CARTSVG='), oneLine('var CARTADD='), oneLine('var PHB='), oneLine('function inCart'), oneLine('function cartMarks'), oneLine('function cartBadge'), oneLine('var SP_BY_ID='), oneLine('function ratingHTML'), oneLine('function byId'), oneLine('function nmOf'), oneLine('function sec('), oneLine('function T()'),
    oneLine('function taxNote'), oneLine('function best('), oneLine('function closeSheet'),
    between('var FAVS=[]', '\nvar SP_BY_ID='), between('function prodView', '\nfunction strip('),
    between('var MENU_ORDER=', 'function logoutNow'), oneLine('function logoutNow'),
    between('function sheet(k)', '\nfunction sendMsg')
  ].join('\n').replace(/^var LB=\{ar:/m, 'var LB={ar:');
  vm.runInContext(code.replace('var LB=', 'var LB='), context);
  return { context, menu, favButtons, cartButtons, badge, sheetBody, sheetEl, localStorage, calls, run: (src) => vm.runInContext(src, context) };
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

test('menu: Create account, Sign in and Sign out are always listed in that order; the one that does not apply is dimmed', () => {
  const out = harness();
  out.run('buildMenu()');
  const t = out.context.D.ar.menu, signedOut = labels(out.menu.innerHTML);
  assert.deepEqual(signedOut.slice(-3), [t[14], t[13], t[15]], 'Create account, Sign in, Sign out');
  assert.match(out.menu.innerHTML, /<a data-sheet="signup">[^<]*<\/a><a data-sheet="login">[^<]*<\/a><a class="off" data-menu-note="notin">تسجيل الخروج<\/a>/);
  assert.doesNotMatch(out.menu.innerHTML, /data-logout/, 'signed out: sign out only explains itself');
  const inn = harness({ auth: { access_token: 'token', user: { id: 'u1' } } });
  inn.run('buildMenu()');
  const signedIn = labels(inn.menu.innerHTML);
  assert.deepEqual(signedIn.slice(-3), [t[14], t[13], t[15]], 'same order when signed in');
  assert.equal(t[15], 'تسجيل الخروج');
  assert.match(inn.menu.innerHTML, /<a class="off" data-menu-note="already">[^<]*<\/a><a class="off" data-menu-note="already">[^<]*<\/a><a data-logout>تسجيل الخروج<\/a>/);
  assert.doesNotMatch(inn.menu.innerHTML, /data-sheet="(login|signup)"/, 'signed in: no sign-in forms are opened from the menu');
  assert.equal(inn.context.D.en.menu[15], 'Sign Out');
  assert.match(core, /var mn=e\.target\.closest\('\[data-menu-note\]'\);if\(mn\)\{e\.preventDefault\(\);toast\(LB\[lang\]\[mn\.dataset\.menuNote\]\|\|''\);return\}/);
  assert.match(core, /notin:'أنت غير مسجّل الدخول حاليًا',already:'أنت مسجّل الدخول بالفعل'/);
  assert.match(core, /notin:'You are not signed in',already:'You are already signed in'/);
  assert.match(css, /#menu a\.off\{opacity:\.4;cursor:default\}/);
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
  assert.match(html, /<button type="button" class="cartb" data-add="p1" aria-label="أضف إلى العربة"><svg class="i-add"/);
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
  assert.match(css, /\.card\.pf \.pim\{[^}]*aspect-ratio:7\/8;background:#fff/);
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

test('page and cards are pure white from below the hero to the footer, so white product photos blend in', () => {
  assert.match(css, /section:nth-of-type\(3n\+2\),section:nth-of-type\(3n\),section:nth-of-type\(even\)\{background:#fff\}/);
  assert.match(css, /\.about\{background:#fff!important\}/);
  assert.match(css, /\n\.card\{background:#fff;border-radius:20px\}/);
  assert.match(css.match(/\n\.card\{flex:0 0 150px[^}]*\}/)[0], /background:#fff;/);
  assert.match(css.match(/\.card\.pf\{[^}]*\}/)[0], /background:#fff/);
  assert.match(css.match(/\.pdi\{[^}]*\}/)[0], /background:#fff/);
  for (const selector of ['section', '.about']) {
    const rules = css.match(new RegExp('(?:^|\\n)' + selector.replace(/[.]/g, '\\.') + '[^{}]*\\{[^}]*\\}', 'g')) || [];
    for (const rule of rules.filter((r) => !r.includes(':before'))) assert.doesNotMatch(rule, /gradient|var\(--off\)/, rule);
  }
  assert.doesNotMatch(css, /#fdfbf7,#f6efe2|#fff,#fcfaf6 60%,#fff|#fff,#f8f2e6|#fff,#fffcf6|#fff,#fffdf9/);
});

test('card footer: price and cart button share one centred line at the bottom, both flush with the text edges', () => {
  const pbody = css.match(/\.card\.pf \.pbody\{[^}]*\}/)[0];
  assert.match(pbody, /flex:1;display:flex;flex-direction:column/);
  const foot = css.match(/\.card\.pf \.pfoot\{[^}]*\}/)[0];
  assert.match(foot, /display:flex;align-items:center;justify-content:space-between/);
  assert.match(foot, /margin-top:auto/, 'the footer sits at the bottom of every card in a row');
  assert.match(css.match(/\.card\.pf \.price\{[^}]*\}/)[0], /align-items:center;gap:3px;height:30px/);
  assert.match(css.match(/\.cartb\{[^}]*\}/)[0], /width:30px;height:30px/);
  assert.match(pbody, /padding:2px 10px 10px/);
  assert.doesNotMatch(css.match(/\.card\.pf h4\{[^}]*\}/)[0], /min-height/, 'the name and brand stay together');
});

function button(id) { const set = new Set(); return { dataset: { add: id }, attrs: {}, classList: { toggle: (c, on) => (on ? set.add(c) : set.delete(c)), has: (c) => set.has(c) }, setAttribute(k, v) { this.attrs[k] = v; } }; }

test('cart mark: a perfume that is in the cart stays marked on its card, whatever else is tapped', () => {
  const h = harness({ perfumes: [sample()] });
  assert.doesNotMatch(h.run('pc({p:PERFUMES[0],b:best(PERFUMES[0])})'), /class="cartb in"/, 'not in the cart yet');
  h.run("CART=[{sid:'p1',q:1}]");
  const html = h.run('pc({p:PERFUMES[0],b:best(PERFUMES[0])})');
  assert.match(html, /class="cartb in" data-add="p1" aria-label="في سلتك، اضغط لإضافة المزيد"/);
  h.run("toggleFav('p1')");
  assert.match(h.run('pc({p:PERFUMES[0],b:best(PERFUMES[0])})'), /class="cartb in"/, 'the favourite heart does not clear the cart mark');
  assert.match(h.run('pc({p:PERFUMES[0],b:best(PERFUMES[0])})'), /class="favb on"/);
  assert.match(html, /<svg class="i-add"[^>]*>.*<svg class="i-in"/s, 'a plus cart for adding and a ticked cart once added');
  assert.match(html, /M10\.6 9\.2l1\.6 1\.6 2\.9-3\.1/);
});

test('cart mark follows the cart live: adding, removing and emptying update every card button', () => {
  const h = harness({ perfumes: [sample()] });
  const a = button('p1'), b = button('p9'); h.cartButtons.push(a, b);
  h.run("CART=[{sid:'p1',q:2}];cartBadge()");
  assert.equal(a.classList.has('in'), true); assert.equal(b.classList.has('in'), false);
  assert.equal(a.attrs['aria-label'], 'في سلتك، اضغط لإضافة المزيد');
  h.run("CART=[];cartBadge()");
  assert.equal(a.classList.has('in'), false);
  assert.equal(a.attrs['aria-label'], 'أضف إلى العربة');
  assert.match(core, /function cartBadge\(\)\{[^\n]*;cartMarks\(\)\}/, 'every cart change already goes through cartBadge');
});

test('cart mark style: dark ticked circle while in the cart; hover colours only where a real hover exists', () => {
  assert.match(css, /\.cartb \.i-in\{display:none\}\.cartb\.in \.i-add\{display:none\}\.cartb\.in \.i-in\{display:block\}/);
  assert.match(css, /\.cartb\.in,\.cartb:active\{background:#2b2418;color:#f6efe0\}/);
  assert.match(css, /@media\(hover:hover\)\{\.cartb:hover\{background:#2b2418;color:#f6efe0\}\}/);
  assert.doesNotMatch(css, /(?<!\()\.cartb:hover,/, 'no sticky touch hover that fakes an added state');
});

test('card picture: one fixed frame for every image, no inner frame, a quiet bottle outline when there is no photo', () => {
  const none = harness({ perfumes: [sample({ img: '' })] }).run('pc({p:PERFUMES[0],b:best(PERFUMES[0])})');
  assert.match(none, /<div class="pim"><svg class="phb"/);
  assert.doesNotMatch(none, /class="ph"|dashed/);
  const pageNone = harness({ perfumes: [sample({ img: '' })] }).run("prodView({sid:'p1'},LB[lang],T())");
  assert.match(pageNone, /<div class="pdi"><svg class="phb"/);
  const pim = css.match(/\.card\.pf \.pim\{[^}]*\}/)[0];
  assert.match(pim, /aspect-ratio:7\/8;background:#fff/);
  assert.doesNotMatch(pim, /border|padding/, 'the frame itself has no border or padding of its own');
  const img = css.match(/\.card\.pf \.pim img\{[^}]*\}/)[0];
  assert.match(img, /width:100%;height:100%;object-fit:cover/, 'any catalogue image is brought to the same size');
  assert.match(img, /border:0/);
  assert.match(css, /\.card\.pf \.pim \.phb,\.pdi \.phb\{width:52%;height:auto;color:#e3d6b8\}/);
});

test('perfume cards under MASTERPIECES (inside .cb) keep the compact card fonts', () => {
  assert.match(css, /\.cb \.card:not\(\.pf\) h4\{font-size:26px!important\}/);
  assert.match(css, /\.cb \.card:not\(\.pf\) small\{font-size:13px\}\.cb \.card:not\(\.pf\) \.st\{font-size:12\.5px\}/);
  assert.doesNotMatch(css, /\.cb \.card h4\{/, 'the big heading rule no longer reaches perfume cards');
  assert.doesNotMatch(css, /\.cb \.card small\{|\.cb \.card \.st\{/);
  assert.match(css.match(/\.card\.pf h4\{[^}]*\}/)[0], /font-size:12\.5px/);
});

test('no cream or black surfaces are left on the page or the inner pages (only buttons, icons and lines carry colour)', () => {
  const surfaces = css.split('\n').filter((line) => !line.startsWith('footer')).join('\n');
  assert.doesNotMatch(surfaces, /#fbf8f2|#fdfbf7|#fffdf7|#ede8de|#f8efd9|#f7f0e3|#fdf9ef|#f6efe2|#fcfaf6|#fffcf6|#fffdf9/i);
  assert.match(css, /:root\{--bg:#fff;--off:#fff;/);
  assert.match(css, /#menu\{background:#fff\}/);
  assert.match(css, /\.flt\{background:#fff\}/);
  assert.match(css, /\.chip\{[^}]*background:#fff/);
  assert.match(css, /\.filter-body\{[^}]*background:#fff\}/);
  assert.match(css, /\.pdbuy\{[^}]*background:#fff\}/);
  assert.match(css, /\.disc\{[^}]*background:#fff;/);
  assert.doesNotMatch(top, /#ede8de/);
  const design = JSON.parse(read('design/home.json'));
  for (const [id, edit] of Object.entries(design.edits.all)) assert.ok(!edit.style || !/^#0{3,6}$/i.test(edit.style.background || ''), id + ' must not carry a black background');
});
