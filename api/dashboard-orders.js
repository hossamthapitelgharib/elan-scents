const { getContext, requireRoles } = require('./_auth');
function reply(res, status, body) { res.status(status).setHeader('Content-Type', 'application/json').json(body); }
module.exports = async function dashboardOrders(req, res) {
  if (req.method !== 'GET') return reply(res, 405, { ok: false, error: 'method_not_allowed' });
  try {
    let context;
    if (process.env.DASHBOARD_TOKEN && req.headers['x-dashboard-token'] === process.env.DASHBOARD_TOKEN) {
      context = { supabaseUrl: process.env.SUPABASE_URL || process.env.NEXT_PUBLIC_SUPABASE_URL, serviceRoleKey: process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_SECRET_KEY, profile: { role: 'platform_admin' } };
    } else {
      context = requireRoles(await getContext(req), ['platform_admin']);
    }
    if (context.error) return reply(res, context.status, { ok: false, error: context.error });
    const query = req.query || {};
    const params = new URLSearchParams({ select: '*,stores(name),store_order_request_items(*),store_order_notifications(*),order_operation_events(*),order_reconciliation_checks(*)', order: 'created_at.desc', limit: String(Math.min(Math.max(Number(query.limit) || 100, 1), 200)) });
    if (query.status) params.set('status', `eq.${query.status}`);
    if (query.matchStatus) params.set('reconciliation_status', `eq.${query.matchStatus}`);
    if (query.storeId) params.set('store_id', `eq.${query.storeId}`);
    const response = await fetch(`${context.supabaseUrl}/rest/v1/store_order_requests?${params}`, { headers: { apikey: context.serviceRoleKey, Authorization: `Bearer ${context.serviceRoleKey}` } });
    const data = await response.json();
    if (!response.ok) return reply(res, 502, { ok: false, error: 'supabase_read_failed', details: data });
    reply(res, 200, { ok: true, orders: data });
  } catch (_) { reply(res, 502, { ok: false, error: 'dashboard_read_failed' }); }
};
