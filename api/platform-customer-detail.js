const { getContext, requireRoles } = require('./_auth');
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function reply(res, status, body) {
  res.setHeader('Cache-Control', 'no-store');
  return res.status(status).setHeader('Content-Type', 'application/json').json(body);
}
function queryValue(value) { return Array.isArray(value) ? String(value[0] || '') : String(value || ''); }

module.exports = async function platformCustomerDetail(req, res) {
  if (req.method !== 'GET') return reply(res, 405, { ok: false, error: 'method_not_allowed' });
  try {
    const context = requireRoles(await getContext(req), ['platform_admin']);
    if (context.error) return reply(res, context.status, { ok: false, error: context.error });
    const type = queryValue(req.query && req.query.type);
    const id = queryValue(req.query && req.query.id);
    const limit = Number(queryValue(req.query && req.query.limit) || 100);
    const offset = Number(queryValue(req.query && req.query.offset) || 0);
    if (!['guest', 'customer'].includes(type) || !UUID.test(id)) return reply(res, 400, { ok: false, error: 'invalid_customer' });
    if (!Number.isInteger(limit) || limit < 1 || limit > 100 || !Number.isInteger(offset) || offset < 0 || offset > 100000) {
      return reply(res, 400, { ok: false, error: 'invalid_page' });
    }
    const response = await fetch(`${context.supabaseUrl}/rest/v1/rpc/platform_customer_activity_detail`, {
      method: 'POST',
      headers: {
        apikey: context.serviceRoleKey,
        Authorization: `Bearer ${context.serviceRoleKey}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        p_guest_id: type === 'guest' ? id : null,
        p_user_id: type === 'customer' ? id : null,
        p_limit: limit,
        p_offset: offset
      })
    });
    if (!response.ok) return reply(res, 502, { ok: false, error: 'customer_activity_unavailable' });
    const detail = await response.json();
    if (!detail || detail.found !== true) return reply(res, 404, { ok: false, error: 'customer_not_found' });
    return reply(res, 200, { ok: true, detail });
  } catch (_) {
    return reply(res, 502, { ok: false, error: 'customer_activity_unavailable' });
  }
};
