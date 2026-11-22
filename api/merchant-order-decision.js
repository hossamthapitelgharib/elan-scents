'use strict';
const { runMerchantAction } = require('../lib/merchant-adapter');

/* POST /api/merchant-order-decision — a merchant's decision on an order of ITS OWN store (Merchant Adapter). Élan normally gets the
   decision as the reply to the signed order message it sends (lib/merchant-dispatcher.js); this door takes the same decision, through the
   same database function, for a merchant system that answers the message late or separately, and it is idempotent.
   Approving carries only the https address of the MERCHANT'S payment window; rejecting needs a reason, which the customer is shown. Shipping, the
   final total, the payment methods and how long the window stays open are the merchant's own, inside its window: Élan reads none of them from here
   (a reply that still carries them is accepted and they are ignored).
   Body: { trackingNumber, decision: 'approve' | 'reject', reason?, paymentWindowUrl? }. */
module.exports = async function merchantOrderDecision(req, res) {
  return runMerchantAction(req, res, { rpc: 'merchant_review_order', fields: ['trackingNumber', 'decision', 'reason', 'paymentWindowUrl'] });
};
