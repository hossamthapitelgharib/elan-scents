'use strict';
const { runMerchantAction } = require('../lib/merchant-adapter');

/* POST /api/merchant-order-decision — a merchant's decision on an order of ITS OWN store (Merchant Adapter). Élan normally gets the
   decision as the reply to the signed order message it sends (lib/merchant-dispatcher.js); this door takes the same decision, through the
   same database function, for a merchant system that answers the message late or separately, and it is idempotent.
   Approving carries the https address of the MERCHANT'S payment window, which must be on a host the store listed when it was linked, and optionally
   idleSeconds (60 to 86400): how long the customer may stay without any interaction in that window before the purchase is cancelled (30 minutes when it is
   not given; the merchant then reports the customer's interactions: /api/merchant-window-interaction). Rejecting needs a reason, which the customer is shown.
   Shipping, the final total and the payment methods are the merchant's own, inside its window: Élan reads none of them from here (a reply that still
   carries them is accepted and they are ignored).
   Body: { trackingNumber, decision: 'approve' | 'reject', reason?, paymentWindowUrl?, idleSeconds? }. */
module.exports = async function merchantOrderDecision(req, res) {
  return runMerchantAction(req, res, { rpc: 'merchant_review_order', fields: ['trackingNumber', 'decision', 'reason', 'paymentWindowUrl', 'idleSeconds'] });
};
