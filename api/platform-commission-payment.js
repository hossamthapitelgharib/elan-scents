const { getContext, requireRoles } = require('./_auth');
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
function reply(res, status, body) { res.setHeader('Cache-Control', 'no-store'); res.setHeader('Content-Type', 'application/json'); return res.status(status).json(body); }
module.exports = async function platformCommissionPayment(req, res) {
  if (req.method !== 'POST') return reply(res, 405, { ok: false, error: 'method_not_allowed' });
  try {
    const context = requireRoles(await getContext(req), ['platform_admin']);
    if (context.error) return reply(res, context.status, { ok: false, error: context.error });
    const body = req.body && typeof req.body === 'object' && !Array.isArray(req.body) ? req.body : {};
    const commissionId = String(body.commissionId || '');
    const paymentReference = typeof body.paymentReference === 'string' ? body.paymentReference.trim() : '';
    if (!UUID.test(commissionId)) return reply(res, 400, { ok: false, error: 'invalid_commission_id' });
    if (!paymentReference || paymentReference.length > 160) return reply(res, 400, { ok: false, error: 'payment_reference_required' });
    const actor = UUID.test(String(context.user && context.user.id || '')) ? context.user.id : null;
    const response = await fetch(`${context.supabaseUrl}/rest/v1/rpc/platform_mark_commission_paid`, {
      method: 'POST',
      headers: { apikey: context.serviceRoleKey, Authorization: `Bearer ${context.serviceRoleKey}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ p_commission_id: commissionId, p_payment_reference: paymentReference, p_actor: actor })
    });
    let result = null;
    try { result = await response.json(); } catch (_) { result = null; }
    if (!response.ok) {
      const message = result && typeof result.message === 'string' ? result.message : '';
      if (message === 'Commission not found') return reply(res, 404, { ok: false, error: 'commission_not_found' });
      if (message === 'Commission is not payable') return reply(res, 409, { ok: false, error: 'commission_not_payable' });
      if (message === 'Payment reference is required') return reply(res, 400, { ok: false, error: 'payment_reference_required' });
      return reply(res, 502, { ok: false, error: 'commission_payment_record_failed' });
    }
    return reply(res, 200, { ok: true, settlement: result });
  } catch (_) { return reply(res, 502, { ok: false, error: 'commission_payment_record_failed' }); }
};
