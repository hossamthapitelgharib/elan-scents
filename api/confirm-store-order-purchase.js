'use strict';

const { authenticateCustomer } = require('../lib/customer-rpc');

function reply(res, status, body) {
  res.setHeader('Cache-Control', 'no-store');
  return res.status(status).setHeader('Content-Type', 'application/json').json(body);
}

// Retired in phase 1 (docs/implementation-phase-1-purchase-core.ar.md): the customer no longer confirms a purchase, and nothing in the
// sale or commission cycle reads such a confirmation. The route stays registered so an old page gets a clear answer instead of a 404;
// it never reaches the database.
module.exports = async function confirmStoreOrderPurchase(req, res) {
  if (req.method !== 'POST') return reply(res, 405, { ok: false, error: 'method_not_allowed' });
  const context = await authenticateCustomer(req);
  if (context.error) return reply(res, context.status, { ok: false, error: context.error });
  return reply(res, 410, { ok: false, error: 'deprecated_customer_confirmation' });
};
