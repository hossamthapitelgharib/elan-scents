'use strict';
const { runMerchantAction } = require('../lib/merchant-adapter');

/* POST /api/merchant-order-decision — a merchant's decision on an order of ITS OWN store (Merchant Adapter). Élan normally gets the
   decision as the reply to the signed order message it sends (lib/merchant-dispatcher.js); this door takes the same decision, through the
   same database function, for a merchant system that answers the message late or separately, and it is idempotent.
   Approving carries the https address of the MERCHANT'S payment window (and optionally how long it stays valid, 60 to 1800 seconds, default
   1800) plus the shipping and total it will charge; rejecting needs a reason, which the customer is shown.
   Body: { trackingNumber, decision: 'approve' | 'reject', reason?, shipping?, total?, paymentWindowUrl?, validitySeconds? }. */
module.exports = async function merchantOrderDecision(req, res) {
  return runMerchantAction(req, res, { rpc: 'merchant_review_order', fields: ['trackingNumber', 'decision', 'reason', 'shipping', 'total', 'paymentWindowUrl', 'validitySeconds'] });
};
