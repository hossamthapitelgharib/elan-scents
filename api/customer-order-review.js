'use strict';

const { authenticateCustomer, callCustomerRpc, errorKey } = require('../lib/customer-rpc');
const { runDeliveries } = require('../lib/merchant-dispatcher');
const { createLimiter, setRateLimitHeaders } = require('../lib/rate-limit');

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const limiter = createLimiter({ max: 120, windowMs: 60 * 1000 });

function reply(res, status, body) {
  res.setHeader('Cache-Control', 'no-store');
  return res.status(status).setHeader('Content-Type', 'application/json').json(body);
}

/* POST /api/customer-order-review  { orderId }  — what the order page (and «طلباتي») asks every few seconds while the order is being sent
   to the store and until the store's decision arrives. It answers where the order stands (never the payment window's address) and, if
   the order is still waiting for the store and its next attempt is due, makes that attempt first (about ten seconds after the previous
   one; the database decides when one is due, so asking more often changes nothing). Only the order's own customer can ask. */
module.exports = async function customerOrderReview(req, res) {
  if (req.method !== 'POST') return reply(res, 405, { ok: false, error: 'method_not_allowed' });
  const context = await authenticateCustomer(req);
  if (context.error) return reply(res, context.status, { ok: false, error: context.error });
  const limit = limiter(context.user.id);
  if (!limit.allowed) { setRateLimitHeaders(res, limit, 120); return reply(res, 429, { ok: false, error: 'rate_limited' }); }
  const orderId = String(req.body && req.body.orderId || '');
  if (!UUID.test(orderId)) return reply(res, 400, { ok: false, error: 'order_not_found' });
  const ask = () => callCustomerRpc(context, 'customer_order_state', { p_request_id: orderId, p_user_id: context.user.id });
  let state = await ask();
  if (!state.ok) return reply(res, state.status >= 400 && state.status < 500 ? 404 : 502, { ok: false, error: errorKey(state) });
  const waiting = state.data && state.data.status === 'awaiting_store_confirmation' && state.data.delivery && ['pending', 'sending'].includes(state.data.delivery.state);
  if (waiting) {
    try { await runDeliveries(context, { requestId: orderId, limit: 1 }); } catch (error) { console.error('merchant attempt failed', error && error.message); }
    const fresh = await ask();
    if (fresh.ok) state = fresh;
  }
  return reply(res, 200, { ok: true, ...(state.data || {}) });
};
