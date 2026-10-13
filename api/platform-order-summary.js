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

module.exports = async function platformOrderSummary(req, res) {
  if (req.method !== 'GET') return reply(res, 405, { ok: false, error: 'method_not_allowed' });
  try {
    const context = requireRoles(await getContext(req), ['platform_admin']);
    if (context.error) return reply(res, context.status, { ok: false, error: context.error });
    const headers = {
      apikey: context.serviceRoleKey,
      Authorization: `Bearer ${context.serviceRoleKey}`,
      Prefer: 'count=exact',
      Range: '0-0'
    };
    const base = `${context.supabaseUrl}/rest/v1/store_order_requests?`;
    const queries = [
      ['orders', {}],
      ['completed', { status: 'in.(completed,delivered)' }],
      ['open', { status: 'in.(awaiting_store_confirmation,store_confirmed,processing,shipped)' }],
      ['needsReview', { or: '(status.eq.needs_review,reconciliation_status.eq.mismatched)' }]
    ];
    const counts = await Promise.all(queries.map(async ([key, filters]) => {
      const params = new URLSearchParams({ select: 'id', limit: '1', ...filters });
      const response = await fetch(`${base}${params}`, { method: 'HEAD', headers });
      if (!response.ok) return [key, null];
      return [key, totalFrom(response)];
    }));
    if (counts.some(([, value]) => value === null)) return reply(res, 502, { ok: false, error: 'order_summary_unavailable' });
    return reply(res, 200, { ok: true, counts: Object.fromEntries(counts) });
  } catch (_) {
    return reply(res, 502, { ok: false, error: 'order_summary_unavailable' });
  }
};
