const { getContext, requireRoles } = require('./_auth');

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const STORE_ACCOUNT_PAGE = 500;
const MAX_OFFSET = 1000000;
const STATUSES = new Set(['awaiting_store_confirmation', 'store_confirmed', 'processing', 'shipped', 'delivered', 'store_rejected', 'store_cancelled', 'needs_review', 'completed', 'cancelled']);
const ORDER_SELECT = 'id,store_id,tracking_number,checkout_tracking_number,customer_name,customer_phone,customer_address,status,subtotal,shipping_amount,total_amount,currency,reconciliation_status,created_at,updated_at,stores(name),store_order_request_items(id,request_id,product_name,brand_name,size_label,quantity,unit_price,line_total,currency,created_at),store_order_notifications(id,request_id,tracking_number,event_type,store_status,match_status,received_at),store_order_cancellation_requests(request_id,reason,created_at),store_shipments(id,request_id,carrier_name,tracking_code,shipping_status,status_note,estimated_delivery_at,delivered_at,created_at,updated_at)';
const ORDER_FIELDS = ['id', 'store_id', 'tracking_number', 'checkout_tracking_number', 'customer_name', 'customer_phone', 'customer_address', 'status', 'subtotal', 'shipping_amount', 'total_amount', 'currency', 'reconciliation_status', 'created_at', 'updated_at'];
const ITEM_FIELDS = ['id', 'request_id', 'product_name', 'brand_name', 'size_label', 'quantity', 'unit_price', 'line_total', 'currency', 'created_at'];
const NOTIFICATION_FIELDS = ['id', 'request_id', 'tracking_number', 'event_type', 'store_status', 'match_status', 'received_at'];
const CANCELLATION_FIELDS = ['request_id', 'reason', 'created_at'];
const SHIPMENT_FIELDS = ['id', 'request_id', 'carrier_name', 'tracking_code', 'shipping_status', 'status_note', 'estimated_delivery_at', 'delivered_at', 'created_at', 'updated_at'];

function reply(res, status, body) {
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('Content-Type', 'application/json');
  return res.status(status).json(body);
}
function queryValue(query, key, fallback) {
  const value = query && query[key];
  return value === undefined || value === null || value === '' ? fallback : String(Array.isArray(value) ? value[0] : value);
}
function pageNumber(value, fallback, minimum, maximum) {
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed >= minimum && parsed <= maximum ? parsed : fallback;
}
function pick(row, fields) {
  const result = {};
  for (const field of fields) if (Object.prototype.hasOwnProperty.call(row || {}, field)) result[field] = row[field];
  return result;
}
function totalFrom(response) {
  const value = response.headers && typeof response.headers.get === 'function' ? response.headers.get('content-range') : '';
  const match = String(value || '').match(/\/(\d+|\*)$/);
  return match && match[1] !== '*' ? Number(match[1]) : null;
}
function sanitizeOrders(rows) {
  return rows.map(order => {
    const safe = pick(order, ORDER_FIELDS);
    safe.stores = order.stores && typeof order.stores === 'object' ? pick(order.stores, ['name']) : null;
    safe.store_order_request_items = (Array.isArray(order.store_order_request_items) ? order.store_order_request_items : []).map(item => pick(item, ITEM_FIELDS));
    safe.store_order_notifications = (Array.isArray(order.store_order_notifications) ? order.store_order_notifications : []).map(item => pick(item, NOTIFICATION_FIELDS));
    const cancellation = order.store_order_cancellation_requests;
    safe.store_order_cancellation_requests = (Array.isArray(cancellation) ? cancellation : cancellation && typeof cancellation === 'object' ? [cancellation] : []).map(item => pick(item, CANCELLATION_FIELDS));
    safe.store_shipments = (Array.isArray(order.store_shipments) ? order.store_shipments : []).map(item => pick(item, SHIPMENT_FIELDS));
    return safe;
  });
}
async function readStoreIds(context) {
  const storeIds = new Set();
  const headers = { apikey: context.serviceRoleKey, Authorization: `Bearer ${context.serviceRoleKey}` };
  for (let offset = 0; offset <= MAX_OFFSET; offset += STORE_ACCOUNT_PAGE) {
    const params = new URLSearchParams({ select: 'store_id', user_id: `eq.${context.user.id}`, order: 'created_at.asc,id.asc', limit: String(STORE_ACCOUNT_PAGE), offset: String(offset) });
    const response = await fetch(`${context.supabaseUrl}/rest/v1/store_accounts?${params}`, { headers });
    let rows;
    try { rows = await response.json(); } catch (_) { throw new Error('store_access_check_failed'); }
    if (!response.ok || !Array.isArray(rows)) throw new Error('store_access_check_failed');
    for (const row of rows) if (UUID.test(String(row.store_id || ''))) storeIds.add(row.store_id);
    if (rows.length < STORE_ACCOUNT_PAGE) return [...storeIds];
  }
  throw new Error('store_access_check_failed');
}
module.exports = async function storeDashboardOrders(req, res) {
  if (req.method !== 'GET') return reply(res, 405, { ok: false, error: 'method_not_allowed' });
  try {
    const context = requireRoles(await getContext(req), ['store_admin', 'platform_admin']);
    if (context.error) return reply(res, context.status, { ok: false, error: context.error });
    const query = req.query || {};
    const limit = pageNumber(queryValue(query, 'limit', '50'), null, 1, 100);
    const offset = pageNumber(queryValue(query, 'offset', '0'), null, 0, MAX_OFFSET);
    if (limit === null || offset === null) return reply(res, 400, { ok: false, error: 'invalid_page' });
    const status = queryValue(query, 'status', '');
    if (status && !STATUSES.has(status)) return reply(res, 400, { ok: false, error: 'invalid_status' });

    let storeIds;
    if (context.profile.role === 'platform_admin') {
      const requested = queryValue(query, 'storeId', '');
      if (requested && !UUID.test(requested)) return reply(res, 400, { ok: false, error: 'invalid_store_id' });
      storeIds = requested ? [requested] : [];
    } else {
      storeIds = await readStoreIds(context);
    }
    if (!storeIds.length) return reply(res, 200, { ok: true, stores: [], orders: [], pagination: { limit, offset, total: 0, hasMore: false } });

    const params = new URLSearchParams({ select: ORDER_SELECT, order: 'created_at.desc,id.desc', limit: String(limit), offset: String(offset), store_id: `in.(${storeIds.join(',')})` });
    if (status) params.set('status', `eq.${status}`);
    const response = await fetch(`${context.supabaseUrl}/rest/v1/store_order_requests?${params}`, {
      headers: { apikey: context.serviceRoleKey, Authorization: `Bearer ${context.serviceRoleKey}`, Prefer: 'count=exact' }
    });
    let rows;
    try { rows = await response.json(); } catch (_) { return reply(res, 502, { ok: false, error: 'supabase_read_failed' }); }
    if (!response.ok || !Array.isArray(rows)) return reply(res, 502, { ok: false, error: 'supabase_read_failed' });
    const total = totalFrom(response);
    const orders = sanitizeOrders(rows);
    return reply(res, 200, { ok: true, stores: storeIds, orders, pagination: { limit, offset, total, hasMore: total === null ? rows.length === limit : offset + rows.length < total } });
  } catch (error) {
    return reply(res, 502, { ok: false, error: error && error.message === 'store_access_check_failed' ? error.message : 'store_dashboard_failed' });
  }
};
