'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { digest, verify, MAX_SKEW_SECONDS } = require('../lib/store-webhook-signature');

const secret = 'store-secret-for-signature-2026';
const body = { trackingNumber: 'T-1', status: 'completed', subtotal: 100 };
const timestamp = String(Math.floor(Date.now() / 1000));
const eventId = 'evt-20261103-1';
function request(overrides = {}) {
  return { body, headers: {
    'x-webhook-timestamp': timestamp,
    'x-webhook-id': eventId,
    'x-webhook-signature': digest(secret, timestamp, eventId, body),
    ...overrides,
  } };
}

test('HMAC covers timestamp, event id and the exact JSON body', () => {
  assert.deepEqual(verify(request(), secret), { ok: true, eventId });
  assert.equal(verify({ ...request(), body: { ...body, subtotal: 1 } }, secret).ok, false);
  assert.equal(verify(request({ 'x-webhook-id': 'another-event' }), secret).ok, false);
});

test('stale, malformed and missing signatures fail closed', () => {
  const old = String(Math.floor(Date.now() / 1000) - MAX_SKEW_SECONDS - 1);
  assert.equal(verify(request({ 'x-webhook-timestamp': old }), secret).error, 'stale_webhook_signature');
  assert.equal(verify(request({ 'x-webhook-signature': '00' }), secret).error, 'invalid_webhook_signature');
  assert.equal(verify({ body, headers: {} }, secret).ok, false);
});

test('a weak signing secret is never accepted', () => {
  assert.equal(verify(request(), 'short').ok, false);
});
