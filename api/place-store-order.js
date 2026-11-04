'use strict';

const { authenticateCustomer, callCustomerRpc, errorKey } = require('../lib/customer-rpc');

function reply(res, status, body) {
  res.setHeader('Cache-Control', 'no-store');
  return res.status(status).setHeader('Content-Type', 'application/json').json(body);
}

module.exports = async function placeStoreOrder(req, res) {
  if (req.method !== 'POST') return reply(res, 405, { ok: false, error: 'method_not_allowed' });
  const context = await authenticateCustomer(req);
  if (context.error) return reply(res, context.status, { ok: false, error: context.error });
  const payload = req.body && req.body.payload;
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) return reply(res, 400, { ok: false, error: 'invalid_order_payload' });
  const result = await callCustomerRpc(context, 'place_store_order_server', { p_payload: payload, p_user_id: context.user.id });
  if (!result.ok) return reply(res, result.status >= 400 && result.status < 500 ? 400 : 502, { ok: false, error: errorKey(result) });
  return reply(res, 200, result.data);
};
