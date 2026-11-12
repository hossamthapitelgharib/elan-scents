'use strict';
const { runMerchantAction } = require('../lib/merchant-adapter');

/* POST /api/merchant-order-decision — the merchant approves or rejects an order of ITS OWN store (Merchant Adapter, phase 2).
   Approving fixes what the customer will be asked to pay (products + shipping, or the merchant's own total) and the payment methods
   offered for this order (the store's methods, or `paymentMethods` sent here); the platform freezes that snapshot at approval.
   Rejecting needs a reason, which the customer is shown. Body: { trackingNumber, decision: 'approve' | 'reject', reason?, shipping?,
   total?, paymentMethods?: [{ kind: 'card'|'cod'|'other', mode?, provider?, labelAr, labelEn?, redirectUrl? }] }. */
module.exports = async function merchantOrderDecision(req, res) {
  return runMerchantAction(req, res, { rpc: 'merchant_review_order', fields: ['trackingNumber', 'decision', 'reason', 'shipping', 'total', 'paymentMethods'] });
};
