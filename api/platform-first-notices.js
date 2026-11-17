const { getContext, requireRoles } = require('./_auth');

/* Platform admin only: the FIRST notice (public.platform_order_notices), the one the platform writes once, after the trusted payment
   result of an order. It is immutable, so this endpoint only reads.
     GET /api/platform-first-notices[?limit=20&offset=0&store=<uuid>&q=<part of a tracking number>]   the list, newest first
     GET /api/platform-first-notices?id=<notice uuid>                                                  one notice in full
   The table is closed to every browser role (only the service role reads it), and only the keys listed below leave the server: a field
   the platform adds to the notice later does not reach the admin's screen until it is listed here on purpose. A notice that is not the
   shape we expect is still shown with what we recognise; it is never dropped from the list. */

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const MAX_OFFSET = 100000;

function reply(res, status, body) {
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('Content-Type', 'application/json');
  return res.status(status).json(body);
}

function first(value) { return Array.isArray(value) ? value[0] : value; }

function integerQuery(value, fallback, min, max) {
  const raw = first(value);
  if (raw === undefined || raw === null || raw === '') return fallback;
  const number = Number(raw);
  return Number.isSafeInteger(number) && number >= min && number <= max ? number : null;
}

function isObject(value) { return !!value && typeof value === 'object' && !Array.isArray(value); }

function text(value, max) {
  if (typeof value !== 'string' && typeof value !== 'number') return null;
  const clean = String(value).trim();
  return clean ? clean.slice(0, max) : null;
}

function amount(value) {
  if (value === null || value === undefined || value === '') return null;
  const number = Number(value);
  return Number.isFinite(number) && Math.abs(number) <= 1e12 ? Math.round(number * 100) / 100 : null;
}

function quantity(value) {
  const number = Number(value);
  return Number.isSafeInteger(number) && number >= 0 && number <= 100000 ? number : null;
}

/* What the merchant and the courier received: the snapshot's `delivery` block, or the same five keys at the top of an older shape. */
function deliveryView(customer) {
  const source = isObject(customer) ? (isObject(customer.delivery) ? customer.delivery : customer) : {};
  return {
    name: text(source.name, 160),
    phone: text(source.phone, 40),
    email: text(source.email, 320),
    address: text(source.address, 600),
    notes: text(source.notes, 2000)
  };
}

function itemView(item) {
  const source = isObject(item) ? item : {};
  return {
    platformOrderNumber: text(source.platformOrderNumber, 80),
    productName: text(source.productName || source.product_name, 200),
    brandName: text(source.brandName || source.brand_name, 160),
    sizeLabel: text(source.sizeLabel || source.size_label || source.size, 80),
    quantity: quantity(source.quantity),
    unitPrice: amount(source.unitPrice),
    lineTotal: amount(source.lineTotal)
  };
}

function paymentView(payment) {
  const source = isObject(payment) ? payment : {};
  return {
    method: text(source.method, 60),
    provider: text(source.provider, 80),
    status: text(source.status, 40),
    reference: text(source.reference, 160),
    paidAt: text(source.paidAt, 60)
  };
}

/* The second notice (the merchant's own) is matched against this one: this says where that stands, from the order row. */
function secondNoticeView(order) {
  const row = isObject(order) ? order : {};
  const merchantOrder = text(row.merchant_order_number, 160);
  const merchantInvoice = text(row.merchant_invoice_number, 160);
  const reconciliation = text(row.reconciliation_status, 40);
  const mismatches = Array.isArray(row.mismatch_fields) ? row.mismatch_fields.filter(value => typeof value === 'string').slice(0, 50).map(value => value.slice(0, 120)) : [];
  let state = 'waiting';
  if (reconciliation === 'matched') state = 'matched';
  else if (reconciliation === 'mismatched' || mismatches.length) state = 'mismatch';
  return { state, merchantOrderNumber: merchantOrder, merchantInvoiceNumber: merchantInvoice, mismatches };
}

function orderStateView(order) {
  const row = isObject(order) ? order : {};
  return {
    status: text(row.status, 60),
    paymentStatus: text(row.payment_status, 40),
    saleProvenAt: text(row.sale_proven_at, 60)
  };
}

function summaryView(row, storeName, order) {
  const payload = isObject(row.payload) ? row.payload : {};
  const store = isObject(payload.store) ? payload.store : {};
  const items = Array.isArray(payload.items) ? payload.items : [];
  const payment = paymentView(payload.payment);
  const delivery = deliveryView(payload.customer);
  return {
    id: row.id,
    requestId: row.request_id,
    storeId: row.store_id,
    storeName: text(storeName, 200) || text(store.name, 200),
    trackingNumber: text(row.tracking_number, 120),
    createdAt: row.created_at,
    itemCount: items.length,
    unitCount: items.reduce((total, item) => total + (quantity(isObject(item) ? item.quantity : 0) || 0), 0),
    total: amount(payload.total),
    currency: text(payload.currency, 12),
    paymentMethod: payment.method,
    paymentStatus: payment.status,
    customerName: delivery.name,
    second: secondNoticeView(order).state
  };
}

function detailView(row, storeName, order) {
  const payload = isObject(row.payload) ? row.payload : {};
  const store = isObject(payload.store) ? payload.store : {};
  const items = Array.isArray(payload.items) ? payload.items.slice(0, 200).map(itemView) : [];
  return {
    ...summaryView(row, storeName, order),
    checkoutTrackingNumber: text(payload.checkoutTrackingNumber, 120),
    version: Number.isSafeInteger(Number(payload.version)) ? Number(payload.version) : null,
    payloadHash: text(row.payload_hash, 80),
    storeName: text(storeName, 200) || text(store.name, 200),
    delivery: deliveryView(payload.customer),
    items,
    subtotal: amount(payload.subtotal),
    shipping: amount(payload.shipping),
    payment: paymentView(payload.payment),
    secondNotice: secondNoticeView(order),
    order: orderStateView(order)
  };
}

async function readJson(response) {
  try { return await response.json(); } catch (_) { return null; }
}

/* The names and order rows of one page of notices, in two small reads (a notice and its order are one to one). */
async function lookups(context, headers, rows) {
  const storeIds = [...new Set(rows.map(row => row.store_id).filter(value => UUID.test(String(value || ''))))];
  const requestIds = [...new Set(rows.map(row => row.request_id).filter(value => UUID.test(String(value || ''))))];
  const stores = new Map(), orders = new Map();
  if (storeIds.length) {
    const params = new URLSearchParams({ select: 'id,name', id: `in.(${storeIds.join(',')})` });
    const response = await fetch(`${context.supabaseUrl}/rest/v1/stores?${params}`, { headers });
    const data = await readJson(response);
    if (!response.ok || !Array.isArray(data)) throw new Error('first_notice_lookup_failed');
    for (const store of data) stores.set(store.id, store.name);
  }
  if (requestIds.length) {
    const params = new URLSearchParams({ select: 'id,status,payment_status,reconciliation_status,mismatch_fields,merchant_order_number,merchant_invoice_number,sale_proven_at', id: `in.(${requestIds.join(',')})` });
    const response = await fetch(`${context.supabaseUrl}/rest/v1/store_order_requests?${params}`, { headers });
    const data = await readJson(response);
    if (!response.ok || !Array.isArray(data)) throw new Error('first_notice_lookup_failed');
    for (const order of data) orders.set(order.id, order);
  }
  return { stores, orders };
}

function totalFrom(response) {
  const match = (response.headers.get('content-range') || '').match(/\/(\d+)$/);
  return match ? Number(match[1]) : null;
}

module.exports = async function platformFirstNotices(req, res) {
  if (req.method !== 'GET') return reply(res, 405, { ok: false, error: 'method_not_allowed' });
  try {
    const context = requireRoles(await getContext(req), ['platform_admin']);
    if (context.error) return reply(res, context.status, { ok: false, error: context.error });
    const query = req.query || {};
    const headers = { apikey: context.serviceRoleKey, Authorization: `Bearer ${context.serviceRoleKey}` };
    const columns = 'id,request_id,store_id,tracking_number,payload_hash,payload,created_at';

    const id = first(query.id);
    if (id !== undefined && id !== '') {
      if (!UUID.test(String(id))) return reply(res, 400, { ok: false, error: 'invalid_notice_id' });
      const params = new URLSearchParams({ select: columns, id: `eq.${id}`, limit: '1' });
      const response = await fetch(`${context.supabaseUrl}/rest/v1/platform_order_notices?${params}`, { headers });
      const rows = await readJson(response);
      if (!response.ok || !Array.isArray(rows)) return reply(res, 502, { ok: false, error: 'first_notices_unavailable' });
      if (!rows.length) return reply(res, 404, { ok: false, error: 'notice_not_found' });
      const { stores, orders } = await lookups(context, headers, rows);
      return reply(res, 200, { ok: true, notice: detailView(rows[0], stores.get(rows[0].store_id), orders.get(rows[0].request_id)) });
    }

    const limit = integerQuery(query.limit, 20, 1, 50);
    const offset = integerQuery(query.offset, 0, 0, MAX_OFFSET);
    if (limit === null || offset === null) return reply(res, 400, { ok: false, error: 'invalid_limit' });
    const params = new URLSearchParams({ select: columns, order: 'created_at.desc,id.desc', limit: String(limit), offset: String(offset) });
    const store = first(query.store);
    if (store !== undefined && store !== '') {
      if (!UUID.test(String(store))) return reply(res, 400, { ok: false, error: 'invalid_store_id' });
      params.set('store_id', `eq.${store}`);
    }
    const search = first(query.q);
    if (search !== undefined && search !== '') {
      // A tracking number is letters, digits and dashes: anything else cannot match and is refused instead of being put into a filter.
      if (!/^[A-Za-z0-9_-]{1,60}$/.test(String(search))) return reply(res, 400, { ok: false, error: 'invalid_search' });
      params.set('tracking_number', `ilike.*${search}*`);
    }
    const response = await fetch(`${context.supabaseUrl}/rest/v1/platform_order_notices?${params}`, { headers: { ...headers, Prefer: 'count=exact' } });
    const rows = await readJson(response);
    if (!response.ok || !Array.isArray(rows)) return reply(res, 502, { ok: false, error: 'first_notices_unavailable' });
    const { stores, orders } = await lookups(context, headers, rows);
    const total = totalFrom(response);
    return reply(res, 200, {
      ok: true,
      total: total === null ? rows.length + offset : total,
      hasMore: total === null ? rows.length === limit : offset + rows.length < total,
      notices: rows.map(row => summaryView(row, stores.get(row.store_id), orders.get(row.request_id)))
    });
  } catch (_) {
    return reply(res, 502, { ok: false, error: 'first_notices_unavailable' });
  }
};
