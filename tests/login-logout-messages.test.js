// The messages a customer sees when signing in and out, and «forgot password» in the sign-in sheet.
// app-core.js is one long file, so the functions under test are cut out and run against a fake page and a fake server.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const read = (name) => fs.readFileSync(path.join(__dirname, '..', name), 'utf8');
const CORE = read('app-core.js');
const AUTH = CORE.slice(CORE.indexOf('function authFailText('), CORE.indexOf('async function loadData('));
const ESC = CORE.slice(CORE.indexOf('function esc(s){'), CORE.indexOf('function ratingHTML('));
const settle = () => new Promise((resolve) => setTimeout(resolve, 20));

function page() {
  const sheet = { hidden: true, dataset: {} };
  const sheetB = { innerHTML: '' };
  return { sheet, sheetB, document: { getElementById: (id) => ({ sheet, sheetB }[id] || null), body: { classList: { add() {}, remove() {} } } } };
}

function shop(server, { lang = 'ar', turnstile } = {}) {
  const log = { toasts: [], requests: [], sheets: [] };
  const p = page();
  const context = vm.createContext({
    lang, SB: { url: 'https://project.example.invalid', key: 'anon-key' }, AUTH: null, PENDING_STORE: '', CART_FIRST_SYNC_DONE: true,
    location: { origin: 'https://shop.example.invalid' }, document: p.document,
    toast: (text, ms) => log.toasts.push({ text, ms }), closeSheet() {}, sheet: (k) => log.sheets.push(k), openStoreOrder() {},
    buildMenu() {}, syncCartFromCloud: async () => {}, localStorage: { setItem() {} },
    fetch: async (url, init) => { log.requests.push({ url: String(url), body: JSON.parse(init.body) }); return { json: async () => server }; },
    Promise, JSON, String, RegExp, Array, encodeURIComponent
  });
  context.window = context;
  if (turnstile) context.ElanTurnstile = turnstile;
  vm.runInContext(ESC + '\n' + AUTH, context, { filename: 'app-core.js (auth)' });
  const button = { disabled: false };
  const form = (mode, elements) => ({ dataset: { authMode: mode }, elements: Object.assign({ email: { value: ' buyer@example.invalid ' } }, elements), querySelector: () => button });
  return { submit: vm.runInContext('authSubmit', context), form, log, p, context };
}
const withPassword = { password: { value: 'a-test-password' } };

/* ---------- welcome after signing in ---------- */

test('after signing in the customer is welcomed on screen, for a few seconds', async () => {
  const s = shop({ access_token: 'a', user: { id: 'u1' } });
  s.submit(s.form('login', withPassword));
  await settle();
  assert.deepEqual(s.log.toasts, [{ text: 'أهلًا ومرحبًا بك ونتمنى لك رحلة تسويقية ممتعة', ms: 4500 }]);
  assert.deepEqual(s.log.sheets, ['cart']);
});

test('the welcome is English on the English page, and a failed sign-in gets no welcome', async () => {
  const en = shop({ access_token: 'a' }, { lang: 'en' });
  en.submit(en.form('login', withPassword));
  await settle();
  assert.match(en.log.toasts[0].text, /^Welcome/);
  const bad = shop({ error_code: 'invalid_credentials', msg: 'Invalid login credentials' });
  bad.submit(bad.form('login', withPassword));
  await settle();
  assert.equal(bad.log.toasts.length, 1);
  assert.match(bad.log.toasts[0].text, /غير صحيحة/);
});

test('signing up and being signed in at once says registered, not the sign-in welcome', async () => {
  const s = shop({ access_token: 'a' });
  s.submit(s.form('signup', Object.assign({ name: { value: 'Test Buyer' } }, withPassword)));
  await settle();
  assert.equal(s.log.toasts[0].text, 'تم التسجيل بنجاح');
});

/* ---------- signing out ---------- */

const OUT = CORE.slice(CORE.indexOf('function logoutNow('), CORE.indexOf('function card('));
function signOut(extra = {}) {
  const log = { reloaded: 0, session: {}, local: [] };
  const context = vm.createContext(Object.assign({
    ElanAuth: { signOut: async () => {} },
    localStorage: { removeItem: (k) => log.local.push(k) },
    sessionStorage: { setItem: (k, v) => { log.session[k] = v; } },
    location: { reload: () => { log.reloaded++; } },
    setTimeout, Promise
  }, extra));
  context.window = context;
  vm.runInContext(OUT, context);
  return { run: () => vm.runInContext('logoutNow()', context), log };
}

test('signing out leaves a note for the page that loads next, then reloads', async () => {
  const o = signOut();
  o.run();
  await settle();
  assert.equal(o.log.session.elan_flash, 'logout');
  assert.equal(o.log.reloaded, 1);
  assert.ok(o.log.local.includes('elan_auth_session'), 'the session is still removed');
});

test('a sign-out that the server could not complete still signs the customer out here and leaves the note', async () => {
  const o = signOut({ ElanAuth: { signOut: async () => { throw new Error('offline'); } } });
  o.run();
  await settle();
  assert.equal(o.log.session.elan_flash, 'logout');
  assert.ok(o.log.local.includes('elan_auth_session'));
  assert.equal(o.log.reloaded, 1);
});

function flash(value, lang = 'ar') {
  const toasts = [], store = new Map(value ? [['elan_flash', value]] : []);
  const context = vm.createContext({ lang, toast: (text, ms) => toasts.push({ text, ms }), sessionStorage: { getItem: (k) => (store.has(k) ? store.get(k) : null), removeItem: (k) => store.delete(k) } });
  vm.runInContext(ESC + '\n' + AUTH, context);
  vm.runInContext('showFlash()', context);
  return { toasts, store, again: () => vm.runInContext('showFlash()', context) };
}

test('the page that loads after signing out says so once', () => {
  const f = flash('logout');
  assert.deepEqual(f.toasts, [{ text: 'تم تسجيل الخروج بنجاح', ms: 4500 }]);
  assert.equal(f.store.has('elan_flash'), false, 'the note is used up');
  f.again();
  assert.equal(f.toasts.length, 1, 'a second load says nothing');
});

test('no note, no message; English page, English message', () => {
  assert.deepEqual(flash('').toasts, []);
  assert.deepEqual(flash('something-else').toasts, []);
  assert.equal(flash('logout', 'en').toasts[0].text, 'Signed out successfully');
});

test('the page calls showFlash when it starts, and toast takes an optional duration', () => {
  assert.match(CORE, /render\(\);cartBadge\(\);showFlash\(\);/);
  const timers = [];
  const el = { className: '', textContent: '' };
  const context = vm.createContext({ document: { getElementById: () => el }, setTimeout: (f, ms) => { timers.push(ms); return 1; }, clearTimeout() {} });
  vm.runInContext(CORE.slice(CORE.indexOf('function toast('), CORE.indexOf('function addToCart(')), context);
  vm.runInContext("toast('a');toast('b',4500)", context);
  assert.deepEqual(timers, [2600, 4500]);
});

/* ---------- forgot password inside the sign-in sheet ---------- */

const SHEET = CORE.slice(CORE.indexOf('function sheet(k){'), CORE.indexOf('function sendMsg('));
function renderSheet(kind) {
  const p = page();
  const D = vm.runInContext('(function(){' + read('texts.js') + ';return D})()', vm.createContext({ window: {}, document: {}, console }));
  const context = vm.createContext({ lang: 'ar', PENDING_STORE: '', document: p.document, cartHTML: () => '', favHTML: () => '', T: () => D.ar });
  vm.runInContext(SHEET, context);
  vm.runInContext(`sheet(${JSON.stringify(kind)})`, context);
  return { html: p.sheetB.innerHTML, shown: !p.sheet.hidden, kind: p.sheet.dataset.kind };
}

test('the sign-in sheet offers «نسيت كلمة المرور؟», the sign-up sheet does not', () => {
  const login = renderSheet('login');
  assert.match(login.html, /<button type="button" class="back-cart" data-sheet="forgot">نسيت كلمة المرور؟<\/button>/);
  assert.match(login.html, /name="password"/);
  assert.doesNotMatch(renderSheet('signup').html, /data-sheet="forgot"/);
});

test('the forgot sheet asks for the e-mail only and can go back to sign-in', () => {
  const forgot = renderSheet('forgot');
  assert.equal(forgot.shown, true);
  assert.equal(forgot.kind, 'forgot');
  assert.match(forgot.html, /<h3>نسيت كلمة المرور<\/h3>/);
  assert.match(forgot.html, /data-auth-mode="forgot"/);
  assert.match(forgot.html, /name="email"/);
  assert.doesNotMatch(forgot.html, /name="password"/, 'no password asked while resetting it');
  assert.match(forgot.html, /type="submit">إرسال رابط إعادة التعيين<\/button>/);
  assert.match(forgot.html, /data-sheet="login"/, 'a way back to sign-in');
});

test('every new text exists in Arabic and in English', () => {
  const D = vm.runInContext('(function(){' + read('texts.js') + ';return D})()', vm.createContext({ window: {}, document: {}, console }));
  for (const lang of ['ar', 'en']) {
    for (const key of ['fgl', 'fg']) assert.ok(D[lang][key] && D[lang][key].length > 3, `${lang}.${key}`);
    assert.ok(D[lang].sh.forgot, `${lang}.sh.forgot`);
  }
});

test('asking for the link: the reset request goes to Supabase with the account page as the return address, and the customer is told to check the inbox', async () => {
  const s = shop({});
  s.submit(s.form('forgot', {}));
  await settle();
  assert.equal(s.log.requests.length, 1);
  assert.equal(s.log.requests[0].url, 'https://project.example.invalid/auth/v1/recover?redirect_to=' + encodeURIComponent('https://shop.example.invalid/account.html'));
  assert.deepEqual(s.log.requests[0].body, { email: 'buyer@example.invalid' }, 'only the e-mail is sent');
  assert.equal(s.p.sheet.dataset.kind, 'forgotDone');
  assert.match(s.p.sheetB.innerHTML, /<h3>تم إرسال الرابط<\/h3>/);
  assert.match(s.p.sheetB.innerHTML, /إن كان هذا البريد مسجّلًا/, 'the same sentence whether or not the address has an account');
  assert.match(s.p.sheetB.innerHTML, /<b dir="ltr">buyer@example\.invalid<\/b>/);
  assert.match(s.p.sheetB.innerHTML, /data-close-sheet>موافق<\/button>/);
  assert.deepEqual(s.log.toasts, []);
});

test('the reset request carries the human check when the shop has one, like the other account forms', async () => {
  const boxes = [];
  const s = shop({}, { turnstile: { token: async (form) => { boxes.push(form); return 'stub-token'; }, body: (o, t) => Object.assign(o, { gotrue_meta_security: { captcha_token: t } }) } });
  const form = s.form('forgot', {});
  s.submit(form);
  await settle();
  assert.equal(boxes[0], form);
  assert.deepEqual(s.log.requests[0].body, { email: 'buyer@example.invalid', gotrue_meta_security: { captcha_token: 'stub-token' } });
});

test('a reset that fails says so in words, never a wrong-password or weak-password message', async () => {
  const cases = [
    [{ code: 500, error_code: 'unexpected_failure', msg: 'Error sending recovery email' }, /تعذر إرسال الرابط الآن/],
    [{ code: 400, error_code: 'validation_failed', msg: 'Unable to validate email address: invalid format' }, /تعذر إرسال الرابط الآن/],
    [{ code: 400, error_code: 'weak_password', msg: 'Password should be at least 6 characters' }, /تعذر إرسال الرابط الآن/],
    [{ code: 429, error_code: 'over_email_send_rate_limit', msg: 'email rate limit exceeded' }, /محاولات كثيرة/],
    [{ error_code: 'captcha_failed', msg: 'captcha protection: request disallowed' }, /التحقق الأمني/]
  ];
  for (const [answer, expected] of cases) {
    const s = shop(answer);
    s.submit(s.form('forgot', {}));
    await settle();
    assert.match(s.log.toasts.at(-1).text, expected, JSON.stringify(answer));
    assert.equal(s.p.sheetB.innerHTML, '', 'no success notice');
  }
});
