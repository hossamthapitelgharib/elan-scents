'use strict';
const { runMerchantAction } = require('../lib/merchant-adapter');

/* POST /api/merchant-window-interaction — the merchant's signed report of what the customer does inside the MERCHANT'S payment window, which Élan cannot see.
   Élan keeps one clock for that window: the customer's idle time (30 minutes unless the merchant gave its own idleSeconds in the reply that opened the window),
   counted from the customer's LAST interaction. So the merchant reports:
     - event "activity" (the default): the customer did something in the window (chose or dropped a method, typed, moved on). The idle time starts again.
       Send it on every interaction, or at most once a minute: the idle time is 60 seconds at the least, so a report a minute is always in time.
     - event "provider_window": the customer left the merchant's window for the electronic payment provider's. The clock stops for good; the time is the provider's.
   A report after the idle time ran out is too late: the purchase was already cancelled ("تم إلغاء المعاملة برغبة العميل") and is never reopened. A merchant that reports
   nothing gets the plain idle time from the moment the window opened. Repeating a report changes nothing but the restart.
   Body: { trackingNumber, event? }. */
module.exports = async function merchantWindowInteraction(req, res) {
  return runMerchantAction(req, res, { rpc: 'merchant_window_interaction', fields: ['trackingNumber', 'event'] });
};
