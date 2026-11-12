const { getContext, requireRoles } = require('./_auth');
const ORDER_SELECT = 'id,created_at,store_order_requests(id,tracking_number,status,created_at,subtotal,shipping_amount,total_amount,currency,merchant_order_number,merchant_invoice_number,approved_at,payable_amount,payment_status,payment_method,payment_provider,paid_at,payment_options,failure_reason,sale_proven_at,stores(name),store_order_request_items(product_name,brand_name,size_label,product_size_id,quantity,unit_price,line_total,currency,platform_order_number),store_order_cart_restorations(status),store_order_cancellation_requests(created_at),store_shipments(carrier_name,tracking_code,shipping_status,estimated_delivery_at,delivered_at,delivery_verified_at,status_note,updated_at),store_shipment_events(shipping_status,carrier_name,tracking_code,occurred_at,source,note))';
function reply(res, status, body) {
  res.setHeader('Cache-Control', 'no-store');
  return res.status(status).setHeader('Content-Type', 'application/json').json(body);
}
function integerQuery(value, fallback, min, max) {
  if (value === undefined || value === null || value === '') return fallback;
  const raw = Array.isArray(value) ? value[0] : value;
  const parsed = Number(raw);
  return Number.isSafeInteger(parsed) && parsed >= min && parsed <= max ? parsed : null;
}
function contentRangeTotal(response) {
  const value = response.headers && typeof response.headers.get === 'function' ? response.headers.get('content-range') : '';
  const match = String(value || '').match(/\/(\d+|\*)$/);
  return match && match[1] !== '*' ? Number(match[1]) : null;
}
function pick(row, fields) {
  const result = {};
  for (const field of fields) if (Object.prototype.hasOwnProperty.call(row || {}, field)) result[field] = row[field];
  return result;
}
function sanitizeSessions(rows) {
  return rows.map(session => {
    const safeSession = pick(session, ['id', 'created_at']);
    safeSession.store_order_requests = (Array.isArray(session.store_order_requests) ? session.store_order_requests : []).map(request => {
      const safeRequest = pick(request, ['id', 'tracking_number', 'status', 'created_at', 'subtotal', 'shipping_amount', 'total_amount', 'currency', 'merchant_order_number', 'merchant_invoice_number', 'approved_at', 'payable_amount', 'payment_status', 'payment_method', 'payment_provider', 'paid_at', 'sale_proven_at']);
      // The merchant's reason is the customer's to read only when the store turned the order down.
      if (request.status === 'store_rejected' && request.failure_reason) safeRequest.rejection_reason = String(request.failure_reason).slice(0, 500);
      // What the customer may pick, as frozen at approval: the choice and its labels (the payment page address comes back with the choice itself).
      safeRequest.payment_options = (Array.isArray(request.payment_options) ? request.payment_options : []).map(option => pick(option, ['id', 'kind', 'mode', 'provider', 'labelAr', 'labelEn']));
      safeRequest.store_shipment_events = (Array.isArray(request.store_shipment_events) ? request.store_shipment_events : []).map(event => pick(event, ['shipping_status', 'carrier_name', 'tracking_code', 'occurred_at', 'source', 'note']))
        .sort((a, b) => String(a.occurred_at).localeCompare(String(b.occurred_at)));
      safeRequest.stores = request.stores && typeof request.stores === 'object' ? pick(request.stores, ['name']) : null;
      safeRequest.store_order_request_items = (Array.isArray(request.store_order_request_items) ? request.store_order_request_items : []).map(item => pick(item, ['product_name', 'brand_name', 'size_label', 'product_size_id', 'quantity', 'unit_price', 'line_total', 'currency', 'platform_order_number']));
      // One request per order at most; PostgREST answers an object for this one-to-one link, an array elsewhere: the page always gets a list.
      const cancellation = request.store_order_cancellation_requests;
      safeRequest.store_order_cancellation_requests = (Array.isArray(cancellation) ? cancellation : cancellation && typeof cancellation === 'object' ? [cancellation] : []).map(row => pick(row, ['created_at']));
      safeRequest.store_order_cart_restorations = (Array.isArray(request.store_order_cart_restorations) ? request.store_order_cart_restorations : []).map(restoration => pick(restoration, ['status']));
      safeRequest.store_shipments = (Array.isArray(request.store_shipments) ? request.store_shipments : []).map(shipment => pick(shipment, ['carrier_name', 'tracking_code', 'shipping_status', 'estimated_delivery_at', 'delivered_at', 'delivery_verified_at', 'status_note', 'updated_at']));
      return safeRequest;
    });
    return safeSession;
  });
}
module.exports = async function customerOrders(req, res) {
  if (req.method !== 'GET') return reply(res, 405, { ok: false, error: 'method_not_allowed' });
  try {
    const context = requireRoles(await getContext(req), ['customer', 'store_admin', 'platform_admin']);
    if (context.error) return reply(res, context.status, { ok: false, error: context.error });
    const query = req.query || {};
    const limit = integerQuery(query.limit, 100, 1, 100);
    const offset = integerQuery(query.offset, 0, 0, 100000);
    if (limit === null || offset === null) return reply(res, 400, { ok: false, error: 'invalid_page' });
    const params = new URLSearchParams({ select: ORDER_SELECT, user_id: `eq.${context.user.id}`, order: 'created_at.desc,id.desc', limit: String(limit), offset: String(offset) });
    if (query.year && /^\d{4}$/.test(String(query.year))) {
      params.set('created_at', `gte.${String(query.year)}-01-01`);
      params.set('and', `(created_at.lt.${Number(query.year) + 1}-01-01)`);
    }
    const search = String(query.q || '').trim().slice(0, 100);
    if (search) params.set('tracking_number', `ilike.*${search.replace(/[(),]/g, '')}*`);
    const response = await fetch(`${context.supabaseUrl}/rest/v1/checkout_sessions?${params}`, {
      headers: { apikey: context.serviceRoleKey, Authorization: `Bearer ${context.serviceRoleKey}`, Prefer: 'count=exact' }
    });
    let data;
    try { data = await response.json(); } catch (_) { return reply(res, 502, { ok: false, error: 'supabase_read_failed' }); }
    if (!response.ok || !Array.isArray(data)) return reply(res, 502, { ok: false, error: 'supabase_read_failed' });
    const total = contentRangeTotal(response);
    reply(res, 200, { ok: true, sessions: sanitizeSessions(data), pagination: { limit, offset, total, hasMore: total === null ? data.length === limit : offset + data.length < total } });
  } catch (_) { reply(res, 502, { ok: false, error: 'customer_dashboard_failed' }); }
};
