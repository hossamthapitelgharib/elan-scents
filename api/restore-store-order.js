const { createDistributedLimiter, clientIp, setRateLimitHeaders } = require('../lib/rate-limit');

// The restore token is a random UUID (gen_random_uuid), so anything else can never match a row.
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const limiter = createDistributedLimiter({ name: 'restore-store-order', max: 30, windowMs: 60 * 1000 });
// A restoration link is valid for 30 days from cancellation. The status and age are
// both checked again in the conditional write, so only one concurrent request can consume it.
const RESTORE_TTL_MS = 30 * 24 * 60 * 60 * 1000;
const RESTORE_RESULT_FIELDS = 'request_id,tracking_number,items';

function isExpired(createdAt, now) {
  const created = Date.parse(createdAt);
  return !Number.isFinite(created) || created > now || now - created > RESTORE_TTL_MS;
}

function reply(res, status, body) {
  // Restore tokens are bearer capabilities and success responses contain cart data.
  res.status(status).setHeader('Content-Type', 'application/json').setHeader('Cache-Control', 'no-store').json(body);
}

module.exports = async function restoreStoreOrder(req, res) {
  if (req.method !== 'POST') {
    reply(res, 405, { ok: false, error: 'method_not_allowed' });
    return;
  }
  const limit = await limiter(clientIp(req));
  if (!limit.allowed) {
    setRateLimitHeaders(res, limit, 30);
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
    const query = new URLSearchParams({ select: `id,created_at,status,${RESTORE_RESULT_FIELDS}`, restore_token: `eq.${restoreToken}`, limit: '1' });
    const foundResponse = await fetch(`${supabaseUrl}/rest/v1/store_order_cart_restorations?${query.toString()}`, { headers });
    const found = await foundResponse.json();
    if (!foundResponse.ok || !Array.isArray(found) || !found[0]) {
      reply(res, 404, { ok: false, error: 'restoration_not_found' });
      return;
    }

    const restoration = found[0];
    const now = Date.now();
    if (isExpired(restoration.created_at, now) || restoration.status === 'expired') {
      reply(res, 410, { ok: false, error: 'restoration_expired' });
      return;
    }
    if (restoration.status !== 'pending') {
      // A previously consumed token is not an idempotent read capability.
      reply(res, 410, { ok: false, error: 'restoration_already_used' });
      return;
    }

    const cutoff = new Date(now - RESTORE_TTL_MS).toISOString();
    const updateParams = new URLSearchParams({
      id: `eq.${restoration.id}`,
      restore_token: `eq.${restoreToken}`,
      status: 'eq.pending',
      created_at: `gte.${cutoff}`,
      select: RESTORE_RESULT_FIELDS
    });
    const updateResponse = await fetch(`${supabaseUrl}/rest/v1/store_order_cart_restorations?${updateParams.toString()}`, {
      method: 'PATCH',
      headers: { ...headers, Prefer: 'return=representation' },
      body: JSON.stringify({ status: 'restored', restored_at: new Date(now).toISOString() })
    });
    if (!updateResponse.ok) {
      reply(res, 502, { ok: false, error: 'restoration_update_failed' });
      return;
    }
    const consumed = await updateResponse.json().catch(() => null);
    if (!Array.isArray(consumed) || consumed.length !== 1) {
      // Another request consumed the token (or it expired) after our initial read.
      // Do not return the pre-read cart or any contact information to the losing request.
      reply(res, 409, { ok: false, error: 'restoration_already_used' });
      return;
    }

    const result = consumed[0];
    reply(res, 200, {
      ok: true,
      status: 'restored',
      trackingNumber: result.tracking_number,
      requestId: result.request_id,
      items: Array.isArray(result.items) ? result.items : []
    });
  } catch (_) {
    reply(res, 502, { ok: false, error: 'restoration_processing_failed' });
  }
};
module.exports.RESTORE_TTL_MS = RESTORE_TTL_MS;
