'use strict';

const crypto = require('node:crypto');

const TIMESTAMP_HEADER = 'x-webhook-timestamp';
const SIGNATURE_HEADER = 'x-webhook-signature';
const EVENT_HEADER = 'x-webhook-id';
const MAX_SKEW_SECONDS = 300;
const HEX = /^[a-f0-9]{64}$/i;

function header(req, name) {
  const value = req && req.headers ? req.headers[name] : undefined;
  return String(Array.isArray(value) ? value[0] : value == null ? '' : value).trim();
}

function canonicalBody(body) {
  return typeof body === 'string' ? body : JSON.stringify(body == null ? {} : body);
}

function digest(secret, timestamp, eventId, body) {
  return crypto.createHmac('sha256', secret)
    .update(`${timestamp}.${eventId}.${canonicalBody(body)}`, 'utf8')
    .digest('hex');
}

function verify(req, secret, nowSeconds = Math.floor(Date.now() / 1000)) {
  if (typeof secret !== 'string' || secret.length < 16) return { ok: false, error: 'invalid_webhook_signature' };
  const timestamp = header(req, TIMESTAMP_HEADER);
  const eventId = header(req, EVENT_HEADER);
  const signature = header(req, SIGNATURE_HEADER);
  if (!/^\d{1,12}$/.test(timestamp) || !eventId || eventId.length > 200 || !HEX.test(signature)) {
    return { ok: false, error: 'invalid_webhook_signature' };
  }
  const age = Math.abs(nowSeconds - Number(timestamp));
  if (!Number.isSafeInteger(Number(timestamp)) || age > MAX_SKEW_SECONDS) {
    return { ok: false, error: 'stale_webhook_signature' };
  }
  const expected = digest(secret, timestamp, eventId, req.body);
  const valid = crypto.timingSafeEqual(Buffer.from(signature, 'hex'), Buffer.from(expected, 'hex'));
  return valid ? { ok: true, eventId } : { ok: false, error: 'invalid_webhook_signature' };
}

module.exports = { TIMESTAMP_HEADER, SIGNATURE_HEADER, EVENT_HEADER, MAX_SKEW_SECONDS, canonicalBody, digest, verify };
