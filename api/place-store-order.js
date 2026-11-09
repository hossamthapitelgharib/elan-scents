'use strict';

const { authenticateCustomer, callCustomerRpc, errorKey } = require('../lib/customer-rpc');

function reply(res, status, body) {
  res.setHeader('Cache-Control', 'no-store');
  return res.status(status).setHeader('Content-Type', 'application/json').json(body);
}

// Phase 1 (docs/implementation-phase-1-purchase-core.ar.md): the browser says only WHICH store and WHICH attempt, and what total
// it showed the customer. The customer data, the lines, the prices, the currency and the tracking number are rebuilt by the database
// from the signed-in account and the saved cart, so nothing else in the body is forwarded.
module.exports = async function placeStoreOrder(req, res) {
  if (req.method !== 'POST') return reply(res, 405, { ok: false, error: 'method_not_allowed' });
  const context = await authenticateCustomer(req);
  if (context.error) return reply(res, context.status, { ok: false, error: context.error });
  const payload = req.body && req.body.payload;
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) return reply(res, 400, { ok: false, error: 'invalid_order_payload' });
  const storeId = String(payload.storeId || '');
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(storeId)) return reply(res, 400, { ok: false, error: 'invalid_store' });
  const idempotencyKey = String(payload.idempotencyKey || '');
  if (idempotencyKey.length < 8 || idempotencyKey.length > 64) return reply(res, 400, { ok: false, error: 'invalid_retry_key' });
  const expectedSubtotal = typeof payload.expectedSubtotal === 'number' ? payload.expectedSubtotal : Number.NaN;
  if (!Number.isFinite(expectedSubtotal) || expectedSubtotal <= 0 || expectedSubtotal > 100000000) return reply(res, 400, { ok: false, error: 'expected_subtotal_required' });
  const safePayload = { storeId, idempotencyKey, expectedSubtotal };
  const result = await callCustomerRpc(context, 'place_store_order_server', { p_payload: safePayload, p_user_id: context.user.id });
  if (!result.ok) return reply(res, result.status >= 400 && result.status < 500 ? 400 : 502, { ok: false, error: errorKey(result) });
  return reply(res, 200, result.data);
};
