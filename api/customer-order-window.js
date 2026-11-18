'use strict';

const { authenticateCustomer, callCustomerRpc, errorKey } = require('../lib/customer-rpc');
const { createLimiter, setRateLimitHeaders } = require('../lib/rate-limit');

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const limiter = createLimiter({ max: 60, windowMs: 60 * 1000 });

function reply(res, status, body) {
  res.setHeader('Cache-Control', 'no-store');
  return res.status(status).setHeader('Content-Type', 'application/json').json(body);
}

/* POST /api/customer-order-window  { orderId, action: 'open' | 'return' | 'state', outcome?: 'success' | 'cancel' | 'closed' }
   The merchant's payment window, from the customer's side (step 6 of docs/purchase-flow-final.ar.md).
     open    gives the window's address once, to the customer that owns an approved, unpaid order whose window has not ended
     return  says how the customer left the window: success (their browser's claim, which proves nothing), cancel, or closed (the window
             was shut). Cancel and closed cancel the order at once, for good; expiry does the same on the clock
     state   where the order stands (no address)
   Payment itself is never decided here: only a neutral confirmation makes an order paid (stage 2). */
module.exports = async function customerOrderWindow(req, res) {
  if (req.method !== 'POST') return reply(res, 405, { ok: false, error: 'method_not_allowed' });
  const context = await authenticateCustomer(req);
  if (context.error) return reply(res, context.status, { ok: false, error: context.error });
  const limit = limiter(context.user.id);
  if (!limit.allowed) { setRateLimitHeaders(res, limit, 60); return reply(res, 429, { ok: false, error: 'rate_limited' }); }
  const body = req.body || {};
  const orderId = String(body.orderId || '');
  if (!UUID.test(orderId)) return reply(res, 400, { ok: false, error: 'order_not_found' });
  const action = String(body.action || '');
  let name;
  let args;
  if (action === 'open') { name = 'open_payment_window'; args = { p_request_id: orderId, p_user_id: context.user.id }; }
  else if (action === 'return') {
    const outcome = String(body.outcome || '');
    if (!['success', 'cancel', 'closed'].includes(outcome)) return reply(res, 400, { ok: false, error: 'invalid_outcome' });
    name = 'payment_window_return'; args = { p_request_id: orderId, p_user_id: context.user.id, p_outcome: outcome };
  } else if (action === 'state') { name = 'customer_order_state'; args = { p_request_id: orderId, p_user_id: context.user.id }; }
  else return reply(res, 400, { ok: false, error: 'invalid_action' });
  const result = await callCustomerRpc(context, name, args);
  if (!result.ok) return reply(res, result.status >= 400 && result.status < 500 ? (/Order not found/i.test(result.message || '') ? 404 : 409) : 502, { ok: false, error: errorKey(result) });
  return reply(res, 200, { ok: true, ...(result.data || {}) });
};
