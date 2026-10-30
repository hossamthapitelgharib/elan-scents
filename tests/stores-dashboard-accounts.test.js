const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

// The admin stores panel (stores-dashboard.js) runs here with a minimal fake page. All data below is fake.
const root = path.join(__dirname, '..');
const read = name => fs.readFileSync(path.join(root, name), 'utf8');
const json = (status, body) => ({ ok: status >= 200 && status < 300, status, headers: { get: () => '' }, json: async () => body });
const tick = async () => { for (let i = 0; i < 8; i++) await new Promise(resolve => setImmediate(resolve)); };

const STORE = { id: 'f6ab1d8d-1087-4112-8976-1210d1ec8c55', name: 'Store A', slug: 'store-a', status: 'active', commission_rate: 8, summary: { linked_accounts: 1 } };
const ACCOUNT = { accountId: '0b7d8b0e-5b5e-4c3e-9d54-0c2a8f4f2b11', storeId: STORE.id, storeName: 'Store A', email: 'staff@example.invalid', fullName: 'Staff <img src=x onerror=alert(1)>', accountRole: 'store_admin', profileRole: 'store_admin', createdAt: '2026-10-28T10:00:00Z' };

function makeNode() {
  return {
    hidden: false, value: '', textContent: '', innerHTML: '', className: '', disabled: false, dataset: {}, attributes: {}, listeners: {}, children: {},
    classList: { toggle() {}, add() {}, remove() {} },
    elements: { search: { value: '', addEventListener() {} }, status: { value: '', addEventListener() {} } },
    addEventListener(type, callback) { this.listeners[type] = callback; },
    setAttribute(name, value) { this.attributes[name] = value; },
    insertAdjacentHTML() {}, scrollIntoView() {}, reset() {},
    querySelector(selector) { return this.children[selector] || (this.children[selector] = makeNode()); },
    querySelectorAll() { return []; }
  };
}

function boot(routes) {
  const nodes = new Map();
  const get = selector => { if (!nodes.has(selector)) nodes.set(selector, makeNode()); return nodes.get(selector); };
  const docListeners = {};
  const calls = [];
  const store = { elan_auth_session: JSON.stringify({ access_token: 'fake-token' }) };
  const document = {
    hidden: false,
    querySelector: get,
    getElementById: id => get(`#${id}`),
    querySelectorAll: () => [],
    addEventListener(type, callback) { (docListeners[type] = docListeners[type] || []).push(callback); }
  };
  const context = vm.createContext({
    document, console, URLSearchParams, URL, encodeURIComponent, JSON,
    setTimeout: () => 0, setInterval: () => 0, clearInterval() {},
    location: { reload() {} },
    localStorage: { getItem: key => (key in store ? store[key] : null), setItem: (key, value) => { store[key] = String(value); }, removeItem: key => { delete store[key]; } },
    fetch: async (url, options = {}) => {
      const call = { url: String(url), method: options.method || 'GET', headers: options.headers || {}, body: options.body ? JSON.parse(options.body) : null };
      calls.push(call);
      const path = call.url.split('?')[0];
      const route = routes[`${call.method} ${path}`] || routes[path];
      if (!route) throw new Error(`unexpected fetch ${call.method} ${call.url}`);
      return typeof route === 'function' ? route(call) : route;
    }
  });
  context.window = context;
  context.addEventListener = () => {};
  context.confirm = () => true;
  const toasts = [];
  for (const file of ['portal.js', 'stores-dashboard.js']) {
    vm.runInContext(read(file), context, { filename: file });
    if (file === 'portal.js') vm.runInContext('Portal.toast = (text, kind) => globalThis.__toasts.push([text, kind]);', Object.assign(context, { __toasts: toasts }));
  }
  const dispatch = (type, event) => (docListeners[type] || []).forEach(callback => callback(event));
  const click = match => dispatch('click', { target: { closest: selector => (match[selector] !== undefined ? match[selector] : null) } });
  const submit = form => { let prevented = false; dispatch('submit', { preventDefault() { prevented = true; }, target: { closest: selector => (selector === '#storeAccountForm' ? form : null) } }); return () => prevented; };
  return { context, calls, get, click, submit, toasts };
}

function baseRoutes(extra = {}) {
  return {
    '/api/platform-stores': json(200, { ok: true, stores: [STORE], count: 1 }),
    '/api/platform-store-unlinked': json(200, { ok: true, records: [], hasMore: false }),
    '/api/platform-store-detail': json(200, { ok: true, section: 'overview', store: STORE, summary: {}, accounts: [{ id: 'link-1', user_id: 'internal-user-id', role: 'store_admin' }] }),
    'GET /api/platform-store-accounts': json(200, { ok: true, accounts: [ACCOUNT] }),
    ...extra
  };
}
function linkForm(email) {
  const button = { disabled: false };
  let reset = 0;
  return { elements: { email: { value: email } }, querySelector: () => button, reset() { reset++; }, button, get resets() { return reset; } };
}
async function openStore(page) {
  await tick();
  page.click({ '[data-store-detail]': { dataset: { storeDetail: STORE.id } } });
  await tick();
}

test('opening a store lists its linked accounts with email and name, escaped, and no raw internal ids', async () => {
  const page = boot(baseRoutes());
  await openStore(page);
  const request = page.calls.find(call => call.url.startsWith('/api/platform-store-accounts'));
  assert.ok(request, 'the accounts are read from the admin API');
  assert.match(request.url, new RegExp(`storeId=${STORE.id}`));
  assert.equal(request.headers.Authorization, 'Bearer fake-token');
  const html = page.get('#storeAccountsBody').innerHTML;
  assert.match(html, /staff@example\.invalid/);
  assert.match(html, /Staff &lt;img src=x onerror=alert\(1\)&gt;/, 'the name is escaped');
  assert.doesNotMatch(html, /<img/i);
  assert.match(html, new RegExp(`data-unlink-account="${ACCOUNT.accountId}"`));
  assert.match(page.get('#storeDetailContent').innerHTML, /id="storeAccountForm"/);
  assert.doesNotMatch(page.get('#storeDetailContent').innerHTML, /internal-user-id/, 'the id-only table is gone');
});

test('a store with no account says so', async () => {
  const page = boot(baseRoutes({ 'GET /api/platform-store-accounts': json(200, { ok: true, accounts: [] }) }));
  await openStore(page);
  assert.match(page.get('#storeAccountsBody').innerHTML, /لا يوجد حساب مرتبط/);
});

test('linking sends the store and the trimmed email, clears the form, tells the admin and refreshes the lists', async () => {
  const page = boot(baseRoutes({ 'POST /api/platform-store-accounts': json(201, { ok: true, accountId: ACCOUNT.accountId, storeId: STORE.id, alreadyLinked: false }) }));
  await openStore(page);
  const form = linkForm('  staff@example.invalid ');
  const prevented = page.submit(form);
  await tick();
  assert.ok(prevented(), 'the form does not reload the page');
  const post = page.calls.find(call => call.method === 'POST');
  assert.deepEqual(post.body, { storeId: STORE.id, email: 'staff@example.invalid' });
  assert.equal(post.headers['Content-Type'], 'application/json');
  assert.equal(post.headers.Authorization, 'Bearer fake-token');
  assert.equal(form.resets, 1);
  assert.equal(form.button.disabled, false, 'the button is usable again');
  assert.deepEqual([...page.toasts.at(-1)], ['تم ربط الحساب بالمتجر.', 'info']);
  assert.ok(page.calls.filter(call => call.url.startsWith('/api/platform-store-accounts') && call.method === 'GET').length >= 2, 'the account list is read again');
  assert.ok(page.calls.filter(call => call.url === '/api/platform-stores').length >= 2, 'the store counts are refreshed');
  assert.equal(page.get('#storeAccountsError').hidden, true);
});

test('linking an account that is already linked says so', async () => {
  const page = boot(baseRoutes({ 'POST /api/platform-store-accounts': json(200, { ok: true, accountId: ACCOUNT.accountId, storeId: STORE.id, alreadyLinked: true }) }));
  await openStore(page);
  page.submit(linkForm('staff@example.invalid'));
  await tick();
  assert.deepEqual([...page.toasts.at(-1)], ['هذا الحساب مربوط بالمتجر من قبل.', 'info']);
});

test('every refusal is shown in Arabic next to the form and the form keeps what was typed', async () => {
  const cases = [
    [404, 'user_not_found', /لا يوجد حساب مسجّل/],
    [409, 'email_not_confirmed', /لم يؤكد بريده/],
    [409, 'platform_admin_not_linkable', /مدير منصة/],
    [409, 'customer_has_order_history', /لديه طلبات سابقة/],
    [404, 'store_not_found', /المتجر لم يعد موجودًا/],
    [400, 'invalid_email', /بريدًا إلكترونيًا صحيحًا/],
    [502, 'store_account_link_failed', /تعذر ربط الحساب/],
    [403, 'forbidden', /غير مصرح/],
    [401, 'unauthorized', /انتهت جلسة الدخول/]
  ];
  for (const [status, error, pattern] of cases) {
    const page = boot(baseRoutes({ 'POST /api/platform-store-accounts': json(status, { ok: false, error }) }));
    await openStore(page);
    const form = linkForm('staff@example.invalid');
    page.submit(form);
    await tick();
    const box = page.get('#storeAccountsError');
    assert.equal(box.hidden, false, error);
    assert.match(box.textContent, pattern, error);
    assert.doesNotMatch(box.textContent, /[a-z]+_[a-z_]+/, `${error}: no raw code on screen`);
    assert.equal(form.resets, 0, 'the typed email stays');
    assert.equal(form.button.disabled, false);
  }
});

test('a code the page has no sentence for is kept in brackets for support, and a network failure is Arabic', async () => {
  let page = boot(baseRoutes({ 'POST /api/platform-store-accounts': json(500, { ok: false, error: 'brand_new_code' }) }));
  await openStore(page);
  page.submit(linkForm('staff@example.invalid'));
  await tick();
  assert.match(page.get('#storeAccountsError').textContent, /\(brand_new_code\)/);
  page = boot(baseRoutes({ 'POST /api/platform-store-accounts': () => { throw new TypeError('Failed to fetch'); } }));
  await openStore(page);
  page.submit(linkForm('staff@example.invalid'));
  await tick();
  assert.match(page.get('#storeAccountsError').textContent, /تعذر الاتصال/);
});

test('an empty email sends nothing', async () => {
  const page = boot(baseRoutes());
  await openStore(page);
  const before = page.calls.length;
  page.submit(linkForm('   '));
  await tick();
  assert.equal(page.calls.length, before);
});

test('unlinking asks first, sends the account id only after a yes, and refreshes', async () => {
  const page = boot(baseRoutes({ 'DELETE /api/platform-store-accounts': json(200, { ok: true, accountId: ACCOUNT.accountId, roleBackToCustomer: true }) }));
  await openStore(page);
  const button = { dataset: { unlinkAccount: ACCOUNT.accountId, unlinkEmail: 'staff@example.invalid' }, disabled: false };
  let question = '';
  page.context.confirm = text => { question = text; return false; };
  page.click({ '[data-unlink-account]': button });
  await tick();
  assert.match(question, /staff@example\.invalid/, 'the question names the account');
  assert.equal(page.calls.some(call => call.method === 'DELETE'), false, 'a no changes nothing');
  assert.equal(button.disabled, false);
  page.context.confirm = () => true;
  page.click({ '[data-unlink-account]': button });
  await tick();
  const del = page.calls.find(call => call.method === 'DELETE');
  assert.deepEqual(del.body, { accountId: ACCOUNT.accountId });
  assert.equal(del.headers.Authorization, 'Bearer fake-token');
  assert.deepEqual([...page.toasts.at(-1)], ['تم فك ربط الحساب.', 'info']);
  assert.ok(page.calls.filter(call => call.url === '/api/platform-stores').length >= 2, 'the store counts are refreshed');
});

test('a failed unlink shows an Arabic message and gives the button back', async () => {
  const page = boot(baseRoutes({ 'DELETE /api/platform-store-accounts': json(404, { ok: false, error: 'account_not_found' }) }));
  await openStore(page);
  const button = { dataset: { unlinkAccount: ACCOUNT.accountId, unlinkEmail: '' }, disabled: false };
  page.click({ '[data-unlink-account]': button });
  await tick();
  assert.match(page.get('#storeAccountsError').textContent, /هذا الربط لم يعد موجودًا/);
  assert.equal(button.disabled, false);
});

test('a failing account list shows an Arabic message instead of an empty table', async () => {
  const page = boot(baseRoutes({ 'GET /api/platform-store-accounts': json(502, { ok: false, error: 'store_accounts_unavailable' }) }));
  await openStore(page);
  assert.match(page.get('#storeAccountsError').textContent, /تعذر تحميل حسابات المتجر/);
  assert.equal(page.get('#storeAccountsBody').innerHTML, '');
});

test('the page code has no inline handlers and the unlink button is wired by delegation', () => {
  const js = read('stores-dashboard.js');
  assert.doesNotMatch(js, /\bonclick=|\bonsubmit=/i);
  assert.match(js, /data-unlink-account/);
});

test('a failed stores list, store detail or unlinked records list shows a sentence, never an API code', async () => {
  let page = boot(baseRoutes({ '/api/platform-stores': json(502, { ok: false, error: 'store_data_unavailable' }) }));
  await tick();
  assert.equal(page.get('#storeError').textContent, 'تعذر تحميل بيانات المتاجر الآن، حاول بعد قليل.');
  assert.equal(page.get('#storeError').hidden, false);

  page = boot(baseRoutes({ '/api/platform-store-detail': json(404, { ok: false, error: 'store_not_found' }) }));
  await openStore(page);
  assert.equal(page.get('#storeDetailError').textContent, 'هذا المتجر لم يعد موجودًا، حدّث القائمة.');

  page = boot(baseRoutes({ '/api/platform-store-unlinked': json(502, { ok: false, error: 'unlinked_store_data_unavailable' }) }));
  await tick();
  assert.equal(page.get('#unlinkedStoreError').textContent, 'تعذر تحميل سجلات التشغيل غير المرتبطة الآن، حاول بعد قليل.');
  for (const selector of ['#storeError', '#storeDetailError', '#unlinkedStoreError', '#message']) assert.doesNotMatch(page.get(selector).textContent, /[a-z]+_[a-z_]+/, `${selector}: no raw code`);
});
