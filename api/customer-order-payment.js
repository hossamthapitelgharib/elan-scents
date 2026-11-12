'use strict';

const { authenticateCustomer, callCustomerRpc, errorKey } = require('../lib/customer-rpc');

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function reply(res, status, body) {
  res.setHeader('Cache-Control', 'no-store');
  return res.status(status).setHeader('Content-Type', 'application/json').json(body);
}

/* The page address the customer is sent to for an online payment. The merchant's own page learns which order and how much from the query
   string; none of it is a secret, and none of it proves anything: the result comes back only through the merchant's signed payment event. */
function paymentPageUrl(instructions) {
  if (!instructions || !instructions.redirectUrl) return null;
  try {
    const url = new URL(instructions.redirectUrl);
    if (url.protocol !== 'https:') return null;
    url.searchParams.set('elan_order', String(instructions.trackingNumber || ''));
    url.searchParams.set('amount', String(instructions.amount));
    url.searchParams.set('currency', 'EGP');
    return url.toString();
  } catch (_) { return null; }
}

/* POST /api/customer-order-payment { requestId, methodId, idempotencyKey } — the signed-in customer chooses how to pay an approved order.
   Cash on delivery is recorded at once (and the platform's first notice is written); a card choice only opens a payment attempt and
   answers with the merchant's payment page: the order is NOT paid until the signed payment event arrives. The amount, the currency and
   the methods on offer all come from the terms the platform froze at approval; nothing in the body but the choice is read. */
module.exports = async function customerOrderPayment(req, res) {
  if (req.method !== 'POST') return reply(res, 405, { ok: false, error: 'method_not_allowed' });
  const context = await authenticateCustomer(req);
  if (context.error) return reply(res, context.status, { ok: false, error: context.error });
  const body = req.body && typeof req.body === 'object' ? req.body : {};
  const requestId = String(body.requestId || '');
  const methodId = String(body.methodId || '');
  const idempotencyKey = String(body.idempotencyKey || '');
  if (!UUID.test(requestId)) return reply(res, 400, { ok: false, error: 'invalid_order' });
  if (!UUID.test(methodId)) return reply(res, 400, { ok: false, error: 'invalid_payment_method' });
  if (!/^[A-Za-z0-9_-]{8,64}$/.test(idempotencyKey)) return reply(res, 400, { ok: false, error: 'invalid_retry_key' });
  const result = await callCustomerRpc(context, 'select_order_payment_server', { p_request_id: requestId, p_user_id: context.user.id, p_method_id: methodId, p_idempotency_key: idempotencyKey });
  if (!result.ok) return reply(res, result.status >= 400 && result.status < 500 ? 400 : 502, { ok: false, error: errorKey(result) });
  const data = result.data || {};
  return reply(res, 200, {
    ok: true,
    trackingNumber: data.trackingNumber,
    kind: data.kind,
    mode: data.mode,
    provider: data.provider,
    status: data.status,
    paymentStatus: data.paymentStatus,
    amount: data.amount,
    currency: data.currency,
    paymentUrl: data.kind === 'cod' ? null : paymentPageUrl(data)
  });
};
