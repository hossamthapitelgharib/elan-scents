// What a shopper sees after pressing «إنشاء حساب»: a success message and the sheet closes by itself. app-core.js is one long file,
// so only the sign-up/sign-in functions are cut out and run against a fake server (no network, no real addresses).
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const CORE = fs.readFileSync(path.join(__dirname, '..', 'app-core.js'), 'utf8');
const SOURCE = CORE.slice(CORE.indexOf('function authFailText('), CORE.indexOf('async function loadData('));
const settle = () => new Promise((resolve) => setTimeout(resolve, 20));

function shop(server, { lang = 'ar', pending = '' } = {}) {
  const log = { toasts: [], closed: 0, sheets: [], stores: [], saved: [] };
  const context = vm.createContext({
    lang, SB: { url: 'https://project.example.invalid', key: 'anon-key' }, AUTH: null, PENDING_STORE: pending, CART_FIRST_SYNC_DONE: true,
    toast: (text) => log.toasts.push(text), closeSheet: () => { log.closed++; }, sheet: (k) => log.sheets.push(k), openStoreOrder: (s) => log.stores.push(s),
    buildMenu() {}, syncCartFromCloud: async () => {}, localStorage: { setItem: (k) => log.saved.push(k) },
    fetch: async () => ({ json: async () => server }), Promise, JSON, String, RegExp, Array
  });
  context.window = context;
  vm.runInContext(SOURCE, context, { filename: 'app-core.js (auth)' });
  const button = { disabled: false };
  const form = (mode) => ({ dataset: { authMode: mode }, elements: { email: { value: 'buyer@example.invalid' }, password: { value: 'a-test-password' }, name: { value: 'Test Buyer' } }, querySelector: () => button });
  return { submit: vm.runInContext('authSubmit', context), form, log };
}

test('a new account that must confirm its e-mail: success message, sheet closes, nobody is logged in', async () => {
  const s = shop({ id: 'u1', email: 'buyer@example.invalid', identities: [{ id: 'i1' }], confirmation_sent_at: 'now' });
  s.submit(s.form('signup'));
  await settle();
  assert.match(s.log.toasts.at(-1), /تم التسجيل بنجاح/);
  assert.match(s.log.toasts.at(-1), /بريدك/);
  assert.equal(s.log.closed, 1, 'the sign-up sheet closes by itself');
  assert.equal(s.log.saved.length, 0, 'no session is stored');
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

test('sign-in is unchanged: no sign-up message, the cart sheet opens', async () => {
  const s = shop({ access_token: 'a' });
  s.submit(s.form('login'));
  await settle();
  assert.deepEqual(s.log.toasts, []);
  assert.deepEqual(s.log.sheets, ['cart']);
  assert.equal(s.log.closed, 0);
});

test('an address that is already registered is said so and the sheet stays open', async () => {
  const s = shop({ id: 'fake', email: 'buyer@example.invalid', identities: [] });
  s.submit(s.form('signup'));
  await settle();
  assert.match(s.log.toasts.at(-1), /مسجّل بالفعل/);
  assert.doesNotMatch(s.log.toasts.at(-1), /تم التسجيل بنجاح/);
  assert.equal(s.log.closed, 0);
});

test('a server failure (for example the mail service refusing) is not shown as success or as a wrong password', async () => {
  const s = shop({ code: 500, error_code: 'unexpected_failure', msg: 'Error sending confirmation email' });
  s.submit(s.form('signup'));
  await settle();
  assert.match(s.log.toasts.at(-1), /تعذر إنشاء الحساب الآن/);
  assert.equal(s.log.closed, 0);
  const l = shop({ code: 500, error_code: 'unexpected_failure' });
  l.submit(l.form('login'));
  await settle();
  assert.match(l.log.toasts.at(-1), /تعذر تسجيل الدخول الآن/);
});

test('the English page gets English success text', async () => {
  const s = shop({ id: 'u1', identities: [{ id: 'i1' }] }, { lang: 'en' });
  s.submit(s.form('signup'));
  await settle();
  assert.match(s.log.toasts.at(-1), /^Registered successfully/);
});
