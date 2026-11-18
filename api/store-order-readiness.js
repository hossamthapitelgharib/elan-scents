'use strict';

const { serviceContext } = require('../lib/merchant-dispatcher');
const { createLimiter, clientIp, setRateLimitHeaders } = require('../lib/rate-limit');

const limiter = createLimiter({ max: 120, windowMs: 60 * 1000 });

/* GET /api/store-order-readiness — which stores can take an order now (an active store with an enabled technical link to Élan: order address
   and secret). The storefront locks the order button of every other store as "غير متاح حاليًا" (docs/purchase-flow-final.ar.md, step 1).
   It tells a visitor nothing but a yes or a no per store, never an address or a secret; the database refuses an order from a store that
   is not ready all the same, so this list only saves the customer a disappointment. */
module.exports = async function storeOrderReadiness(req, res) {
  res.setHeader('Cache-Control', 'public, max-age=30');
  if (req.method !== 'GET') return res.status(405).setHeader('Content-Type', 'application/json').json({ ok: false, error: 'method_not_allowed' });
  const limit = limiter(clientIp(req));
  if (!limit.allowed) { setRateLimitHeaders(res, limit, 120); res.setHeader('Cache-Control', 'no-store'); return res.status(429).setHeader('Content-Type', 'application/json').json({ ok: false, error: 'rate_limited' }); }
  const context = serviceContext();
  if (!context) { res.setHeader('Cache-Control', 'no-store'); return res.status(503).setHeader('Content-Type', 'application/json').json({ ok: false, error: 'supabase_service_configuration_missing' }); }
  try {
    const response = await fetch(`${context.supabaseUrl}/rest/v1/rpc/store_order_readiness`, {
      method: 'POST',
      headers: { apikey: context.serviceRoleKey, Authorization: `Bearer ${context.serviceRoleKey}`, 'Content-Type': 'application/json' },
      body: '{}'
    });
    const rows = response.ok ? await response.json().catch(() => null) : null;
    if (!Array.isArray(rows)) throw new Error('readiness unavailable');
    const stores = {};
    for (const row of rows) if (row && typeof row.store_id === 'string') stores[row.store_id] = row.ready === true;
    return res.status(200).setHeader('Content-Type', 'application/json').json({ ok: true, stores });
  } catch (_) {
    res.setHeader('Cache-Control', 'no-store');
    return res.status(502).setHeader('Content-Type', 'application/json').json({ ok: false, error: 'readiness_unavailable' });
  }
};
