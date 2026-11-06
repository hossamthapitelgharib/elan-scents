const { getContext, requireRoles } = require('./_auth');
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
function reply(res, status, body) { res.setHeader('Cache-Control', 'no-store'); res.setHeader('Content-Type', 'application/json'); return res.status(status).json(body); }
const READ_FIELDS = 'id,commission_id,store_id,amount,currency,status,requested_at,submitted_at,verified_at,paid_at,payment_reference,evidence_reference,created_at,updated_at,stores(name)';
const COMMISSION_FIELDS = 'id,store_id,amount,status,created_at,updated_at,stores(name)';
const ACTIONS = {
  request: { rpc: 'platform_request_commission_settlement', id: 'commissionId', params: (body, actor) => ({ p_commission_id: body.commissionId, p_actor: actor }) },
  submit: { rpc: 'platform_submit_commission_settlement', id: 'settlementId', params: (body, actor) => ({ p_settlement_id: body.settlementId, p_payment_reference: body.paymentReference, p_evidence_reference: body.evidenceReference || null, p_actor: actor }) },
  verify: { rpc: 'platform_verify_commission_settlement', id: 'settlementId', params: (body, actor) => ({ p_settlement_id: body.settlementId, p_actor: actor }) },
  paid: { rpc: 'platform_mark_commission_settlement_paid', id: 'settlementId', params: (body, actor) => ({ p_settlement_id: body.settlementId, p_payment_reference: body.paymentReference || null, p_actor: actor }) }
};
module.exports = async function platformCommissionSettlement(req, res) {
  if (!['GET', 'POST'].includes(req.method)) return reply(res, 405, { ok: false, error: 'method_not_allowed' });
  try {
    const context = requireRoles(await getContext(req), ['platform_admin']);
    if (context.error) return reply(res, context.status, { ok: false, error: context.error });
    if (req.method === 'GET') {
      const query = new URL(req.url || '/api/platform-commission-settlement', 'http://localhost').searchParams;
      const limit = Math.min(100, Math.max(1, Number.parseInt(query.get('limit') || '100', 10) || 100));
      const offset = Math.max(0, Number.parseInt(query.get('offset') || '0', 10) || 0);
      const requestedStatus = query.get('status');
      const allowedStatuses = new Set(['payable', 'payment_requested', 'payment_submitted', 'payment_verified', 'paid', 'rejected', 'cancelled']);
      if (requestedStatus && !allowedStatuses.has(requestedStatus)) return reply(res, 400, { ok: false, error: 'invalid_settlement_status' });
      const headers = { apikey: context.serviceRoleKey, Authorization: `Bearer ${context.serviceRoleKey}` };
      const base = `${context.supabaseUrl}/rest/v1/`;
      const settlementQuery = new URLSearchParams({ select: READ_FIELDS, order: 'updated_at.desc', limit: String(limit), offset: String(offset) });
      const commissionQuery = new URLSearchParams({ select: COMMISSION_FIELDS, status: 'eq.payable', order: 'updated_at.desc', limit: String(limit), offset: String(offset) });
      if (requestedStatus && requestedStatus !== 'payable') settlementQuery.set('status', `eq.${requestedStatus}`);
      const [settlementResponse, commissionResponse] = await Promise.all([
        requestedStatus === 'payable' ? Promise.resolve(new Response('[]', { status: 200 })) : fetch(`${base}commission_settlements?${settlementQuery}`, { headers }),
        !requestedStatus || requestedStatus === 'payable' ? fetch(`${base}commissions?${commissionQuery}`, { headers }) : Promise.resolve(new Response('[]', { status: 200 }))
      ]);
      const [settlements, payable] = await Promise.all([settlementResponse.json(), commissionResponse.json()]);
      if (!settlementResponse.ok || !commissionResponse.ok || !Array.isArray(settlements) || !Array.isArray(payable)) return reply(res, 502, { ok: false, error: 'settlement_data_unavailable' });
      const settlementCommissionIds = new Set(settlements.map(settlement => settlement.commission_id));
      const records = [
        ...payable.filter(commission => !settlementCommissionIds.has(commission.id)).map(commission => ({ id: null, commissionId: commission.id, storeId: commission.store_id, amount: commission.amount, currency: commission.currency || 'EGP', status: 'payable', createdAt: commission.created_at, updatedAt: commission.updated_at, storeName: commission.stores && commission.stores.name })),
        ...settlements.map(settlement => ({ ...settlement, commissionId: settlement.commission_id, storeId: settlement.store_id, requestedAt: settlement.requested_at, submittedAt: settlement.submitted_at, verifiedAt: settlement.verified_at, paidAt: settlement.paid_at, paymentReference: settlement.payment_reference, evidenceReference: settlement.evidence_reference, createdAt: settlement.created_at, updatedAt: settlement.updated_at, storeName: settlement.stores && settlement.stores.name }))
      ];
      records.sort((a, b) => new Date(b.updatedAt || b.createdAt || 0) - new Date(a.updatedAt || a.createdAt || 0));
      return reply(res, 200, { ok: true, settlements: records, limit, offset, hasMore: settlements.length === limit || payable.length === limit });
    }
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
