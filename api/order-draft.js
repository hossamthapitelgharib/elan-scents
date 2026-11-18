'use strict';

const { authenticateCustomer, callCustomerRpc, errorKey } = require('../lib/customer-rpc');
const { createLimiter, clientIp, setRateLimitHeaders } = require('../lib/rate-limit');

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const limiter = createLimiter({ max: 30, windowMs: 60 * 1000 });

function reply(res, status, body) {
  res.setHeader('Cache-Control', 'no-store');
  return res.status(status).setHeader('Content-Type', 'application/json').json(body);
}

/* POST /api/order-draft  { storeId }  — the order page asks for the tracking number the order will carry, before the customer presses "موافق".
   One open draft per customer and store (two hours); asking again returns the same one. A store without a technical link has none:
   the page says "غير متاح حاليًا". The number comes from the database, never from the browser. */
module.exports = async function orderDraft(req, res) {
  if (req.method !== 'POST') return reply(res, 405, { ok: false, error: 'method_not_allowed' });
  const context = await authenticateCustomer(req);
  if (context.error) return reply(res, context.status, { ok: false, error: context.error });
  const limit = limiter(`${context.user.id}|${clientIp(req)}`);
  if (!limit.allowed) { setRateLimitHeaders(res, limit, 30); return reply(res, 429, { ok: false, error: 'rate_limited' }); }
  const storeId = String(req.body && req.body.storeId || '');
  if (!UUID.test(storeId)) return reply(res, 400, { ok: false, error: 'invalid_store' });
  const result = await callCustomerRpc(context, 'reserve_order_draft', { p_user_id: context.user.id, p_store_id: storeId });
  if (!result.ok) return reply(res, result.status >= 400 && result.status < 500 ? 400 : 502, { ok: false, error: errorKey(result) });
  return reply(res, 200, { ok: true, ...(result.data || {}) });
};
