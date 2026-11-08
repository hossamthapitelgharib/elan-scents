// «Forgot password» in the storefront (owner, 8 Nov 2026): the e-mail link lands on the shop's home page and opens a card where the customer
// writes the new password; once saved he is signed in and welcomed in the same card style, and no second page appears.
// app-core.js is one long file, so the functions under test are cut out and run against a fake page and a fake server (no network, no real addresses).
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const CORE = fs.readFileSync(path.join(__dirname, '..', 'app-core.js'), 'utf8');
const SOURCE = CORE.slice(CORE.indexOf('function authFailText('), CORE.indexOf('async function loadData('));
const ESC = CORE.slice(CORE.indexOf('function esc(s){'), CORE.indexOf('function ratingHTML('));
const HASH = '#access_token=recovery.tok.en&expires_at=1893456000&expires_in=3600&refresh_token=ref123&token_type=bearer&type=recovery';

function build(hash, { lang = 'ar', userOk = true, put = { ok: true, body: { id: 'u1', email: 'buyer@example.invalid' } } } = {}) {
  const log = { replaced: [], saved: {}, menus: 0, adopted: [], toasts: [], requests: [], claimed: [], synced: 0, favs: 0 };
  const sheet = { hidden: true, dataset: {} };
  const sheetB = { innerHTML: '' };
  const context = vm.createContext({
    lang, SB: { url: 'https://project.example.invalid', key: 'anon-key' }, AUTH: null, PENDING_STORE: '', CART_FIRST_SYNC_DONE: false,
    location: { hash, pathname: '/', search: '' }, history: { replaceState: (...a) => log.replaced.push(a) },
    document: { getElementById: (id) => ({ sheet, sheetB }[id] || null), body: { classList: { add() {}, remove() {} } } },
    localStorage: { setItem: (k, v) => { log.saved[k] = JSON.parse(v); } },
    toast: (text) => log.toasts.push(text), buildMenu: () => { log.menus++; }, adoptAccountLists: (id) => log.adopted.push(id),
    syncCartFromCloud: async () => { log.synced++; }, syncFavsFromCloud: async () => { log.favs++; },
    GuestIdentity: { claim: async (token) => { log.claimed.push(token); } },
    fetch: async (url, init = {}) => {
      log.requests.push({ url: String(url), method: init.method || 'GET', headers: init.headers || {}, body: init.body ? JSON.parse(init.body) : null });
      if (init.method === 'PUT') return { ok: put.ok, json: async () => put.body };
      return { ok: userOk, json: async () => ({ id: 'u1', email: 'buyer@example.invalid' }) };
    },
    URLSearchParams, Promise, JSON, String, Number, RegExp, Array
  });
  context.window = context;
  vm.runInContext(ESC + '\n' + SOURCE, context, { filename: 'app-core.js (recovery)' });
  const btn = { disabled: false };
  const form = (password, confirm) => ({ dataset: {}, elements: { password: { value: password }, confirm: { value: confirm } }, querySelector: () => btn });
  return { open: () => vm.runInContext('readConfirmLink()', context), submit: (f) => vm.runInContext('newPassSubmit', context)(f), form, btn, log, sheet, sheetB, context };
}

test('a recovery link opens the new-password card on the shop, and nobody is signed in yet', async () => {
  const r = build(HASH);
  assert.equal(await r.open(), true);
  assert.equal(r.sheet.hidden, false);
  assert.equal(r.sheet.dataset.kind, 'newpass');
  assert.deepEqual(r.log.replaced, [[null, '', '/']], 'the token is out of the address bar and the history');
  assert.equal(r.context.AUTH, null, 'not signed in until the new password is saved');
  assert.deepEqual(r.log.saved, {}, 'the recovery token is not stored as a session');
  assert.equal(r.log.menus, 0);
  assert.equal(r.log.requests.length, 1, 'only the check of the token');
  assert.equal(r.log.requests[0].headers.Authorization, 'Bearer recovery.tok.en');
  assert.match(r.sheetB.innerHTML, /<h3>كلمة مرور جديدة<\/h3>/);
  assert.match(r.sheetB.innerHTML, /<form data-newpass-form/);
  assert.equal((r.sheetB.innerHTML.match(/type="password"/g) || []).length, 2, 'the new password and its repetition');
  assert.equal((r.sheetB.innerHTML.match(/autocomplete="new-password"/g) || []).length, 2);
  assert.doesNotMatch(r.sheetB.innerHTML, /onclick|onsubmit|<script/i, 'the page policy forbids inline code');
});

test('an expired recovery link is explained and no card for a password opens', async () => {
  const r = build('#error=access_denied&error_code=otp_expired&error_description=Email+link+is+invalid+or+has+expired');
  assert.equal(await r.open(), false);
  assert.equal(r.sheet.dataset.kind, 'confirmFail');
  const bad = build(HASH, { userOk: false });
  assert.equal(await bad.open(), false);
  assert.equal(bad.sheet.dataset.kind, 'confirmFail', 'a token Supabase refuses never reaches the password form');
});

test('two different passwords, or a short one, are refused on the spot and nothing is sent', async () => {
  const r = build(HASH);
  await r.open();
  const before = r.log.requests.length;
  await r.submit(r.form('a-new-password', 'another-password'));
  assert.deepEqual(r.log.toasts, ['كلمتا المرور غير متطابقتين.']);
  await r.submit(r.form('short', 'short'));
  assert.equal(r.log.toasts.at(-1), 'اكتب 8 أحرف على الأقل.');
  assert.equal(r.log.requests.length, before, 'no request for either');
  assert.equal(r.context.AUTH, null);
});

test('saving the new password: it is sent with the link\'s token, the customer is signed in and welcomed in the card style', async () => {
  const r = build(HASH);
  await r.open();
  const form = r.form('a-new-password', 'a-new-password');
  await r.submit(form);
  const put = r.log.requests.find((q) => q.method === 'PUT');
  assert.equal(put.url, 'https://project.example.invalid/auth/v1/user');
  assert.equal(put.headers.Authorization, 'Bearer recovery.tok.en');
  assert.equal(put.headers.apikey, 'anon-key');
  assert.deepEqual(put.body, { password: 'a-new-password' }, 'only the password is sent');
  assert.equal(r.context.AUTH.access_token, 'recovery.tok.en');
  assert.equal(r.context.AUTH.user.email, 'buyer@example.invalid');
  assert.equal(r.log.saved.elan_auth_session.access_token, 'recovery.tok.en', 'the session is kept for the next visit');
  assert.deepEqual(r.log.adopted, ['u1'], 'the cart and favourites of this account are adopted');
  assert.ok(r.log.menus >= 1);
  assert.equal(r.sheet.dataset.kind, 'passChanged');
  assert.match(r.sheetB.innerHTML, /<div class="auth-done" role="alert"><h3>تم تغيير كلمة المرور<\/h3>/);
  assert.match(r.sheetB.innerHTML, /data-close-sheet>موافق<\/button>/);
  assert.deepEqual(r.log.claimed, ['recovery.tok.en']);
  assert.equal(r.log.synced, 1);
  assert.equal(r.log.favs, 1);
  assert.equal(form.dataset.busy, undefined, 'the form is free again');
  assert.equal(r.btn.disabled, false);
  await r.submit(r.form('a-new-password', 'a-new-password'));
  assert.equal(r.log.requests.filter((q) => q.method === 'PUT').length, 1, 'the card is used up: a second submit sends nothing');
});

test('a refused save says why in words and stores nothing', async () => {
  const cases = [
    [{ error_code: 'same_password' }, /مختلفة عن القديمة/],
    [{ error_code: 'weak_password' }, /ضعيفة/],
    [{ error_code: 'something_else', msg: 'raw server text' }, /اطلب رابطًا جديدًا/]
  ];
  for (const [body, expected] of cases) {
    const r = build(HASH, { put: { ok: false, body } });
    await r.open();
    await r.submit(r.form('a-new-password', 'a-new-password'));
    assert.match(r.log.toasts.at(-1), expected);
    assert.doesNotMatch(r.log.toasts.at(-1), /raw server text/, 'the server\'s own wording is not shown');
    assert.equal(r.context.AUTH, null);
    assert.deepEqual(r.log.saved, {});
    assert.equal(r.sheet.dataset.kind, 'newpass', 'the card stays so he can try again');
  }
});

test('the English page gets the English card and messages', async () => {
  const r = build(HASH, { lang: 'en' });
  await r.open();
  assert.match(r.sheetB.innerHTML, /<h3>New password<\/h3>/);
  await r.submit(r.form('a-new-password', 'different-one'));
  assert.equal(r.log.toasts.at(-1), 'The two passwords are not the same.');
  await r.submit(r.form('a-new-password', 'a-new-password'));
  assert.match(r.sheetB.innerHTML, /<h3>Your password is changed<\/h3>/);
});

test('the shop wires the card: its form is submitted through the one delegated handler, and the editor preview never opens it', async () => {
  assert.match(CORE, /\[data-newpass-form\]/);
  assert.match(CORE, /newPassSubmit\(/);
  const r = build(HASH);
  r.context.ELAN_EDITOR_PREVIEW = true;
  assert.equal(await r.open(), false);
  assert.equal(r.log.requests.length, 0);
});

test('the e-mail link returns to the home page of the shop from both forgot forms', () => {
  assert.match(CORE, /recover\?redirect_to='\+encodeURIComponent\(location\.origin\+'\/'\)/);
  const account = fs.readFileSync(path.join(__dirname, '..', 'account.js'), 'utf8');
  assert.match(account, /const redirect = encodeURIComponent\(`\$\{location\.origin\}\/`\);/);
  assert.match(account, /recover\?redirect_to=\$\{redirect\}/);
});
