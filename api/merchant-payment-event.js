'use strict';
const { runMerchantAction } = require('../lib/merchant-adapter');

/* POST /api/merchant-payment-event — the merchant's (or its payment provider's) signed payment result for an order of ITS OWN store.
   This is the only way a card payment becomes «paid»: the customer's browser coming back from the payment page proves nothing.
   The platform applies it once (event id, and the provider transaction id) and only when the amount and the currency equal the
   terms frozen at approval; otherwise the event is recorded with its outcome and a platform admin is told.
   Body: { trackingNumber, eventType: 'payment.succeeded' | 'payment.failed', providerTransactionId, paymentReference?, provider?,
   amount, currency: 'EGP', occurredAt?, reason? }. */
module.exports = async function merchantPaymentEvent(req, res) {
  return runMerchantAction(req, res, { rpc: 'record_payment_event', fields: ['trackingNumber', 'eventType', 'providerTransactionId', 'paymentReference', 'provider', 'amount', 'currency', 'occurredAt', 'reason'] });
};
