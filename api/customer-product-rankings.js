const { getContext, requireRoles } = require('./_auth');
const PERIODS = new Set(['today', 'week', 'month', 'year']);
const ACTORS = new Set(['guest', 'customer', 'all']);
const EVENTS = new Set(['view', 'search', 'cart_add', 'cart_remove']);
function reply(res, status, body) {
  res.setHeader('Cache-Control', 'no-store');
  return res.status(status).setHeader('Content-Type', 'application/json').json(body);
}
function queryValue(query, key, fallback) {
  const value = query && query[key];
  return value === undefined || value === null || value === '' ? fallback : String(Array.isArray(value) ? value[0] : value);
}
function pageNumber(value, fallback, minimum, maximum) {
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed >= minimum && parsed <= maximum ? parsed : fallback;
}
module.exports = async function customerProductRankings(req, res) {
  if (req.method !== 'GET') return reply(res, 405, { ok: false, error: 'method_not_allowed' });
  try {
    const context = requireRoles(await getContext(req), ['platform_admin']);
    if (context.error) return reply(res, context.status, { ok: false, error: context.error });
    const query = req.query || {};
    const actor = queryValue(query, 'actor', 'guest');
    const period = queryValue(query, 'period', 'today');
    const eventType = queryValue(query, 'eventType', 'view');
    const rawLimit = queryValue(query, 'limit', '20');
    const rawOffset = queryValue(query, 'offset', '0');
    const limit = pageNumber(rawLimit, null, 1, 100);
    const offset = pageNumber(rawOffset, null, 0, 100000);
    if (!ACTORS.has(actor)) return reply(res, 400, { ok: false, error: 'invalid_actor' });
    if (!PERIODS.has(period)) return reply(res, 400, { ok: false, error: 'invalid_period' });
    if (!EVENTS.has(eventType)) return reply(res, 400, { ok: false, error: 'invalid_event_type' });
    if (limit === null || offset === null) return reply(res, 400, { ok: false, error: 'invalid_page' });

    const response = await fetch(`${context.supabaseUrl}/rest/v1/rpc/customer_product_ranking`, {
      method: 'POST',
      headers: { apikey: context.serviceRoleKey, Authorization: `Bearer ${context.serviceRoleKey}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ p_actor_type: actor, p_period: period, p_event_type: eventType, p_limit: limit, p_offset: offset })
    });
    if (!response.ok) return reply(res, 502, { ok: false, error: 'product_ranking_unavailable' });
    const result = await response.json();
    if (!result || !Array.isArray(result.records)) return reply(res, 502, { ok: false, error: 'product_ranking_unavailable' });
    return reply(res, 200, {
      ok: true, actorType: actor, period, eventType,
      limit, offset,
      total: Math.max(0, Number(result.total) || 0),
      hasMore: result.hasMore === true,
      records: result.records.map(row => ({ product: row && row.product || null, operations: Math.max(0, Number(row && row.operations) || 0), people: Math.max(0, Number(row && row.people) || 0) }))
    });
  } catch (_) {
    return reply(res, 502, { ok: false, error: 'product_ranking_unavailable' });
  }
};
