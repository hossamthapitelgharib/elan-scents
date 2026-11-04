'use strict';

const { authenticateCustomer, callCustomerRpc, errorKey } = require('../lib/customer-rpc');

function reply(res, status, body) {
  res.setHeader('Cache-Control', 'no-store');
  return res.status(status).setHeader('Content-Type', 'application/json').json(body);
}

module.exports = async function confirmStoreOrderPurchase(req, res) {
  if (req.method !== 'POST') return reply(res, 405, { ok: false, error: 'method_not_allowed' });
  const context = await authenticateCustomer(req);
  if (context.error) return reply(res, context.status, { ok: false, error: context.error });
  const requestId = String(req.body && req.body.requestId || '');
  if (!/^[0-9a-f-]{36}$/i.test(requestId)) return reply(res, 400, { ok: false, error: 'invalid_request_id' });
  const result = await callCustomerRpc(context, 'confirm_store_order_purchase_server', { p_request_id: requestId, p_user_id: context.user.id });
  if (!result.ok) return reply(res, result.status >= 400 && result.status < 500 ? 400 : 502, { ok: false, error: errorKey(result) });
  return reply(res, 200, result.data);
};
