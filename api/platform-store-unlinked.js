const { getContext, requireRoles } = require('./_auth');

const TYPES = {
  notifications: {
    table: 'store_order_notifications',
    select: 'id,tracking_number,event_type,store_status,match_status,mismatch_fields,received_at',
    order: 'received_at.desc,id.asc',
    fields: ['id', 'tracking_number', 'event_type', 'store_status', 'match_status', 'mismatch_fields', 'received_at']
  },
  events: {
    table: 'order_operation_events',
    select: 'id,checkout_session_id,actor_role,event_type,source,created_at',
    order: 'created_at.desc,id.asc',
    fields: ['id', 'checkout_session_id', 'actor_role', 'event_type', 'source', 'created_at']
  }
};
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
  const result = {};
  for (const field of fields) if (Object.prototype.hasOwnProperty.call(row || {}, field)) result[field] = row[field];
  return result;
}
module.exports = async function platformStoreUnlinked(req, res) {
  if (req.method !== 'GET') return reply(res, 405, { ok: false, error: 'method_not_allowed' });
  try {
    const context = requireRoles(await getContext(req), ['platform_admin']);
    if (context.error) return reply(res, context.status, { ok: false, error: context.error });
    const query = req.query || {};
    const type = String(query.type || '');
    const config = Object.prototype.hasOwnProperty.call(TYPES, type) ? TYPES[type] : null;
    if (!config) return reply(res, 400, { ok: false, error: 'invalid_unlinked_record_type' });
    const limit = clampInt(query.limit, 50, 100) || 50;
    const offset = clampInt(query.offset, 0, 1000000);
    const params = new URLSearchParams({ select: config.select, request_id: 'is.null', order: config.order, limit: String(limit + 1), offset: String(offset) });
    const response = await fetch(`${context.supabaseUrl}/rest/v1/${config.table}?${params.toString()}`, {
      headers: { apikey: context.serviceRoleKey, Authorization: `Bearer ${context.serviceRoleKey}` }
    });
    let rows;
    try { rows = await response.json(); } catch (_) { return reply(res, 502, { ok: false, error: 'unlinked_store_data_unavailable' }); }
    if (!response.ok || !Array.isArray(rows)) return reply(res, 502, { ok: false, error: 'unlinked_store_data_unavailable' });
    const hasMore = rows.length > limit;
    const records = rows.slice(0, limit).map(row => {
      const clean = pick(row, config.fields);
      if (type === 'notifications') clean.mismatch_fields = Array.isArray(clean.mismatch_fields) ? clean.mismatch_fields.filter(value => typeof value === 'string').slice(0, 100) : [];
      return clean;
    });
    return reply(res, 200, { ok: true, type, records, limit, offset, hasMore });
  } catch (_) {
    return reply(res, 502, { ok: false, error: 'unlinked_store_data_unavailable' });
  }
};
