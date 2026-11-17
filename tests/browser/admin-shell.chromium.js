'use strict';
/* The admin panel (platform-dashboard.html) in a real Chromium: sign-in gate, moving between pages without reloading, the first-notice list and its
   detail, the messages page, the alert strip with its sound, and the phone layout. Every /api call is answered here with made-up data and nothing
   reaches the live site, Supabase or any store. */
const test = require('node:test');
const assert = require('node:assert/strict');
const H = require('./harness.js');

const pw = H.loadPlaywright();
const SUPABASE = 'https://' + 'sbgdtuqfrnfeggkwqtrw.supabase.co';
const PAGES = ['overview', 'first-notices', 'messages', 'customers', 'stores', 'settlements', 'rankings', 'audit'];
const id = n => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const ago = mins => new Date(Date.now() - mins * 60000).toISOString();
const token = 'h.' + Buffer.from(JSON.stringify({ exp: Math.floor(Date.now() / 1000) + 86400, sub: id(1) })).toString('base64url') + '.s';
const session = JSON.stringify({ access_token: token, refresh_token: 'r', user: { id: 'u' } });
const json = (route, body, status = 200) => route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(body) });
const EVIL = 'متجر <img src=x onerror="window.__xss=1"> الاختبار';

let browser, server;
test.before(async () => { server = await H.startServer(); browser = await pw.chromium.launch({ args: ['--no-sandbox'] }); });
test.after(async () => { if (browser) await browser.close(); if (server) await server.stop(); });

function freshAlerts() {
  return [
    { id: id(1), type: 'order_payment_recorded', title: 'تم تسجيل دفع طلب جديد', body: 'سُجّل دفع الطلب ELN-TEST-0001', isRead: false, createdAt: ago(3), trackingNumber: 'ELN-TEST-0001', requestId: id(90), storeId: id(91) },
    { id: id(2), type: 'customer_cancel_requested', title: 'طلب إلغاء من عميل', body: 'العميل يطلب إلغاء الطلب ELN-TEST-0002', isRead: false, createdAt: ago(25), trackingNumber: 'ELN-TEST-0002', requestId: id(92), storeId: id(91) },
    { id: id(3), type: 'customer_registered', title: 'عميل جديد سجّل حسابه', body: 'تم تأكيد بريد حساب جديد', isRead: true, createdAt: ago(300), trackingNumber: '', requestId: null, storeId: null }
  ];
}
const notice = n => ({
  id: id(100 + n), requestId: id(90 + n), storeId: id(91), storeName: n === 3 ? EVIL : 'عطور النخبة', trackingNumber: `ELN-TEST-000${n}`, createdAt: ago(n * 40),
  itemCount: 2, unitCount: 3, total: 4350 + n * 100, currency: 'EGP', paymentMethod: n === 2 ? 'cod' : 'card', paymentStatus: n === 2 ? 'cod_selected' : 'paid',
  customerName: 'عميل تجريبي', second: ['waiting', 'matched', 'mismatch'][n % 3]
});
const noticeDetail = n => Object.assign(notice(n), {
  checkoutTrackingNumber: 'CHK-TEST-9988', version: 1, payloadHash: 'a'.repeat(64),
  delivery: { name: 'عميل تجريبي', phone: '01000000000', email: 'test@example.invalid', address: 'القاهرة، مدينة نصر، شارع الاختبار، مبنى 12', notes: 'الاتصال قبل الوصول' },
  items: [{ platformOrderNumber: `ELN-TEST-000${n}-1`, productName: 'عود ملكي', brandName: 'ماركة تجريبية', sizeLabel: '100 مل', quantity: 2, unitPrice: 1450, lineTotal: 2900 }],
  subtotal: 4250, shipping: 100, payment: { method: 'card', provider: 'مزوّد تجريبي', status: 'paid', reference: 'PAY-TEST-123', paidAt: ago(n * 40) },
  secondNotice: { state: 'waiting', merchantOrderNumber: '', merchantInvoiceNumber: '', mismatches: [] }, order: { status: 'store_confirmed', paymentStatus: 'paid', saleProvenAt: '' }
});

/* An admin panel with a fake server behind it. `world` is what the server holds right now; a test changes it to make news arrive. */
async function openPanel(size, options = {}) {
  const { context, problems } = await H.openContext(browser, server, size);
  const world = { status: options.status || 200, alerts: freshAlerts(), patches: [], calls: [], loginBody: null };
  if (options.signedIn !== false) await context.addInitScript(value => { try { if (!localStorage.getItem('elan_auth_session') && !sessionStorage.getItem('test_signed_out')) localStorage.setItem('elan_auth_session', value); } catch (_) {} }, session);
  // Chromium's audio needs no device here; the spy counts the notes the chime plays instead of listening to them.
  await context.addInitScript(() => {
    window.__notes = 0;
    const Base = window.AudioContext;
    if (!Base) return;
    window.AudioContext = class extends Base {
      createOscillator() { window.__notes += 1; return super.createOscillator(); }
    };
  });
  await context.route('**/api/**', async route => {
    const url = new URL(route.request().url()), pathName = url.pathname, query = url.searchParams, method = route.request().method();
    world.calls.push(`${method} ${pathName}`);
    if (pathName === '/api/config') return json(route, { url: SUPABASE, key: 'anon', supabase_url: SUPABASE, supabase_anon_key: 'anon' });
    if (world.status !== 200 && pathName === '/api/platform-alerts') return json(route, { error: world.status === 401 ? 'unauthorized' : 'forbidden' }, world.status);
    if (pathName === '/api/platform-alerts') {
      if (method === 'PATCH') {
        const body = JSON.parse(route.request().postData() || '{}');
        world.patches.push(body);
        world.alerts.forEach(item => { if (body.all || item.id === body.id || (body.ids || []).includes(item.id)) item.isRead = true; });
        return json(route, { ok: true });
      }
      const rows = query.get('unread') ? world.alerts.filter(item => !item.isRead) : world.alerts;
      return json(route, { ok: true, unread: world.alerts.filter(item => !item.isRead).length, firstNotices: 5, total: rows.length, hasMore: false, serverTime: new Date().toISOString(), notifications: rows });
    }
    if (pathName === '/api/platform-first-notices') return query.get('id') ? json(route, { ok: true, notice: noticeDetail(Number(query.get('id').slice(-1)) || 1) }) : json(route, { ok: true, notices: [1, 2, 3, 4, 5].map(notice), total: 5, hasMore: false });
    if (pathName === '/api/platform-order-summary') return json(route, { counts: { orders: 39, completed: 21, open: 5, cancelled: 4, needsReview: 2 } });
    if (pathName === '/api/platform-customer-summary') return json(route, { counts: { registered: 214, visitors: 1380 } });
    if (pathName === '/api/platform-stores') return json(route, { stores: [{ id: id(91), name: 'عطور النخبة', slug: 'nokhba', status: 'active', summary: { linked_accounts: 2, available_product_count: 140, product_count: 160, active_offer_count: 6, order_count: 31, open_order_count: 4, commission_due: 5200 } }] });
    if (pathName === '/api/platform-audit-log') return json(route, { entries: [{ action: 'store_account_linked', subjectEmail: 'admin@example.invalid', storeName: 'عطور النخبة', actorEmail: 'owner@example.invalid', createdAt: ago(400), detail: {} }], hasMore: false });
    if (pathName === '/api/platform-commission-settlement') return json(route, { settlements: [{ id: id(201), commissionId: id(301), storeName: 'عطور النخبة', status: 'payable', amount: 2600, currency: 'EGP', updatedAt: ago(120), createdAt: ago(300) }], hasMore: false });
    if (pathName === '/api/platform-product-rankings') return json(route, { rankings: { sales: [{ rank: 1, name: 'عود ملكي', brand: 'ماركة تجريبية', value: 128, source: 'combined' }], views: [], searches: [], rating: [] }, hasMore: { sales: false } });
    if (pathName === '/api/platform-customers') return json(route, { counts: { registered: 214, visitors: 1380 }, registeredCustomers: [{ id: id(401), full_name: 'منى أحمد (تجريبي)', phone: '01000000001', created_at: ago(5000), cart_items: 2, cart_quantity: 3 }], guestVisitors: [{ id: id(501), visitor_label: 'G-48213', first_seen_at: ago(3000), last_seen_at: ago(30), cart_items: 1, cart_quantity: 1 }], pagination: { registered: { offset: 0, limit: 50, total: 214 }, visitors: { offset: 0, limit: 50, total: 1380 } } });
    if (pathName === '/api/platform-store-unlinked') return json(route, { notices: [], events: [] });
    return json(route, { ok: true });
  });
  await context.route(SUPABASE + '/auth/v1/token*', async route => {
    const cors = { 'access-control-allow-origin': '*', 'access-control-allow-headers': '*', 'access-control-allow-methods': '*' };
    if (route.request().method() === 'OPTIONS') return route.fulfill({ status: 204, headers: cors });
    world.loginBody = JSON.parse(route.request().postData() || '{}');
    await route.fulfill({ status: 200, headers: cors, contentType: 'application/json', body: JSON.stringify({ access_token: token, refresh_token: 'r', user: { id: 'u' } }) });
  });
  const errors = [];
  const page = await context.newPage();
  H.watchErrors(page, errors);
  return { context, page, world, errors, problems };
}
const open = (panel, hash = '') => panel.page.goto(H.SITE + '/platform-dashboard.html' + hash, { waitUntil: 'load' });
const notes = page => page.evaluate(() => window.__notes);
/* The drawer slides in from the side, so "closed" means it sits outside the screen, not that it is display:none. */
const drawerOnScreen = page => page.evaluate(() => { const box = document.querySelector('#adminNav').getBoundingClientRect(); return box.right > 0 && box.left < window.innerWidth; });
const overflow = page => page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);

test('no session shows the sign-in card; signing in with the real form opens the panel on its overview', async () => {
  const panel = await openPanel(H.WIDTHS[2], { signedIn: false });
  try {
    await open(panel);
    await panel.page.waitForSelector('#login:not([hidden])');
    assert.equal(await panel.page.locator('#app').isHidden(), true);
    assert.equal(panel.world.calls.filter(call => call.includes('platform-')).length, 0, 'nothing is asked of the server before sign-in');
    // The "are you a person" box (Cloudflare) cannot be solved here: it is replaced by an answer that gives an empty token.
    await panel.page.evaluate(() => { window.ElanTurnstile.token = async () => ''; });
    await panel.page.fill('#loginForm [name="email"]', 'admin@example.invalid');
    await panel.page.fill('#loginForm [name="password"]', 'not-a-real-password');
    await panel.page.click('#loginForm button[type="submit"]');
    await panel.page.waitForSelector('#app:not([hidden])');
    assert.equal(await panel.page.locator('#login').isHidden(), true);
    assert.equal(panel.world.loginBody.email, 'admin@example.invalid');
    assert.match(await panel.page.textContent('#pageTitle'), /الرئيسية/);
    assert.deepEqual(panel.errors, []);
  } finally { await panel.context.close(); }
});

test('an account that is not a platform admin, and a session that has ended, are sent back to sign-in with the reason', async () => {
  const wrong = await openPanel(H.WIDTHS[2], { status: 403 });
  try {
    await open(wrong);
    await wrong.page.waitForSelector('#login:not([hidden])');
    assert.equal(await wrong.page.locator('#app').isHidden(), true);
    assert.match(await wrong.page.textContent('#message'), /غير مصرح/);
  } finally { await wrong.context.close(); }
  const ended = await openPanel(H.WIDTHS[2], { status: 401 });
  try {
    await open(ended);
    await ended.page.waitForSelector('#login:not([hidden])');
    assert.equal(await ended.page.evaluate(() => localStorage.getItem('elan_auth_session')), null, 'the dead session is removed');
  } finally { await ended.context.close(); }
});

test('moving through all eight pages never reloads the document, and each shows its own heading and menu mark', async () => {
  const panel = await openPanel(H.WIDTHS[2]);
  try {
    await open(panel);
    await panel.page.waitForSelector('#app:not([hidden])');
    await panel.page.evaluate(() => { window.__kept = 'same document'; });
    for (const key of PAGES) {
      await panel.page.click(`#adminNav a[data-page="${key}"]`);
      await panel.page.waitForFunction(k => !document.querySelector(`#page-${k}`).hidden, key);
      assert.equal(await panel.page.evaluate(() => location.hash), `#${key}`);
      assert.equal(await panel.page.locator('.page:not([hidden])').count(), 1, `only ${key} is open`);
      assert.equal(await panel.page.getAttribute(`#adminNav a[data-page="${key}"]`, 'aria-current'), 'page');
      assert.ok((await panel.page.textContent('#pageTitle')).trim().length > 2);
    }
    assert.equal(await panel.page.evaluate(() => window.__kept), 'same document', 'no reload happened');
    await panel.page.goBack();
    assert.equal(await panel.page.evaluate(() => window.__kept), 'same document', 'the back button moves between pages inside the document');
    await open(panel, '#nonsense');
    await panel.page.waitForSelector('#app:not([hidden])');
    assert.equal(await panel.page.locator('#page-overview').isVisible(), true, 'an unknown address opens the overview');
    assert.deepEqual(panel.errors, []);
  } finally { await panel.context.close(); }
});

test('the old customers and stores addresses land on their new pages', async () => {
  const panel = await openPanel(H.WIDTHS[2]);
  try {
    await panel.page.goto(H.SITE + '/customers-dashboard.html', { waitUntil: 'load' });
    await panel.page.waitForURL(/platform-dashboard\.html#customers/);
    await panel.page.waitForSelector('#page-customers:not([hidden])');
    await panel.page.goto(H.SITE + '/stores-dashboard.html', { waitUntil: 'load' });
    await panel.page.waitForURL(/platform-dashboard\.html#stores/);
    await panel.page.waitForSelector('#page-stores:not([hidden])');
  } finally { await panel.context.close(); }
});

test('the first-notice page lists the notices, opens one in full, and shows store text as text', async () => {
  const panel = await openPanel(H.WIDTHS[2]);
  try {
    await open(panel, '#first-notices');
    await panel.page.waitForSelector('.notice-row');
    assert.equal(await panel.page.locator('.notice-row').count(), 5);
    await panel.page.click('.notice-row >> nth=0');
    await panel.page.waitForSelector('#noticeDetail .slip-head, #noticeDetail header');
    const detail = await panel.page.textContent('#noticeDetail');
    assert.match(detail, /ELN-TEST-0001/);
    assert.match(detail, /عود ملكي/);
    assert.match(detail, /PAY-TEST-123/);
    // the notice whose store name is an attack: it stays text, in the list and in the detail
    await panel.page.click('.notice-row[data-notice-id$="103"]');
    await panel.page.waitForFunction(() => /ELN-TEST-0003/.test(document.querySelector('#noticeDetail').textContent));
    assert.equal(await panel.page.locator('#noticeList img, #noticeDetail img').count(), 0, 'no tag from store text became an element');
    assert.match(await panel.page.textContent('#noticeDetail'), /<img src=x/);
    assert.equal(await panel.page.evaluate(() => window.__xss === undefined), true);
    assert.deepEqual(panel.errors, []);
  } finally { await panel.context.close(); }
});

test('the messages page lists everything, filters to unread, and «تمت القراءة» changes the counts everywhere', async () => {
  const panel = await openPanel(H.WIDTHS[2]);
  try {
    await open(panel, '#messages');
    await panel.page.waitForSelector('.message');
    assert.equal(await panel.page.locator('.message').count(), 3);
    assert.equal(await panel.page.locator('.message.is-unread').count(), 2);
    assert.equal((await panel.page.textContent('#bellCount')).trim(), '٢');
    await panel.page.click('#messagesTabUnread');
    await panel.page.waitForFunction(() => document.querySelectorAll('.message').length === 2);
    await panel.page.click('[data-message-read]:first-of-type >> nth=0');
    await panel.page.waitForFunction(() => document.querySelectorAll('.message').length === 1);
    assert.deepEqual(panel.world.patches, [{ id: id(1) }]);
    assert.equal((await panel.page.textContent('#bellCount')).trim(), '١');
    await panel.page.click('#messagesReadAll');
    await panel.page.waitForFunction(() => document.querySelectorAll('.message').length === 0);
    assert.deepEqual(panel.world.patches[1], { all: true });
    assert.equal(await panel.page.locator('#bellCount').isHidden(), true, 'nothing unread: no number on the bell');
    assert.equal(await panel.page.locator('#messagesEmpty').isVisible(), true);
    assert.deepEqual(panel.errors, []);
  } finally { await panel.context.close(); }
});

test('a new message appears at the top at once with a chime, the opening poll stays silent, and a request for a decision sounds three notes', async () => {
  const panel = await openPanel(H.WIDTHS[2]);
  try {
    await open(panel);
    await panel.page.waitForSelector('#app:not([hidden])');
    assert.equal(await panel.page.locator('#alertStrip').isHidden(), true, 'what was already waiting is not announced as news');
    assert.equal(await notes(panel.page), 0);
    // turning the sound on is a click, which is what lets the browser start audio; it plays the test chime (two notes)
    await panel.page.click('#soundToggle');
    await panel.page.waitForFunction(() => document.querySelector('#soundToggle').dataset.state === 'on');
    assert.equal(await notes(panel.page), 2);
    assert.equal(await panel.page.evaluate(() => localStorage.getItem('elan_admin_sound')), '1');

    panel.world.alerts.unshift({ id: id(50), type: 'order_payment_recorded', title: 'دفع جديد وصل', body: 'الطلب ELN-TEST-0050', isRead: false, createdAt: ago(0), trackingNumber: 'ELN-TEST-0050', requestId: id(150), storeId: id(91) });
    await panel.page.evaluate(() => AdminAlerts.pollOnce());
    await panel.page.waitForSelector('#alertStrip:not([hidden]) .alert-item');
    assert.match(await panel.page.textContent('#alertStripList'), /دفع جديد وصل/);
    assert.equal(await notes(panel.page), 4, 'two more notes for news');
    assert.match(await panel.page.title(), /^\(٣\) /, 'the tab title carries the unread count');

    panel.world.alerts.unshift({ id: id(51), type: 'customer_cancel_requested', title: 'عميل يطلب الإلغاء', body: 'الطلب ELN-TEST-0051', isRead: false, createdAt: ago(0), trackingNumber: 'ELN-TEST-0051', requestId: id(151), storeId: id(91) });
    await panel.page.evaluate(() => AdminAlerts.pollOnce());
    await panel.page.waitForFunction(() => document.querySelectorAll('#alertStripList .alert-item').length === 2);
    assert.equal(await notes(panel.page), 7, 'three notes for something that needs a decision');

    // the same message is not announced twice
    await panel.page.evaluate(() => AdminAlerts.pollOnce());
    assert.equal(await notes(panel.page), 7);
    // turning the sound off keeps the strip but stays quiet
    await panel.page.click('#soundToggle');
    await panel.page.waitForFunction(() => document.querySelector('#soundToggle').dataset.state === 'off');
    panel.world.alerts.unshift({ id: id(52), type: 'order_initial', title: 'طلب بلا صوت', body: '', isRead: false, createdAt: ago(0), trackingNumber: 'ELN-TEST-0052', requestId: id(152), storeId: id(91) });
    await panel.page.evaluate(() => AdminAlerts.pollOnce());
    await panel.page.waitForFunction(() => document.querySelectorAll('#alertStripList .alert-item').length === 3);
    assert.equal(await notes(panel.page), 7);

    // reading from the strip removes the card and tells the server
    await panel.page.click(`[data-alert-read="${id(50)}"]`);
    await panel.page.waitForFunction(() => !document.querySelector('[data-alert-id="00000000-0000-4000-8000-000000000050"]'));
    assert.deepEqual(panel.world.patches[0], { id: id(50) });
    assert.deepEqual(panel.errors, []);
  } finally { await panel.context.close(); }
});

test('text inside an alert is shown as text', async () => {
  const panel = await openPanel(H.WIDTHS[2]);
  try {
    await open(panel);
    await panel.page.waitForSelector('#app:not([hidden])');
    panel.world.alerts.unshift({ id: id(60), type: 'order_initial', title: '<img src=x onerror="window.__xss=1">عنوان', body: '<script>window.__xss=1</script>', isRead: false, createdAt: ago(0), trackingNumber: '', requestId: null, storeId: null });
    await panel.page.evaluate(() => AdminAlerts.pollOnce());
    await panel.page.waitForSelector('#alertStrip:not([hidden]) .alert-item');
    assert.equal(await panel.page.locator('#alertStrip img, #alertStrip script').count(), 0);
    assert.match(await panel.page.textContent('#alertStripList'), /<img src=x/);
    assert.equal(await panel.page.evaluate(() => window.__xss === undefined), true);
  } finally { await panel.context.close(); }
});

test('on a phone the menu is a drawer that opens, closes after choosing a page and with Escape', async () => {
  const panel = await openPanel(H.WIDTHS[0]);
  try {
    await open(panel);
    await panel.page.waitForSelector('#app:not([hidden])');
    assert.equal(await panel.page.getAttribute('#menuToggle', 'aria-expanded'), 'false');
    assert.equal(await drawerOnScreen(panel.page), false, 'closed by default on a phone');
    await panel.page.click('#menuToggle');
    await panel.page.waitForFunction(() => document.body.classList.contains('nav-open'));
    await panel.page.waitForTimeout(350);
    assert.equal(await drawerOnScreen(panel.page), true);
    assert.equal(await panel.page.getAttribute('#menuToggle', 'aria-expanded'), 'true');
    await panel.page.keyboard.press('Escape');
    await panel.page.waitForTimeout(350);
    assert.equal(await drawerOnScreen(panel.page), false, 'Escape closes it');
    assert.equal(await panel.page.getAttribute('#menuToggle', 'aria-expanded'), 'false');
    await panel.page.click('#menuToggle');
    await panel.page.waitForTimeout(350);
    await panel.page.click('#adminNav a[data-page="customers"]');
    await panel.page.waitForSelector('#page-customers:not([hidden])');
    await panel.page.waitForTimeout(350);
    assert.equal(await drawerOnScreen(panel.page), false, 'choosing a page closes the drawer');
    assert.deepEqual(panel.errors, []);
  } finally { await panel.context.close(); }
});

for (const size of H.WIDTHS) {
  test(`${size.name} (${size.width}px): no page scrolls sideways, and nothing the page script raised is an error`, async () => {
    const panel = await openPanel(size);
    try {
      for (const key of PAGES) {
        await open(panel, `#${key}`);
        await panel.page.waitForSelector(`#page-${key}:not([hidden])`);
        if (key === 'first-notices') { await panel.page.waitForSelector('.notice-row'); await panel.page.click('.notice-row >> nth=0'); await panel.page.waitForSelector('#noticeDetail .slip-head, #noticeDetail header'); }
        if (key === 'stores') { await panel.page.waitForSelector('#page-stores tbody tr, #page-stores .store-row'); }
        await panel.page.waitForTimeout(250);
        assert.equal(await overflow(panel.page), 0, `${key} scrolls sideways at ${size.width}px`);
      }
      assert.deepEqual(panel.errors, []);
    } finally { await panel.context.close(); }
  });
}
