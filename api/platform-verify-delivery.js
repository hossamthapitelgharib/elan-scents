const { getContext, requireRoles } = require('./_auth');

function reply(res, status, body) {
  res.status(status).setHeader('Content-Type', 'application/json').setHeader('Cache-Control', 'no-store').json(body);
}

function isUuid(value) {
  return typeof value === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value);
}

module.exports = async function platformVerifyDelivery(req, res) {
  if (req.method !== 'POST') return reply(res, 405, { ok: false, error: 'method_not_allowed' });
  try {
    const context = requireRoles(await getContext(req), ['platform_admin']);
    if (context.error) return reply(res, context.status, { ok: false, error: context.error });
    const body = req.body && typeof req.body === 'object' ? req.body : {};
    const requestId = String(body.requestId || '').trim();
    const evidenceReference = String(body.evidenceReference || '').trim();
    const deliveredAtText = String(body.deliveredAt || '').trim();
    const deliveredAt = new Date(deliveredAtText);
    if (!isUuid(requestId) || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?(?:Z|[+-]\d{2}:\d{2})$/.test(deliveredAtText) || Number.isNaN(deliveredAt.getTime()) || deliveredAt.getTime() > Date.now() + 5 * 60 * 1000 || evidenceReference.length < 3 || evidenceReference.length > 200) {
      return reply(res, 400, { ok: false, error: 'invalid_delivery_evidence' });
    }
    const result = await fetch(`${context.supabaseUrl}/rest/v1/rpc/platform_verify_store_delivery`, {
      method: 'POST',
      headers: { apikey: context.serviceRoleKey, Authorization: `Bearer ${context.serviceRoleKey}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ p_request_id: requestId, p_delivered_at: deliveredAt.toISOString(), p_evidence_reference: evidenceReference, p_actor: context.user.id })
    });
    const data = await result.json().catch(() => ({}));
    if (!result.ok) {
      const message = String(data.message || data.details || '');
      if (/Shipment not found|Order not found/i.test(message)) return reply(res, 404, { ok: false, error: 'shipment_not_found' });
      if (/already verified/i.test(message)) return reply(res, 409, { ok: false, error: 'delivery_already_verified' });
      if (/Invalid delivered time|cannot be marked delivered/i.test(message)) return reply(res, 409, { ok: false, error: 'delivery_verification_conflict' });
      console.error('platform-verify-delivery: rpc failed', data.code, message.slice(0, 200));
      return reply(res, 502, { ok: false, error: 'delivery_verification_failed' });
    }
    return reply(res, 200, { ok: true, delivery: data });
  } catch (_) {
    return reply(res, 502, { ok: false, error: 'delivery_verification_failed' });
  }
};
