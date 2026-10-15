const { getContext, requireRoles } = require('./_auth');

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const ORDER_STATUSES = new Set([
  'awaiting_store_confirmation', 'store_confirmed', 'processing', 'shipped', 'delivered',
  'store_rejected', 'store_cancelled', 'needs_review', 'completed', 'cancelled'
]);
const MATCH_STATUSES = new Set(['pending', 'matched', 'mismatched']);
const ORDER_SELECT = [
  'id', 'store_id', 'tracking_number', 'checkout_tracking_number', 'status', 'subtotal',
  'shipping_amount', 'total_amount', 'currency', 'customer_name', 'customer_phone',
  'customer_email', 'customer_address', 'customer_notes', 'reconciliation_status',
  'created_at', 'stores(name)',
  'store_order_request_items(product_name,brand_name,quantity,line_total,currency)',
  'store_order_notifications(event_type,match_status,received_at)'
].join(',');

function reply(res, status, body) {
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('Content-Type', 'application/json');
  return res.status(status).json(body);
}
function integerQuery(value, fallback, min, max) {
  if (value === undefined || value === null || value === '') return fallback;
  const raw = Array.isArray(value) ? value[0] : value;
  const number = Number(raw);
  return Number.isSafeInteger(number) && number >= min && number <= max ? number : null;
}
function contentRangeTotal(response) {
  const value = response.headers && typeof response.headers.get === 'function'
    ? response.headers.get('content-range') : '';
  const match = String(value || '').match(/\/(\d+|\*)$/);
  return match && match[1] !== '*' ? Number(match[1]) : null;
}

module.exports = async function dashboardOrders(req, res) {
  if (req.method !== 'GET') return reply(res, 405, { ok: false, error: 'method_not_allowed' });
  try {
    const context = requireRoles(await getContext(req), ['platform_admin']);
    if (context.error) return reply(res, context.status, { ok: false, error: context.error });

    const query = req.query || {};
    const limit = integerQuery(query.limit, 100, 1, 100);
    const offset = integerQuery(query.offset, 0, 0, 1000000);
    if (limit === null || offset === null) return reply(res, 400, { ok: false, error: 'invalid_page' });

    const params = new URLSearchParams({
      select: ORDER_SELECT,
      order: 'created_at.desc,id.desc',
      limit: String(limit),
      offset: String(offset)
    });
    if (query.status) {
      const status = String(query.status);
      if (!ORDER_STATUSES.has(status)) return reply(res, 400, { ok: false, error: 'invalid_status' });
      params.set('status', `eq.${status}`);
    }
    if (query.matchStatus) {
      const matchStatus = String(query.matchStatus);
      if (!MATCH_STATUSES.has(matchStatus)) return reply(res, 400, { ok: false, error: 'invalid_match_status' });
      params.set('reconciliation_status', `eq.${matchStatus}`);
    }
    if (query.storeId) {
      const storeId = String(query.storeId);
      if (!UUID.test(storeId)) return reply(res, 400, { ok: false, error: 'invalid_store_id' });
      params.set('store_id', `eq.${storeId}`);
    }
    const tracking = String(query.tracking || '').trim().slice(0, 120).replace(/[(),*%]/g, '');
    if (tracking) params.set('tracking_number', `ilike.*${tracking}*`);
    if (query.from) params.set('created_at', `gte.${String(query.from).slice(0, 40)}`);
    if (query.to) params.set('and', `(created_at.lt.${String(query.to).slice(0, 40)})`);
    if (query.attention === '1') params.set('or', '(status.eq.needs_review,reconciliation_status.eq.mismatched)');

    const response = await fetch(`${context.supabaseUrl}/rest/v1/store_order_requests?${params}`, {
      headers: {
        apikey: context.serviceRoleKey,
        Authorization: `Bearer ${context.serviceRoleKey}`,
        Prefer: 'count=exact'
      }
    });
    let data;
    try { data = await response.json(); } catch (_) {
      return reply(res, 502, { ok: false, error: 'store_order_read_failed' });
    }
    if (!response.ok || !Array.isArray(data)) return reply(res, 502, { ok: false, error: 'store_order_read_failed' });
    const total = contentRangeTotal(response);
    return reply(res, 200, {
      ok: true,
      orders: data,
      pagination: {
        limit,
        offset,
        total,
        hasMore: total === null ? data.length === limit : offset + data.length < total
      }
    });
  } catch (_) {
    return reply(res, 502, { ok: false, error: 'dashboard_read_failed' });
  }
};
