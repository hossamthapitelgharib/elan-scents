const crypto = require('node:crypto');
const { safeEqual } = require('./secure');
const { createLimiter, clientIp } = require('./rate-limit');

// Optional second way for a store to authenticate a webhook, next to the shared STORE_ORDER_WEBHOOK_SECRET.
// It is used only when the request carries a store-identifier header holding a UUID. Any other request
// keeps going through the shared-secret check exactly as before.
//
// The store then proves itself with its own secret (store_integrations.webhook_secret) in the same
// x-store-webhook-secret header, and may only report on orders that belong to it.
const STORE_ID_HEADER = 'x-store-id';
const SECRET_HEADER = 'x-store-webhook-secret';
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// Per client address and per minute, counted before any database call. A store platform may send all of its
// stores' webhooks from one address, so the cap is far above real traffic and far below a guessing attack.
const RATE_LIMIT = { max: 120, windowMs: 60000 };
const limiter = createLimiter(RATE_LIMIT);

// One answer for every authentication failure, so a response never says whether the store exists,
// has a secret, or has its integration switched off.
const deny = () => ({ status: 401, body: { ok: false, error: 'invalid_webhook_secret' } });
// Once the store has proved itself, an order it cannot report on gets one answer whether the order does not exist or
// belongs to another store, so it cannot be used to find out which tracking numbers other stores have.
const notFound = () => ({ status: 404, body: { ok: false, error: 'order_not_found' } });
const unavailable = () => ({ status: 502, body: { ok: false, error: 'store_auth_unavailable' } });

// Compared against when the store or its secret does not exist, so that case runs the same comparison.
const DUMMY_SECRET = crypto.randomBytes(32).toString('hex');

function headerValue(req, name) {
  const value = req && req.headers ? req.headers[name] : undefined;
  return String(Array.isArray(value) ? value[0] : value == null ? '' : value).trim();
}

// The lower-cased store id when the per-store path applies to this request, otherwise ''.
function storeIdFromRequest(req) {
  const value = headerValue(req, STORE_ID_HEADER);
  return UUID.test(value) ? value.toLowerCase() : '';
}

function serviceConfig() {
  const url = process.env.SUPABASE_URL || process.env.NEXT_PUBLIC_SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_SECRET_KEY;
  return url && key ? { url, key } : null;
}

async function readRows(url, key) {
  const response = await fetch(url, { headers: { apikey: key, Authorization: `Bearer ${key}` } });
  if (!response.ok) throw new Error('store_lookup_failed');
  const rows = await response.json();
  if (!Array.isArray(rows)) throw new Error('store_lookup_failed');
  return rows;
}

// Resolves to { storeId, config } when the store's own secret is accepted, otherwise to
// { denied: { status, body, retryAfter? } } that the handler sends back as is.
async function authenticateStoreWebhook(req, storeId) {
  const gate = limiter(clientIp(req));
  if (!gate.allowed) return { denied: { status: 429, retryAfter: gate.retryAfter, body: { ok: false, error: 'too_many_requests' } } };

  const provided = headerValue(req, SECRET_HEADER);
  if (!provided) return { denied: deny() };

  const config = serviceConfig();
  if (!config) return { denied: { status: 503, body: { ok: false, error: 'supabase_service_configuration_missing' } } };

  let stored = '';
  try {
    const params = new URLSearchParams({ select: 'webhook_secret,enabled', store_id: `eq.${storeId}`, limit: '1' });
    const rows = await readRows(`${config.url}/rest/v1/store_integrations?${params}`, config.key);
    // A switched-off integration no longer authenticates, exactly like a store without a secret.
    stored = rows[0] && rows[0].enabled !== false && typeof rows[0].webhook_secret === 'string' ? rows[0].webhook_secret : '';
  } catch (_) {
    return { denied: unavailable() };
  }

  const equal = safeEqual(provided, stored || DUMMY_SECRET);
  if (!stored || !equal) return { denied: deny() };
  return { storeId, config };
}

// null when the order with this tracking number belongs to the authenticated store, otherwise { status, body }
// (404 for an unknown order and for another store's order alike, 502 when Supabase cannot be read).
// A cancellation may also name the order by its checkout tracking number, like cancel_store_order_request does.
async function checkOrderOwnership(auth, trackingNumber, { checkoutNumber = false } = {}) {
  const tracking = String(trackingNumber == null ? '' : trackingNumber);
  if (!tracking) return notFound();
  const columns = checkoutNumber ? ['tracking_number', 'checkout_tracking_number'] : ['tracking_number'];
  try {
    for (const column of columns) {
      const params = new URLSearchParams({ select: 'id', store_id: `eq.${auth.storeId}`, [column]: `eq.${tracking}`, limit: '1' });
      const rows = await readRows(`${auth.config.url}/rest/v1/store_order_requests?${params}`, auth.config.key);
      if (rows.length) return null;
    }
  } catch (_) {
    return unavailable();
  }
  return notFound();
}

module.exports = { STORE_ID_HEADER, RATE_LIMIT, storeIdFromRequest, authenticateStoreWebhook, checkOrderOwnership };
