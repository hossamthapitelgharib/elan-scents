'use strict';

const { authenticateCustomer, callCustomerRpc, errorKey } = require('../lib/customer-rpc');

function reply(res, status, body) {
  res.setHeader('Cache-Control', 'no-store');
  return res.status(status).setHeader('Content-Type', 'application/json').json(body);
}

module.exports = async function customerCart(req, res) {
  if (req.method !== 'POST') return reply(res, 405, { ok: false, error: 'method_not_allowed' });
  const context = await authenticateCustomer(req);
  if (context.error) return reply(res, context.status, { ok: false, error: context.error });
  const items = req.body && req.body.items;
  if (!Array.isArray(items)) return reply(res, 400, { ok: false, error: 'invalid_cart' });
  const result = await callCustomerRpc(context, 'replace_customer_cart_server', { p_items: items, p_user_id: context.user.id });
  if (!result.ok) return reply(res, result.status >= 400 && result.status < 500 ? 400 : 502, { ok: false, error: errorKey(result) });
  return reply(res, 200, { ok: true, items: Array.isArray(result.data) ? result.data : [] });
};
