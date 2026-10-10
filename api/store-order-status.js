const crypto = require('node:crypto');
const ALLOWED_STATUSES = new Set([
  'completed',
  'success',
  'succeeded',
  'paid',
  'confirmed',
  'rejected',
  'failed',
  'cancelled',
  'not_completed',
  'declined',
  'under_review',
]);

function send(res, status, body) {
  res.status(status).setHeader('Content-Type', 'application/json').json(body);
}

function normalizePayload(body) {
  const source = body && body.order && typeof body.order === 'object'
    ? { ...body.order, status: body.status || body.order.status, reason: body.reason || body.order.reason }
    : body || {};

  const normalized = {
    ...source,
    trackingNumber: source.trackingNumber || source.orderNumber,
    status: String(source.status || '').toLowerCase(),
  };
  normalized.idempotencyKey = normalized.idempotencyKey || normalized.eventId || crypto.createHash('sha256').update(JSON.stringify({ trackingNumber: normalized.trackingNumber, status: normalized.status, subtotal: normalized.subtotal, items: normalized.items })).digest('hex');
  return normalized;
}

function validatePayload(payload) {
  if (!payload.trackingNumber) return 'trackingNumber is required';
  if (!ALLOWED_STATUSES.has(payload.status)) return 'status is invalid';
  if (!payload.customer || typeof payload.customer !== 'object') return 'customer is required';
  if (!payload.customer.name || !payload.customer.phone || !payload.customer.address) {
    return 'customer name, phone and address are required';
  }
  if (!Array.isArray(payload.items) || payload.items.length === 0) return 'items are required';
  if (typeof payload.subtotal !== 'number' && typeof payload.subtotal !== 'string') return 'subtotal is required';
  return null;
}

module.exports = async function storeOrderStatus(req, res) {
  if (req.method === 'OPTIONS') {
    res.status(204).setHeader('Access-Control-Allow-Origin', '*').setHeader('Access-Control-Allow-Headers', 'Content-Type, X-Store-Webhook-Secret').setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS').end();
    return;
  }
  if (req.method !== 'POST') {
    send(res, 405, { ok: false, error: 'method_not_allowed' });
    return;
  }

  const expectedSecret = process.env.STORE_ORDER_WEBHOOK_SECRET;
  if (expectedSecret && req.headers['x-store-webhook-secret'] !== expectedSecret) {
    send(res, 401, { ok: false, error: 'invalid_webhook_secret' });
    return;
  }

  const payload = normalizePayload(req.body);
  const validationError = validatePayload(payload);
  if (validationError) {
    send(res, 400, { ok: false, error: validationError });
    return;
  }

  const supabaseUrl = process.env.SUPABASE_URL || process.env.NEXT_PUBLIC_SUPABASE_URL;
  const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_SECRET_KEY;
  if (!supabaseUrl || !serviceRoleKey) {
    send(res, 503, { ok: false, error: 'supabase_service_configuration_missing' });
    return;
  }

  try {
    const response = await fetch(`${supabaseUrl}/rest/v1/rpc/receive_store_order_notification`, {
      method: 'POST',
      headers: {
        apikey: serviceRoleKey,
        Authorization: `Bearer ${serviceRoleKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ p_payload: payload }),
    });
    const raw = await response.text();
    let result;
    try { result = raw ? JSON.parse(raw) : null; } catch (_) { result = { raw }; }

    if (!response.ok) {
      send(res, response.status >= 400 && response.status < 500 ? response.status : 502, {
        ok: false,
        error: 'supabase_update_failed',
        details: result,
      });
      return;
    }

    const reconciliation = Array.isArray(result) ? result[0] : result;
    send(res, reconciliation && reconciliation.matched === false ? 409 : 200, {
      ok: true,
      trackingNumber: payload.trackingNumber,
      status: reconciliation && reconciliation.status,
      matched: reconciliation && reconciliation.matched,
      mismatches: reconciliation && reconciliation.mismatches || [],
    });
  } catch (error) {
    send(res, 502, { ok: false, error: 'notification_processing_failed' });
  }
};
