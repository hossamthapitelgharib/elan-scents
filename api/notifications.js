const { getContext, requireRoles } = require('./_auth');
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const STORE_ACCOUNT_PAGE = 500;
const MAX_OFFSET = 1000000;
function reply(res, status, body) { res.setHeader('Cache-Control', 'no-store'); res.status(status).setHeader('Content-Type', 'application/json').json(body); }
function safeText(value, max) {
  if (typeof value !== 'string') return null;
  const text = value.trim();
  return text ? text.slice(0, max) : null;
}
function safeAmount(value) {
  if (value === null || value === undefined || value === '') return null;
  const number = Number(value);
  return Number.isFinite(number) && Math.abs(number) <= 1000000000000 ? Math.round(number * 100) / 100 : null;
}
function visibleOrder(row) {
  const payload = row && row.payload && typeof row.payload === 'object' && !Array.isArray(row.payload) ? row.payload : {};
  const customer = payload.customer && typeof payload.customer === 'object' && !Array.isArray(payload.customer) ? payload.customer : {};
  const store = payload.store && typeof payload.store === 'object' && !Array.isArray(payload.store) ? payload.store : {};
  const items = Array.isArray(payload.items) ? payload.items.slice(0, 100).map(item => {
    const source = item && typeof item === 'object' && !Array.isArray(item) ? item : {};
    return {
      productName: safeText(source.productName || source.product_name || source.name, 200),
      brandName: safeText(source.brandName || source.brand_name, 160),
      size: safeText(source.size || source.size_label, 80),
      quantity: Number.isSafeInteger(Number(source.quantity)) && Number(source.quantity) >= 0 && Number(source.quantity) <= 999 ? Number(source.quantity) : null,
      unitPrice: safeAmount(source.unitPrice),
      lineTotal: safeAmount(source.lineTotal ?? source.total ?? source.line_total)
    };
  }) : [];
  const shipment = payload.shipment && typeof payload.shipment === 'object' && !Array.isArray(payload.shipment) ? payload.shipment : {};
  return {
    trackingNumber: safeText(payload.trackingNumber || row.tracking_number, 120),
    checkoutTrackingNumber: safeText(payload.checkoutTrackingNumber, 120),
    storeOrderReference: safeText(payload.storeOrderReference, 160),
    status: safeText(payload.status, 60),
    subtotal: safeAmount(payload.subtotal),
    shipping: safeAmount(payload.shipping),
    total: safeAmount(payload.total),
    currency: safeText(payload.currency, 12),
    matched: typeof payload.matched === 'boolean' ? payload.matched : null,
    mismatches: Array.isArray(payload.mismatches) ? payload.mismatches.filter(value => typeof value === 'string').slice(0, 50).map(value => value.slice(0, 120)) : [],
    shipment: {
      carrier: safeText(shipment.carrier || shipment.carrierName, 120),
      trackingCode: safeText(shipment.trackingCode || shipment.tracking_code, 120),
      status: safeText(shipment.status || shipment.shippingStatus, 60),
      estimatedDeliveryAt: safeText(shipment.estimatedDeliveryAt || shipment.estimated_delivery_at, 60)
    },
    itemCount: Number.isSafeInteger(Number(payload.itemCount)) && Number(payload.itemCount) >= 0 && Number(payload.itemCount) <= 10000 ? Number(payload.itemCount) : items.length,
    store: { name: safeText(store.name, 200) },
    customer: {
      name: safeText(customer.name, 120),
      phone: safeText(customer.phone, 40),
      email: safeText(customer.email, 320),
      address: safeText(customer.address, 500),
      notes: safeText(customer.notes, 2000)
    },
    items,
    handedOffAt: safeText(payload.handedOffAt, 60)
  };
}
function visibleNotification(row, role) {
  const notification = { id: row.id, title: row.title, body: row.body, is_read: !!row.is_read, created_at: row.created_at };
  // Customer order notices stay concise; detailed order/contact data is only for the owning store and platform staff.
  if (role !== 'customer' && ['order_initial', 'store_purchase_completed', 'store_purchase_needs_review'].includes(row.type)) notification.order = visibleOrder(row);
  return notification;
}
function storeScope(userId, ids) {
  const safeIds = ids.length ? ids.join(',') : '00000000-0000-0000-0000-000000000000';
  return `(user_id.eq.${userId},store_id.in.(${safeIds}))`;
}
module.exports = async function notifications(req, res) {
  if (req.method !== 'GET' && req.method !== 'PATCH') return reply(res, 405, { ok: false, error: 'method_not_allowed' });
  try {
    const context = requireRoles(await getContext(req), ['customer', 'store_admin', 'platform_admin']);
    if (context.error) return reply(res, context.status, { ok: false, error: context.error });
    const headers = { apikey: context.serviceRoleKey, Authorization: `Bearer ${context.serviceRoleKey}`, 'Content-Type': 'application/json' };
    if (req.method === 'PATCH') {
      const id = req.body && req.body.id;
      if (!UUID.test(String(id || ''))) return reply(res, 400, { ok: false, error: 'notification_id_required' });
      const params = new URLSearchParams({ id: `eq.${id}` });
      if (context.profile.role === 'platform_admin') params.set('recipient_role', 'eq.platform_admin');
      else if (context.profile.role === 'store_admin') params.set('or', storeScope(context.user.id, await storeIds(context)));
      else params.set('user_id', `eq.${context.user.id}`);
      const response = await fetch(`${context.supabaseUrl}/rest/v1/notifications?${params}`, { method: 'PATCH', headers: { ...headers, Prefer: 'return=minimal' }, body: JSON.stringify({ is_read: true, read_at: new Date().toISOString() }) });
      if (!response.ok) return reply(res, 502, { ok: false, error: 'notification_update_failed' });
      return reply(res, 200, { ok: true });
    }
    const limit = Math.min(Math.max(Number((req.query || {}).limit) || 50, 1), 100);
    const params = new URLSearchParams({ select: 'id,title,body,is_read,created_at,type,tracking_number,payload', order: 'created_at.desc', limit: String(limit) });
    if ((req.query || {}).unread === '1') params.set('is_read', 'eq.false');
    if (context.profile.role === 'platform_admin') params.set('recipient_role', 'eq.platform_admin');
    else if (context.profile.role === 'store_admin') {
      const ids = await storeIds(context);
      params.set('or', storeScope(context.user.id, ids));
    } else params.set('user_id', `eq.${context.user.id}`);
    const response = await fetch(`${context.supabaseUrl}/rest/v1/notifications?${params}`, { headers });
    const data = await response.json();
    if (!response.ok || !Array.isArray(data)) return reply(res, 502, { ok: false, error: 'notification_read_failed' });
    reply(res, 200, { ok: true, notifications: data.map(row => visibleNotification(row, context.profile.role)) });
  } catch (_) { reply(res, 502, { ok: false, error: 'notification_api_failed' }); }
};
async function storeIds(context) {
  const ids = new Set();
  const headers = { apikey: context.serviceRoleKey, Authorization: `Bearer ${context.serviceRoleKey}` };
  for (let offset = 0; offset <= MAX_OFFSET; offset += STORE_ACCOUNT_PAGE) {
    const params = new URLSearchParams({ select: 'store_id', user_id: `eq.${context.user.id}`, order: 'created_at.asc,id.asc', limit: String(STORE_ACCOUNT_PAGE), offset: String(offset) });
    const response = await fetch(`${context.supabaseUrl}/rest/v1/store_accounts?${params}`, { headers });
    let rows;
    try { rows = await response.json(); } catch (_) { throw new Error('store_memberships_unavailable'); }
    if (!response.ok || !Array.isArray(rows)) throw new Error('store_memberships_unavailable');
    for (const row of rows) if (UUID.test(String(row.store_id || ''))) ids.add(row.store_id);
    if (rows.length < STORE_ACCOUNT_PAGE) return [...ids];
  }
  throw new Error('store_memberships_unavailable');
}
