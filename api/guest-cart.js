const { createHmac } = require('node:crypto');
const { createLimiter, clientIp } = require('../lib/rate-limit');

// Per client address and per minute. Creating a visitor row (resolve) and claiming are the expensive actions.
const LIMITS = {
  resolve: createLimiter({ max: 30, windowMs: 60000 }),
  claim: createLimiter({ max: 30, windowMs: 60000 }),
  save: createLimiter({ max: 120, windowMs: 60000 }),
  track: createLimiter({ max: 300, windowMs: 60000 })
};

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const json = (res, status, body) => res.status(status).json(body);

function cleanCart(input) {
  if (!Array.isArray(input)) return [];
  const bySize = new Map();
  for (const row of input.slice(0, 100)) {
    if (!row || !UUID.test(String(row.sid || ''))) continue;
    const q = Math.max(1, Math.min(99, Math.trunc(Number(row.q ?? row.quantity) || 1)));
    const storeProductId = UUID.test(String(row.storeProductId || '')) ? String(row.storeProductId) : null;
    const old = bySize.get(row.sid);
    bySize.set(row.sid, { sid: row.sid, storeProductId: storeProductId || (old && old.storeProductId) || null, q: Math.max(q, (old && old.q) || 0) });
  }
  return [...bySize.values()];
}

function createAdminClient(url, key) {
  const headers = { apikey: key, Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' };
  return async (path, body) => fetch(`${url}/rest/v1/${path}`, {
    method: 'POST', headers, body: JSON.stringify(body)
  });
}

function hmac(secret, purpose, visitorKey) {
  return createHmac('sha256', secret).update(`${purpose}:${visitorKey}`).digest('hex');
}

module.exports = async (req, res) => {
  res.setHeader('Cache-Control', 'no-store');
  if (req.method !== 'POST') return json(res, 405, { error: 'method_not_allowed' });
  if (Buffer.byteLength(JSON.stringify(req.body || {})) > 24000) return json(res, 413, { error: 'payload_too_large' });

  const body = req.body || {};
  const action = String(body.action || 'resolve');
  const visitorKey = String(body.visitorKey || '');
  if (!UUID.test(visitorKey)) return json(res, 400, { error: 'invalid_browser_key' });
  if (!['resolve', 'save', 'claim', 'track'].includes(action)) return json(res, 400, { error: 'unsupported_action' });
  const limit = LIMITS[action](`${clientIp(req)}:${action}`);
  if (!limit.allowed) {
    res.setHeader('Retry-After', String(limit.retryAfter));
    return json(res, 429, { error: 'too_many_requests' });
  }

  const supabaseUrl = process.env.SUPABASE_URL || process.env.NEXT_PUBLIC_SUPABASE_URL;
  const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_SECRET_KEY;
  if (!supabaseUrl || !serviceKey) return json(res, 503, { error: 'guest_sync_unavailable' });
  const fingerprintHash = hmac(serviceKey, 'guest-browser', visitorKey);
  const analyticsHash = hmac(serviceKey, 'guest-analytics', visitorKey);
  const admin = createAdminClient(supabaseUrl, serviceKey);

  try {
    if (action === 'resolve' || action === 'save') {
      const cart = action === 'save' ? cleanCart(body.items) : undefined;
      const rpc = action === 'resolve' ? 'resolve_guest_browser' : 'save_guest_browser_cart';
      const payload = { p_fingerprint_hash: fingerprintHash, p_analytics_hash: analyticsHash };
      if (action === 'save') payload.p_cart_snapshot = cart;
      const response = await admin(`rpc/${rpc}`, payload);
      if (!response.ok) return json(res, 502, { error: 'guest_profile_unavailable' });
      const profile = await response.json();
      return json(res, 200, { ok: true, visitorId: profile.visitorId, status: profile.status, cart: profile.cart || [] });
    }

    if (action === 'track') {
      const eventType = String(body.eventType || '');
      const productId = String(body.productId || '');
      if (!['view', 'search', 'cart_add'].includes(eventType) || !UUID.test(productId)) {
        return json(res, 400, { error: 'invalid_product_activity' });
      }
      const response = await admin('rpc/record_guest_product_activity', {
        p_fingerprint_hash: fingerprintHash,
        p_analytics_hash: analyticsHash,
        p_product_id: productId,
        p_event_type: eventType
      });
      if (!response.ok) return json(res, 502, { error: 'guest_activity_unavailable' });
      return json(res, 200, { ok: true, tracked: await response.json() === true });
    }

    const authorization = req.headers.authorization || '';
    const accessToken = authorization.startsWith('Bearer ') ? authorization.slice(7) : '';
    if (!accessToken) return json(res, 401, { error: 'login_required' });
    const userResponse = await fetch(`${supabaseUrl}/auth/v1/user`, {
      headers: { apikey: serviceKey, Authorization: `Bearer ${accessToken}` }
    });
    if (!userResponse.ok) return json(res, 401, { error: 'login_required' });
    const user = await userResponse.json();
    if (!UUID.test(String(user.id || ''))) return json(res, 401, { error: 'login_required' });

    const response = await admin('rpc/claim_guest_browser_cart', {
      p_fingerprint_hash: fingerprintHash,
      p_user_id: user.id
    });
    if (!response.ok) return json(res, 502, { error: 'cart_transfer_failed' });
    const result = await response.json();
    return json(res, 200, { ok: true, claimed: !!result.claimed, cart: Number(result.cart) || 0 });
  } catch (_) {
    return json(res, 502, { error: 'guest_sync_unavailable' });
  }
};
