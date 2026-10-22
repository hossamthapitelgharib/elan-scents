const crypto = require('node:crypto');
const { checkSecret } = require('../lib/secure');
const { storeIdFromRequest, authenticateStoreWebhook, checkOrderOwnership, scopeIdempotencyKey, storeFailureStatus } = require('../lib/store-webhook-auth');
function reply(res, status, body) {
  res.status(status).setHeader('Content-Type', 'application/json').json(body);
}

module.exports = async function storeOrderCancelled(req, res) {
  if (req.method !== 'POST') {
    reply(res, 405, { ok: false, error: 'method_not_allowed' });
    return;
  }
  // The per-store path applies only when the request carries a store-identifier header (a UUID).
  // Every other request is checked against the shared secret exactly as before.
  const storeId = storeIdFromRequest(req);
  let storeAuth = null;
  if (storeId) {
    const result = await authenticateStoreWebhook(req, storeId);
    if (result.denied) {
      if (result.denied.retryAfter) res.setHeader('Retry-After', String(result.denied.retryAfter));
      reply(res, result.denied.status, result.denied.body);
      return;
    }
    storeAuth = result;
  } else {
    const denied = checkSecret(req, 'STORE_ORDER_WEBHOOK_SECRET', 'x-store-webhook-secret');
    if (denied) {
      reply(res, denied.status, { ok: false, error: denied.error });
      return;
    }
  }
  const body = req.body && typeof req.body === 'object' ? req.body : {};
  const payload = body.order && typeof body.order === 'object'
    ? { ...body.order, ...body, status: 'store_cancelled' }
    : { ...body, status: 'store_cancelled' };
  if (!payload.trackingNumber && !payload.orderNumber) {
    reply(res, 400, { ok: false, error: 'trackingNumber is required' });
    return;
  }
  if (!Array.isArray(payload.items) || payload.items.length === 0) {
    reply(res, 400, { ok: false, error: 'items are required' });
    return;
  }

  const supabaseUrl = process.env.SUPABASE_URL || process.env.NEXT_PUBLIC_SUPABASE_URL;
  const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_SECRET_KEY;
  if (!supabaseUrl || !serviceRoleKey) {
    reply(res, 503, { ok: false, error: 'supabase_service_configuration_missing' });
    return;
  }
  payload.trackingNumber = payload.trackingNumber || payload.orderNumber;
  if (storeAuth) {
    // cancel_store_order_request scopes its lookup by payload.storeId: never trust one sent in the body.
    payload.storeId = storeAuth.storeId;
    const notOwned = await checkOrderOwnership(storeAuth, payload.trackingNumber, { checkoutNumber: true });
    if (notOwned) {
      reply(res, notOwned.status, notOwned.body);
      return;
    }
  }
  payload.idempotencyKey = payload.idempotencyKey || payload.eventId || crypto.createHash('sha256').update(JSON.stringify({ trackingNumber: payload.trackingNumber, status: payload.status, reason: payload.reason, items: payload.items })).digest('hex');
  if (storeAuth) payload.idempotencyKey = scopeIdempotencyKey(storeAuth.storeId, payload.idempotencyKey);
  try {
    const response = await fetch(`${supabaseUrl}/rest/v1/rpc/cancel_store_order_request`, {
      method: 'POST',
      headers: { apikey: serviceRoleKey, Authorization: `Bearer ${serviceRoleKey}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ p_payload: payload }),
    });
    const raw = await response.text();
    let data;
    try { data = raw ? JSON.parse(raw) : null; } catch (_) { data = { raw }; }
    if (!response.ok) {
      if (storeAuth) {
        reply(res, storeFailureStatus('store-order-cancelled', response.status, raw), { ok: false, error: 'cancellation_update_failed' });
        return;
      }
      reply(res, response.status >= 400 && response.status < 500 ? response.status : 502, { ok: false, error: 'cancellation_update_failed', details: data });
      return;
    }
    const result = Array.isArray(data) ? data[0] : data;
    reply(res, 200, { ok: true, status: result.status, trackingNumber: result.trackingNumber, checkoutTrackingNumber: result.checkoutTrackingNumber, matched: result.matched, mismatches: result.mismatches || [], restoreToken: result.restoreToken, items: result.items || [] });
  } catch (_) {
    reply(res, 502, { ok: false, error: 'cancellation_processing_failed' });
  }
};
