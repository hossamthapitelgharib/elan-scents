const { storeIdFromRequest, authenticateStoreWebhook, storeFailureStatus, RATE_LIMIT } = require('../lib/store-webhook-auth');
const { verify: verifyWebhookSignature } = require('../lib/store-webhook-signature');
const { setRateLimitHeaders } = require('../lib/rate-limit');

// A store reports what its own catalog measured, and the platform's four store rankings (best sellers, most viewed, most
// searched, most rated) are built from it:  POST /api/store-catalog-figures
//   headers  x-store-id: <the store's uuid>   x-store-webhook-secret: <the store's own secret>   (same as the order webhooks)
//   body     { "figures": [ { "store_product_id" | "product_size_id": "<uuid>",
//                             "units_sold": 12, "views_count": 340, "searches_count": 57,
//                             "average_rating": 4.6, "ratings_count": 31,
//                             "reported_at": "2026-11-08T10:00:00Z" } ] }
// Every figure is optional, but a rating comes with its count. At most 1000 offers per call; one wrong item refuses the whole
// call (nothing is half-written); sending the same report again is harmless, and an older report never overwrites a newer one.
//
// There is no shared-secret path on purpose: a figure always belongs to ONE store, and that store is the one that proved itself
// with its own secret. A store id written in the body is never used - only the authenticated one - and the database function
// (public.ingest_store_catalog_figures, service_role only) refuses any offer that is not that store's.
const MAX_FIGURES = 1000;
// Messages the database function raises on purpose for a store's own mistakes (HTTP 400, code 22023). Only these are shown to
// the store; anything else the database says stays in the server log.
const OWN_VALIDATION_MESSAGE = /^(item \d+: [\w .,'-]{1,160}|at most 1000 offers per call|p_figures must be a JSON array of objects)$/;

function send(res, status, body) {
  res.status(status).setHeader('Content-Type', 'application/json').json(body);
}

module.exports = async function storeCatalogFigures(req, res) {
  if (req.method === 'OPTIONS') {
    res.status(204).setHeader('Access-Control-Allow-Origin', '*').setHeader('Access-Control-Allow-Headers', 'Content-Type, X-Store-Id, X-Store-Webhook-Secret, X-Webhook-Timestamp, X-Webhook-Id, X-Webhook-Signature').setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS').end();
    return;
  }
  if (req.method !== 'POST') {
    send(res, 405, { ok: false, error: 'method_not_allowed' });
    return;
  }

  const storeId = storeIdFromRequest(req);
  if (!storeId) {
    send(res, 401, { ok: false, error: 'invalid_webhook_secret' });
    return;
  }
  const auth = await authenticateStoreWebhook(req, storeId);
  if (auth.denied) {
    if (auth.denied.retryAfter) setRateLimitHeaders(res, { retryAfter: auth.denied.retryAfter, remaining: 0 }, RATE_LIMIT.max);
    send(res, auth.denied.status, auth.denied.body);
    return;
  }
  if (process.env.STORE_WEBHOOK_SIGNATURE_REQUIRED === '1') {
    const signed = verifyWebhookSignature(req, auth.webhookSecret);
    if (!signed.ok) {
      send(res, 401, { ok: false, error: signed.error });
      return;
    }
  }

  const figures = req.body && req.body.figures;
  if (!Array.isArray(figures)) {
    send(res, 400, { ok: false, error: 'figures_must_be_an_array' });
    return;
  }
  if (figures.length > MAX_FIGURES) {
    send(res, 400, { ok: false, error: 'too_many_figures', max: MAX_FIGURES });
    return;
  }

  try {
    const response = await fetch(`${auth.config.url}/rest/v1/rpc/ingest_store_catalog_figures`, {
      method: 'POST',
      headers: { apikey: auth.config.key, Authorization: `Bearer ${auth.config.key}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ p_store_id: auth.storeId, p_figures: figures }),
    });
    const raw = await response.text();
    let result = null;
    try { result = raw ? JSON.parse(raw) : null; } catch (_) { result = null; }

    if (!response.ok) {
      if (response.status === 400 && result && result.code === '22023' && typeof result.message === 'string' && OWN_VALIDATION_MESSAGE.test(result.message)) {
        send(res, 422, { ok: false, error: 'invalid_figures', message: result.message });
        return;
      }
      send(res, storeFailureStatus('store-catalog-figures', response.status, raw), { ok: false, error: 'supabase_update_failed' });
      return;
    }
    send(res, 200, {
      ok: true,
      offers: result && result.offers,
      bestSellers: result && result.best_sellers,
      mostViewed: result && result.most_viewed,
      mostSearched: result && result.most_searched,
      ratings: result && result.ratings,
      skippedOlderThanStored: result && result.skipped_older_than_stored,
    });
  } catch (_) {
    send(res, 502, { ok: false, error: 'catalog_figures_processing_failed' });
  }
};
