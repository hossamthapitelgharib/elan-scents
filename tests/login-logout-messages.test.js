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
  const log = { toasts: [], requests: [], sheets: [], closed: 0 };
  const p = page();
  const context = vm.createContext({
    lang, SB: { url: 'https://project.example.invalid', key: 'anon-key' }, AUTH: null, PENDING_STORE: '', CART_FIRST_SYNC_DONE: true,
    location: { origin: 'https://shop.example.invalid' }, document: p.document,
    toast: (text, ms) => log.toasts.push({ text, ms }), closeSheet() { log.closed++; }, sheet: (k) => log.sheets.push(k), openStoreOrder() {},
    buildMenu() {}, adoptAccountLists() {}, syncCartFromCloud: async () => {}, syncFavsFromCloud: async () => {}, localStorage: { setItem() {} },
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

test('after signing in the customer is welcomed in the same card as the first-time welcome, not in a toast', async () => {
  const s = shop({ access_token: 'a', user: { id: 'u1' } });
  s.submit(s.form('login', withPassword));
  await settle();
  assert.deepEqual(s.log.toasts, [], 'no toast: the welcome is a card');
  assert.equal(s.p.sheet.hidden, false, 'the card is shown');
  assert.equal(s.p.sheet.dataset.kind, 'welcome');
  assert.match(s.p.sheetB.innerHTML, /<div class="auth-done" role="alert"><h3>تم تسجيل الدخول بنجاح<\/h3>/, 'the same markup as the «account confirmed» card');
  assert.match(s.p.sheetB.innerHTML, /أهلًا ومرحبًا بك ونتمنى لك رحلة تسويقية ممتعة/, 'the owner\'s wording');
  assert.match(s.p.sheetB.innerHTML, /data-close-sheet>موافق<\/button>/, 'it has its own OK button');
  assert.deepEqual(s.log.sheets, [], 'the cart does not open by itself after signing in');
  assert.equal(s.log.closed, 0, 'the sign-in sheet is replaced by the card, not closed under it');
});

test('the welcome is English on the English page, and a failed sign-in gets no welcome', async () => {
  const en = shop({ access_token: 'a' }, { lang: 'en' });
  en.submit(en.form('login', withPassword));
  await settle();
  assert.match(en.p.sheetB.innerHTML, /<h3>Signed in successfully<\/h3>/);
  assert.match(en.p.sheetB.innerHTML, />OK<\/button>/);
  const bad = shop({ error_code: 'invalid_credentials', msg: 'Invalid login credentials' });
  bad.submit(bad.form('login', withPassword));
  await settle();
  assert.equal(bad.log.toasts.length, 1);
  assert.match(bad.log.toasts[0].text, /غير صحيحة/);
  assert.equal(bad.p.sheetB.innerHTML, '', 'a failed sign-in shows no welcome card');
});

test('signing up and being signed in at once says registered, not the sign-in welcome', async () => {
  const s = shop({ access_token: 'a' });
  s.submit(s.form('signup', Object.assign({ name: { value: 'Test Buyer' } }, withPassword)));
  await settle();
  assert.deepEqual(s.log.toasts, []);
  assert.equal(s.p.sheet.dataset.kind, 'signupDone');
  assert.match(s.p.sheetB.innerHTML, /<h3>تم التسجيل بنجاح<\/h3>/);
  assert.doesNotMatch(s.p.sheetB.innerHTML, /تسجيل الدخول بنجاح/);
});

/* ---------- signing out ---------- */

const OUT = CORE.slice(CORE.indexOf('function logoutNow('), CORE.indexOf('function card('));
const MAIL = CORE.slice(CORE.indexOf('function mailEvent('), CORE.indexOf('\nfunction ', CORE.indexOf('function mailEvent(') + 10));
function signOut(extra = {}) {
  const log = { reloaded: 0, session: {}, local: [] };
  log.order = [];
  log.badges = 0; log.sheetsClosed = 0;
  const context = vm.createContext(Object.assign({
    AUTH: null, LOGGING_OUT: false, CART: [{ sid: 's1', q: 2 }], FAVS: ['s1'], CART_REV: 0, FAV_REV: 0,
    cartBadge: () => { log.badges++; }, favBadge: () => { log.badges++; }, closeSheet: () => { log.sheetsClosed++; },
    ElanAuth: { signOut: async () => { log.order.push('signOut'); } },
    fetch: async (url, init) => { log.order.push('mail'); log.mail = { url: String(url), init }; return { ok: true }; },
    localStorage: { removeItem: (k) => log.local.push(k) },
    sessionStorage: { setItem: (k, v) => { log.session[k] = v; } },
    location: { reload: () => { log.reloaded++; } },
    setTimeout, Promise, JSON
  }, extra));
  context.window = context;
  vm.runInContext(MAIL + '\n' + OUT, context);
  return { run: () => vm.runInContext('logoutNow()', context), log, context, read: (expr) => vm.runInContext(expr, context) };
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

test('signing out empties the cart and favourites on screen at once and shuts every later write', async () => {
  const o = signOut({ AUTH: { access_token: 'user-token' } });
  o.run();
  // before anything has been awaited: the screen is already empty and nothing can write the old lists back
  assert.deepEqual(JSON.parse(JSON.stringify(o.read('CART'))), []);
  assert.deepEqual(JSON.parse(JSON.stringify(o.read('FAVS'))), []);
  assert.equal(o.read('LOGGING_OUT'), true);
  assert.ok(o.log.badges >= 2, 'both header counters are redrawn');
  assert.equal(o.log.sheetsClosed, 1, 'an open cart or favourites sheet is closed so it cannot show the old rows');
  for (const key of ['elan_cart', 'elan_favs', 'elan_cart_owner', 'elan_favs_owner']) assert.ok(o.log.local.includes(key), key + ' is removed from the device');
  await settle();
  assert.equal(o.log.reloaded, 1);
});

test('a second tap on sign out while the first is running does nothing', async () => {
  const o = signOut({ AUTH: { access_token: 'user-token' } });
  o.run(); o.run();
  await settle();
  assert.equal(o.log.reloaded, 1);
  assert.equal(o.log.order.filter((x) => x === 'signOut').length, 1);
});

function flash(value, lang = 'ar') {
  const p = page(), store = new Map(value ? [['elan_flash', value]] : []);
  const context = vm.createContext({ lang, document: p.document, toast() {}, sessionStorage: { getItem: (k) => (store.has(k) ? store.get(k) : null), removeItem: (k) => store.delete(k) } });
  vm.runInContext(ESC + '\n' + AUTH, context);
  vm.runInContext('showFlash()', context);
  return { p, store, again: () => vm.runInContext('showFlash()', context) };
}

test('the page that loads after signing out says so once, in the same card as the welcome', () => {
  const f = flash('logout');
  assert.equal(f.p.sheet.hidden, false);
  assert.equal(f.p.sheet.dataset.kind, 'goodbye');
  assert.match(f.p.sheetB.innerHTML, /<div class="auth-done" role="alert"><h3>تم تسجيل الخروج بنجاح<\/h3>/);
  assert.match(f.p.sheetB.innerHTML, /كنا سعداء بوجودك معنا، وفي انتظارك دائمًا\./, 'the goodbye carries the farewell line');
  assert.equal(f.store.has('elan_flash'), false, 'the note is used up');
  f.p.sheet.hidden = true; f.p.sheetB.innerHTML = '';
  f.again();
  assert.equal(f.p.sheet.hidden, true, 'a second load says nothing');
  assert.equal(f.p.sheetB.innerHTML, '');
});

test('no note, no message; English page, English message', () => {
  assert.equal(flash('').p.sheet.hidden, true);
  assert.equal(flash('something-else').p.sheet.hidden, true);
  assert.match(flash('logout', 'en').p.sheetB.innerHTML, /<h3>Signed out successfully<\/h3>/);
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

test('the sign-up and sign-in sheets carry no policy sentence and no link to each other (owner, 3 Nov 2026); only «forgot password» goes back to sign-in', () => {
  const signup = renderSheet('signup').html, login = renderSheet('login').html;
  assert.doesNotMatch(signup, /auth-consent|privacy\.html|سياسة الخصوصية/, 'no policy sentence under the sign-up button');
  assert.doesNotMatch(signup, /data-sheet="login"/, 'no «sign in» line under the sign-up button');
  assert.doesNotMatch(login, /data-sheet="signup"/, 'no «create account» line under the sign-in button');
  assert.equal((signup.match(/<button/g) || []).length, 2, 'the close button and the submit button only');
  assert.equal((login.match(/<button/g) || []).length, 3, 'the close button, the submit button and «forgot password»');
  assert.match(signup, /<input name="name"/);
  assert.match(login, /type="submit">تسجيل الدخول<\/button>/);
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

test('asking for the link: the reset request goes to Supabase with the home page of the shop as the return address (the new-password card opens there), and the customer is told to check the inbox', async () => {
  const s = shop({});
  s.submit(s.form('forgot', {}));
  await settle();
  assert.equal(s.log.requests.length, 1);
  assert.equal(s.log.requests[0].url, 'https://project.example.invalid/auth/v1/recover?redirect_to=' + encodeURIComponent('https://shop.example.invalid/'));
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

/* ---------- the service e-mails (api/customer-mail.js) ---------- */

test('signing out sends no e-mail request at all (no goodbye mail), while the token is still valid it only ends the session', async () => {
  const o = signOut({ AUTH: { access_token: 'user-token' } });
  o.run();
  await settle();
  assert.deepEqual(o.log.order, ['signOut'], 'nothing is asked of the mail endpoint');
  assert.equal(o.log.mail, undefined);
  assert.equal(o.log.reloaded, 1);
});

test('nobody signed in, nothing to mail: signing out sends no request', async () => {
  const o = signOut({ AUTH: null });
  o.run();
  await settle();
  assert.deepEqual(o.log.order, ['signOut']);
  assert.equal(o.log.reloaded, 1);
});

test('mailEvent: no token or the editor preview sends nothing; the request never rejects; with a wait it gives up on time', async () => {
  const calls = [];
  const context = vm.createContext({ fetch: async (u, i) => { calls.push({ u, i }); return {}; }, setTimeout, Promise, JSON });
  context.window = context;
  vm.runInContext(MAIL, context);
  const mailEvent = vm.runInContext('mailEvent', context);
  await mailEvent('login', '');
  assert.equal(calls.length, 0, 'no token, no request');
  context.window.ELAN_EDITOR_PREVIEW = true;
  await mailEvent('login', 'tk');
  assert.equal(calls.length, 0, 'the editor preview records nothing');
  context.window.ELAN_EDITOR_PREVIEW = false;
  await mailEvent('login', 'tk');
  await settle();
  assert.equal(calls.length, 1);
  assert.equal(JSON.parse(calls[0].i.body).event, 'login');
  assert.ok(!calls[0].i.keepalive, 'no keepalive: the page wrapper skips those, and they would not be refreshed on a 401');

  const hang = vm.createContext({ fetch: () => new Promise(() => {}), setTimeout, Promise, JSON });
  hang.window = hang;
  vm.runInContext(MAIL, hang);
  const started = Date.now();
  await vm.runInContext('mailEvent', hang)('logout', 'tk', 30);
  assert.ok(Date.now() - started < 500, 'it returns after the wait even if the server never answers');
  const boom = vm.createContext({ fetch: async () => { throw new Error('x'); }, setTimeout, Promise, JSON });
  boom.window = boom;
  vm.runInContext(MAIL, boom);
  await vm.runInContext('mailEvent', boom)('logout', 'tk', 30);
});

test('signing in asks for the welcome mail, and a sign-up that is signed in at once reports the new account instead', async () => {
  const login = shop({ access_token: 'login-token' });
  login.submit(login.form('login', withPassword));
  await settle();
  const sent = login.log.requests.find((r) => r.url === '/api/customer-mail');
  assert.ok(sent, 'a successful sign-in asks the server for the welcome mail');
  assert.deepEqual(sent.body, { event: 'login' });

  const signup = shop({ access_token: 'new-token' });
  signup.submit(signup.form('signup', Object.assign({ name: { value: 'Test Buyer' } }, withPassword)));
  await settle();
  assert.deepEqual(signup.log.requests.find((r) => r.url === '/api/customer-mail').body, { event: 'registered' });

  const wrong = shop({ error_code: 'invalid_credentials', msg: 'Invalid login credentials' });
  wrong.submit(wrong.form('login', withPassword));
  await settle();
  assert.ok(!wrong.log.requests.some((r) => r.url === '/api/customer-mail'), 'a failed sign-in mails nothing');

  const pending = shop({ id: 'x', email: 'a@b.c', identities: [{ id: 'i' }], confirmation_sent_at: 'now' });
  pending.submit(pending.form('signup', Object.assign({ name: { value: 'Test Buyer' } }, withPassword)));
  await settle();
  assert.ok(!pending.log.requests.some((r) => r.url === '/api/customer-mail'), 'a sign-up that still waits for its confirmation has no session to ask with');
});

test('the confirmation link reports the new account with the link\'s own token', () => {
  const fn = CORE.slice(CORE.indexOf('function readConfirmLink('), CORE.indexOf('\nfunction ', CORE.indexOf('function readConfirmLink(') + 10));
  assert.match(fn, /buildMenu\(\);mailEvent\('registered',tk\);/);
});
