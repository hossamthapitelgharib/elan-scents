const escS = value => String(value ?? '').replace(/[&<>"']/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#039;' }[char]));
const labelS = { awaiting_store_confirmation: 'بانتظار التنفيذ', store_confirmed: 'تم التأكيد', processing: 'قيد التجهيز', shipped: 'تم الشحن', delivered: 'تم التسليم', store_rejected: 'مرفوض', cancelled: 'ملغى', store_cancelled: 'ملغى', needs_review: 'يحتاج مراجعة', completed: 'مكتمل', cancelled: 'ملغى' };
const shippingLabels = { preparing: 'قيد التجهيز', handed_to_carrier: 'تم تسليمها لشركة الشحن', in_transit: 'في الطريق', out_for_delivery: 'خرجت للتسليم', delivered: 'تم التسليم', delayed: 'متأخرة', returned: 'مرتجعة', cancelled: 'ملغاة' };
const badgeS = status => `<span class="badge ${status === 'delivered' ? 'green' : ['store_rejected', 'store_cancelled', 'returned', 'cancelled'].includes(status) ? 'red' : ['processing', 'shipped', 'in_transit', 'out_for_delivery', 'handed_to_carrier'].includes(status) ? 'blue' : status === 'delayed' ? 'orange' : ''}">${escS(labelS[status] || status || '—')}</span>`;
const shipmentBadgeS = status => `<span class="badge ${status === 'delivered' ? 'green' : ['returned', 'cancelled'].includes(status) ? 'red' : status === 'delayed' ? 'orange' : status ? 'blue' : 'muted'}">${escS(shippingLabels[status] || 'لم تُسجل')}</span>`;
const moneyS = (value, currency = 'EGP') => `${Number(value || 0).toLocaleString('ar-EG', { minimumFractionDigits: 2, maximumFractionDigits: 2 })} ${escS(currency)}`;
const reconS = { pending: 'بانتظار المطابقة', matched: 'مطابق', mismatched: 'غير مطابق' };
const stateS = { orders: [], offset: 0, limit: 50, total: null, hasMore: false, busy: false, linked: null, filters: { status: '', q: '' } };
const shipmentOf = order => (order.store_shipments || [])[0] || {};
// ---- payment and the shipment timeline (read only: the order reaches the store through its technical link and is answered by it, nobody here presses anything) ---------------------------------------------------------------------------
const payLabelS = { not_started: 'بانتظار الدفع', awaiting_payment: 'بانتظار تأكيد الدفع', paid: 'تم الدفع', cod_selected: 'الدفع عند الاستلام', failed: 'تعذر الدفع' };
const payKindS = { card: 'بطاقة', cod: 'الدفع عند الاستلام', other: 'طريقة أخرى' };
const sourceS = { merchant_api: 'واجهة المتجر', merchant_notice: 'إشعار المتجر', store_dashboard: 'لوحة المتجر', platform_admin: 'المنصة' };
const paymentDoneS = order => ['paid', 'cod_selected'].includes(order.payment_status);
function paymentBoxS(order) {
  if (['awaiting_store_confirmation', 'store_rejected', 'store_cancelled', 'cancelled', 'restored'].includes(order.status)) return '';
  const status = order.payment_status || 'not_started';
  const amount = order.payable_amount != null ? `<br>المبلغ المعتمد: <b>${moneyS(order.payable_amount, order.currency)}</b>` : '';
  const reference = order.payment_reference ? `<br>مرجع الدفع: <span dir="ltr">${escS(order.payment_reference)}</span>` : '';
  const paid = order.paid_at ? `<br>وقت الدفع: ${escS(new Date(order.paid_at).toLocaleString('ar-EG', { dateStyle: 'medium', timeStyle: 'short' }))}` : '';
  const method = order.payment_method ? `<br>الطريقة: ${escS(payKindS[order.payment_method] || order.payment_method)}` : '';
  const gate = paymentDoneS(order) ? '' : '<br><b>يُجهَّز الطلب بعد تأكيد الدفع من جهة محايدة.</b>';
  return `<section class="shipment-box store-shipment-box" aria-label="الدفع"><div class="shipment-head"><div><small>الدفع</small><strong>${escS(payLabelS[status] || status)}</strong></div></div><p class="shipment-note">${amount.replace(/^<br>/, '')}${method}${reference}${paid}${gate}</p></section>`;
}
function shipmentEventsS(order) {
  const events = order.store_shipment_events || [];
  if (!events.length) return '';
  return `<section class="shipment-box" aria-label="سجل الشحن"><div class="shipment-head"><div><small>سجل أحداث الشحن</small></div></div><ol class="shipment-log">${events.map(event => `<li>${shipmentBadgeS(event.shipping_status)} <span>${escS(new Date(event.occurred_at).toLocaleString('ar-EG', { dateStyle: 'medium', timeStyle: 'short' }))}${event.carrier_name ? ` · ${escS(event.carrier_name)}` : ''}${event.tracking_code ? ` · <bdi dir="ltr">${escS(event.tracking_code)}</bdi>` : ''} · <small class="muted">${escS(sourceS[event.source] || '')}</small>${event.note ? `<small>${escS(event.note)}</small>` : ''}</span></li>`).join('')}</ol></section>`;
}
function renderStats() {
  const orders = stateS.orders;
  const count = predicate => orders.filter(predicate).length;
  const cards = [
    ['طلبات محمّلة', orders.length],
    ['بانتظار التنفيذ', count(order => order.status === 'awaiting_store_confirmation')],
    ['قيد التجهيز', count(order => order.status === 'processing')],
    ['تم الشحن', count(order => order.status === 'shipped' || shipmentOf(order).shipping_status === 'in_transit')],
    ['تم التسليم', count(order => order.status === 'delivered' || shipmentOf(order).shipping_status === 'delivered')]
  ];
  document.querySelector('#stats').innerHTML = cards.map(([label, value]) => `<div class="stat"><small>${label}</small><b>${value.toLocaleString('ar-EG')}</b></div>`).join('');
  const total = stateS.total == null ? '—' : stateS.total.toLocaleString('ar-EG');
  const summary = document.querySelector('#ordersSummary');
  summary.textContent = `تم تحميل ${orders.length.toLocaleString('ar-EG')} من ${total} طلب. الإحصاءات أعلاه تخص الطلبات المحمّلة.`;
  summary.hidden = false;
}
// Why an order ended without a sale, as the store's own link answered it or failed to (read only).
function failureS(order) {
  if (order.status === 'store_rejected' && order.failure_reason) return `<div class="cancel-box cancel-accepted" role="status"><b>ردّ المتجر</b><span>${escS(order.failure_reason)}</span></div>`;
  if (order.status === 'cancelled') return '<div class="cancel-box cancel-accepted" role="status"><b>أُلغي الطلب</b><span>لم يُستكمل الدفع أو لم يردّ المتجر في الوقت المحدد.</span></div>';
  return '';
}
function shipmentSummaryS(order) {
  const shipment = shipmentOf(order);
  if (!shipment.shipping_status) return '';
  return `<section class="shipment-box store-shipment-box"><div class="shipment-head"><div><small>الشحنة</small><strong>${shipmentBadgeS(shipment.shipping_status)}</strong></div>${shipment.carrier_name ? `<span class="shipment-scope">${escS(shipment.carrier_name)}</span>` : ''}</div></section>`;
}
function renderStore(order) {
  const items = (order.store_order_request_items || []).map(item => `<div class="item"><span>${escS(item.product_name)}${item.brand_name ? ` · ${escS(item.brand_name)}` : ''}${item.size_label ? ` · ${escS(item.size_label)}` : ''} × ${Number(item.quantity || 0).toLocaleString('ar-EG')}<small>سعر الوحدة: ${moneyS(item.unit_price, item.currency)}${item.platform_order_number ? ` · رقم البند: <span dir="ltr">${escS(item.platform_order_number)}</span>` : ''}</small></span><b>${moneyS(item.line_total, item.currency)}</b></div>`).join('');
  return `<article class="order"><h3>${escS(order.customer_name || 'عميل')} · <span dir="ltr">${escS(order.tracking_number || '—')}</span></h3><div class="meta"><span>طلب جديد عبر Élan Scents</span><span>${escS(order.stores && order.stores.name || '')}</span>${badgeS(order.status)}<span>المطابقة: ${escS(reconS[order.reconciliation_status] || '—')}</span></div><div class="grid"><div><b>بيانات التسليم الضرورية لهذا الطلب</b><p>الاسم: ${escS(order.customer_name || '—')}<br>الهاتف: ${escS(order.customer_phone || '—')}${order.customer_email ? `<br>البريد: <span dir="ltr">${escS(order.customer_email)}</span>` : ''}<br>العنوان: ${escS(order.customer_address || '—')}${order.customer_notes ? `<br>ملاحظات: ${escS(order.customer_notes)}` : ''}</p><p class="meta">رقم تتبع Élan Scents: <span dir="ltr">${escS(order.tracking_number || '—')}</span>${order.merchant_order_number ? `<br>رقم طلب المتجر: <span dir="ltr">${escS(order.merchant_order_number)}</span>` : ''}${order.merchant_invoice_number ? `<br>رقم الفاتورة: <span dir="ltr">${escS(order.merchant_invoice_number)}</span>` : ''}</p></div><div><b>المنتجات</b>${items || '<p class="meta">لا توجد بنود محفوظة.</p>'}<p><b>الإجمالي: ${moneyS(order.total_amount ?? order.subtotal, order.currency)}</b></p></div></div>${failureS(order)}${paymentBoxS(order)}${shipmentSummaryS(order)}${shipmentEventsS(order)}</article>`;
}
function renderOrders() {
  const container = document.querySelector('#orders');
  const filtered = Boolean(stateS.filters.status || stateS.filters.q);
  container.innerHTML = stateS.orders.length ? stateS.orders.map(renderStore).join('') : `<div class="empty">${filtered ? 'لا توجد طلبات تطابق هذا البحث' : 'لا توجد طلبات لهذا المتجر'}</div>`;
  const more = document.querySelector('#loadMoreOrders');
  more.hidden = !stateS.hasMore;
  more.disabled = stateS.busy;
  renderStats();
}
async function loadStore(append = false) {
  if (!Portal.session() || stateS.busy) return;
  document.querySelector('#login').hidden = true;
  document.querySelector('#app').hidden = false;
  document.querySelector('#logout').hidden = false;
  stateS.busy = true;
  const offset = append ? stateS.offset : 0;
  const more = document.querySelector('#loadMoreOrders');
  const error = document.querySelector('#storeOrdersError');
  more.disabled = true;
  error.hidden = true;
  if (!append) document.querySelector('#orders').innerHTML = '<p class="muted">جارٍ تحميل الطلبات…</p>';
  try {
    const params = new URLSearchParams({ limit: String(stateS.limit), offset: String(offset) });
    if (stateS.filters.status) params.set('status', stateS.filters.status);
    if (stateS.filters.q) params.set('q', stateS.filters.q);
    const response = await fetch(`/api/store-dashboard-orders?${params}`, { headers: Portal.auth() });
    const data = await response.json().catch(() => null);
    if (!response.ok || !data) throw new Error(data && data.error || 'store_dashboard_failed');
    stateS.linked = Array.isArray(data.stores) ? data.stores.length : null;
    const page = Array.isArray(data.orders) ? data.orders : [];
    stateS.orders = append ? stateS.orders.concat(page) : page;
    stateS.offset = offset + page.length;
    stateS.total = data.pagination && Number.isFinite(Number(data.pagination.total)) ? Number(data.pagination.total) : null;
    stateS.hasMore = Boolean(data.pagination && data.pagination.hasMore);
    renderOrders();
    document.querySelector('#noStoreNotice').hidden = stateS.linked !== 0;
  } catch (cause) {
    error.textContent = Portal.errorText(cause, 'تعذر تحميل طلبات المتجر.');
    error.hidden = false;
    if (!append) document.querySelector('#orders').innerHTML = '';
  } finally {
    stateS.busy = false;
    more.disabled = false;
    more.hidden = !stateS.hasMore;
  }
}
document.querySelector('#loadMoreOrders').addEventListener('click', () => loadStore(true));
document.querySelector('#refreshOrders').addEventListener('click', () => loadStore());
document.querySelector('#orderFilters').addEventListener('submit', event => {
  event.preventDefault();
  const form = event.target;
  stateS.filters = { status: String(form.elements.status.value || ''), q: String(form.elements.q.value || '').trim() };
  loadStore();
});
document.querySelector('#loginForm').addEventListener('submit', async event => {
  event.preventDefault();
  try {
    await Portal.login(event.target);
    await loadStore();
  } catch (error) {
    document.querySelector('#message').textContent = Portal.errorText(error, 'تعذر تسجيل الدخول، حاول مرة أخرى.');
  }
});
if (Portal.session()) loadStore();
