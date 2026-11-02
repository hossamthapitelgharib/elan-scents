// What a shopper sees and gets after «إنشاء حساب»: a notice they cannot miss (with an OK button) when they must confirm their e-mail,
// a sheet that closes by itself when they are signed in at once, a sign-up form the browser does not fill with old credentials, and
// a «Confirm» link that really signs them in. app-core.js is one long file, so only the functions under test are cut out and run
// against a fake page and a fake server (no network, no real addresses).
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const CORE = fs.readFileSync(path.join(__dirname, '..', 'app-core.js'), 'utf8');
const SOURCE = CORE.slice(CORE.indexOf('function authFailText('), CORE.indexOf('async function loadData('));
const ESC = CORE.slice(CORE.indexOf('function esc(s){'), CORE.indexOf('function ratingHTML('));
const settle = () => new Promise((resolve) => setTimeout(resolve, 20));

function page() {
  const sheet = { hidden: true, dataset: {} };
  const sheetB = { innerHTML: '' };
  const classes = new Set();
  return { sheet, sheetB, classes, document: { getElementById: (id) => ({ sheet, sheetB }[id] || null), body: { classList: { add: (c) => classes.add(c), remove: (c) => classes.delete(c) } } } };
}

function shop(server, { lang = 'ar', pending = '' } = {}) {
  const log = { toasts: [], closed: 0, sheets: [], stores: [], saved: [] };
  const p = page();
  const context = vm.createContext({
    lang, SB: { url: 'https://project.example.invalid', key: 'anon-key' }, AUTH: null, PENDING_STORE: pending, CART_FIRST_SYNC_DONE: true,
    toast: (text) => log.toasts.push(text), closeSheet: () => { log.closed++; }, sheet: (k) => log.sheets.push(k), openStoreOrder: (s) => log.stores.push(s),
    buildMenu() {}, syncCartFromCloud: async () => {}, localStorage: { setItem: (k) => log.saved.push(k) }, document: p.document,
    fetch: async () => ({ json: async () => server }), Promise, JSON, String, RegExp, Array
  });
  context.window = context;
  vm.runInContext(ESC + '\n' + SOURCE, context, { filename: 'app-core.js (auth)' });
  const button = { disabled: false };
  const form = (mode, email = 'buyer@example.invalid') => ({ dataset: { authMode: mode }, elements: { email: { value: email }, password: { value: 'a-test-password' }, name: { value: 'Test Buyer' } }, querySelector: () => button });
  return { submit: vm.runInContext('authSubmit', context), form, log, p };
}

test('a new account that must confirm its e-mail: a notice with the address and an OK button, nothing closes by itself, nobody is logged in', async () => {
  const s = shop({ id: 'u1', email: 'buyer@example.invalid', identities: [{ id: 'i1' }], confirmation_sent_at: 'now' });
  s.submit(s.form('signup'));
  await settle();
  const html = s.p.sheetB.innerHTML;
  assert.equal(s.p.sheet.hidden, false, 'the sheet stays open on the notice');
  assert.equal(s.p.sheet.dataset.kind, 'signupDone');
  assert.match(html, /<h3>تم التسجيل بنجاح<\/h3>/);
  assert.match(html, /افتح بريدك الإلكتروني واضغط على رابط التأكيد/);
  assert.match(html, /Spam/, 'tells where the message may be hiding');
  assert.match(html, /<b dir="ltr">buyer@example\.invalid<\/b>/, 'shows which address to open');
  assert.match(html, /<button class="btn" type="button" data-close-sheet>موافق<\/button>/, 'the OK button closes the sheet');
  assert.match(html, /role="alert"/);
  assert.equal(s.log.closed, 0);
  assert.deepEqual(s.log.toasts, []);
  assert.equal(s.log.saved.length, 0, 'no session is stored');
});

test('the address shown in the notice is escaped', async () => {
  const s = shop({ id: 'u1', identities: [{ id: 'i1' }] });
  s.submit(s.form('signup', '<img src=x onerror=alert(1)>@example.invalid'));
  await settle();
  assert.doesNotMatch(s.p.sheetB.innerHTML, /<img/);
  assert.match(s.p.sheetB.innerHTML, /&lt;img src=x/);
});

test('a new account that is logged in at once: success message, sheet closes, no cart sheet opens', async () => {
  const s = shop({ access_token: 'a', refresh_token: 'r', user: { id: 'u1' } });
  s.submit(s.form('signup'));
  await settle();
  assert.equal(s.log.toasts.at(-1), 'تم التسجيل بنجاح');
  assert.equal(s.log.closed, 1);
  assert.deepEqual(s.log.sheets, []);
  assert.equal(s.log.saved.length, 1);
});

test('sign-up that began from «execute order» goes on to the store order form, not to a closed sheet', async () => {
  const s = shop({ access_token: 'a' }, { pending: 'store-1' });
  s.submit(s.form('signup'));
  await settle();
  assert.deepEqual(s.log.stores, ['store-1']);
  assert.equal(s.log.closed, 0);
});

test('sign-in is unchanged apart from the welcome: no sign-up message, the cart sheet opens', async () => {
  const s = shop({ access_token: 'a' });
  s.submit(s.form('login'));
  await settle();
  assert.deepEqual(s.log.toasts, ['أهلًا ومرحبًا بك ونتمنى لك رحلة تسويقية ممتعة'], 'the welcome of tests/login-logout-messages.test.js, not «registered»');
  assert.deepEqual(s.log.sheets, ['cart']);
  assert.equal(s.log.closed, 0);
});

test('an address that is already registered is said so and the sheet stays as it was', async () => {
  const s = shop({ id: 'fake', email: 'buyer@example.invalid', identities: [] });
  s.submit(s.form('signup'));
  await settle();
  assert.match(s.log.toasts.at(-1), /مسجّل بالفعل/);
  assert.doesNotMatch(s.log.toasts.at(-1), /تم التسجيل بنجاح/);
  assert.equal(s.p.sheetB.innerHTML, '', 'no success notice');
  assert.equal(s.log.closed, 0);
});

test('a server failure (for example the mail service refusing) is not shown as success or as a wrong password', async () => {
  const s = shop({ code: 500, error_code: 'unexpected_failure', msg: 'Error sending confirmation email' });
  s.submit(s.form('signup'));
  await settle();
  assert.match(s.log.toasts.at(-1), /تعذر إنشاء الحساب الآن/);
  assert.equal(s.p.sheetB.innerHTML, '');
  const l = shop({ code: 500, error_code: 'unexpected_failure' });
  l.submit(l.form('login'));
  await settle();
  assert.match(l.log.toasts.at(-1), /تعذر تسجيل الدخول الآن/);
});

test('the English page gets English text and an OK button', async () => {
  const s = shop({ id: 'u1', identities: [{ id: 'i1' }] }, { lang: 'en' });
  s.submit(s.form('signup'));
  await settle();
  assert.match(s.p.sheetB.innerHTML, /<h3>Registered successfully<\/h3>/);
  assert.match(s.p.sheetB.innerHTML, />OK<\/button>/);
});

/* ---------- the sign-up form does not take the browser's saved credentials ---------- */

const SHEET_SOURCE = CORE.slice(CORE.indexOf('function sheet(k){'), CORE.indexOf('function sendMsg('));
function renderSheet(kind) {
  const p = page();
  const context = vm.createContext({
    lang: 'ar', PENDING_STORE: '', document: p.document, cartHTML: () => '', favHTML: () => '',
    T: () => ({ nb: '', nm: 'الاسم', em: 'البريد', pw: 'كلمة المرور', ac: 'x', sh: { login: 'دخول', signup: 'إنشاء حساب', cart: 'السلة', fav: 'المفضلة' }, she: {} })
  });
  vm.runInContext(SHEET_SOURCE, context);
  vm.runInContext(`sheet(${JSON.stringify(kind)})`, context);
  return p.sheetB.innerHTML;
}

test('the sign-up form tells the browser not to fill old credentials: new-password, and no autofill for the other fields', () => {
  const html = renderSheet('signup');
  assert.match(html, /<form data-auth-form data-auth-mode="signup" autocomplete="off"/);
  assert.match(html, /<input name="name" autocomplete="off"/);
  assert.match(html, /<input name="email" type="email" autocomplete="off"/);
  assert.match(html, /<input name="password" type="password" autocomplete="new-password"/);
  assert.match(html, /minlength="8"/, 'the 8-character rule is still there');
});

test('the sign-in form is left alone so the browser can still offer the saved password', () => {
  const html = renderSheet('login');
  assert.doesNotMatch(html, /autocomplete/);
});

/* ---------- the «Confirm» link signs the customer in ---------- */

function confirmPage(hash, { user = { id: 'u1', email: 'buyer@example.invalid' }, userOk = true, config = { url: 'https://project.example.invalid', key: 'anon-key' }, claim } = {}) {
  const log = { replaced: [], saved: {}, menus: 0, fetched: [], claimed: [], synced: 0 };
  const p = page();
  const context = vm.createContext({
    lang: 'ar', SB: { url: '', key: '' }, AUTH: null, CART_FIRST_SYNC_DONE: false,
    location: { hash, pathname: '/', search: '' }, history: { replaceState: (...a) => log.replaced.push(a) },
    document: p.document, localStorage: { setItem: (k, v) => { log.saved[k] = JSON.parse(v); } },
    buildMenu: () => { log.menus++; }, syncCartFromCloud: async () => { log.synced++; },
    GuestIdentity: { claim: claim || (async (token) => { log.claimed.push(token); }) },
    fetch: async (url, init) => {
      log.fetched.push({ url: String(url), init });
      if (String(url) === '/api/config') return { ok: true, json: async () => config };
      return { ok: userOk, json: async () => user };
    },
    URLSearchParams, Promise, JSON, String, Number, RegExp, Array
  });
  context.window = context;
  vm.runInContext(ESC + '\n' + SOURCE, context, { filename: 'app-core.js (confirm)' });
  const run = () => vm.runInContext('readConfirmLink()', context);
  return { run, log, p, context };
}
const LINK = '#access_token=tok.en.value&expires_at=1893456000&expires_in=3600&refresh_token=ref123&token_type=bearer&type=signup';

test('the confirmation link signs the customer in, clears the address bar and welcomes them', async () => {
  const c = confirmPage(LINK);
  assert.equal(await c.run(), true);
  assert.equal(c.context.AUTH.access_token, 'tok.en.value');
  assert.equal(c.context.AUTH.refresh_token, 'ref123');
  assert.equal(c.context.AUTH.user.email, 'buyer@example.invalid', 'the user is read from Supabase with the new token');
  assert.equal(c.log.saved.elan_auth_session.access_token, 'tok.en.value', 'the session is kept for the next visit');
  assert.deepEqual(c.log.replaced, [[null, '', '/']], 'the token is out of the address bar and the history');
  const user = c.log.fetched.find((f) => /\/auth\/v1\/user$/.test(f.url));
  assert.equal(user.init.headers.Authorization, 'Bearer tok.en.value');
  assert.equal(user.init.headers.apikey, 'anon-key');
  assert.ok(c.log.menus >= 1, 'the menu is rebuilt, so «تسجيل الخروج» is live');
  assert.deepEqual(c.log.claimed, ['tok.en.value']);
  assert.equal(c.log.synced, 1);
  assert.equal(c.p.sheet.dataset.kind, 'confirmed');
  assert.match(c.p.sheetB.innerHTML, /<h3>تم تأكيد حسابك<\/h3>/);
  assert.match(c.p.sheetB.innerHTML, /أهلًا ومرحبًا بك شريك نجاح بمتجر Élan Scents ونتمنى لك رحلة تسويقية ممتعة/);
  assert.match(c.p.sheetB.innerHTML, /data-close-sheet>موافق<\/button>/);
});

test('a failing guest-cart merge does not undo the sign-in or the welcome', async () => {
  const c = confirmPage(LINK, { claim: async () => { throw new Error('boom'); } });
  assert.equal(await c.run(), true);
  assert.equal(c.context.AUTH.access_token, 'tok.en.value');
  assert.equal(c.p.sheet.dataset.kind, 'confirmed');
});

test('an expired or already used link is explained and nobody is signed in', async () => {
  const c = confirmPage('#error=access_denied&error_code=otp_expired&error_description=Email+link+is+invalid+or+has+expired');
  assert.equal(await c.run(), false);
  assert.equal(c.context.AUTH, null);
  assert.deepEqual(c.log.saved, {});
  assert.equal(c.log.replaced.length, 1);
  assert.equal(c.p.sheet.dataset.kind, 'confirmFail');
  assert.match(c.p.sheetB.innerHTML, /تعذر فتح رابط التأكيد/);
  assert.match(c.p.sheetB.innerHTML, /سجّل الدخول ببريدك وكلمة المرور/, 'tells them the account may already be active');
});

test('a token Supabase refuses is not stored, and the customer is told the link did not work', async () => {
  const c = confirmPage(LINK, { userOk: false });
  assert.equal(await c.run(), false);
  assert.equal(c.context.AUTH, null);
  assert.deepEqual(c.log.saved, {});
  assert.equal(c.p.sheet.dataset.kind, 'confirmFail');
});

test('no site configuration: the link cannot be checked, so nothing is stored', async () => {
  const c = confirmPage(LINK, { config: {} });
  assert.equal(await c.run(), false);
  assert.equal(c.context.AUTH, null);
  assert.equal(c.p.sheet.dataset.kind, 'confirmFail');
});

test('ordinary addresses are not touched: menu anchors, a recovery link and an empty hash', async () => {
  for (const hash of ['', '#about', '#contact', '#access_token=x&type=recovery', '#type=signup']) {
    const c = confirmPage(hash);
    assert.equal(await c.run(), false, hash);
    assert.deepEqual(c.log.replaced, [], 'the address is left as it was: ' + hash);
    assert.equal(c.log.fetched.length, 0);
    assert.equal(c.p.sheetB.innerHTML, '');
  }
});

test('the page starts the check when it loads, and the editor preview never does', () => {
  assert.match(CORE, /render\(\);cartBadge\(\);showFlash\(\);readConfirmLink\(\);loadData\(\);/);
  const c = confirmPage(LINK);
  c.context.ELAN_EDITOR_PREVIEW = true;
  return c.run().then((result) => { assert.equal(result, false); assert.equal(c.log.fetched.length, 0); });
});
