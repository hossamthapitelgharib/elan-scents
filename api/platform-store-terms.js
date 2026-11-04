const { getContext, requireRoles } = require('./_auth');
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
function reply(res, status, body) { res.setHeader('Cache-Control', 'no-store'); res.setHeader('Content-Type', 'application/json'); return res.status(status).json(body); }
module.exports = async function platformStoreTerms(req, res) {
  if (req.method !== 'PUT') return reply(res, 405, { ok: false, error: 'method_not_allowed' });
  try {
    const context = requireRoles(await getContext(req), ['platform_admin']);
    if (context.error) return reply(res, context.status, { ok: false, error: context.error });
    const body = req.body && typeof req.body === 'object' && !Array.isArray(req.body) ? req.body : {};
    const storeId = String(body.storeId || '');
    const days = Number(body.returnWindowDays);
    if (!UUID.test(storeId)) return reply(res, 400, { ok: false, error: 'invalid_store_id' });
    if (!Number.isInteger(days) || days < 1 || days > 365) return reply(res, 400, { ok: false, error: 'invalid_return_window' });
    if (body.commissionRate !== undefined && Number(body.commissionRate) !== 15) return reply(res, 400, { ok: false, error: 'commission_rate_fixed' });
    const actor = UUID.test(String(context.user && context.user.id || '')) ? context.user.id : null;
    const response = await fetch(`${context.supabaseUrl}/rest/v1/rpc/platform_set_store_commercial_terms`, {
      method: 'POST',
      headers: { apikey: context.serviceRoleKey, Authorization: `Bearer ${context.serviceRoleKey}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ p_store_id: storeId, p_return_window_days: days, p_actor: actor })
    });
    let result = null;
    try { result = await response.json(); } catch (_) { result = null; }
    if (!response.ok) {
      const message = result && typeof result.message === 'string' ? result.message : '';
      if (message === 'Store not found') return reply(res, 404, { ok: false, error: 'store_not_found' });
      if (message === 'Invalid return window') return reply(res, 400, { ok: false, error: 'invalid_return_window' });
      return reply(res, 502, { ok: false, error: 'store_terms_update_failed' });
    }
    return reply(res, 200, { ok: true, terms: result });
  } catch (_) { return reply(res, 502, { ok: false, error: 'store_terms_update_failed' }); }
};
