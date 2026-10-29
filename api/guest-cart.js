const { createHmac } = require('node:crypto');
const { guestHashSecret } = require('../lib/guest-hash-secret.js');
const { createLimiter, clientIp } = require('../lib/rate-limit');
const match = require('../lib/guest-match');

// Per client address and per minute. Creating a visitor row (resolve) and claiming are the expensive actions.
// Mobile carriers and offices share one address between many shoppers, so the per-address cap is
// generous and the strict cap is per browser key. A busy network must not lose real visitors.
const LIMITS = {
  resolve: createLimiter({ max: 30, windowMs: 60000 }),
  identify: createLimiter({ max: 12, windowMs: 60000 }),
  claim: createLimiter({ max: 30, windowMs: 60000 }),
  save: createLimiter({ max: 120, windowMs: 60000 }),
  track: createLimiter({ max: 300, windowMs: 60000 }),
  forget: createLimiter({ max: 30, windowMs: 60000 })     // keyed by address: the erase is one call per refusal
};
const NETWORK_LIMITS = {
  resolve: createLimiter({ max: 600, windowMs: 60000 }),
  identify: createLimiter({ max: 240, windowMs: 60000 }),
  claim: createLimiter({ max: 300, windowMs: 60000 }),
  save: createLimiter({ max: 2400, windowMs: 60000 }),
  track: createLimiter({ max: 6000, windowMs: 60000 })
};
// Crawlers and monitors run scripts too; they must not be counted as shoppers.
const BOT_AGENT = /bot\b|crawl|spider|slurp|headless|lighthouse|pagespeed|preview|monitor|uptime|curl\/|wget|python-requests|node-fetch|axios/i;

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

function cookieKey(req) {
  const m = String((req.headers && req.headers.cookie) || '').match(/(?:^|;\s*)elan_gid=([^;]+)/);
  return m && UUID.test(m[1]) ? m[1] : null;
}
const secureFlag = (req) => (String((req.headers && req.headers['x-forwarded-proto']) || '').includes('https') ? '; Secure' : '');
function setKeyCookie(req, res, key) {
  res.setHeader('Set-Cookie', `elan_gid=${key}; Max-Age=34560000; Path=/; HttpOnly; SameSite=Lax${secureFlag(req)}`);
}
function expireKeyCookie(req, res) {
  res.setHeader('Set-Cookie', `elan_gid=; Max-Age=0; Path=/; HttpOnly; SameSite=Lax${secureFlag(req)}`);
}

// Server-side signals are stored only as keyed hashes. IPv4 keeps its /24, IPv6 its /48 prefix.
function ipPrefix(ip) {
  const v4 = /^(\d{1,3}\.\d{1,3}\.\d{1,3})\.\d{1,3}$/.exec(ip);
  if (v4) return v4[1];
  if (ip.includes(':')) return ip.split(':').slice(0, 3).join(':');
  return '';
}

function hmac(secret, purpose, visitorKey) {
  return createHmac('sha256', secret).update(`${purpose}:${visitorKey}`).digest('hex');
}

const HEXFP = /^[a-f0-9]{16,64}$/;

// Stores this browser's signals and links it to other guests only when the strict rules say so.
// A failure here never affects the shopper: the answer is simply "not identified".
async function identify({ req, body, admin, hashSecret, analyticsUse, ip }) {
  try {
    const parts = match.cleanParts(body.parts);
    const fp = HEXFP.test(String(body.fp || '')) ? String(body.fp) : '';
    if (!fp || Object.keys(parts).length < 4) return { ok: true, identified: false };
    const b = body.behavior && typeof body.behavior === 'object' ? body.behavior : {};
    const behavior = {
      interactions: Math.max(0, Math.min(100000, Math.trunc(Number(b.interactions) || 0))),
      activeSeconds: Math.max(0, Math.min(86400, Math.trunc(Number(b.activeSeconds) || 0))),
      pages: Math.max(0, Math.min(10000, Math.trunc(Number(b.pages) || 0)))
    };
    const headers = req.headers || {};
    const h = (purpose, value) => (value ? hmac(hashSecret, purpose, value) : null);
    const ipSignal = typeof ip === 'string' && ip.trim() && ip.trim().toLowerCase() !== 'unknown' ? ip.trim() : '';
    const cartSig = typeof body.cartSig === 'string' && /^[a-f0-9]{8,64}$/.test(body.cartSig) ? body.cartSig : '';
    const own = {
      parts, fp, behavior,
      ipHash: h('guest-ip', ipSignal), ipPrefixHash: h('guest-ip-prefix', ipPrefix(ipSignal)),
      cartHash: cartSig ? h('guest-cart-sig', cartSig) : ''
    };

    const stored = await admin('rpc/guest_signal_store', {
      p_analytics_hash: analyticsUse, p_fp_hash: fp, p_parts: parts,
      p_ip_hash: own.ipHash, p_ip_prefix_hash: own.ipPrefixHash,
      p_ua_hash: h('guest-ua', String(headers['user-agent'] || '')), p_lang_hash: h('guest-lang', String(headers['accept-language'] || '')),
      p_cart_hash: own.cartHash || null,
      p_interactions: behavior.interactions, p_active_seconds: behavior.activeSeconds, p_pages: behavior.pages
    });
    if (!stored.ok) return { ok: true, identified: false };

    let linked = 0;
    if (match.trustedBehavior(behavior)) {
      const found = await admin('rpc/guest_signal_candidates', { p_analytics_hash: analyticsUse, p_fp_hash: fp, p_gpu: parts.gpu || null, p_screen: parts.screen || null });
      const candidates = found.ok ? await found.json() : [];
      const list = Array.isArray(candidates) ? candidates : [];
      // How many OTHER look-alike guests already share this address: a crowded address (carrier NAT,
      // an office, a campaign through one carrier) is not evidence that two guests are one person.
      const distinct = (key, value) => (value ? new Set(list.filter((c) => c[key] === value).map((c) => c.analyticsHash)).size : 0);
      const crowd = { ip: distinct('ipHash', own.ipHash), prefix: distinct('ipPrefixHash', own.ipPrefixHash) };
      const links = [];
      for (const c of list) {
        const verdict = match.decide(own, c, Number(c.popularity) || 1, Date.now(), { crowd });
        if (!verdict.link) continue;
        links.push({ a: analyticsUse, b: c.analyticsHash, score: verdict.score, reasons: verdict.reasons });
      }
      if (links.length) {
        const batch = await admin('rpc/guest_identity_link_many', { p_links: links });
        if (batch.ok) {
          const count = Number(await batch.json().catch(() => 0));
          linked = Number.isFinite(count) ? Math.max(0, Math.min(links.length, Math.trunc(count))) : 0;
        } else {
          // تظل الدالة الحالية متوافقة حتى يوافق المالك على الترحيل المعلّق ويطبّقه.
          for (const link of links) {
            const done = await admin('rpc/guest_identity_link', { p_a: link.a, p_b: link.b, p_score: link.score, p_reasons: link.reasons });
            if (done.ok && (await done.json()) === true) linked += 1;
          }
        }
      }
    }
    const finalRes = await admin('rpc/guest_final_id', { p_hash: analyticsUse });
    const finalHash = finalRes.ok ? await finalRes.json() : analyticsUse;
    return { ok: true, identified: true, linked, finalVisitorId: hmac(hashSecret, 'final-visitor', String(finalHash || analyticsUse)).slice(0, 32) };
  } catch (_) {
    return { ok: true, identified: false };
  }
}

module.exports = async (req, res) => {
  res.setHeader('Cache-Control', 'no-store');
  if (req.method !== 'POST') return json(res, 405, { error: 'method_not_allowed' });
  if (Buffer.byteLength(JSON.stringify(req.body || {})) > 24000) return json(res, 413, { error: 'payload_too_large' });

  if (String((req.headers && req.headers['sec-fetch-site']) || '') === 'cross-site') return json(res, 403, { error: 'cross_site_not_allowed' });
  const body = req.body || {};
  const action = String(body.action || 'resolve');
  // The visitor refused tracking in the privacy policy (owner decision of 2026-10-29). Everything held about this browser is
  // erased: the rows behind the browser key the page sends and behind the HttpOnly cookie key, which is the same browser. The
  // cookie is expired only once the rows are gone, so a failed call can be retried by the browser. Registered customers' data is
  // never touched (forget_guest_browser works on guest rows only). No key at all means there is nothing to erase.
  if (action === 'forget') {
    const keys = [...new Set([String(body.visitorKey || ''), cookieKey(req) || ''].filter((k) => UUID.test(k)))];
    if (!keys.length) {
      expireKeyCookie(req, res);
      return json(res, 200, { ok: true, forgotten: false });
    }
    const ip = clientIp(req);
    const limit = LIMITS.forget(`${ip}:forget`);
    if (!limit.allowed) {
      res.setHeader('Retry-After', String(limit.retryAfter));
      return json(res, 429, { error: 'too_many_requests' });
    }
    const supabaseUrl = process.env.SUPABASE_URL || process.env.NEXT_PUBLIC_SUPABASE_URL;
    const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_SECRET_KEY;
    const hashSecret = guestHashSecret();
    if (!supabaseUrl || !serviceKey || !hashSecret) return json(res, 503, { error: 'guest_sync_unavailable' });
    const admin = createAdminClient(supabaseUrl, serviceKey);
    try {
      for (const key of keys) {
        const response = await admin('rpc/forget_guest_browser', {
          p_fingerprint_hash: hmac(hashSecret, 'guest-browser', key),
          p_analytics_hash: hmac(hashSecret, 'guest-analytics', key)
        });
        if (!response.ok) return json(res, 502, { error: 'guest_forget_failed' });
      }
    } catch (_) {
      return json(res, 502, { error: 'guest_forget_failed' });
    }
    expireKeyCookie(req, res);
    return json(res, 200, { ok: true, forgotten: true });
  }
  let visitorKey = String(body.visitorKey || '');
  if (!UUID.test(visitorKey)) return json(res, 400, { error: 'invalid_browser_key' });
  if (!['resolve', 'save', 'claim', 'track', 'identify'].includes(action)) return json(res, 400, { error: 'unsupported_action' });
  const ip = clientIp(req);
  const limit = [LIMITS[action](`${visitorKey}:${action}`), NETWORK_LIMITS[action](`${ip}:${action}`)].find((l) => !l.allowed) || { allowed: true };
  if (action !== 'claim' && BOT_AGENT.test(String((req.headers && req.headers['user-agent']) || ''))) {
    return json(res, 200, { ok: true, tracked: false, bot: true, cart: [] });
  }
  if (!limit.allowed) {
    res.setHeader('Retry-After', String(limit.retryAfter));
    return json(res, 429, { error: 'too_many_requests' });
  }

  const supabaseUrl = process.env.SUPABASE_URL || process.env.NEXT_PUBLIC_SUPABASE_URL;
  const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_SECRET_KEY;
  const hashSecret = guestHashSecret();
  if (!supabaseUrl || !serviceKey || !hashSecret) return json(res, 503, { error: 'guest_sync_unavailable' });
  const fingerprintHash = hmac(hashSecret, 'guest-browser', visitorKey);
  const analyticsHash = hmac(hashSecret, 'guest-analytics', visitorKey);
  const admin = createAdminClient(supabaseUrl, serviceKey);

  try {
    // The server cookie outlives script-set storage (Safari clears that after a week without a visit).
    // If this browser arrives with a different key than the one the server already gave it, the two
    // records are merged into the cookie's key, so one browser is never two visitors.
    let canonicalKey = null;
    if (action === 'resolve') {
      const known = cookieKey(req);
      if (!known || body.fresh === true) setKeyCookie(req, res, visitorKey);
      else if (known !== visitorKey) {
        const merge = await admin('rpc/merge_guest_browser', {
          p_from_fingerprint: fingerprintHash, p_to_fingerprint: hmac(hashSecret, 'guest-browser', known),
          p_from_analytics: analyticsHash, p_to_analytics: hmac(hashSecret, 'guest-analytics', known)
        }).then((r) => (r.ok ? r.json() : null)).catch(() => null);
        if (merge && merge.merged === true) { canonicalKey = known; visitorKey = known; }
      }
    }
    const fingerprintUse = canonicalKey ? hmac(hashSecret, 'guest-browser', canonicalKey) : fingerprintHash;
    const analyticsUse = canonicalKey ? hmac(hashSecret, 'guest-analytics', canonicalKey) : analyticsHash;
    if (action === 'identify') {
      return json(res, 200, await identify({ req, body, admin, hashSecret, analyticsUse, ip }));
    }

    if (action === 'resolve' || action === 'save') {
      const cart = action === 'save' ? cleanCart(body.items) : undefined;
      const rpc = action === 'resolve' ? 'resolve_guest_browser' : 'save_guest_browser_cart';
      const payload = { p_fingerprint_hash: fingerprintUse, p_analytics_hash: analyticsUse };
      if (action === 'save') payload.p_cart_snapshot = cart;
      const response = await admin(`rpc/${rpc}`, payload);
      if (!response.ok) return json(res, 502, { error: 'guest_profile_unavailable' });
      const profile = await response.json();
      return json(res, 200, { ok: true, visitorId: profile.visitorId, status: profile.status, cart: cleanCart(profile.cart || []), ...(profile.limited === true ? { limited: true } : {}), ...(canonicalKey ? { visitorKey: canonicalKey } : {}) });
    }

    if (action === 'track') {
      const eventType = String(body.eventType || '');
      const productId = String(body.productId || '');
      if (!['view', 'search', 'cart_add', 'cart_remove'].includes(eventType) || !UUID.test(productId)) {
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

    // The claim also removes this browser's guest analytics, so the same person is not counted as a guest and as a
    // customer. The older two-argument function that skipped that step was dropped (guest_identity_hardening).
    const response = await admin('rpc/claim_guest_browser_cart', {
      p_fingerprint_hash: fingerprintHash,
      p_user_id: user.id,
      p_analytics_hash: analyticsHash
    });
    if (!response.ok) return json(res, 502, { error: 'cart_transfer_failed' });
    const result = await response.json();
    return json(res, 200, { ok: true, claimed: !!result.claimed, cart: Number(result.cart) || 0 });
  } catch (_) {
    return json(res, 502, { error: 'guest_sync_unavailable' });
  }
};
