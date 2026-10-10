const { createHmac } = require('node:crypto');

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const json = (res, status, body) => res.status(status).json(body);

function cleanFeatures(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) return null;
  const string = (key, max = 80) => String(input[key] ?? '').trim().slice(0, max);
  const number = (key, min, max) => {
    const n = Number(input[key]);
    return Number.isFinite(n) ? Math.max(min, Math.min(max, n)) : 0;
  };
  const result = {
    platform: string('platform'), language: string('language'), timezone: string('timezone'),
    screenWidth: number('screenWidth', 0, 20000), screenHeight: number('screenHeight', 0, 20000),
    colorDepth: number('colorDepth', 0, 128), pixelRatio: number('pixelRatio', 0, 10),
    cores: number('cores', 0, 256), memory: number('memory', 0, 1024), touchPoints: number('touchPoints', 0, 100)
  };
  if (!result.platform && !result.language && !result.timezone && !result.screenWidth) return null;
  return result;
}

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
  return async (path, method = 'GET', body, prefer) => {
    const h = { ...headers };
    if (prefer) h.Prefer = prefer;
    return fetch(`${url}/rest/v1/${path}`, { method, headers: h, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
  };
}

module.exports = async (req, res) => {
  res.setHeader('Cache-Control', 'no-store');
  if (req.method !== 'POST') return json(res, 405, { error: 'method_not_allowed' });
  if (Buffer.byteLength(JSON.stringify(req.body || {})) > 24000) return json(res, 413, { error: 'payload_too_large' });

  const features = cleanFeatures(req.body && req.body.fingerprint);
  if (!features) return json(res, 400, { error: 'invalid_fingerprint_features' });
  const supabaseUrl = process.env.SUPABASE_URL || process.env.NEXT_PUBLIC_SUPABASE_URL;
  const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_SECRET_KEY;
  if (!supabaseUrl || !serviceKey) return json(res, 503, { error: 'guest_sync_unavailable' });
  const hash = createHmac('sha256', serviceKey).update(JSON.stringify(features)).digest('hex');
  const action = String(req.body.action || 'resolve');
  const admin = createAdminClient(supabaseUrl, serviceKey);
  const timestamp = new Date().toISOString();
  const selectGuest = `guest_visitors?select=id,cart_snapshot,status,converted_user_id&fingerprint_hash=eq.${hash}&limit=1`;

  try {
    if (action === 'resolve' || action === 'save') {
      const payload = { fingerprint_hash: hash, last_seen_at: timestamp };
      if (action === 'save') payload.cart_snapshot = cleanCart(req.body.items);
      const upsert = await admin('guest_visitors?on_conflict=fingerprint_hash&select=id,cart_snapshot,status', 'POST', payload, 'resolution=merge-duplicates,return=representation');
      if (!upsert.ok) return json(res, 502, { error: 'guest_profile_unavailable' });
      const rows = await upsert.json();
      const profile = rows[0];
      return json(res, 200, { ok: true, visitorId: profile.id, status: profile.status, cart: profile.cart_snapshot || [] });
    }

    if (action === 'claim') {
      const authorization = req.headers.authorization || '';
      const accessToken = authorization.startsWith('Bearer ') ? authorization.slice(7) : '';
      if (!accessToken) return json(res, 401, { error: 'login_required' });
      const userResponse = await fetch(`${supabaseUrl}/auth/v1/user`, { headers: { apikey: serviceKey, Authorization: `Bearer ${accessToken}` } });
      if (!userResponse.ok) return json(res, 401, { error: 'login_required' });
      const user = await userResponse.json();
      if (!UUID.test(String(user.id || ''))) return json(res, 401, { error: 'login_required' });

      const guestResponse = await admin(selectGuest);
      if (!guestResponse.ok) return json(res, 502, { error: 'guest_profile_unavailable' });
      const guestRows = await guestResponse.json();
      const guest = guestRows[0];
      if (!guest || guest.status !== 'guest') return json(res, 200, { ok: true, claimed: false, cart: [] });

      const customerResponse = await admin(`cart_items?select=store_product_id,quantity&user_id=eq.${user.id}&limit=500`);
      if (!customerResponse.ok) return json(res, 502, { error: 'customer_cart_unavailable' });
      const customerRows = await customerResponse.json();
      const quantities = new Map();
      for (const row of customerRows) quantities.set(row.store_product_id, Math.max(quantities.get(row.store_product_id) || 0, Number(row.quantity) || 1));
      const guestItems = cleanCart(guest.cart_snapshot);
      for (const row of guestItems) {
        if (!row.storeProductId) continue;
        const q = Math.max(quantities.get(row.storeProductId) || 0, row.q);
        if (q <= 0) continue;
        if (quantities.has(row.storeProductId)) {
          const update = await admin(`cart_items?user_id=eq.${user.id}&store_product_id=eq.${row.storeProductId}`, 'PATCH', { quantity: q }, 'return=minimal');
          if (!update.ok) return json(res, 502, { error: 'cart_transfer_failed' });
        } else {
          const insert = await admin('cart_items', 'POST', { user_id: user.id, store_product_id: row.storeProductId, quantity: q }, 'return=minimal');
          if (!insert.ok) return json(res, 502, { error: 'cart_transfer_failed' });
        }
        quantities.set(row.storeProductId, q);
      }

      const mark = await admin(`guest_visitors?id=eq.${guest.id}`, 'PATCH', {
        status: 'converted', converted_user_id: user.id, converted_at: timestamp,
        fingerprint_hash: null, cart_snapshot: [], last_seen_at: timestamp
      }, 'return=minimal');
      if (!mark.ok) return json(res, 502, { error: 'guest_conversion_failed' });
      return json(res, 200, { ok: true, claimed: true, cart: guestItems.length });
    }

    return json(res, 400, { error: 'unsupported_action' });
  } catch (_) {
    return json(res, 502, { error: 'guest_sync_unavailable' });
  }
};
