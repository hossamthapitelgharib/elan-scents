const STATUS_LABELS={
  awaiting_store_confirmation:'بانتظار المتجر',
  store_confirmed:'تم تأكيد الطلب',
  processing:'قيد التجهيز',
  shipped:'تم الشحن',
  delivered:'تم التسليم',
  completed:'مكتمل',
  store_rejected:'مرفوض من المتجر',
  store_cancelled:'أُلغي من المتجر',
  restored:'عادت المنتجات للسلة',
  needs_review:'يحتاج مراجعة'
};
const STORE_TRANSITIONS={
  awaiting_store_confirmation:new Set(['store_confirmed','store_rejected']),
  store_confirmed:new Set(['processing','store_rejected']),
  processing:new Set(['shipped']),
  shipped:new Set(['delivered']),
  delivered:new Set(),
  completed:new Set(),
  store_rejected:new Set(),
  store_cancelled:new Set(),
  restored:new Set(),
  needs_review:new Set(['store_confirmed','store_rejected'])
};
function canStoreTransition(from,to){return Boolean(STORE_TRANSITIONS[from]&&STORE_TRANSITIONS[from].has(to));}
module.exports={STATUS_LABELS,STORE_TRANSITIONS,canStoreTransition};
