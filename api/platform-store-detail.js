const { getContext, requireRoles } = require('./_auth');

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const SECTIONS = new Set(['overview', 'catalog', 'offers', 'orders', 'shipments', 'commissions', 'sync', 'reconciliation']);
const ORDER_STATUSES = new Set(['awaiting_store_confirmation', 'store_confirmed', 'processing', 'shipped', 'delivered', 'store_rejected', 'store_cancelled', 'needs_review', 'completed', 'cancelled']);
const RECONCILIATION_STATUSES = new Set(['pending', 'matched', 'mismatched']);
const COMMISSION_STATUSES = new Set(['pending', 'payable', 'paid']);
const STORE_SELECT = 'id,name,slug,logo_url,image_url,short_description,website_url,status,commission_rate,priority_rank,created_at,updated_at';
const STORE_PRODUCT_SELECT = 'id,store_id,product_size_id,price,original_price,discount_percentage,stock_quantity,is_available,is_new_arrival,is_coming_soon,price_includes_tax,price_includes_shipping,currency,data_source,sync_status,last_synced_at,created_at,updated_at,product_url,is_catalog_bestseller';
const ORDER_SELECT = 'id,store_id,tracking_number,checkout_tracking_number,status,subtotal,shipping_amount,total_amount,currency,store_order_reference,failure_reason,reconciliation_status,mismatch_fields,created_at,updated_at';
const ORDER_ITEM_SELECT = 'request_id,store_product_id,product_size_id,product_name,brand_name,size_label,quantity,unit_price,line_total,currency,created_at';
const SHIPMENT_SELECT = 'id,request_id,carrier_name,tracking_code,shipping_status,status_note,estimated_delivery_at,delivered_at,created_at,updated_at';

function reply(res, status, body) {
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('Content-Type', 'application/json');
  return res.status(status).json(body);
}
function clampInt(value, fallback, max) {
  const number = Number.parseInt(value, 10);
  return Number.isFinite(number) && number >= 0 ? Math.min(number, max) : fallback;
}
function pick(row, fields) {
  const out = {};
  for (const field of fields) if (Object.prototype.hasOwnProperty.call(row || {}, field)) out[field] = row[field];
  return out;
}
function groupBy(rows, key) {
  const groups = new Map();
  for (const row of rows) {
    const id = row && row[key];
    if (!id) continue;
    if (!groups.has(id)) groups.set(id, []);
    groups.get(id).push(row);
  }
  return groups;
}
function inFilter(ids) {
  const safe = [...new Set(ids)].filter(id => UUID.test(String(id)));
  return safe.length ? `in.(${safe.join(',')})` : null;
}

async function readRows(context, table, params) {
  const response = await fetch(`${context.supabaseUrl}/rest/v1/${table}?${params.toString()}`, {
    headers: { apikey: context.serviceRoleKey, Authorization: `Bearer ${context.serviceRoleKey}` }
  });
  let data;
  try { data = await response.json(); } catch (_) { throw new Error('store_detail_read_failed'); }
  if (!response.ok || !Array.isArray(data)) throw new Error('store_detail_read_failed');
  return data;
}
async function readRpc(context, name) {
  const response = await fetch(`${context.supabaseUrl}/rest/v1/rpc/${name}`, {
    method: 'POST',
    headers: { apikey: context.serviceRoleKey, Authorization: `Bearer ${context.serviceRoleKey}`, 'Content-Type': 'application/json' },
    body: '{}'
  });
  let data;
  try { data = await response.json(); } catch (_) { throw new Error('store_detail_read_failed'); }
  if (!response.ok || !Array.isArray(data)) throw new Error('store_detail_read_failed');
  return data;
}
function storeParams(storeId, select, limit, offset) {
  return new URLSearchParams({ select, store_id: `eq.${storeId}`, order: 'created_at.desc', limit: String(limit), offset: String(offset) });
}
function pageParams(storeId, select, limit, offset) {
  return new URLSearchParams({ select, store_id: `eq.${storeId}`, order: 'updated_at.desc', limit: String(limit), offset: String(offset) });
}

async function productContexts(context, productSizeIds) {
  const sizeIds = [...new Set(productSizeIds.filter(id => UUID.test(String(id || ''))))];
  if (!sizeIds.length) return { sizes: new Map(), products: new Map(), brands: new Map() };
  const sizeParams = new URLSearchParams({ select: 'id,product_id,size_ml,size_label,sku', id: inFilter(sizeIds), limit: String(sizeIds.length) });
  const sizeRows = await readRows(context, 'product_sizes', sizeParams);
  const productIds = [...new Set(sizeRows.map(row => row.product_id).filter(id => UUID.test(String(id || ''))))];
  if (!productIds.length) return { sizes: new Map(sizeRows.map(row => [row.id, row])), products: new Map(), brands: new Map() };
  const productParams = new URLSearchParams({ select: 'id,brand_id,name,slug,short_description,gender,status,is_active,created_at,updated_at', id: inFilter(productIds), limit: String(productIds.length) });
  const productRows = await readRows(context, 'products', productParams);
  const brandIds = [...new Set(productRows.map(row => row.brand_id).filter(id => UUID.test(String(id || ''))))];
  let brandRows = [];
  if (brandIds.length) {
    const brandParams = new URLSearchParams({ select: 'id,name,slug,official_logo_url,is_active', id: inFilter(brandIds), limit: String(brandIds.length) });
    brandRows = await readRows(context, 'brands', brandParams);
  }
  return {
    sizes: new Map(sizeRows.map(row => [row.id, row])),
    products: new Map(productRows.map(row => [row.id, row])),
    brands: new Map(brandRows.map(row => [row.id, row]))
  };
}
function attachProductContext(rows, contexts, sizeField = 'product_size_id') {
  return rows.map(row => {
    const size = contexts.sizes.get(row[sizeField]) || null;
    const product = size && contexts.products.get(size.product_id) || null;
    const brand = product && contexts.brands.get(product.brand_id) || null;
    return { ...row, size, product, brand };
  });
}
async function getRequestChildren(context, requests) {
  const ids = requests.map(row => row.id).filter(id => UUID.test(String(id || '')));
  if (!ids.length) return { items: new Map(), shipments: new Map(), notifications: new Map(), checks: new Map(), audit: new Map() };
  const requestFilter = inFilter(ids);
  const childParams = (select, limit = 500) => new URLSearchParams({ select, request_id: requestFilter, order: 'created_at.desc', limit: String(limit) });
  const notificationParams = new URLSearchParams({ select: 'request_id,tracking_number,event_type,store_status,match_status,mismatch_fields,received_at', request_id: requestFilter, order: 'received_at.desc', limit: '500' });
  const checkParams = new URLSearchParams({ select: 'request_id,tracking_number,event_type,match_status,mismatch_fields,checked_at', request_id: requestFilter, order: 'checked_at.desc', limit: '500' });
  const auditParams = new URLSearchParams({ select: 'request_id,actor_role,event_type,source,created_at', request_id: requestFilter, order: 'created_at.desc', limit: '500' });
  const [itemRows, shipmentRows, notificationRows, checkRows, auditRows] = await Promise.all([
    readRows(context, 'store_order_request_items', childParams(ORDER_ITEM_SELECT)),
    readRows(context, 'store_shipments', new URLSearchParams({ select: SHIPMENT_SELECT, store_id: `eq.${requests[0].store_id}`, request_id: requestFilter, order: 'created_at.desc', limit: '500' })),
    readRows(context, 'store_order_notifications', notificationParams),
    readRows(context, 'order_reconciliation_checks', checkParams),
    readRows(context, 'order_operation_events', auditParams)
  ]);
  return {
    items: groupBy(itemRows, 'request_id'),
    shipments: groupBy(shipmentRows, 'request_id'),
    notifications: groupBy(notificationRows, 'request_id'),
    checks: groupBy(checkRows, 'request_id'),
    audit: groupBy(auditRows, 'request_id')
  };
}
function orderRecords(rows, children) {
  const fields = ORDER_SELECT.split(',');
  const safeChildren = (group, id, allowed) => (group.get(id) || []).map(item => pick(item, allowed));
  return rows.map(row => ({
    ...pick(row, fields),
    items: safeChildren(children.items, row.id, ORDER_ITEM_SELECT.split(',')),
    shipments: safeChildren(children.shipments, row.id, SHIPMENT_SELECT.split(',')),
    notifications: safeChildren(children.notifications, row.id, ['request_id', 'tracking_number', 'event_type', 'store_status', 'match_status', 'mismatch_fields', 'received_at']),
    checks: safeChildren(children.checks, row.id, ['request_id', 'tracking_number', 'event_type', 'match_status', 'mismatch_fields', 'checked_at']),
    audit: safeChildren(children.audit, row.id, ['request_id', 'actor_role', 'event_type', 'source', 'created_at'])
  }));
}

module.exports = async function platformStoreDetail(req, res) {
  if (req.method !== 'GET') return reply(res, 405, { ok: false, error: 'method_not_allowed' });
  try {
    const context = requireRoles(await getContext(req), ['platform_admin']);
    if (context.error) return reply(res, context.status, { ok: false, error: context.error });
    const query = req.query || {};
    const storeId = String(query.storeId || '');
    const section = String(query.section || 'overview');
    if (!UUID.test(storeId) || !SECTIONS.has(section)) return reply(res, 400, { ok: false, error: 'invalid_store_detail_request' });
    const limit = clampInt(query.limit, 50, 100) || 50;
    const offset = clampInt(query.offset, 0, 1000000);
    const storeLookupParams = new URLSearchParams({ select: STORE_SELECT, id: `eq.${storeId}`, limit: '1' });
    const stores = await readRows(context, 'stores', storeLookupParams);
    if (!stores.length) return reply(res, 404, { ok: false, error: 'store_not_found' });
    const store = pick(stores[0], STORE_SELECT.split(','));
    let records = [];
    let summary = null;
    let accounts = [];
    let hasMore = false;

    if (section === 'overview') {
      const accountParams = new URLSearchParams({ select: 'id,user_id,role,created_at,updated_at', store_id: `eq.${storeId}`, order: 'created_at.desc', limit: '100' });
      const [accountRows, summaryRows] = await Promise.all([readRows(context, 'store_accounts', accountParams), readRpc(context, 'platform_store_summary')]);
      accounts = accountRows.map(row => pick(row, ['id', 'user_id', 'role', 'created_at', 'updated_at']));
      summary = summaryRows.find(row => row.store_id === storeId) || null;
      hasMore = false;
    } else if (section === 'catalog') {
      const params = pageParams(storeId, STORE_PRODUCT_SELECT, limit, offset);
      const rows = await readRows(context, 'store_products', params);
      const contexts = await productContexts(context, rows.map(row => row.product_size_id));
      records = attachProductContext(rows, contexts);
      hasMore = rows.length === limit;
    } else if (section === 'offers') {
      const params = new URLSearchParams({ select: 'id,store_id,product_size_id,title,description,discount_type,discount_value,start_date,end_date,is_active,created_at,updated_at', store_id: `eq.${storeId}`, order: 'created_at.desc', limit: String(limit), offset: String(offset) });
      const rows = await readRows(context, 'offers', params);
      const contexts = await productContexts(context, rows.map(row => row.product_size_id).filter(Boolean));
      records = attachProductContext(rows, contexts);
      hasMore = rows.length === limit;
    } else if (section === 'orders') {
      const params = storeParams(storeId, ORDER_SELECT, limit, offset);
      const status = String(query.status || '');
      const matchStatus = String(query.matchStatus || '');
      if (status && !ORDER_STATUSES.has(status)) return reply(res, 400, { ok: false, error: 'invalid_order_status' });
      if (matchStatus && !RECONCILIATION_STATUSES.has(matchStatus)) return reply(res, 400, { ok: false, error: 'invalid_reconciliation_status' });
      if (status) params.set('status', `eq.${status}`);
      if (matchStatus) params.set('reconciliation_status', `eq.${matchStatus}`);
      const tracking = String(query.tracking || '').trim().slice(0, 120).replace(/[(),*%]/g, '');
      if (tracking) params.set('tracking_number', `ilike.*${tracking}*`);
      const rows = await readRows(context, 'store_order_requests', params);
      const children = await getRequestChildren(context, rows);
      records = orderRecords(rows, children);
      hasMore = rows.length === limit;
    } else if (section === 'shipments') {
      const params = new URLSearchParams({ select: SHIPMENT_SELECT, store_id: `eq.${storeId}`, order: 'created_at.desc', limit: String(limit), offset: String(offset) });
      const rows = await readRows(context, 'store_shipments', params);
      const requestIds = rows.map(row => row.request_id).filter(id => UUID.test(String(id || '')));
      let requests = [];
      if (requestIds.length) {
        const requestParams = new URLSearchParams({ select: 'id,tracking_number,status,reconciliation_status', id: inFilter(requestIds), limit: String(requestIds.length) });
        requests = await readRows(context, 'store_order_requests', requestParams);
      }
      const requestById = new Map(requests.map(row => [row.id, row]));
      records = rows.map(row => ({ ...pick(row, SHIPMENT_SELECT.split(',')), order: pick(requestById.get(row.request_id), ['id', 'tracking_number', 'status', 'reconciliation_status']) }));
      hasMore = rows.length === limit;
    } else if (section === 'commissions') {
      const params = new URLSearchParams({ select: 'id,store_id,order_item_id,rate,amount,status,created_at,updated_at', store_id: `eq.${storeId}`, order: 'created_at.desc', limit: String(limit), offset: String(offset) });
      const status = String(query.status || '');
      if (status && !COMMISSION_STATUSES.has(status)) return reply(res, 400, { ok: false, error: 'invalid_commission_status' });
      if (status) params.set('status', `eq.${status}`);
      const rows = await readRows(context, 'commissions', params);
      const itemIds = rows.map(row => row.order_item_id).filter(id => UUID.test(String(id || '')));
      let items = [];
      if (itemIds.length) {
        const itemParams = new URLSearchParams({ select: 'id,order_id,store_product_id,quantity,price_at_time,created_at', id: inFilter(itemIds), limit: String(itemIds.length) });
        items = await readRows(context, 'order_items', itemParams);
      }
      items = items.map(row => pick(row, ['id', 'order_id', 'store_product_id', 'quantity', 'price_at_time', 'created_at']));
      const orderIds = [...new Set(items.map(row => row.order_id).filter(id => UUID.test(String(id || ''))))];
      let orders = [];
      if (orderIds.length) {
        const orderParams = new URLSearchParams({ select: 'id,status,subtotal,total_amount,created_at,updated_at', id: inFilter(orderIds), limit: String(orderIds.length) });
        orders = await readRows(context, 'orders', orderParams);
      }
      orders = orders.map(row => pick(row, ['id', 'status', 'subtotal', 'total_amount', 'created_at', 'updated_at']));
      const storeProductIds = [...new Set(items.map(row => row.store_product_id).filter(id => UUID.test(String(id || ''))))];
      let storeProducts = [];
      if (storeProductIds.length) {
        const productParams = new URLSearchParams({ select: STORE_PRODUCT_SELECT, id: inFilter(storeProductIds), store_id: `eq.${storeId}`, limit: String(storeProductIds.length) });
        storeProducts = await readRows(context, 'store_products', productParams);
      }
      const contexts = await productContexts(context, storeProducts.map(row => row.product_size_id));
      const enrichedStoreProducts = attachProductContext(storeProducts, contexts);
      const productById = new Map(enrichedStoreProducts.map(row => [row.id, row]));
      const itemById = new Map(items.map(row => [row.id, { ...row, product: productById.get(row.store_product_id) || null }]));
      const orderById = new Map(orders.map(row => [row.id, row]));
      records = rows.map(row => ({ ...pick(row, ['id', 'store_id', 'order_item_id', 'rate', 'amount', 'status', 'created_at', 'updated_at']), item: itemById.get(row.order_item_id) || null, order: orderById.get((itemById.get(row.order_item_id) || {}).order_id) || null }));
      hasMore = rows.length === limit;
    } else if (section === 'sync') {
      const params = storeParams(storeId, 'id,store_id,status,records_count,created_at,updated_at', limit, offset);
      const rows = await readRows(context, 'sync_logs', params);
      records = rows.map(row => pick(row, ['id', 'store_id', 'status', 'records_count', 'created_at', 'updated_at']));
      hasMore = rows.length === limit;
    } else if (section === 'reconciliation') {
      const params = storeParams(storeId, 'id,tracking_number,status,reconciliation_status,created_at,updated_at', limit, offset);
      const requests = await readRows(context, 'store_order_requests', params);
      const requestIds = requests.map(row => row.id).filter(id => UUID.test(String(id || '')));
      let checks = [];
      if (requestIds.length) {
        const checkParams = new URLSearchParams({ select: 'id,request_id,notification_id,tracking_number,event_type,mismatch_fields,match_status,checked_at', request_id: inFilter(requestIds), order: 'checked_at.desc', limit: String(Math.min(500, Math.max(limit, requests.length * 10))) });
        checks = await readRows(context, 'order_reconciliation_checks', checkParams);
      }
      const checksByRequest = groupBy(checks, 'request_id');
      records = requests.map(row => ({ ...pick(row, ['id', 'tracking_number', 'status', 'reconciliation_status', 'created_at', 'updated_at']), checks: (checksByRequest.get(row.id) || []).map(check => pick(check, ['id', 'request_id', 'notification_id', 'tracking_number', 'event_type', 'mismatch_fields', 'match_status', 'checked_at'])) }));
      hasMore = requests.length === limit;
    } else {
      return reply(res, 400, { ok: false, error: 'invalid_store_detail_request' });
    }

    return reply(res, 200, { ok: true, section, store, summary, accounts, records, hasMore, limit, offset });
  } catch (_) {
    return reply(res, 502, { ok: false, error: 'store_detail_unavailable' });
  }
};
