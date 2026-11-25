const escA = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#039;' }[c]));
const statusA = { awaiting_store_confirmation: ['بانتظار تأكيد المتجر', 'gold'], store_confirmed: ['أكّد المتجر الطلب', 'green'], processing: ['قيد التجهيز', 'blue'], shipped: ['في الطريق إليك', 'blue'], delivered: ['تم التسليم', 'green'], completed: ['تم التسليم', 'green'], store_rejected: ['أُلغي الطلب', 'red'], cancelled: ['أُلغي الطلب', 'red'], store_cancelled: ['أُلغي الطلب وأُعيدت المنتجات', 'red'], restored: ['عادت المنتجات إلى السلة', 'green'], needs_review: ['قيد المراجعة', 'orange'] };
const shippingA = { preparing: ['قيد التجهيز', 'gold'], handed_to_carrier: ['تم تسليمها لشركة الشحن', 'blue'], in_transit: ['في الطريق', 'blue'], out_for_delivery: ['خرجت للتسليم', 'blue'], delivered: ['تم التسليم', 'green'], delayed: ['متأخرة', 'orange'], returned: ['مرتجعة', 'red'], cancelled: ['ملغاة', 'red'] };
// The sentence at the top of an order that is still being followed, and the four steps under it (the order's whole life in one glance).
const headlineA = { awaiting_store_confirmation: 'المتجر يراجع طلبك', store_confirmed: 'أكّد المتجر طلبك', processing: 'المتجر يجهّز طلبك', shipped: 'طلبك في الطريق إليك', needs_review: 'طلبك قيد المراجعة' };
const stepsA = ['تم الطلب', 'أكّد المتجر', 'خرج للشحن', 'وصل إليك'];
const terminalA = new Set(['completed', 'delivered', 'store_cancelled', 'store_rejected', 'cancelled', 'restored', 'closed']);
// Errors go where the person can see them: the login box before sign-in, the orders page after it
// (the login box is hidden once the orders are shown, so an error written there is never seen).
function showMessage(error) {
  const text = error ? Portal.errorText(error, 'تعذر تحميل البيانات، حاول مرة أخرى.') : '';
  const appVisible = !document.querySelector('#app').hidden;
  const appBox = document.querySelector('#appMessage'), loginBox = document.querySelector('#message');
  if (appBox) { appBox.textContent = appVisible ? text : ''; appBox.hidden = !(appVisible && text); }
  if (loginBox) loginBox.textContent = appVisible ? '' : text;
}
const badgeA = status => { const value = statusA[status] || ['قيد المتابعة', 'muted']; return `<span class="badge ${value[1]}">${value[0]}</span>`; };
const shippingBadgeA = status => { const value = shippingA[status] || ['غير مسجل', 'muted']; return `<span class="badge ${value[1]}">${value[0]}</span>`; };
// Money reads "3,450 ج.م" (digits as everywhere in the shop, the pound written out; a fraction only when there is one).
const numA = amount => { const n = Number(amount); return (Number.isFinite(n) ? n : 0).toLocaleString('en-US', { maximumFractionDigits: 2 }); };
const currencyA = currency => (!currency || currency === 'EGP' ? 'ج.م' : String(currency));
const moneyA = (amount, currency = 'EGP') => `${numA(amount)} ${escA(currencyA(currency))}`;
const stateA = request => { const restoration = (request.store_order_cart_restorations || [])[0]; if (restoration && restoration.status === 'restored') return 'restored'; return request.status || 'awaiting_store_confirmation'; };
const shipmentA = request => (request.store_shipments || [])[0] || null;
// There is no cancel button on this page: the customer never cancels an order from here (docs/purchase-flow-final.ar.md). «طلباتي» only RECORDS what
// happened. An unpaid order ends only by the store turning it down, the store not answering, or the payment window ending before a payment: closed,
// cancelled, left untouched for the idle time, or ended at the store. All of those last are the customer's own doing in the platform's words.
const cancelledByCustomerA = new Set(['payment_window_cancelled', 'payment_window_closed', 'payment_window_expired', 'customer_requested_before_payment']);
function cancelNoteA(request) {
  if (stateA(request) !== 'cancelled') return '';
  const why = request.cancel_reason;
  if (why === 'store_unresponsive') return `<div class="cancel-box cancel-accepted" role="status"><b>تعذر تنفيذ الطلب الآن</b><span>نعتذر عن تنفيذ طلبك في الوقت الحالي، برجاء إعادة المحاولة بعد ساعة. منتجاتك ما زالت في سلتك.</span></div>`;
  if (cancelledByCustomerA.has(why)) return `<div class="cancel-box cancel-accepted" role="status"><b>تم إلغاء المعاملة برغبة العميل</b><span>تم إلغاء المعاملة برغبة العميل. منتجاتك ما زالت في سلتك ويمكنك طلبها مرة أخرى.</span></div>`;
  return '';
}
// The badge of a cancelled order says how it ended, not only that it did.
function badgeOfA(request, state) {
  if (state === 'cancelled') {
    const why = request.cancel_reason;
    if (why === 'store_unresponsive') return '<span class="badge red">المتجر لم يستجب</span>';
    if (cancelledByCustomerA.has(why)) return '<span class="badge red">أُلغيت برغبة العميل</span>';
  }
  return badgeA(state);
}
// Dates and times with the digits the rest of the shop uses (1, 2, 3); the year only when it is not this year.
const LATN = 'ar-EG-u-nu-latn';
const dateOptA = date => (date.getFullYear() === new Date().getFullYear() ? { day: 'numeric', month: 'long' } : { day: 'numeric', month: 'long', year: 'numeric' });
const dateA = value => { try { const date = new Date(value); return Number.isNaN(date.getTime()) ? '' : date.toLocaleDateString(LATN, dateOptA(date)); } catch (_) { return ''; } };
const dateTimeA = value => { try { const date = new Date(value); return Number.isNaN(date.getTime()) ? '' : date.toLocaleString(LATN, { ...dateOptA(date), hour: 'numeric', minute: '2-digit' }); } catch (_) { return ''; } };
const PAGE_SIZE = 100;
let guestCartClaimed = false;
let resettingPassword = false;
let recoveryToken = null;
let accountSessions = [];
let accountOffset = 0;
let accountTotal = null;
let accountLoading = false;
let archiveSessions = [];
let archiveOffset = 0;
let archiveTotal = null;
let archiveQuery = {};
let archiveLoading = false;
let recentShown = 5;          // how many finished orders the list shows; "show older orders" adds five more
let accountHasMore = false;   // the server has older orders than the ones read so far

function cartSnapshot() { try { return JSON.parse(localStorage.getItem('elan_cart') || '[]').reduce((total, item) => total + (Number(item.q) || 0), 0); } catch (_) { return 0; } }
function updateCartShortcut(restored = 0) { const element = document.querySelector('#cartShortcut'); if (!element) return; element.querySelector('b').textContent = cartSnapshot(); element.classList.toggle('has-restored', restored > 0); element.querySelector('span').textContent = restored ? 'السلة · عادت منتجاتك' : 'السلة'; }
// Which of the four steps have happened: placed (always), confirmed by the store, handed to shipping, delivered. The first one that has not is "now".
function stageA(request) {
  const state = stateA(request), shipment = shipmentA(request), shipping = shipment && shipment.shipping_status;
  const delivered = state === 'delivered' || state === 'completed' || shipping === 'delivered';
  const shipped = delivered || state === 'shipped' || ['handed_to_carrier', 'in_transit', 'out_for_delivery', 'delayed'].includes(shipping);
  return [true, shipped || state === 'store_confirmed' || state === 'processing', shipped, delivered];
}
function trackerA(request) {
  const done = stageA(request), current = done.indexOf(false);
  return `<ol class="acct-steps" aria-label="مراحل الطلب">${stepsA.map((label, index) => `<li class="${done[index] ? 'done' : index === current ? 'current' : 'todo'}"${index === current ? ' aria-current="step"' : ''}><span class="dot" aria-hidden="true">${done[index] ? '✓' : ''}</span>${label}</li>`).join('')}</ol>`;
}
// The shipping box. With no shipment recorded it says what to expect, and only while the order is at a stage where shipping is the next thing.
const noShipmentA = { store_confirmed: 'المتجر يجهّز طلبك. ستظهر بيانات الشحن هنا فور تسليمه لشركة الشحن.', processing: 'المتجر يجهّز طلبك. ستظهر بيانات الشحن هنا فور تسليمه لشركة الشحن.', shipped: 'خرج طلبك من المتجر. ستظهر بيانات شركة الشحن هنا قريبًا.' };
function shipmentLine(request) {
  const shipment = shipmentA(request);
  if (!shipment) { const text = noShipmentA[stateA(request)]; return text ? `<div class="shipment-box shipment-empty"><span>${text}</span></div>` : ''; }
  const deliveryVerification = shipment.shipping_status === 'delivered'
    ? shipment.delivery_verified_at ? `أكدت المنصة التسليم من شركة الشحن في ${dateTimeA(shipment.delivery_verified_at)}.` : 'أبلغ المتجر عن التسليم؛ جارٍ تحقق المنصة من بيانات شركة الشحن.'
    : '';
  return `<div class="shipment-box"><div class="shipment-head"><div><small>شركة الشحن</small><strong>${escA(shipment.carrier_name || 'لم تُحدَّد بعد')}</strong></div>${shippingBadgeA(shipment.shipping_status)}</div><div class="shipment-meta"><span>رقم تتبع الشحنة</span><b dir="ltr">${escA(shipment.tracking_code || 'لم يُضَف بعد')}</b></div>${shipment.estimated_delivery_at ? `<div class="shipment-meta"><span>موعد التسليم المتوقع</span><b>${dateA(shipment.estimated_delivery_at)}</b></div>` : ''}${deliveryVerification ? `<p class="shipment-note">${escA(deliveryVerification)}</p>` : ''}${shipment.status_note ? `<p class="shipment-note">${escA(shipment.status_note)}</p>` : ''}<small class="shipment-updated">آخر تحديث: ${dateTimeA(shipment.updated_at)}</small></div>`;
}
// ---- the merchant's payment window, the store's reason and the shipping timeline ------------------------------------------
// The store answers an order by itself; when it accepts, ITS OWN payment window opens for the customer by itself from the order page (order-page.js and
// pay-window.js). There is no «الدفع» button here: this page only records what happens (a window open, a purchase cancelled by the customer, paid with the
// method, cash on delivery, refused by the store with its reason, refused by the payment provider with its reason). Closing the window before paying
// cancels the order. What the browser reports on return proves nothing: the order is paid only when a neutral confirmation of the payment reaches the
// platform, and «طلباتي» then shows it.
const payStatusA = { not_started: ['بانتظار الدفع', 'gold'], awaiting_payment: ['بانتظار تأكيد الدفع', 'gold'], paid: ['تم الدفع', 'green'], cod_selected: ['الدفع عند الاستلام', 'blue'], failed: ['تعذر الدفع', 'orange'] };
const payKindA = { card: 'بطاقة', cod: 'الدفع عند الاستلام', other: 'طريقة أخرى' };
const payWindowOpenA = request => { const win = request.payment_window; return stateA(request) === 'store_confirmed' && !!win && ['issued', 'opened'].includes(win.state) && !['paid', 'cod_selected'].includes(request.payment_status || 'not_started'); };
function rejectionLine(request) {
  if (stateA(request) !== 'store_rejected' || !request.rejection_reason) return '';
  return `<div class="cancel-box cancel-accepted" role="status"><b>سبب رفض المتجر</b><span>${escA(request.rejection_reason)}</span></div>`;
}
function paymentLine(request) {
  const status = request.payment_status || 'not_started', amount = request.payable_amount ?? request.total_amount;
  if (status === 'paid') {
    return `<div class="pay-box pay-done" role="status"><b>الدفع</b><span>تم دفع ${moneyA(amount, request.currency)}${request.payment_method ? ` (${escA(payKindA[request.payment_method] || request.payment_method)})` : ''}${request.paid_at ? ` في ${dateTimeA(request.paid_at)}` : ''}.</span></div>`;
  }
  if (status === 'cod_selected') {
    return `<div class="pay-box pay-done" role="status"><b>الدفع عند الاستلام</b><span>تدفع ${moneyA(amount, request.currency)} للمندوب عند التسليم.</span></div>`;
  }
  const win = request.payment_window;
  if (stateA(request) === 'store_confirmed' && win && win.state === 'success_claimed') {
    // The customer pressed OK in the store's window. With an electronic method the provider's confirmation makes it a purchase; with no provider window
    // it was cash on delivery, which the store reports. Until one of them reaches the platform the order is not called confirmed.
    return `<div class="pay-box" data-pay-watch role="status"><div><b>نؤكد طريقة الدفع</b><span>عدت من نافذة المتجر. الدفع الإلكتروني يؤكده مزود الدفع، والدفع عند الاستلام يؤكده المتجر، ولا يُعدّ طلبك مؤكدًا قبل ذلك.</span></div></div>`;
  }
  if (!payWindowOpenA(request)) return '';
  // No button and no countdown. The window opened by itself when the store accepted; its duration, its payment methods, the shipping and the final
  // total are the store's, so no amount due is claimed here. This is a status line the page keeps reading (data-pay-watch) until the result arrives.
  return `<div class="pay-box" data-pay-watch role="status"><div><b>فُتحت لك نافذة الدفع الخاصة بالمتجر</b><span>قبِل المتجر طلبك وفتح لك نافذته للدفع، وفيها يحدد الشحن والإجمالي النهائي وطرق الدفع. أكمل الدفع فيها، وستجد هنا نتيجة العملية فور وصولها. إغلاق النافذة قبل إتمام الدفع يلغي المعاملة برغبتك.</span></div></div>`;
}
function timelineLine(request) {
  const events = request.store_shipment_events || [];
  if (!events.length) return '';
  return `<hr><div class="order-timeline"><b>تتبع الشحن</b><ol>${events.map(event => { const value = shippingA[event.shipping_status] || [escA(event.shipping_status), 'muted']; return `<li><span class="badge ${value[1]}">${value[0]}</span><span>${dateTimeA(event.occurred_at)}${event.carrier_name ? ` · ${escA(event.carrier_name)}` : ''}${event.tracking_code ? ` · <bdi dir="ltr">${escA(event.tracking_code)}</bdi>` : ''}${event.note ? `<small>${escA(event.note)}</small>` : ''}<small class="muted">${escA(eventSourceA[event.source] || '')}</small></span></li>`; }).join('')}</ol></div>`;
}
function paymentRows(request) {
  const status = request.payment_status || 'not_started';
  if (!request.approved_at && status === 'not_started') return '';
  const value = payStatusA[status] || payStatusA.not_started;
  return `<div><span>حالة الدفع</span><b>${value[0]}</b></div>`;
}
// An order whose payment window is open (or whose customer just came back from it) is read again every ten seconds while the page is in view, so a
// cancellation by the store, or the provider's confirmation, shows without a reload. There is no clock of ours on the window.
let payWatchAt = 0;
setInterval(() => {
  if (document.hidden || !document.querySelector('[data-pay-watch]') || Date.now() - payWatchAt < 9000) return;
  payWatchAt = Date.now();
  loadAccount(false, true).catch(() => {});
}, 10000);
function itemLine(item) {
  const label = [item.brand_name, item.product_name, item.size_label].filter(Boolean).map(escA).join(' · ');
  const unit = item.unit_price != null && Number(item.quantity) > 1 ? ` <small class="muted">(${moneyA(item.unit_price, item.currency)} للواحدة)</small>` : '';
  const platformNo = item.platform_order_number ? ` <small class="muted" dir="ltr">${escA(item.platform_order_number)}</small>` : '';
  return `<div><span>${label} × ${Number(item.quantity) || 0}${unit}${platformNo}</span><b>${moneyA(item.line_total, item.currency)}</b></div>`;
}
// What was ordered, as a short list (the first three); the rest is in the details.
function itemsPreviewA(items) {
  if (!items.length) return '';
  const rest = items.length - 3;
  const rows = items.slice(0, 3).map(item => { const meta = [item.brand_name, item.size_label].filter(Boolean).map(escA).join(' · '); return `<li><span><b>${escA(item.product_name || 'منتج')}</b>${meta ? ` · ${meta}` : ''}</span><em>× ${Number(item.quantity) || 0}</em></li>`; }).join('');
  return `<ul class="acct-items">${rows}${rest > 0 ? `<li class="more">و${rest === 1 ? 'منتج آخر' : rest === 2 ? 'منتجان آخران' : `${rest} منتجات أخرى`} في التفاصيل</li>` : ''}</ul>`;
}
// The opened "details": prices line by line, the totals, who sold it and the numbers to quote. `lead` is anything that belongs on top (the shipping box of a finished order).
function detailsA(request, items, lead = '', reorder = '') {
  const total = request.total_amount ?? request.subtotal;
  const shipping = request.shipping_amount == null ? '' : `<div><span>الشحن</span><b>${moneyA(request.shipping_amount, request.currency)}</b></div>`;
  return `<details class="acct-more"><summary>تفاصيل الطلب</summary>${lead}<div class="order-detail">${items.map(itemLine).join('')}<hr><div><span>المنتجات</span><b>${moneyA(request.subtotal, request.currency)}</b></div>${shipping}<div class="sum"><span>الإجمالي</span><b>${moneyA(total, request.currency)}</b></div>${paymentRows(request)}${timelineLine(request)}<hr><div><span>المتجر</span><b>${escA(request.stores && request.stores.name || '—')}</b></div><div><span>رقم الطلب</span><b dir="ltr">${escA(request.tracking_number)}</b></div>${request.merchant_order_number ? `<div><span>رقم طلب المتجر</span><b dir="ltr">${escA(request.merchant_order_number)}</b></div>` : ''}${request.merchant_invoice_number ? `<div><span>رقم فاتورة المتجر</span><b dir="ltr">${escA(request.merchant_invoice_number)}</b></div>` : ''}<div><span>وقت الطلب</span><b>${dateTimeA(request.created_at)}</b></div>${reorder}</div></details>`;
}
const totalBoxA = request => `<div class="acct-total"><small>الإجمالي</small><b>${numA(request.total_amount ?? request.subtotal)}<i>${escA(currencyA(request.currency))}</i></b></div>`;
function requestLine(request) {
  const state = stateA(request), items = request.store_order_request_items || [];
  const store = escA(request.stores && request.stores.name || 'متجر'), number = `<span class="num">${escA(request.tracking_number)}</span>`;
  const canReorder = items.some(item => /^[0-9a-f-]{36}$/i.test(String(item.product_size_id || '')));
  const reorder = canReorder ? `<button class="ghost order-reorder" type="button" data-reorder="${escA(request.id)}">اطلب مرة أخرى</button>` : '';
  if (terminalA.has(state)) {
    // Over (delivered, cancelled ...): one compact row, "order again" within reach, everything else behind "details".
    const names = items.slice(0, 2).map(item => `${escA(item.product_name)}${Number(item.quantity) > 1 ? ` × ${item.quantity}` : ''}`).join('، ');
    const more = items.length > 2 ? ` <span class="muted">+${items.length - 2} أخرى</span>` : '';
    return `<article class="acct-order is-past" data-id="${escA(request.id)}" data-state="${escA(state)}"><div class="acct-order-top"><div class="acct-order-title"><h3>${names || 'تفاصيل المنتجات داخل الطلب'}${more}</h3><p class="acct-sub">من ${store} · ${number} · ${dateA(request.created_at)}</p></div><div class="acct-side">${badgeOfA(request, state)}${totalBoxA(request)}</div></div>${rejectionLine(request)}${cancelNoteA(request)}<div class="acct-past-actions">${reorder}${detailsA(request, items, shipmentLine(request))}</div></article>`;
  }
  // Still being followed: what is happening now (the sentence, the four steps, the shipment), then what was ordered.
  return `<article class="acct-order is-active" data-id="${escA(request.id)}" data-state="${escA(state)}"><div class="acct-order-top"><div class="acct-order-title"><h3>${headlineA[state] || 'طلبك قيد المتابعة'}</h3><p class="acct-sub">من ${store} · ${number}</p></div>${totalBoxA(request)}</div>${trackerA(request)}${paymentLine(request)}${shipmentLine(request)}${itemsPreviewA(items)}<div class="acct-order-foot"><span>تاريخ الطلب: ${dateA(request.created_at)}</span>${detailsA(request, items, '', reorder)}</div></article>`;
}
function flatten(sessions) { return sessions.flatMap(session => (session.store_order_requests || []).map(request => ({ ...request, session }))); }
function mergeSessions(newer, older) {
  const seen = new Set();
  return [...newer, ...older].filter(session => { const key = String(session.id || session.tracking_number || ''); if (!key || seen.has(key)) return false; seen.add(key); return true; });
}
function renderList(element, requests, empty) {
  // The page refreshes itself every minute: a card whose details the customer opened must not snap shut under their finger.
  const open = typeof element.querySelectorAll === 'function' ? [...element.querySelectorAll('.acct-order[data-id] details[open]')].map(node => node.closest('.acct-order').dataset.id) : [];
  element.innerHTML = requests.length ? requests.map(requestLine).join('') : `<div class="empty">${empty}</div>`;
  if (open.length && typeof element.querySelectorAll === 'function') element.querySelectorAll('.acct-order[data-id]').forEach(node => { if (open.includes(node.dataset.id)) { const details = node.querySelector('details'); if (details) details.open = true; } });
}
function fillYears() {
  const select = document.querySelector('#archiveYear');
  if (select.dataset.yearsReady) return;
  const currentYear = new Date().getFullYear();
  const years = Array.from({ length: currentYear - 1999 }, (_, index) => currentYear - index);
  select.innerHTML = '<option value="">كل السنوات</option>' + years.map(year => `<option value="${year}">${year}</option>`).join('');
  select.dataset.yearsReady = '1';
}
function renderAccount(sessions) {
  const requests = flatten(sessions);
  const active = requests.filter(request => !terminalA.has(stateA(request)));
  const past = requests.filter(request => terminalA.has(stateA(request))).sort((a, b) => new Date(b.created_at) - new Date(a.created_at));
  const restored = requests.filter(request => stateA(request) === 'restored').length;
  renderList(document.querySelector('#activeOrders'), active, 'لا توجد طلبات جارية الآن.<a href="/">تصفّح العطور</a>');
  renderList(document.querySelector('#recentOrders'), past.slice(0, recentShown), 'لا توجد طلبات سابقة بعد.');
  const more = document.querySelector('#loadMoreOrders');
  if (more) more.hidden = !(past.length > recentShown || accountHasMore);
  fillYears();
  updateCartShortcut(restored);
  window.__customerSessions = sessions;
}
async function fetchSessions(query = {}) {
  const params = new URLSearchParams({ limit: String(PAGE_SIZE), offset: '0' });
  Object.entries(query).forEach(([key, value]) => { if (value !== undefined && value !== null && value !== '') params.set(key, String(value)); });
  const response = await fetch(`/api/customer-orders?${params}`, { headers: Portal.auth() });
  const data = await response.json();
  if (!response.ok) throw Error(data.error || 'تعذر تحميل الطلبات');
  const sessions = Array.isArray(data.sessions) ? data.sessions : [];
  const pagination = data.pagination || {};
  const total = pagination.total === null || pagination.total === undefined ? null : Number(pagination.total);
  return { sessions, total: Number.isFinite(total) ? total : null, hasMore: typeof pagination.hasMore === 'boolean' ? pagination.hasMore : sessions.length === PAGE_SIZE };
}
async function loadArchive(event, append = false) {
  if (event) event.preventDefault();
  if (archiveLoading) return;
  if (!append) {
    const search = document.querySelector('#archiveSearch');   // the order-number box was removed from the page; the query stays a year filter
    archiveQuery = { q: search ? search.value.trim() : '', year: document.querySelector('#archiveYear').value };
    archiveSessions = []; archiveOffset = 0; archiveTotal = null;
    const box = document.querySelector('#archiveOrders'); box.hidden = false; box.innerHTML = '<div class="empty">جارٍ البحث…</div>';
    document.querySelector('#loadMoreArchive').hidden = true;
  }
  archiveLoading = true;
  const more = document.querySelector('#loadMoreArchive'); more.disabled = true;
  try {
    const page = await fetchSessions({ ...archiveQuery, offset: archiveOffset });
    archiveSessions = mergeSessions(archiveSessions, page.sessions);
    archiveOffset += page.sessions.length;
    archiveTotal = page.total;
    const requests = flatten(archiveSessions).filter(request => terminalA.has(stateA(request)));
    const box = document.querySelector('#archiveOrders'); box.hidden = false; renderList(box, requests, 'لا توجد طلبات مطابقة. جرّب رقم الطلب كما وصلك.');
    more.hidden = archiveTotal !== null ? archiveSessions.length >= archiveTotal : !page.hasMore;
    showMessage('');
  } catch (error) {
    // A failed search must not leave "searching…" on the screen forever.
    if (!append) { const box = document.querySelector('#archiveOrders'); box.hidden = false; box.innerHTML = '<div class="empty">تعذر إكمال البحث، حاول مرة أخرى.</div>'; }
    throw error;
  } finally { more.disabled = false; archiveLoading = false; }
}
async function loadAccount(append = false, quiet = false) {
  const session = Portal.session();
  if (!session || accountLoading || resettingPassword) return;
  if (!guestCartClaimed && window.GuestIdentity) { try { await GuestIdentity.claim(session.access_token); guestCartClaimed = true; } catch (_) {} }
  accountLoading = true;
  const offset = append ? accountOffset : 0;
  const more = document.querySelector('#loadMoreOrders'); more.disabled = true;
  try {
    // The automatic refresh only needs the newest orders; the full first page is read when the customer asks for it.
    const page = await fetchSessions(quiet ? { offset, limit: 20 } : { offset });
    accountSessions = append ? mergeSessions(accountSessions, page.sessions) : mergeSessions(page.sessions, accountSessions);
    if (append) accountOffset = offset + page.sessions.length;
    else accountOffset = Math.max(accountOffset, page.sessions.length);
    accountTotal = page.total;
    const hasMore = accountTotal !== null ? accountSessions.length < accountTotal : page.hasMore;
    accountHasMore = hasMore;
    document.querySelector('#login').hidden = true;
    document.querySelector('#app').hidden = false;
    document.querySelector('#logout').hidden = false;
    renderAccount(accountSessions);
    showMessage('');
  } finally { more.disabled = false; accountLoading = false; }
}

function reorder(requestId) {
  const request = flatten([...accountSessions, ...archiveSessions]).find(item => String(item.id) === String(requestId));
  if (!request) return;
  let cart = [];
  try { cart = JSON.parse(localStorage.getItem('elan_cart') || '[]'); } catch (_) { cart = []; }
  if (!Array.isArray(cart)) cart = [];
  let added = 0;
  for (const item of request.store_order_request_items || []) {
    const sid = String(item.product_size_id || '');
    if (!/^[0-9a-f-]{36}$/i.test(sid)) continue;
    const quantity = Math.min(99, Math.max(1, Number(item.quantity) || 1));
    const existing = cart.find(row => String(row.sid) === sid);
    if (existing) existing.q = Math.min(99, Math.max(Number(existing.q) || 0, quantity)); else cart.push({ sid, q: quantity });
    added += 1;
  }
  if (!added) { showMessage('تعذر إضافة منتجات هذا الطلب إلى السلة.'); return; }
  try { localStorage.setItem('elan_cart', JSON.stringify(cart)); } catch (_) { showMessage('تعذر حفظ السلة على هذا الجهاز.'); return; }
  // The store merges this device's cart with the one saved in the account when it opens, and shows only what is still on sale.
  location.href = '/';
}

async function authConfig() {
  const response = await fetch('/api/config');
  const config = await response.json();
  if (!response.ok || !config.url || !config.key) throw new Error('supabase_service_configuration_missing');
  return config;
}
async function authFailure(response, fallback) {
  const data = await response.json().catch(() => ({}));
  return new Error(Portal.errorMessages[data.error_code] || Portal.errorMessages[data.error] || fallback);
}
function readRecoveryLink() {
  const hash = String(location.hash || '').replace(/^#/, '');
  if (!hash) return;
  const params = new URLSearchParams(hash);
  // The link carries a one-time token; take it out of the address bar and the history at once.
  history.replaceState(null, '', location.pathname + location.search);
  if (params.get('type') === 'recovery' && params.get('access_token')) {
    recoveryToken = params.get('access_token');
    resettingPassword = true;
    document.querySelector('#loginForm').hidden = true;
    document.querySelector('#resetForm').hidden = true;
    document.querySelector('.auth-links').hidden = true;
    document.querySelector('#newPasswordForm').hidden = false;
  } else if (params.get('error_code') || params.get('error')) {
    document.querySelector('#message').textContent = Portal.errorMessages[params.get('error_code')] || 'انتهت صلاحية الرابط، اطلب رابطًا جديدًا.';
  }
}

document.querySelector('#loginForm').addEventListener('submit', async event => { event.preventDefault(); try { await Portal.login(event.target); Portal.toast(Portal.welcomeText); await loadAccount(); } catch (error) { showMessage(error); } });
document.querySelector('#archiveForm').addEventListener('submit', event => loadArchive(event).catch(showMessage));
document.querySelector('#loadMoreOrders').addEventListener('click', () => {
  // Older finished orders already read are shown first (five more at a time); only when there are none left is the next page asked of the server.
  const hidden = flatten(accountSessions).filter(request => terminalA.has(stateA(request))).length > recentShown;
  recentShown += 5;
  if (hidden) { renderAccount(accountSessions); return; }
  loadAccount(true).catch(showMessage);
});
document.querySelector('#loadMoreArchive').addEventListener('click', () => loadArchive(null, true).catch(showMessage));
document.addEventListener('click', event => { const button = event.target.closest('[data-reorder]'); if (button) reorder(button.dataset.reorder); });

document.querySelector('#forgotLink').addEventListener('click', event => {
  event.preventDefault();
  const form = document.querySelector('#resetForm');
  form.hidden = !form.hidden;
  if (!form.hidden) form.elements.email.focus();
});
document.querySelector('#resetForm').addEventListener('submit', async event => {
  event.preventDefault();
  const form = event.target, button = form.querySelector('button'); button.disabled = true;
  try {
    const config = await authConfig();
    // the link opens the shop itself, which asks for the new password there (not this page)
    const redirect = encodeURIComponent(`${location.origin}/`);
    // The "are you a person" check (turnstile.js); '' when the shop has no key, and then the request is as it was.
    const captcha = window.ElanTurnstile ? await window.ElanTurnstile.token(form) : '';
    const payload = { email: form.elements.email.value.trim() };
    const response = await fetch(`${config.url}/auth/v1/recover?redirect_to=${redirect}`, {
      method: 'POST', headers: { apikey: config.key, 'Content-Type': 'application/json' }, body: JSON.stringify(window.ElanTurnstile ? window.ElanTurnstile.body(payload, captcha) : payload)
    });
    if (!response.ok) throw await authFailure(response, 'تعذر إرسال الرابط الآن، حاول بعد قليل.');
    // The same sentence whether or not the address is registered, so the page does not reveal who has an account.
    document.querySelector('#message').textContent = 'إن كان هذا البريد مسجلًا لدينا فسيصلك رابط استعادة كلمة المرور خلال دقائق. تحقق من البريد العشوائي أيضًا.';
    form.hidden = true; form.reset();
  } catch (error) { showMessage(error); } finally { button.disabled = false; }
});
document.querySelector('#newPasswordForm').addEventListener('submit', async event => {
  event.preventDefault();
  const form = event.target, password = form.elements.password.value, button = form.querySelector('button');
  if (password !== form.elements.confirm.value) { showMessage('كلمتا المرور غير متطابقتين.'); return; }
  button.disabled = true;
  try {
    const config = await authConfig();
    const headers = { apikey: config.key, Authorization: `Bearer ${recoveryToken}`, 'Content-Type': 'application/json' };
    const response = await fetch(`${config.url}/auth/v1/user`, { method: 'PUT', headers, body: JSON.stringify({ password }) });
    if (!response.ok) throw await authFailure(response, 'تعذر حفظ كلمة المرور، اطلب رابطًا جديدًا وحاول مرة أخرى.');
    // The recovery session is only for this one change: end it, do not keep the customer signed in by it.
    fetch(`${config.url}/auth/v1/logout`, { method: 'POST', headers }).catch(() => {});
    recoveryToken = null; resettingPassword = false;
    form.reset(); form.hidden = true;
    document.querySelector('#loginForm').hidden = false;
    document.querySelector('.auth-links').hidden = false;
    document.querySelector('#message').textContent = 'تم تغيير كلمة المرور. سجّل الدخول بها الآن.';
  } catch (error) { showMessage(error); } finally { button.disabled = false; }
});

readRecoveryLink();
if (Portal.session()) loadAccount().catch(showMessage);

// The page refreshes itself once a minute while it is in front, and backs off (up to eight minutes) while the service
// does not answer, so an open tab does not keep hammering a struggling API. A hidden tab does not poll; coming back
// to it after a minute refreshes once.
let pollFailures = 0;
function schedulePoll() {
  setTimeout(async () => {
    if (!document.hidden && Portal.session() && !resettingPassword) {
      try { await loadAccount(false, true); pollFailures = 0; } catch (_) { pollFailures = Math.min(pollFailures + 1, 3); }
    }
    schedulePoll();
  }, Math.min(60000 * 2 ** pollFailures, 480000));
}
schedulePoll();
let accountHiddenAt = 0;
document.addEventListener('visibilitychange', () => {
  if (document.hidden) { accountHiddenAt = Date.now(); return; }
  if (accountHiddenAt && Date.now() - accountHiddenAt > 60000 && Portal.session()) loadAccount(false, true).catch(() => {});
  accountHiddenAt = 0;
});
