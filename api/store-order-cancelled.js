const crypto = require('node:crypto');
function reply(res, status, body) {
  res.status(status).setHeader('Content-Type', 'application/json').json(body);
}

module.exports = async function storeOrderCancelled(req, res) {
  if (req.method !== 'POST') {
    reply(res, 405, { ok: false, error: 'method_not_allowed' });
    return;
  }
  const expectedSecret = process.env.STORE_ORDER_WEBHOOK_SECRET;
  if (expectedSecret && req.headers['x-store-webhook-secret'] !== expectedSecret) {
    reply(res, 401, { ok: false, error: 'invalid_webhook_secret' });
    return;
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
  payload.idempotencyKey = payload.idempotencyKey || payload.eventId || crypto.createHash('sha256').update(JSON.stringify({ trackingNumber: payload.trackingNumber, status: payload.status, reason: payload.reason, items: payload.items })).digest('hex');
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
      reply(res, response.status >= 400 && response.status < 500 ? response.status : 502, { ok: false, error: 'cancellation_update_failed', details: data });
      return;
    }
    const result = Array.isArray(data) ? data[0] : data;
    reply(res, 200, { ok: true, status: result.status, trackingNumber: result.trackingNumber, checkoutTrackingNumber: result.checkoutTrackingNumber, matched: result.matched, mismatches: result.mismatches || [], restoreToken: result.restoreToken, items: result.items || [] });
  } catch (_) {
    reply(res, 502, { ok: false, error: 'cancellation_processing_failed' });
  }
};
