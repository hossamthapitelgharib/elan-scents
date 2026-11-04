// Structural checks for the purchase notice a merchant sends to /api/store-order-status.
//
// This file only rejects input that is malformed (wrong type, absurd length, a number that is not a number). It never judges
// whether the merchant told the truth: a notice that is well formed but incomplete or different from what the customer ordered
// (no store order number, no carrier, a cheaper basket) still reaches the database function, which records the mismatch,
// keeps the commission on the platform's own base and flags the order for review. Keeping those two jobs apart means a
// merchant cannot hide a sale behind a validation error, and a typo in the payload cannot raise a database exception.
const crypto = require('node:crypto');

// Any UUID: the database accepts any, and a stricter check here would refuse an id the database would have matched.
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const MAX_ITEMS = 100;
const MAX_MONEY = 1e9;
const LIMITS = {
  trackingNumber: 64,
  storeOrderReference: 120,
  reason: 500,
  customerName: 200,
  customerPhone: 40,
  customerAddress: 500,
  customerEmail: 200,
  carrier: 120,
  shipmentTrackingCode: 160,
  shipmentStatus: 40,
  shipmentNote: 500,
  currency: 8,
  platformOrderNumber: 80,
  merchantOrderReference: 160,
};

function isPlainObject(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function textError(value, name, max, { required = false } = {}) {
  if (value === undefined || value === null || value === '') return required ? `${name} is required` : null;
  if (typeof value !== 'string') return `${name} must be text`;
  if (value.length > max) return `${name} is too long`;
  return null;
}

// A money amount is a finite, non-negative number or a numeric string. Anything else would become a database cast error.
function moneyError(value, name, { required = false } = {}) {
  if (value === undefined || value === null || value === '') return required ? `${name} is required` : null;
  if (typeof value !== 'number' && typeof value !== 'string') return `${name} must be a number`;
  if (typeof value === 'string' && !/^\d+(\.\d+)?$/.test(value.trim())) return `${name} must be a number`;
  const amount = Number(value);
  if (!Number.isFinite(amount) || amount < 0 || amount > MAX_MONEY) return `${name} is out of range`;
  return null;
}

function itemError(item, index) {
  const at = `items[${index}]`;
  if (!isPlainObject(item)) return `${at} must be an object`;
  // Every item field is optional here on purpose: a missing field is a difference the database records (and the order goes
  // to review), while a field of the wrong type would only become a database cast error.
  if (item.productSizeId !== undefined && item.productSizeId !== null && item.productSizeId !== '' && (typeof item.productSizeId !== 'string' || !UUID.test(item.productSizeId))) {
    return `${at}.productSizeId must be the platform product-size id`;
  }
  if (item.quantity !== undefined && item.quantity !== null && (!Number.isInteger(item.quantity) || item.quantity < 1 || item.quantity > 999)) {
    return `${at}.quantity must be a whole number from 1 to 999`;
  }
  return textError(item.platformOrderNumber, `${at}.platformOrderNumber`, LIMITS.platformOrderNumber)
    || textError(item.merchantOrderReference, `${at}.merchantOrderReference`, LIMITS.merchantOrderReference)
    || moneyError(item.unitPrice, `${at}.unitPrice`)
    || moneyError(item.total, `${at}.total`)
    || textError(item.currency, `${at}.currency`, LIMITS.currency);
}

function shipmentError(shipment) {
  if (shipment === undefined || shipment === null) return null;
  if (!isPlainObject(shipment)) return 'shipment must be an object';
  const eta = shipment.estimatedDeliveryAt;
  if (eta !== undefined && eta !== null && eta !== '' && (typeof eta !== 'string' || !Number.isFinite(Date.parse(eta)))) {
    return 'shipment.estimatedDeliveryAt must be a date';
  }
  return textError(shipment.carrier, 'shipment.carrier', LIMITS.carrier)
    || textError(shipment.trackingCode, 'shipment.trackingCode', LIMITS.shipmentTrackingCode)
    || textError(shipment.status, 'shipment.status', LIMITS.shipmentStatus)
    || textError(shipment.note, 'shipment.note', LIMITS.shipmentNote);
}

function customerError(customer) {
  if (!isPlainObject(customer)) return 'customer is required';
  return textError(customer.name, 'customer.name', LIMITS.customerName, { required: true })
    || textError(customer.phone, 'customer.phone', LIMITS.customerPhone, { required: true })
    || textError(customer.address, 'customer.address', LIMITS.customerAddress, { required: true })
    || textError(customer.email, 'customer.email', LIMITS.customerEmail)
    || (customer.id !== undefined && customer.id !== null && customer.id !== '' && (typeof customer.id !== 'string' || !UUID.test(customer.id)) ? 'customer.id must be the platform customer id' : null);
}

// Returns null when the notice is well formed, otherwise a short English message for the merchant's developer.
function validatePurchaseNotice(payload) {
  const top = textError(payload.trackingNumber, 'trackingNumber', LIMITS.trackingNumber, { required: true })
    || customerError(payload.customer);
  if (top) return top;
  if (!Array.isArray(payload.items) || payload.items.length === 0) return 'items are required';
  if (payload.items.length > MAX_ITEMS) return 'items has too many lines';
  for (let i = 0; i < payload.items.length; i += 1) {
    const problem = itemError(payload.items[i], i);
    if (problem) return problem;
  }
  return moneyError(payload.subtotal, 'subtotal', { required: true })
    || moneyError(payload.shipping, 'shipping')
    || moneyError(payload.total, 'total')
    || textError(payload.storeOrderReference, 'storeOrderReference', LIMITS.storeOrderReference)
    || textError(payload.reason, 'reason', LIMITS.reason)
    || shipmentError(payload.shipment);
}

// Used only when the merchant sends no eventId / idempotencyKey. Every field the database reads is part of the key, so a
// corrected notice (a real store order number, a carrier, a shipment status) is a new event and not swallowed as a repeat.
function fallbackIdempotencyKey(payload) {
  const material = {
    trackingNumber: payload.trackingNumber,
    status: payload.status,
    subtotal: payload.subtotal,
    shipping: payload.shipping,
    total: payload.total,
    storeOrderReference: payload.storeOrderReference,
    reason: payload.reason,
    shipment: payload.shipment,
    customer: payload.customer,
    items: payload.items,
  };
  return crypto.createHash('sha256').update(JSON.stringify(material)).digest('hex');
}

module.exports = { validatePurchaseNotice, fallbackIdempotencyKey, UUID, LIMITS };
