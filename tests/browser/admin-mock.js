'use strict';
/* A made-up server for the admin panel: every /api call the panel makes is answered here with invented data, and the Supabase sign-in too.
   Used by tests/browser/admin-shell.chromium.js (against the local site) and by scripts/admin-live-check.js (against the published site from a
   GitHub runner), so both check the same screens with the same data. Nothing here reaches Supabase, a store or a real customer. */
const SUPABASE = 'https://' + 'sbgdtuqfrnfeggkwqtrw.supabase.co';
const PAGES = ['overview', 'first-notices', 'messages', 'customers', 'stores', 'settlements', 'rankings', 'audit'];
const id = n => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const ago = mins => new Date(Date.now() - mins * 60000).toISOString();
const token = 'h.' + Buffer.from(JSON.stringify({ exp: Math.floor(Date.now() / 1000) + 86400, sub: id(1) })).toString('base64url') + '.s';
const session = JSON.stringify({ access_token: token, refresh_token: 'r', user: { id: 'u' } });
const json = (route, body, status = 200) => route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(body) });
const EVIL = 'متجر <img src=x onerror="window.__xss=1"> الاختبار';

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


/* What the fake server holds. A test changes it (new `alerts`, another `status`) to make news arrive or the session end. */
function newWorld(options = {}) {
  return { status: options.status || 200, alerts: freshAlerts(), patches: [], calls: [], loginBody: null };
}

/* Puts the fake server behind a browser context: the saved session (unless signedIn is false), a spy on the chime, a record of any content-security-policy
   violation, and the routes. Chromium's audio needs no device here; the spy counts the notes the chime plays instead of listening to them. */
async function installFakeServer(context, world, options = {}) {
  if (options.signedIn !== false) await context.addInitScript(value => { try { if (!localStorage.getItem('elan_auth_session')) localStorage.setItem('elan_auth_session', value); } catch (_) {} }, session);
  await context.addInitScript(() => {
    window.__notes = 0;
    window.__csp = [];
    document.addEventListener('securitypolicyviolation', event => { window.__csp.push(event.violatedDirective + ' ' + String(event.blockedURI || '').slice(0, 120)); });
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
}

module.exports = { SUPABASE, PAGES, id, ago, token, session, json, EVIL, freshAlerts, notice, noticeDetail, newWorld, installFakeServer };
