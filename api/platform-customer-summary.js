const { getContext, requireRoles } = require('./_auth');

function reply(res, status, body) {
  res.setHeader('Cache-Control', 'no-store');
  res.status(status).setHeader('Content-Type', 'application/json').json(body);
}
function totalFrom(response) {
  const value = response.headers.get('content-range') || '';
  const match = value.match(/\/(\d+)$/);
  return match ? Number(match[1]) : null;
}

module.exports = async function platformCustomerSummary(req, res) {
  if (req.method !== 'GET') return reply(res, 405, { ok: false, error: 'method_not_allowed' });
  try {
    const context = requireRoles(await getContext(req), ['platform_admin']);
    if (context.error) return reply(res, context.status, { ok: false, error: context.error });
    const headers = { apikey: context.serviceRoleKey, Authorization: `Bearer ${context.serviceRoleKey}`, Prefer: 'count=exact', Range: '0-0' };
    const base = `${context.supabaseUrl}/rest/v1/`;
    const profiles = new URLSearchParams({ select: 'id', role: 'eq.customer', limit: '1' });
    const visitors = new URLSearchParams({ select: 'id', status: 'eq.guest', identity_version: 'eq.2', limit: '1' });
    const [profileResponse, visitorResponse] = await Promise.all([
      fetch(`${base}profiles?${profiles}`, { headers }),
      fetch(`${base}guest_visitors?${visitors}`, { headers })
    ]);
    if (!profileResponse.ok || !visitorResponse.ok) return reply(res, 502, { ok: false, error: 'customer_summary_unavailable' });
    const registered = totalFrom(profileResponse), visitorsCount = totalFrom(visitorResponse);
    if (registered === null || visitorsCount === null) return reply(res, 502, { ok: false, error: 'customer_summary_unavailable' });
    return reply(res, 200, { ok: true, counts: { registered, visitors: visitorsCount } });
  } catch (_) {
    return reply(res, 502, { ok: false, error: 'customer_summary_unavailable' });
  }
};
