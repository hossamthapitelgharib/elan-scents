'use strict';

/* The Merchant Adapter (phase 2 of the architecture plan, docs/implementation-phase-2-payment-merchant-shipping.ar.md).

   The one door a merchant's own server uses to tell Élan something about an order: its decision (approve / reject), a payment
   result, a shipment event. Every call must prove WHO the merchant is and that the message itself was not changed or replayed:

     1. X-Store-Id           the merchant's id (a store UUID). There is no shared secret on this door: a secret that works for every
                             store could touch every store's orders, which is exactly what this adapter exists to prevent.
     2. X-Store-Webhook-Secret   that merchant's own secret (store_integrations.webhook_secret, 16+ characters, integration enabled).
     3. X-Webhook-Timestamp / X-Webhook-Id / X-Webhook-Signature   an HMAC-SHA256 over `timestamp.id.body` made with the same secret,
                             inside a five-minute window. The id is the event id: the database remembers it per merchant, so a
                             replayed message is answered as a duplicate and applied once.

   After that the merchant id is passed to the database function, which looks the order up by tracking number AND that store.
   An order of another store therefore answers exactly like an order that does not exist, and a merchant can never read or write
   another merchant's order. Nothing the merchant sends is trusted as a fact about money: amounts are compared with the terms the
   platform froze at approval, and the database records a difference instead of overwriting anything. */

const { storeIdFromRequest, authenticateStoreWebhook, RATE_LIMIT } = require('./store-webhook-auth');
const { verify: verifySignature } = require('./store-webhook-signature');
const { setRateLimitHeaders } = require('./rate-limit');

const TRACKING = /^[A-Za-z0-9._-]{1,64}$/;

function send(res, status, body) {
  res.setHeader('Cache-Control', 'no-store');
  res.status(status).setHeader('Content-Type', 'application/json').json(body);
}

/* Messages the database raises on purpose (errcode P0001) and the answer a merchant gets for each. Anything that is not here is a
   failure of ours, never shown to the merchant as text. Order matters: the first match wins. */
const DATABASE_ERRORS = [
  [/Order not found/i, 404, 'order_not_found'],
  [/Decision must be approve or reject/i, 422, 'invalid_decision'],
  [/A rejection needs a reason/i, 422, 'reason_required'],
  [/Reason is too long/i, 422, 'reason_too_long'],
  [/Order is not waiting for the store/i, 409, 'order_not_waiting'],
  [/Configure a payment method before approving/i, 409, 'payment_method_required'],
  [/The approved payment terms are fixed/i, 409, 'payment_terms_fixed'],
  [/Invalid shipping amount|Invalid total amount|Total is below the products total/i, 422, 'invalid_amount'],
  [/Invalid payment method/i, 422, 'invalid_payment_method'],
  [/Invalid event id/i, 422, 'invalid_event_id'],
  [/Invalid event type/i, 422, 'invalid_event_type'],
  [/A provider transaction id is required/i, 422, 'transaction_id_required'],
  [/Invalid payment reference/i, 422, 'invalid_payment_reference'],
  [/Invalid amount/i, 422, 'invalid_amount'],
  [/Invalid time/i, 422, 'invalid_time'],
  [/Invalid shipping status/i, 422, 'invalid_shipping_status'],
  [/Shipment data is too long/i, 422, 'shipment_data_too_long'],
  [/Carrier and waybill are required/i, 422, 'carrier_and_waybill_required'],
  [/Order is not shippable/i, 409, 'order_not_shippable'],
  [/Payment is required before/i, 409, 'payment_required'],
  [/Invalid shipping transition/i, 409, 'invalid_shipping_transition']
];

function mapDatabaseError(status, raw) {
  let message = '';
  try { const body = JSON.parse(raw); message = `${body && body.message || ''}`; } catch (_) { message = String(raw || ''); }
  for (const [pattern, httpStatus, code] of DATABASE_ERRORS) if (pattern.test(message)) return { status: httpStatus, body: { ok: false, error: code } };
  console.error(`[merchant-adapter] database call failed with HTTP ${status}: ${String(raw || '').slice(0, 500)}`);
  return { status: 502, body: { ok: false, error: 'merchant_action_failed' } };
}

/* Resolves to { storeId, body, eventId } for a merchant that proved itself, or sends the refusal and resolves to null. */
async function authenticateMerchant(req, res) {
  if (req.method !== 'POST') { send(res, 405, { ok: false, error: 'method_not_allowed' }); return null; }
  const storeId = storeIdFromRequest(req);
  if (!storeId) { send(res, 401, { ok: false, error: 'merchant_identity_required' }); return null; }
  const auth = await authenticateStoreWebhook(req, storeId);
  if (auth.denied) {
    if (auth.denied.retryAfter) setRateLimitHeaders(res, { retryAfter: auth.denied.retryAfter, remaining: 0 }, RATE_LIMIT.max);
    send(res, auth.denied.status, auth.denied.body);
    return null;
  }
  const signed = verifySignature(req, auth.webhookSecret);
  if (!signed.ok) { send(res, 401, { ok: false, error: signed.error }); return null; }
  const body = req.body;
  if (!body || typeof body !== 'object' || Array.isArray(body)) { send(res, 400, { ok: false, error: 'invalid_body' }); return null; }
  return { storeId, config: auth.config, body, eventId: signed.eventId };
}

function validTracking(value) {
  return typeof value === 'string' && TRACKING.test(value.trim());
}

/* Only the listed fields travel on, the event id is the signed one (a body can not choose its own), and the merchant is the one that
   authenticated. Returns the database function's answer, already mapped for the merchant. */
async function runMerchantAction(req, res, { rpc, fields }) {
  const merchant = await authenticateMerchant(req, res);
  if (!merchant) return;
  const payload = {};
  for (const field of fields) if (merchant.body[field] !== undefined) payload[field] = merchant.body[field];
  if (!validTracking(payload.trackingNumber)) { send(res, 400, { ok: false, error: 'invalid_tracking_number' }); return; }
  payload.trackingNumber = payload.trackingNumber.trim();
  payload.eventId = merchant.eventId;
  try {
    const response = await fetch(`${merchant.config.url}/rest/v1/rpc/${rpc}`, {
      method: 'POST',
      headers: { apikey: merchant.config.key, Authorization: `Bearer ${merchant.config.key}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ p_store_id: merchant.storeId, p_payload: payload })
    });
    const raw = await response.text();
    if (!response.ok) { const mapped = mapDatabaseError(response.status, raw); send(res, mapped.status, mapped.body); return; }
    let data = null;
    try { data = raw ? JSON.parse(raw) : null; } catch (_) { data = null; }
    const result = Array.isArray(data) ? data[0] : data;
    send(res, 200, { ...(result && typeof result === 'object' ? result : {}), ok: true });
  } catch (_) {
    send(res, 502, { ok: false, error: 'merchant_action_failed' });
  }
}

module.exports = { authenticateMerchant, runMerchantAction, mapDatabaseError, validTracking, DATABASE_ERRORS };
