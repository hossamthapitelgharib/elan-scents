const { getContext, requireRoles } = require('./_auth');
function reply(res, status, body) { res.status(status).setHeader('Content-Type', 'application/json').json(body); }
module.exports = async function storeDashboardOrders(req, res) {
  if (req.method !== 'GET') return reply(res, 405, { ok: false, error: 'method_not_allowed' });
  try {
    const context = requireRoles(await getContext(req), ['store_admin', 'platform_admin']);
    if (context.error) return reply(res, context.status, { ok: false, error: context.error });
    let storeIds = [];
    if (context.profile.role === 'platform_admin') {
      const requested = req.query && req.query.storeId;
      storeIds = requested ? [requested] : [];
    } else {
      const accounts = await fetch(`${context.supabaseUrl}/rest/v1/store_accounts?select=store_id&user_id=eq.${context.user.id}&limit=20`, { headers: { apikey: context.serviceRoleKey, Authorization: `Bearer ${context.serviceRoleKey}` } }).then((r) => r.json());
      storeIds = (accounts || []).map((row) => row.store_id);
    }
    if (!storeIds.length) return reply(res, 200, { ok: true, stores: [], orders: [] });
    const params = new URLSearchParams({ select: '*,stores(name),store_order_request_items(*),store_order_notifications(*)', order: 'created_at.desc', limit: '100' });
    params.set('store_id', `in.(${storeIds.join(',')})`);
    if (req.query && req.query.status) params.set('status', `eq.${req.query.status}`);
    const response = await fetch(`${context.supabaseUrl}/rest/v1/store_order_requests?${params}`, { headers: { apikey: context.serviceRoleKey, Authorization: `Bearer ${context.serviceRoleKey}` } });
    const orders = await response.json();
    if (!response.ok) return reply(res, 502, { ok: false, error: 'supabase_read_failed', details: orders });
    reply(res, 200, { ok: true, stores: storeIds, orders });
  } catch (_) { reply(res, 502, { ok: false, error: 'store_dashboard_failed' }); }
};
