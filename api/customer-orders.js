const { getContext, requireRoles } = require('./_auth');
function reply(res, status, body) { res.status(status).setHeader('Content-Type', 'application/json').json(body); }
module.exports = async function customerOrders(req, res) {
  if (req.method !== 'GET') return reply(res, 405, { ok: false, error: 'method_not_allowed' });
  try {
    const context = requireRoles(await getContext(req), ['customer', 'store_admin', 'platform_admin']);
    if (context.error) return reply(res, context.status, { ok: false, error: context.error });
    const query = req.query || {};
    const limit = Math.min(Math.max(Number(query.limit) || 100, 1), 100);
    const offset = Math.max(Number(query.offset) || 0, 0);
    const params = new URLSearchParams({ select: '*,store_order_requests(*,stores(name),store_order_request_items(*),store_order_cart_restorations(*))', user_id: `eq.${context.user.id}`, order: 'created_at.desc', limit: String(limit), offset: String(offset) });
    if (query.year && /^\d{4}$/.test(String(query.year))) {
      params.set('created_at', `gte.${String(query.year)}-01-01`);
      params.set('and', `(created_at.lt.${Number(query.year)+1}-01-01)`);
    }
    if (query.q) params.set('tracking_number', `ilike.*${String(query.q).replace(/[(),]/g, '')}*`);
    const response = await fetch(`${context.supabaseUrl}/rest/v1/checkout_sessions?${params}`, { headers: { apikey: context.serviceRoleKey, Authorization: `Bearer ${context.serviceRoleKey}` } });
    const data = await response.json();
    if (!response.ok) return reply(res, 502, { ok: false, error: 'supabase_read_failed', details: data });
    reply(res, 200, { ok: true, user: context.profile, sessions: data, pagination: { limit, offset, hasMore: data.length === limit } });
  } catch (_) { reply(res, 502, { ok: false, error: 'customer_dashboard_failed' }); }
};
