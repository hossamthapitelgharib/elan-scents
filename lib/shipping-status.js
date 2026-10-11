const SHIPPING_STATUS_LABELS = {
  preparing: 'قيد التجهيز',
  handed_to_carrier: 'تم تسليمها لشركة الشحن',
  in_transit: 'في الطريق',
  out_for_delivery: 'خرجت للتسليم',
  delivered: 'تم التسليم',
  delayed: 'متأخرة',
  returned: 'مرتجعة',
  cancelled: 'ملغاة'
};

const SHIPPING_STATUS_OPTIONS = Object.keys(SHIPPING_STATUS_LABELS);
const SHIPPING_TRANSITIONS = {
  preparing: new Set(['preparing', 'handed_to_carrier', 'cancelled']),
  handed_to_carrier: new Set(['handed_to_carrier', 'in_transit', 'out_for_delivery', 'delayed', 'delivered', 'returned', 'cancelled']),
  in_transit: new Set(['in_transit', 'out_for_delivery', 'delayed', 'delivered', 'returned', 'cancelled']),
  out_for_delivery: new Set(['out_for_delivery', 'delivered', 'delayed', 'returned', 'cancelled']),
  delivered: new Set(['delivered']),
  delayed: new Set(['delayed', 'in_transit', 'out_for_delivery', 'delivered', 'returned', 'cancelled']),
  returned: new Set(['returned']),
  cancelled: new Set(['cancelled'])
};

function canShippingTransition(from, to) {
  return Boolean(SHIPPING_TRANSITIONS[from] && SHIPPING_TRANSITIONS[from].has(to));
}

module.exports = { SHIPPING_STATUS_LABELS, SHIPPING_STATUS_OPTIONS, SHIPPING_TRANSITIONS, canShippingTransition };
