const { getContext, requireRoles } = require('./_auth');

function reply(res, status, body) {
  res.setHeader('Cache-Control', 'no-store');
  res.status(status).setHeader('Content-Type', 'application/json').json(body);
}

module.exports = async function guestAnalytics(req, res) {
  if (req.method !== 'GET') return reply(res, 405, { ok: false, error: 'method_not_allowed' });
  try {
    const context = requireRoles(await getContext(req), ['platform_admin']);
    if (context.error) return reply(res, context.status, { ok: false, error: context.error });
    const period = String((req.query && req.query.period) || 'today');
    const actor = String((req.query && req.query.actor) || 'guest');
    if (!['today', 'week', 'month', 'year'].includes(period)) {
      return reply(res, 400, { ok: false, error: 'invalid_period' });
    }
    if (!['guest', 'customer', 'all'].includes(actor)) return reply(res, 400, { ok: false, error: 'invalid_actor' });
    const headers = {
      apikey: context.serviceRoleKey,
      Authorization: `Bearer ${context.serviceRoleKey}`,
      'Content-Type': 'application/json'
    };
    const response = await fetch(`${context.supabaseUrl}/rest/v1/rpc/customer_activity_summary`, {
      method: 'POST', headers, body: JSON.stringify({ p_actor_type: actor, p_period: period })
    });
    if (!response.ok) return reply(res, 502, { ok: false, error: 'guest_analytics_unavailable' });
    const analytics = await response.json();
    return reply(res, 200, { ok: true, analytics });
  } catch (_) {
    return reply(res, 502, { ok: false, error: 'guest_analytics_unavailable' });
  }
};
