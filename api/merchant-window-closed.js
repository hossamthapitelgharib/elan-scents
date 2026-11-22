'use strict';
const { runMerchantAction } = require('../lib/merchant-adapter');

/* POST /api/merchant-window-closed — the merchant's signed report that ITS OWN payment window ended (its own clock, or its own close mark).
   The duration of that window belongs to the merchant alone; Élan keeps no clock for it. An order whose payment was not made is cancelled at once and
   the customer, the platform dashboard and the store's dashboard are told; an order that is already paid, or whose customer came back from the window
   saying it worked, is left alone (a payment is decided by the payment provider's confirmation, never by this report). Repeating it changes nothing.
   Body: { trackingNumber, reason? }. */
module.exports = async function merchantWindowClosed(req, res) {
  return runMerchantAction(req, res, { rpc: 'merchant_window_closed', fields: ['trackingNumber', 'reason'] });
};
