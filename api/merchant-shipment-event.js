'use strict';
const { runMerchantAction } = require('../lib/merchant-adapter');

/* POST /api/merchant-shipment-event — the merchant's signed shipment event for an order of ITS OWN store (never before payment).
   Every accepted event is logged with its source and time and shown to the customer in «طلباتي». A «delivered» event with the
   carrier's waybill is the delivery evidence that approves the sale and starts the return window.
   Body: { trackingNumber, status: 'preparing'|'handed_to_carrier'|'in_transit'|'out_for_delivery'|'delivered'|'delayed'|'returned'|
   'cancelled', carrier?, trackingCode? (the waybill), note?, estimatedDeliveryAt?, occurredAt? }. */
module.exports = async function merchantShipmentEvent(req, res) {
  return runMerchantAction(req, res, { rpc: 'record_shipment_event', fields: ['trackingNumber', 'status', 'carrier', 'trackingCode', 'waybill', 'note', 'estimatedDeliveryAt', 'occurredAt'] });
};
