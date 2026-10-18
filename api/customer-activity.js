const { createHmac } = require('node:crypto');
const { guestHashSecret } = require('../lib/guest-hash-secret.js');
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function reply(res, status, body) {
  res.setHeader('Cache-Control', 'no-store');
  return res.status(status).setHeader('Content-Type', 'application/json').json(body);
}
function hmac(secret, purpose, value) {
  return createHmac('sha256', secret).update(`${purpose}:${value}`).digest('hex');
}
function client(url, key) {
  const headers = { apikey: key, Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' };
  return (rpc, body) => fetch(`${url}/rest/v1/rpc/${rpc}`, { method: 'POST', headers, body: JSON.stringify(body) });
}

const BOT_AGENT = /bot\b|crawl|spider|slurp|headless|lighthouse|pagespeed|preview|monitor|uptime|curl\/|wget|python-requests|node-fetch|axios/i;

module.exports = async function customerActivity(req, res) {
  if (req.method !== 'POST') return reply(res, 405, { ok: false, error: 'method_not_allowed' });
  if (String((req.headers && req.headers['sec-fetch-site']) || '') === 'cross-site') return reply(res, 403, { ok: false, error: 'cross_site_not_allowed' });
  const body = req.body || {};
  if (Buffer.byteLength(JSON.stringify(body)) > 8000) return reply(res, 413, { ok: false, error: 'payload_too_large' });
  const supabaseUrl = process.env.SUPABASE_URL || process.env.NEXT_PUBLIC_SUPABASE_URL;
  const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_SECRET_KEY;
  const hashSecret = guestHashSecret();
  if (!supabaseUrl || !serviceKey || !hashSecret) return reply(res, 503, { ok: false, error: 'activity_unavailable' });

  if (!(req.headers && req.headers.authorization) && BOT_AGENT.test(String((req.headers && req.headers['user-agent']) || ''))) {
    return reply(res, 200, { ok: true, tracked: false, bot: true });
  }
  const action = String(body.action || '');
  if (!['session', 'track', 'search'].includes(action)) return reply(res, 400, { ok: false, error: 'invalid_action' });
  const sessionId = String(body.sessionId || '');
  if (!UUID.test(sessionId)) return reply(res, 400, { ok: false, error: 'invalid_session_id' });

  try {
    const auth = req.headers.authorization || '';
    const token = auth.startsWith('Bearer ') ? auth.slice(7) : '';
    let userId = null;
    if (token) {
      const userResponse = await fetch(`${supabaseUrl}/auth/v1/user`, {
        headers: { apikey: serviceKey, Authorization: `Bearer ${token}` }
      });
      if (!userResponse.ok) return reply(res, 401, { ok: false, error: 'login_required' });
      const user = await userResponse.json();
      if (!UUID.test(String(user.id || ''))) return reply(res, 401, { ok: false, error: 'login_required' });
      userId = user.id;
    }

    let fingerprintHash = null;
    let analyticsHash = null;
    if (!userId) {
      const browserKey = String(body.visitorKey || '');
      if (!UUID.test(browserKey)) return reply(res, 400, { ok: false, error: 'invalid_browser_key' });
      fingerprintHash = hmac(hashSecret, 'guest-browser', browserKey);
      analyticsHash = hmac(hashSecret, 'guest-analytics', browserKey);
    }

    const rpc = client(supabaseUrl, serviceKey);
    let response;
    if (action === 'session') {
      const sessionAction = String(body.sessionAction || '');
      if (!['start', 'heartbeat', 'end'].includes(sessionAction)) return reply(res, 400, { ok: false, error: 'invalid_session_action' });
      response = await rpc('record_customer_session', {
        p_fingerprint_hash: fingerprintHash,
        p_user_id: userId,
        p_session_id: sessionId,
        p_action: sessionAction
      });
    } else if (action === 'search') {
      const searchText = typeof body.searchText === 'string' ? body.searchText.trim() : '';
      if (!searchText || Array.from(searchText).length > 200) return reply(res, 400, { ok: false, error: 'invalid_search_text' });
      if (!Array.isArray(body.results) || body.results.length > 10) return reply(res, 400, { ok: false, error: 'invalid_search_results' });
      const seen = new Set();
      const results = [];
      for (const item of body.results) {
        if (!item || typeof item !== 'object' || !UUID.test(String(item.productId || ''))) return reply(res, 400, { ok: false, error: 'invalid_search_results' });
        const productSizeId = item.productSizeId ? String(item.productSizeId) : null;
        const storeProductId = item.storeProductId ? String(item.storeProductId) : null;
        if ((productSizeId && !UUID.test(productSizeId)) || (storeProductId && !UUID.test(storeProductId))) {
          return reply(res, 400, { ok: false, error: 'invalid_search_results' });
        }
        const key = `${item.productId}:${productSizeId || ''}:${storeProductId || ''}`;
        if (seen.has(key)) continue;
        seen.add(key);
        results.push({ productId: String(item.productId), productSizeId, storeProductId });
      }
      response = await rpc('record_customer_search', {
        p_fingerprint_hash: fingerprintHash,
        p_analytics_hash: analyticsHash,
        p_user_id: userId,
        p_session_id: sessionId,
        p_search_text: searchText,
        p_results: results
      });
    } else {
      const eventType = String(body.eventType || '');
      const productId = String(body.productId || '');
      const productSizeId = body.productSizeId ? String(body.productSizeId) : null;
      const storeProductId = body.storeProductId ? String(body.storeProductId) : null;
      if (!['view', 'search', 'cart_add', 'cart_remove'].includes(eventType) || !UUID.test(productId)) {
        return reply(res, 400, { ok: false, error: 'invalid_product_activity' });
      }
      if (productSizeId && !UUID.test(productSizeId)) return reply(res, 400, { ok: false, error: 'invalid_product_size' });
      if (storeProductId && !UUID.test(storeProductId)) return reply(res, 400, { ok: false, error: 'invalid_store_product' });
      const rawQuantity = Number(body.quantity);
      const quantity = ['cart_add', 'cart_remove'].includes(eventType)
        ? Math.max(1, Math.min(99, Math.trunc(rawQuantity || 1)))
        : null;
      response = await rpc('record_customer_product_event', {
        p_fingerprint_hash: fingerprintHash,
        p_analytics_hash: analyticsHash,
        p_user_id: userId,
        p_session_id: sessionId,
        p_event_type: eventType,
        p_product_id: productId,
        p_product_size_id: productSizeId,
        p_store_product_id: storeProductId,
        p_quantity: quantity
      });
    }
    if (!response.ok) return reply(res, 502, { ok: false, error: 'activity_unavailable' });
    return reply(res, 200, { ok: true, tracked: await response.json() === true });
  } catch (_) {
    return reply(res, 502, { ok: false, error: 'activity_unavailable' });
  }
};
