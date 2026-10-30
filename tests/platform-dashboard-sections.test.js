const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const root = path.join(__dirname, '..');
const portalSource = fs.readFileSync(path.join(root, 'portal.js'), 'utf8');
const source = fs.readFileSync(path.join(root, 'platform-dashboard.js'), 'utf8');
const html = fs.readFileSync(path.join(root, 'platform-dashboard.html'), 'utf8');

const IDS = ['#loginForm', '#login', '#app', '#logout', '#refresh', '#message', '#stats', '#platformError', '#platformStoreError', '#platformStoreStats', '#platformAuditError', '#platformAuditList', '#platformAuditMore'];
function makeNode() {
  return { hidden: false, disabled: false, value: '', textContent: '', innerHTML: '', listeners: {}, addEventListener(type, callback) { this.listeners[type] = callback; } };
}
const json = (status, body) => ({ ok: status < 400, status, json: async () => body });
const flush = () => new Promise(resolve => setImmediate(resolve));

/* The real portal.js (messages, errorText, auth headers) and the real platform-dashboard.js, in a vm with a stub page and a routed fetch. */
function boot(routes, { session = true } = {}) {
  const nodes = new Map(IDS.map(id => [id, makeNode()]));
  nodes.get('#login').hidden = false;
  nodes.get('#app').hidden = true;
  nodes.get('#logout').hidden = true;
  nodes.get('#refresh').hidden = true;
  const storage = new Map(session ? [['elan_auth_session', JSON.stringify({ access_token: 'admin-token' })]] : []);
  const calls = [];
  const document = {
    querySelector: selector => nodes.get(selector) || null,
    getElementById: id => nodes.get(`#${id}`) || null,
    addEventListener() {},
    body: { appendChild() {} }
  };
  const context = vm.createContext({
    document,
    localStorage: { getItem: key => (storage.has(key) ? storage.get(key) : null), setItem: (key, value) => storage.set(key, String(value)), removeItem: key => storage.delete(key) },
    location: { reload() {} },
    fetch: async (url, options = {}) => {
      const target = String(url);
      const key = `${options.method || 'GET'} ${target.split('?')[0]}`;
      calls.push({ key, url: target, headers: options.headers || {} });
      const route = routes[key];
      if (!route) throw new Error(`unexpected request ${key}`);
      return typeof route === 'function' ? route(target) : route;
    },
    URLSearchParams, console, setTimeout, setInterval, clearInterval
  });
  context.window = context;
  context.window.addEventListener = () => {};
  vm.runInContext(portalSource, context, { filename: 'portal.js' });
  vm.runInContext(source, context, { filename: 'platform-dashboard.js' });
  return { context, nodes, calls, storage };
}

const ENTRY = {
  id: 'e1', createdAt: '2026-10-30T10:00:00Z', action: 'store_account_linked', targetType: 'store_account', targetId: 'a1',
  actorEmail: 'owner@example.invalid', storeId: 's1', storeName: 'Store A', subjectEmail: 'staff@example.invalid', detail: { previousRole: 'customer' }
};
function baseRoutes(extra = {}) {
  return {
    'GET /api/platform-order-summary': json(200, { ok: true, counts: { orders: 70, completed: 18, open: 47, cancelled: 3, needsReview: 2 } }),
    'GET /api/platform-customer-summary': json(200, { ok: true, counts: { registered: 12, visitors: 25 } }),
    'GET /api/platform-stores': json(200, { ok: true, stores: [
      { status: 'active', summary: { linked_accounts: 1, available_product_count: 80, active_offer_count: 16 } },
      { status: 'active', summary: { linked_accounts: 0, available_product_count: 5, active_offer_count: 1 } },
      { status: 'inactive', summary: { linked_accounts: 0, available_product_count: 0, active_offer_count: 0 } }
    ] }),
    'GET /api/platform-audit-log': json(200, { ok: true, entries: [ENTRY], limit: 20, offset: 0, hasMore: false }),
    ...extra
  };
}
/* The page loads itself when it opens with a saved session: let every promise of that load finish. */
async function settle() { for (let i = 0; i < 8; i++) await flush(); }
async function start(routes, options) {
  const page = boot(routes, options);
  await settle();
  return page;
}

test('every section loads with the admin token, and the cards count the right things', async () => {
  const page = await start(baseRoutes());
  assert.deepEqual(page.calls.map(call => call.key).sort(), ['GET /api/platform-audit-log', 'GET /api/platform-customer-summary', 'GET /api/platform-order-summary', 'GET /api/platform-stores']);
  assert.ok(page.calls.every(call => call.headers.Authorization === 'Bearer admin-token'));
  const stats = page.nodes.get('#stats').innerHTML;
  for (const text of ['طلبات المتاجر', 'مكتملة', 'مفتوحة', 'مرفوضة أو ملغاة', 'تحتاج مراجعة', 'عملاء مسجلون', 'الزوار']) assert.ok(stats.includes(text), text);
  assert.match(stats, new RegExp(`<small>مرفوضة أو ملغاة</small><b>${(3).toLocaleString('ar-EG')}</b>`));
  assert.match(stats, /stat orange"><small>تحتاج مراجعة/, 'a non-zero review count is highlighted');
  const stores = page.nodes.get('#platformStoreStats').innerHTML;
  assert.match(stores, new RegExp(`المتاجر النشطة</small><b>${(2).toLocaleString('ar-EG')} من ${(3).toLocaleString('ar-EG')}`));
  assert.match(stores, new RegExp(`stat orange"><small>متاجر بلا حساب مربوط</small><b>${(2).toLocaleString('ar-EG')}</b>`), 'two stores have no linked account');
  assert.match(stores, new RegExp(`المنتجات المتاحة</small><b>${(85).toLocaleString('ar-EG')}`));
  assert.match(stores, new RegExp(`العروض النشطة</small><b>${(17).toLocaleString('ar-EG')}`));
  assert.equal(page.nodes.get('#app').hidden, false);
  assert.equal(page.nodes.get('#login').hidden, true);
  assert.equal(page.nodes.get('#logout').hidden, false);
  assert.equal(page.nodes.get('#refresh').hidden, false);
  assert.equal(page.nodes.get('#refresh').disabled, false);
});

test('no store has a missing-account warning once every store has an account', async () => {
  const page = await start(baseRoutes({ 'GET /api/platform-stores': json(200, { ok: true, stores: [{ status: 'active', summary: { linked_accounts: 2 } }] }) }));
  assert.match(page.nodes.get('#platformStoreStats').innerHTML, new RegExp(`stat "><small>متاجر بلا حساب مربوط</small><b>${(0).toLocaleString('ar-EG')}</b>`));
});

test('the audit log reads as sentences, newest first, with every database text escaped', async () => {
  const hostile = { ...ENTRY, id: 'e2', actorEmail: '<img src=x onerror=alert(1)>@example.invalid', storeName: '<script>alert(2)</script>', subjectEmail: '"><b>x</b>' };
  const unlinked = { ...ENTRY, id: 'e3', action: 'store_account_unlinked', detail: { roleBackToCustomer: true } };
  const page = await start(baseRoutes({ 'GET /api/platform-audit-log': json(200, { ok: true, entries: [unlinked, hostile, ENTRY], hasMore: false }) }));
  const list = page.nodes.get('#platformAuditList').innerHTML;
  assert.match(list, /فك ربط الحساب staff@example\.invalid من متجر Store A \(عاد الحساب عميلًا\)/);
  assert.match(list, /ربط الحساب staff@example\.invalid بمتجر Store A \(تحوّل من عميل إلى مدير متجر\)/);
  assert.match(list, /بواسطة owner@example\.invalid/);
  assert.doesNotMatch(list, /<img|<script|<b>x/, 'no database text becomes live markup');
  assert.match(list, /&lt;script&gt;alert\(2\)&lt;\/script&gt;/);
  assert.ok(list.indexOf('فك ربط') < list.indexOf('ربط الحساب staff'), 'the order of the API is kept');
  assert.equal(page.nodes.get('#platformAuditMore').hidden, true);
});

test('missing names and an unknown action are shown plainly', async () => {
  const page = await start(baseRoutes({ 'GET /api/platform-audit-log': json(200, { ok: true, entries: [
    { ...ENTRY, id: 'e4', actorEmail: '', storeName: '', subjectEmail: '' },
    { ...ENTRY, id: 'e5', action: 'something_new' }
  ], hasMore: false }) }));
  const list = page.nodes.get('#platformAuditList').innerHTML;
  assert.match(list, /ربط حساب لم يعد موجودًا بمتجر لم يعد موجودًا/);
  assert.match(list, /بواسطة مفتاح دخول مؤقت/);
  assert.match(list, /عملية غير معروفة \(something_new\)/);
});

test('an empty log says so', async () => {
  const page = await start(baseRoutes({ 'GET /api/platform-audit-log': json(200, { ok: true, entries: [], hasMore: false }) }));
  assert.match(page.nodes.get('#platformAuditList').innerHTML, /لا توجد عمليات مسجّلة بعد/);
});

test('"show more" asks for the next page, appends it, and goes away on the last page', async () => {
  const urls = [];
  const page = await start(baseRoutes({ 'GET /api/platform-audit-log': url => {
    urls.push(url);
    return url.includes('offset=0') ? json(200, { ok: true, entries: [ENTRY, { ...ENTRY, id: 'e6' }], hasMore: true }) : json(200, { ok: true, entries: [{ ...ENTRY, id: 'e7', storeName: 'Store Z' }], hasMore: false });
  } }));
  assert.equal(page.nodes.get('#platformAuditMore').hidden, false);
  await page.nodes.get('#platformAuditMore').listeners.click();
  assert.ok(urls[1].includes('limit=20') && urls[1].includes('offset=2'), urls[1]);
  const list = page.nodes.get('#platformAuditList').innerHTML;
  assert.equal((list.match(/platform-audit-row/g) || []).length, 3, 'three rows in all');
  assert.match(list, /Store Z/);
  assert.equal(page.nodes.get('#platformAuditMore').hidden, true);
  assert.equal(page.nodes.get('#platformAuditMore').disabled, false);
});

test('a failed "show more" keeps the rows and the button and shows an Arabic error', async () => {
  const page = await start(baseRoutes({ 'GET /api/platform-audit-log': url => (url.includes('offset=0') ? json(200, { ok: true, entries: [ENTRY], hasMore: true }) : json(502, { ok: false, error: 'audit_log_unavailable' })) }));
  await page.nodes.get('#platformAuditMore').listeners.click();
  assert.equal(page.nodes.get('#platformAuditError').hidden, false);
  assert.equal(page.nodes.get('#platformAuditError').textContent, 'تعذر تحميل سجل العمليات الآن، حاول بعد قليل.');
  assert.match(page.nodes.get('#platformAuditList').innerHTML, /platform-audit-row/);
  assert.equal(page.nodes.get('#platformAuditMore').hidden, false, 'the admin can try again');
});

test('one failing section never hides the others, and its error is a sentence, not a code', async () => {
  const page = await start(baseRoutes({ 'GET /api/platform-order-summary': json(502, { ok: false, error: 'order_summary_unavailable' }) }));
  const stats = page.nodes.get('#stats').innerHTML;
  assert.ok(!stats.includes('طلبات المتاجر'), 'no order cards without order numbers');
  assert.ok(stats.includes('عملاء مسجلون'), 'the customer cards stay');
  assert.equal(page.nodes.get('#platformError').hidden, false);
  assert.equal(page.nodes.get('#platformError').textContent, 'تعذر تحميل ملخص الطلبات الآن، حاول بعد قليل.');
  assert.ok(page.nodes.get('#platformStoreStats').innerHTML.includes('المنتجات المتاحة'));
  assert.match(page.nodes.get('#platformAuditList').innerHTML, /platform-audit-row/);

  const stores = await start(baseRoutes({ 'GET /api/platform-stores': json(502, { ok: false, error: 'store_data_unavailable' }) }));
  assert.equal(stores.nodes.get('#platformStoreError').hidden, false);
  assert.equal(stores.nodes.get('#platformStoreError').textContent, 'تعذر تحميل بيانات المتاجر الآن، حاول بعد قليل.');
  assert.equal(stores.nodes.get('#platformStoreStats').innerHTML, '');
  assert.ok(stores.nodes.get('#stats').innerHTML.includes('طلبات المتاجر'));

  const audit = await start(baseRoutes({ 'GET /api/platform-audit-log': json(502, { ok: false, error: 'audit_log_unavailable' }) }));
  assert.equal(audit.nodes.get('#platformAuditError').textContent, 'تعذر تحميل سجل العمليات الآن، حاول بعد قليل.');
  assert.equal(audit.nodes.get('#platformAuditList').innerHTML, '');
});

test('both summaries failing shows both reasons in one box', async () => {
  const page = await start(baseRoutes({
    'GET /api/platform-order-summary': json(502, { ok: false, error: 'order_summary_unavailable' }),
    'GET /api/platform-customer-summary': json(502, { ok: false, error: 'customer_summary_unavailable' })
  }));
  const text = page.nodes.get('#platformError').textContent;
  assert.ok(text.includes('ملخص الطلبات') && text.includes('ملخص العملاء'));
  assert.equal(page.nodes.get('#stats').innerHTML, '');
});

test('an expired session returns to the sign-in card, clears the saved session and says why', async () => {
  const gone = json(401, { ok: false, error: 'unauthorized' });
  const page = await start(baseRoutes({ 'GET /api/platform-order-summary': gone, 'GET /api/platform-customer-summary': gone, 'GET /api/platform-stores': gone, 'GET /api/platform-audit-log': gone }));
  assert.equal(page.storage.has('elan_auth_session'), false, 'the dead session is removed');
  assert.equal(page.nodes.get('#app').hidden, true);
  assert.equal(page.nodes.get('#login').hidden, false);
  assert.equal(page.nodes.get('#logout').hidden, true);
  assert.equal(page.nodes.get('#message').textContent, 'انتهت جلسة الدخول، سجّل الدخول من جديد.');
});

test('a signed-in account that is not a platform admin is told so, as on the customers dashboard, and can sign in with another account', async () => {
  const refused = json(403, { ok: false, error: 'forbidden' });
  const page = await start(baseRoutes({ 'GET /api/platform-order-summary': refused, 'GET /api/platform-customer-summary': refused, 'GET /api/platform-stores': refused, 'GET /api/platform-audit-log': refused }));
  assert.equal(page.storage.has('elan_auth_session'), true, 'a wrong-role session is kept; signing in again replaces it');
  assert.equal(page.nodes.get('#app').hidden, true);
  assert.equal(page.nodes.get('#login').hidden, false);
  assert.equal(page.nodes.get('#logout').hidden, true);
  assert.equal(page.nodes.get('#refresh').hidden, true);
  assert.equal(page.nodes.get('#message').textContent, 'هذا الحساب غير مصرح له بفتح هذه الصفحة.');
});

test('a lost connection is an Arabic sentence', async () => {
  const down = () => { throw new TypeError('Failed to fetch'); };
  const page = await start(baseRoutes({ 'GET /api/platform-order-summary': down, 'GET /api/platform-customer-summary': down, 'GET /api/platform-stores': down, 'GET /api/platform-audit-log': down }));
  assert.equal(page.nodes.get('#platformStoreError').textContent, 'تعذر الاتصال بالخدمة، تحقق من الإنترنت وحاول مرة أخرى.');
  assert.equal(page.nodes.get('#platformAuditError').textContent, 'تعذر الاتصال بالخدمة، تحقق من الإنترنت وحاول مرة أخرى.');
});

test('the refresh button reloads every section', async () => {
  const page = await start(baseRoutes());
  const before = page.calls.length;
  await page.nodes.get('#refresh').listeners.click();
  await settle();
  assert.equal(page.calls.length, before + 4);
});

test('opening the page with a saved session loads it by itself; without one it only shows the sign-in card', async () => {
  const withSession = boot(baseRoutes());
  await settle();
  assert.equal(withSession.calls.length, 4, 'loaded without a click');
  const without = boot(baseRoutes(), { session: false });
  await settle();
  assert.equal(without.calls.length, 0);
  assert.equal(without.nodes.get('#login').hidden, false);
});

test('the page has the sections, the buttons and no inline script or handler', () => {
  for (const id of ['refresh', 'platformAuditList', 'platformAuditMore', 'platformAuditError', 'platformStoreStats', 'stats', 'logout']) assert.match(html, new RegExp(`id="${id}"`), id);
  assert.doesNotMatch(html, /<script(?![^>]*\bsrc=)/i, 'no inline script');
  assert.doesNotMatch(html, /\son[a-z]+=/i, 'no inline handler');
  for (const name of ['auditRowMarkup', 'statMarkup']) {
    const body = source.slice(source.indexOf(`function ${name}`)).split('\n}\n')[0];
    /* Only the lines that build HTML: plain-text sentences are escaped when they are put into that HTML. */
    const markup = body.split('\n').filter(line => line.includes('<')).join('\n');
    const interpolations = [...markup.matchAll(/\$\{(.*?)\}(?=[^}]|$)/g)].map(match => match[1]);
    assert.ok(interpolations.length > 0, name);
    for (const expression of interpolations) assert.match(expression, /^escP\(/, `${name}: ${expression} must be escaped`);
  }
});
