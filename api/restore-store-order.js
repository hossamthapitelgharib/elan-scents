const { createLimiter, clientIp } = require('../lib/rate-limit');

// The restore token is a random UUID (gen_random_uuid), so anything else can never match a row.
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
// Generous for a person restoring one cart, tight for a script trying tokens. Per IP, per process.
const limiter = createLimiter({ max: 30, windowMs: 60 * 1000 });

function reply(res, status, body) {
  // The success response carries the customer's phone and email, so it must never sit in a shared cache.
  res.status(status).setHeader('Content-Type', 'application/json').setHeader('Cache-Control', 'no-store').json(body);
}

module.exports = async function restoreStoreOrder(req, res) {
  if (req.method !== 'POST') {
    reply(res, 405, { ok: false, error: 'method_not_allowed' });
    return;
  }
  const limit = limiter(clientIp(req));
  if (!limit.allowed) {
    res.setHeader('Retry-After', String(limit.retryAfter));
    reply(res, 429, { ok: false, error: 'too_many_requests' });
    return;
  }
  const body = req.body && typeof req.body === 'object' ? req.body : {};
  const rawToken = body.restoreToken || body.token;
  if (!rawToken) {
    reply(res, 400, { ok: false, error: 'restoreToken is required' });
    return;
  }
  const restoreToken = typeof rawToken === 'string' ? rawToken.trim() : '';
  if (!UUID_PATTERN.test(restoreToken)) {
    reply(res, 404, { ok: false, error: 'restoration_not_found' });
    return;
  }
  const supabaseUrl = process.env.SUPABASE_URL || process.env.NEXT_PUBLIC_SUPABASE_URL;
  const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_SECRET_KEY;
  if (!supabaseUrl || !serviceRoleKey) {
    reply(res, 503, { ok: false, error: 'supabase_service_configuration_missing' });
    return;
  }
  const headers = { apikey: serviceRoleKey, Authorization: `Bearer ${serviceRoleKey}`, 'Content-Type': 'application/json' };
  try {
    const query = new URLSearchParams({ select: 'id,request_id,tracking_number,items,status,customer_phone,customer_email', restore_token: `eq.${restoreToken}`, limit: '1' });
    const foundResponse = await fetch(`${supabaseUrl}/rest/v1/store_order_cart_restorations?${query.toString()}`, { headers });
    const found = await foundResponse.json();
    if (!foundResponse.ok || !Array.isArray(found) || !found[0]) {
      reply(res, 404, { ok: false, error: 'restoration_not_found' });
      return;
    }
    const restoration = found[0];
    if (restoration.status === 'pending') {
      const updateResponse = await fetch(`${supabaseUrl}/rest/v1/store_order_cart_restorations?id=eq.${restoration.id}`, { method: 'PATCH', headers: { ...headers, Prefer: 'return=minimal' }, body: JSON.stringify({ status: 'restored', restored_at: new Date().toISOString() }) });
      if (!updateResponse.ok) {
        reply(res, 502, { ok: false, error: 'restoration_update_failed' });
        return;
      }
    }
    reply(res, 200, { ok: true, status: 'restored', trackingNumber: restoration.tracking_number, requestId: restoration.request_id, items: restoration.items || [], customer: { phone: restoration.customer_phone || '', email: restoration.customer_email || '' } });
  } catch (_) {
    reply(res, 502, { ok: false, error: 'restoration_processing_failed' });
  }
};
