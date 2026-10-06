function reply(res, status, body) {
  res.status(status).setHeader('Content-Type', 'application/json').json(body);
}

module.exports = async function dashboardOrders(req, res) {
  if (req.method !== 'GET') {
    reply(res, 405, { ok: false, error: 'method_not_allowed' });
    return;
  }

  const dashboardToken = process.env.DASHBOARD_TOKEN;
  if (!dashboardToken) {
    reply(res, 503, { ok: false, error: 'dashboard_token_not_configured' });
    return;
  }
  if (req.headers['x-dashboard-token'] !== dashboardToken) {
    reply(res, 401, { ok: false, error: 'unauthorized' });
    return;
  }

  const supabaseUrl = process.env.SUPABASE_URL || process.env.NEXT_PUBLIC_SUPABASE_URL;
  const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_SECRET_KEY;
  if (!supabaseUrl || !serviceRoleKey) {
    reply(res, 503, { ok: false, error: 'supabase_service_configuration_missing' });
    return;
  }

  const query = req.query || {};
  const params = new URLSearchParams({
    select: '*,stores(name),store_order_request_items(*),store_order_notifications(*)',
    order: 'created_at.desc',
    limit: String(Math.min(Math.max(Number(query.limit) || 100, 1), 200)),
  });
  if (query.status) params.set('status', `eq.${query.status}`);
  if (query.matchStatus) params.set('reconciliation_status', `eq.${query.matchStatus}`);
  if (query.storeId) params.set('store_id', `eq.${query.storeId}`);

  try {
    const response = await fetch(`${supabaseUrl}/rest/v1/store_order_requests?${params.toString()}`, {
      headers: { apikey: serviceRoleKey, Authorization: `Bearer ${serviceRoleKey}` },
    });
    const raw = await response.text();
    let data;
    try { data = raw ? JSON.parse(raw) : []; } catch (_) { data = { raw }; }
    if (!response.ok) {
      reply(res, 502, { ok: false, error: 'supabase_read_failed', details: data });
      return;
    }
    reply(res, 200, { ok: true, orders: data });
  } catch (_) {
    reply(res, 502, { ok: false, error: 'dashboard_read_failed' });
  }
};
