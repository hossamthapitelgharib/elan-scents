const test = require('node:test');
const assert = require('node:assert/strict');
const { SHIPPING_STATUS_LABELS, SHIPPING_STATUS_OPTIONS, SHIPPING_TRANSITIONS, canShippingTransition } = require('../lib/shipping-status');

test('every shipping status has an Arabic label and a transition entry, and options follow the labels', () => {
  assert.deepEqual(SHIPPING_STATUS_OPTIONS, Object.keys(SHIPPING_STATUS_LABELS));
  assert.deepEqual(Object.keys(SHIPPING_TRANSITIONS).sort(), [...SHIPPING_STATUS_OPTIONS].sort());
  for (const label of Object.values(SHIPPING_STATUS_LABELS)) assert.match(label, /[؀-ۿ]/, 'label is Arabic');
});

test('a transition table only targets known statuses and always allows re-saving the same status', () => {
  for (const [from, targets] of Object.entries(SHIPPING_TRANSITIONS)) {
    assert.ok(targets.has(from), `${from} can be saved again unchanged`);
    for (const to of targets) assert.ok(SHIPPING_STATUS_OPTIONS.includes(to), `${from} -> ${to} targets a known status`);
  }
});

test('final statuses never move, and a new shipment cannot skip the carrier hand-over', () => {
  for (const final of ['delivered', 'returned', 'cancelled']) {
    for (const to of SHIPPING_STATUS_OPTIONS) assert.equal(canShippingTransition(final, to), to === final, `${final} -> ${to}`);
  }
  assert.equal(canShippingTransition('preparing', 'handed_to_carrier'), true);
  assert.equal(canShippingTransition('preparing', 'cancelled'), true);
  for (const to of ['in_transit', 'out_for_delivery', 'delivered', 'delayed', 'returned']) assert.equal(canShippingTransition('preparing', to), false, `preparing -> ${to}`);
});

test('a delayed shipment can resume or finish, and the carrier path is allowed forward', () => {
  for (const to of ['in_transit', 'out_for_delivery', 'delivered', 'returned', 'cancelled']) assert.equal(canShippingTransition('delayed', to), true, `delayed -> ${to}`);
  assert.equal(canShippingTransition('handed_to_carrier', 'in_transit'), true);
  assert.equal(canShippingTransition('in_transit', 'out_for_delivery'), true);
  assert.equal(canShippingTransition('out_for_delivery', 'delivered'), true);
  assert.equal(canShippingTransition('out_for_delivery', 'preparing'), false, 'no move back to preparing');
});

test('unknown statuses are rejected instead of throwing', () => {
  assert.equal(canShippingTransition('nope', 'delivered'), false);
  assert.equal(canShippingTransition('preparing', 'nope'), false);
  assert.equal(canShippingTransition(undefined, undefined), false);
  assert.equal(canShippingTransition(null, 'preparing'), false);
});
