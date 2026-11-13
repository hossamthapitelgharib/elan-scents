'use strict';

const { authenticateCustomer, callCustomerRpc, errorKey } = require('../lib/customer-rpc');

function reply(res, status, body) {
  res.setHeader('Cache-Control', 'no-store');
  return res.status(status).setHeader('Content-Type', 'application/json').json(body);
}

function cartResult(data) {
  if (!data || typeof data !== 'object' || !Array.isArray(data.items) || !Number.isSafeInteger(Number(data.revision)) || Number(data.revision) < 0) return null;
  return { items: data.items, revision: Number(data.revision) };
}

module.exports = async function customerCart(req, res) {
  if (req.method !== 'GET' && req.method !== 'POST') return reply(res, 405, { ok: false, error: 'method_not_allowed' });
  const context = await authenticateCustomer(req);
  if (context.error) return reply(res, context.status, { ok: false, error: context.error });

  if (req.method === 'GET') {
    const result = await callCustomerRpc(context, 'read_customer_cart_server', { p_user_id: context.user.id });
    const cart = result.ok && cartResult(result.data);
    if (!cart) return reply(res, 502, { ok: false, error: result.ok ? 'customer_cart_read_failed' : errorKey(result) });
    return reply(res, 200, { ok: true, ...cart });
  }

  const body = req.body || {};
  if (!Array.isArray(body.items)) return reply(res, 400, { ok: false, error: 'invalid_cart' });
  if (!Number.isSafeInteger(body.expectedRevision) || body.expectedRevision < 0) return reply(res, 400, { ok: false, error: 'invalid_cart_revision' });
  const result = await callCustomerRpc(context, 'replace_customer_cart_server_cas', {
    p_items: body.items,
    p_expected_revision: body.expectedRevision,
    p_user_id: context.user.id
  });
  if (!result.ok) return reply(res, result.status >= 400 && result.status < 500 ? 400 : 502, { ok: false, error: errorKey(result) });
  const cart = cartResult(result.data);
  if (!cart || typeof result.data.ok !== 'boolean') return reply(res, 502, { ok: false, error: 'customer_cart_write_failed' });
  if (result.data.conflict === true || result.data.ok === false) return reply(res, 409, { ok: false, error: 'cart_conflict', ...cart });
  return reply(res, 200, { ok: true, ...cart });
};
