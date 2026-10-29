const escS = value => String(value ?? '').replace(/[&<>"']/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#039;' }[char]));
const labelS = { awaiting_store_confirmation: 'بانتظار التنفيذ', store_confirmed: 'تم التأكيد', processing: 'قيد التجهيز', shipped: 'تم الشحن', delivered: 'تم التسليم', store_rejected: 'مرفوض', store_cancelled: 'ملغى', needs_review: 'يحتاج مراجعة', completed: 'مكتمل', cancelled: 'ملغى' };
const nextS = { awaiting_store_confirmation: ['store_confirmed', 'store_rejected'], store_confirmed: ['processing', 'store_rejected'], processing: ['shipped'], shipped: ['delivered'] };
const shippingLabels = { preparing: 'قيد التجهيز', handed_to_carrier: 'تم تسليمها لشركة الشحن', in_transit: 'في الطريق', out_for_delivery: 'خرجت للتسليم', delivered: 'تم التسليم', delayed: 'متأخرة', returned: 'مرتجعة', cancelled: 'ملغاة' };
const badgeS = status => `<span class="badge ${status === 'delivered' ? 'green' : ['store_rejected', 'store_cancelled', 'returned', 'cancelled'].includes(status) ? 'red' : ['processing', 'shipped', 'in_transit', 'out_for_delivery', 'handed_to_carrier'].includes(status) ? 'blue' : status === 'delayed' ? 'orange' : ''}">${escS(labelS[status] || status || '—')}</span>`;
const shipmentBadgeS = status => `<span class="badge ${status === 'delivered' ? 'green' : ['returned', 'cancelled'].includes(status) ? 'red' : status === 'delayed' ? 'orange' : status ? 'blue' : 'muted'}">${escS(shippingLabels[status] || 'لم تُسجل')}</span>`;
const moneyS = (value, currency = 'EGP') => `${Number(value || 0).toLocaleString('ar-EG', { minimumFractionDigits: 2, maximumFractionDigits: 2 })} ${escS(currency)}`;
const reconS = { pending: 'بانتظار المطابقة', matched: 'مطابق', mismatched: 'غير مطابق' };
// The store records a shipment only once it has confirmed the order, and never for an order it rejected or cancelled
// (the API refuses the last case too).
const shippableS = new Set(['store_confirmed', 'processing', 'shipped', 'delivered', 'needs_review', 'completed']);
const stateS = { orders: [], offset: 0, limit: 50, total: null, hasMore: false, busy: false, linked: null, filters: { status: '', q: '' } };
const shipmentOf = order => (order.store_shipments || [])[0] || {};
function shipmentForm(order) {
  const shipment = shipmentOf(order);
  return `<section class="shipment-box store-shipment-box"><div class="shipment-head"><div><small>شحن هذا المتجر فقط</small><strong>${shipmentBadgeS(shipment.shipping_status)}</strong></div><span class="shipment-scope">لا يوجد ربط آلي بشركات الشحن</span></div><form data-shipment-form="${escS(order.id)}" class="shipment-form"><label>شركة الشحن<input name="carrierName" value="${escS(shipment.carrier_name || '')}" maxlength="120" placeholder="مثال: Aramex أو شحن المتجر"></label><label>رقم التتبع<input name="trackingCode" dir="ltr" value="${escS(shipment.tracking_code || '')}" maxlength="160" placeholder="يُدخل يدويًا من المتجر"></label><label>حالة الشحن<select name="shippingStatus">${Object.entries(shippingLabels).map(([key, label]) => `<option value="${key}"${shipment.shipping_status === key ? ' selected' : ''}>${label}</option>`).join('')}</select></label><label>التسليم المتوقع<input name="estimatedDeliveryAt" type="date" value="${shipment.estimated_delivery_at ? String(shipment.estimated_delivery_at).slice(0, 10) : ''}"></label><label class="shipment-note-field">ملاحظة للعميل<textarea name="statusNote" maxlength="500" rows="2" placeholder="اختياري">${escS(shipment.status_note || '')}</textarea></label><button class="action" type="submit">حفظ تحديث الشحن</button></form></section>`;
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
// The customer may ask to cancel while the order waits for the store. It is only a request: the store answers it with the
// actions it already has («مرفوض» accepts the cancellation, «تم التأكيد» goes on with the order and so declines it).
function cancelNoticeS(order) {
  const asked = (order.store_order_cancellation_requests || [])[0];
  if (!asked) return '';
  const reason = asked.reason ? `<br>السبب: ${escS(asked.reason)}` : '';
  if (order.status === 'awaiting_store_confirmation') return `<div class="cancel-box cancel-pending" role="status"><b>طلب إلغاء من العميل</b><span>طلب العميل إلغاء هذا الطلب قبل تأكيده.${reason}<br>للموافقة على الإلغاء اختر «${labelS.store_rejected}»، واختيار «${labelS.store_confirmed}» يعني متابعة الطلب دون إلغائه.</span></div>`;
  if (['store_rejected', 'store_cancelled', 'cancelled'].includes(order.status)) return `<div class="cancel-box cancel-accepted" role="status"><b>طلب إلغاء من العميل</b><span>طلب العميل إلغاء هذا الطلب وقد أُلغي.${reason}</span></div>`;
  return `<div class="cancel-box cancel-declined" role="status"><b>طلب إلغاء من العميل</b><span>طلب العميل الإلغاء قبل التأكيد، ومضى الطلب في التنفيذ.${reason}</span></div>`;
}
function renderStore(order) {
  const actions = (nextS[order.status] || []).map(status => `<button class="action" data-update="${escS(order.id)}" data-status="${status}">${labelS[status]}</button>`).join('');
  const items = (order.store_order_request_items || []).map(item => `<div class="item"><span>${escS(item.product_name)}${item.brand_name ? ` · ${escS(item.brand_name)}` : ''}${item.size_label ? ` · ${escS(item.size_label)}` : ''} × ${Number(item.quantity || 0).toLocaleString('ar-EG')}<small>سعر الوحدة: ${moneyS(item.unit_price, item.currency)}</small></span><b>${moneyS(item.line_total, item.currency)}</b></div>`).join('');
  return `<article class="order"><h3>${escS(order.customer_name || 'عميل')} · <span dir="ltr">${escS(order.tracking_number || '—')}</span></h3><div class="meta"><span>${escS(order.stores && order.stores.name || '')}</span>${badgeS(order.status)}<span>المطابقة: ${escS(reconS[order.reconciliation_status] || '—')}</span></div><div class="grid"><div><b>بيانات التسليم الضرورية لهذا الطلب</b><p>الهاتف: ${escS(order.customer_phone || '—')}<br>العنوان: ${escS(order.customer_address || '—')}</p></div><div><b>المنتجات</b>${items || '<p class="meta">لا توجد بنود محفوظة.</p>'}<p><b>الإجمالي: ${moneyS(order.total_amount ?? order.subtotal, order.currency)}</b></p></div></div>${cancelNoticeS(order)}${shippableS.has(order.status) ? shipmentForm(order) : ''}${actions ? `<div class="actions">${actions}</div>` : '<p class="meta">لا توجد خطوة متاحة لهذا الطلب الآن.</p>'}</article>`;
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
    showOrderAction('');
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
function showOrderAction(message) {
  const box = document.querySelector('#orderActionError');
  box.textContent = message || '';
  box.hidden = !message;
}
async function updateOrder(button) {
  const body = { requestId: button.dataset.update, status: button.dataset.status };
  if (body.status === 'store_rejected') {
    // Rejecting cannot be undone by the store, so it asks first; the reason is optional and is kept with the order.
    const reason = window.prompt('رفض هذا الطلب؟ اكتب سبب الرفض (اختياري) ثم اضغط موافق، أو اضغط إلغاء للتراجع.', '');
    if (reason === null) return;
    if (reason.trim()) body.reason = reason.trim().slice(0, 500);
  }
  button.disabled = true;
  showOrderAction('');
  try {
    const response = await fetch('/api/store-order-update', { method: 'PATCH', headers: { ...Portal.auth(), 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
    const data = await response.json().catch(() => null);
    if (!response.ok || !data) {
      const code = data && data.error || 'store_update_failed';
      const stale = code === 'order_status_changed' || code === 'invalid_status_transition';
      if (stale) await loadStore();
      const message = stale ? 'تغيّرت حالة الطلب قبل تنفيذ التحديث، وتم تحديث القائمة. راجع الحالة الحالية ثم أعد المحاولة.' : Portal.errorText(code, 'تعذر تحديث حالة الطلب.');
      throw new Error(message);
    }
    await loadStore();
  } catch (error) {
    showOrderAction(Portal.errorText(error, 'تعذر تحديث حالة الطلب.'));
    button.disabled = false;
  }
}
async function updateShipment(form) {
  const button = form.querySelector('button');
  button.disabled = true;
  showOrderAction('');
  try {
    const body = Object.fromEntries(new FormData(form));
    body.requestId = form.dataset.shipmentForm;
    const response = await fetch('/api/store-shipment-update', { method: 'PATCH', headers: { ...Portal.auth(), 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
    const data = await response.json().catch(() => null);
    if (!response.ok || !data) throw new Error(data && data.error || 'shipment_update_failed');
    await loadStore();
  } catch (error) {
    showOrderAction(Portal.errorText(error, 'تعذر حفظ تحديث الشحن.'));
    button.disabled = false;
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
document.addEventListener('click', event => {
  const button = event.target.closest('[data-update]');
  if (button) updateOrder(button);
});
document.addEventListener('submit', event => {
  const form = event.target.closest('[data-shipment-form]');
  if (!form) return;
  event.preventDefault();
  updateShipment(form);
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
