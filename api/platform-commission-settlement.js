const { getContext, requireRoles } = require('./_auth');
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
function reply(res, status, body) { res.setHeader('Cache-Control', 'no-store'); res.setHeader('Content-Type', 'application/json'); return res.status(status).json(body); }
const ACTIONS = {
  request: { rpc: 'platform_request_commission_settlement', id: 'commissionId', params: (body, actor) => ({ p_commission_id: body.commissionId, p_actor: actor }) },
  submit: { rpc: 'platform_submit_commission_settlement', id: 'settlementId', params: (body, actor) => ({ p_settlement_id: body.settlementId, p_payment_reference: body.paymentReference, p_evidence_reference: body.evidenceReference || null, p_actor: actor }) },
  verify: { rpc: 'platform_verify_commission_settlement', id: 'settlementId', params: (body, actor) => ({ p_settlement_id: body.settlementId, p_actor: actor }) },
  paid: { rpc: 'platform_mark_commission_settlement_paid', id: 'settlementId', params: (body, actor) => ({ p_settlement_id: body.settlementId, p_payment_reference: body.paymentReference || null, p_actor: actor }) }
};
module.exports = async function platformCommissionSettlement(req, res) {
  if (req.method !== 'POST') return reply(res, 405, { ok: false, error: 'method_not_allowed' });
  try {
    const context = requireRoles(await getContext(req), ['platform_admin']);
    if (context.error) return reply(res, context.status, { ok: false, error: context.error });
    const body = req.body && typeof req.body === 'object' && !Array.isArray(req.body) ? req.body : {};
    const action = String(body.action || '');
    const spec = ACTIONS[action];
    if (!spec) return reply(res, 400, { ok: false, error: 'invalid_settlement_action' });
    const id = String(body[spec.id] || '');
    if (!UUID.test(id)) return reply(res, 400, { ok: false, error: `invalid_${spec.id}` });
    if ((action === 'submit' || action === 'paid') && body.paymentReference !== undefined && (typeof body.paymentReference !== 'string' || body.paymentReference.trim().length > 160)) {
      return reply(res, 400, { ok: false, error: 'invalid_payment_reference' });
    }
    if (action === 'submit' && body.evidenceReference !== undefined && (typeof body.evidenceReference !== 'string' || body.evidenceReference.trim().length > 200)) {
      return reply(res, 400, { ok: false, error: 'invalid_evidence_reference' });
    }
    if (action === 'submit' && !String(body.paymentReference || '').trim()) return reply(res, 400, { ok: false, error: 'payment_reference_required' });
    if (action === 'submit' && !String(body.evidenceReference || '').trim()) return reply(res, 400, { ok: false, error: 'evidence_reference_required' });
    const actor = UUID.test(String(context.user && context.user.id || '')) ? context.user.id : null;
    const response = await fetch(`${context.supabaseUrl}/rest/v1/rpc/${spec.rpc}`, {
      method: 'POST',
      headers: { apikey: context.serviceRoleKey, Authorization: `Bearer ${context.serviceRoleKey}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(spec.params({ ...body, [spec.id]: id }, actor))
    });
    let result = null; try { result = await response.json(); } catch (_) { result = null; }
    if (!response.ok) {
      const message = result && typeof result.message === 'string' ? result.message : '';
      if (/not found/i.test(message)) return reply(res, 404, { ok: false, error: 'settlement_or_commission_not_found' });
      if (/not payable|not awaiting|not submitted|not verified|evidence is required/i.test(message)) return reply(res, 409, { ok: false, error: 'settlement_state_conflict' });
      if (/reference is required/i.test(message)) return reply(res, 400, { ok: false, error: 'payment_reference_required' });
      return reply(res, 502, { ok: false, error: 'commission_settlement_failed' });
    }
    return reply(res, 200, { ok: true, settlement: result });
  } catch (_) { return reply(res, 502, { ok: false, error: 'commission_settlement_failed' }); }
};
