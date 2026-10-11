const escP = value => String(value ?? '').replace(/[&<>"']/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#039;' }[char]));
const labelP = { awaiting_store_confirmation: 'بانتظار المتجر', store_confirmed: 'تم التأكيد', processing: 'قيد التجهيز', shipped: 'تم الشحن', delivered: 'تم التسليم', completed: 'مكتمل', store_rejected: 'مرفوض', store_cancelled: 'ملغى', restored: 'مسترجع', needs_review: 'يحتاج مراجعة', matched: 'مطابقة', mismatched: 'غير مطابقة', pending: 'قيد الفحص' };
const eventP = { view: 'مشاهدة', search: 'ظهور في البحث', cart_add: 'إضافة للسلة', cart_remove: 'حذف/تقليل من السلة' };
const dateP = value => { try { return value ? new Date(value).toLocaleString('ar-EG') : '—'; } catch (_) { return '—'; } };
function numberP(value) { return Math.max(0, Number(value) || 0).toLocaleString('ar-EG'); }
function durationP(seconds) {
  const total = Math.max(0, Number(seconds) || 0), hours = Math.floor(total / 3600), minutes = Math.floor((total % 3600) / 60), secs = Math.floor(total % 60);
  return hours ? `${hours} س ${minutes} د` : minutes ? `${minutes} د ${secs} ث` : `${secs} ث`;
}

function reportError(error) {
  const message = error && error.message ? error.message : 'تعذر تحميل البيانات';
  const box = document.querySelector('#platformError');
  if (box) { box.textContent = message; box.hidden = false; }
  else document.querySelector('#message').textContent = message;
}
function jsonCell(value) { return value === null || value === undefined || value === '' ? '—' : typeof value === 'object' ? JSON.stringify(value) : String(value); }
function fullDataDetails(data, title) {
  if (!data || typeof data !== 'object') return '—';
  const rows = Object.entries(data).map(([key, value]) => `<div><b>${escP(key)}</b><span>${escP(jsonCell(value))}</span></div>`).join('');
  return `<details class="activity-full-data"><summary>${escP(title || 'كامل البيانات')}</summary><div class="activity-data-grid">${rows}</div></details>`;
}
function productSummary(product) {
  if (!product) return '<strong>منتج محذوف أو غير متاح</strong>';
  return `<strong>${escP(product.name || 'منتج')}</strong><small>${escP(product.brand_name || '')}</small>${fullDataDetails(product, 'كل حقول المنتج')}`;
}
function offerText(offer) {
  if (!offer) return '—';
  return `<span>${escP(offer.storeName || 'متجر')} · ${escP(offer.price == null ? '—' : `${offer.price} ${offer.currency || ''}`)}</span>${fullDataDetails(offer, 'تفاصيل العرض')}`;
}
function sizeText(size) { return size ? `<span>${escP(size.size_label || size.size_ml || size.id || '—')}</span>${fullDataDetails(size, 'تفاصيل الحجم')}` : '—'; }
function activityEventRows(events) {
  return (events || []).map(event => `<tr><td>${escP(eventP[event.eventType] || event.eventType)}</td><td>${escP(dateP(event.occurredAt))}</td><td class="activity-product-cell">${productSummary(event.product)}</td><td>${sizeText(event.size)}</td><td>${offerText(event.offer)}</td><td>${event.quantity == null ? '—' : numberP(event.quantity)}</td></tr>`).join('');
}
function sessionRows(sessions) {
  return (sessions || []).map(session => `<tr><td>${escP(dateP(session.startedAt))}</td><td>${escP(durationP(session.activeSeconds))}</td><td>${escP(session.endedAt ? dateP(session.endedAt) : 'نشطة/لم يصل حدث الإغلاق')}</td><td>${escP(dateP(session.lastSeenAt))}</td></tr>`).join('');
}
function cartRows(items) {
  return (items || []).map(item => `<tr><td class="activity-product-cell">${productSummary(item.product)}</td><td>${sizeText(item.size)}</td><td>${offerText(item.offer)}</td><td>${numberP(item.quantity)}</td></tr>`).join('');
}
function detailMarkup(detail, offset) {
  const cart = Array.isArray(detail.currentCart) ? detail.currentCart : [];
  return `<div class="activity-overview"><span>عدد الزيارات: <b>${numberP(detail.visitCount)}</b></span><span>الوقت النشط: <b>${escP(durationP(detail.activeSeconds))}</b></span><span>عمليات مسجلة: <b>${numberP(detail.eventTotal)}</b></span></div>
    <h4>محتوى السلة الحالي</h4>${cart.length ? `<div class="activity-table-wrap"><table class="activity-table"><thead><tr><th>المنتج وبياناته</th><th>الحجم</th><th>المتجر والعرض</th><th>الكمية</th></tr></thead><tbody>${cartRows(cart)}</tbody></table></div>` : '<p class="muted">السلة الحالية فارغة.</p>'}
    <h4>عمليات مشاهدة وبحث وإضافة وحذف</h4><div class="activity-table-wrap"><table class="activity-table"><thead><tr><th>العملية</th><th>التوقيت</th><th>المنتج بكامل بياناته</th><th>الحجم</th><th>العرض/المتجر</th><th>الكمية المتغيرة</th></tr></thead><tbody data-events>${activityEventRows(detail.events)}</tbody></table></div>
    <p class="activity-page-note">يعرض ${numberP(Math.min(offset + (detail.events || []).length, detail.eventTotal))} من ${numberP(detail.eventTotal)} عملية.</p>
    <h4>الزيارات ومدة كل جلسة</h4><div class="activity-table-wrap"><table class="activity-table"><thead><tr><th>بدأت في</th><th>مدة النشاط</th><th>انتهت في</th><th>آخر تحديث</th></tr></thead><tbody data-sessions>${sessionRows(detail.sessions)}</tbody></table></div>
    <p class="activity-page-note">تُحتسب المدة أثناء ظهور الصفحة في المقدمة وتُحدّث دوريًا؛ قد لا يسجل المتصفح وقت الإغلاق المفاجئ كاملًا.</p>
    <button class="ghost activity-more" type="button" data-more-activity ${detail.hasMore ? '' : 'hidden'}>تحميل المزيد من السجل</button>`;
}
async function fetchCustomerDetail(panel, offset, append) {
  const url = `/api/platform-customer-detail?type=${encodeURIComponent(panel.dataset.type)}&id=${encodeURIComponent(panel.dataset.id)}&limit=100&offset=${offset}`;
  const response = await fetch(url, { headers: Portal.auth() }), result = await response.json();
  if (!response.ok) throw Error(result.error || 'تعذر تحميل سجل العميل');
  const detail = result.detail;
  if (!append) panel.innerHTML = detailMarkup(detail, offset);
  else {
    const eventBody = panel.querySelector('[data-events]'), sessionBody = panel.querySelector('[data-sessions]');
    if (eventBody) eventBody.insertAdjacentHTML('beforeend', activityEventRows(detail.events));
    if (sessionBody) sessionBody.insertAdjacentHTML('beforeend', sessionRows(detail.sessions));
    const note = panel.querySelector('.activity-page-note');
    if (note) note.textContent = `يعرض ${numberP(Math.min(offset + (detail.events || []).length, detail.eventTotal))} من ${numberP(detail.eventTotal)} عملية؛ تُحمّل الزيارات بالصفحات نفسها.`;
    const more = panel.querySelector('[data-more-activity]'); if (more) more.hidden = !detail.hasMore;
  }
  panel.dataset.offset = String(offset + 100);
}

function renderCustomers(data) {
  const customers = data.registeredCustomers || [], visitors = data.guestVisitors || [];
  document.querySelector('#registeredCount').textContent = customers.length;
  document.querySelector('#visitorCount').textContent = visitors.length;
  document.querySelector('#registeredCustomers').innerHTML = customers.length ? customers.map(customer => {
    const target = `activity-customer-${escP(customer.id)}`;
    return `<article class="customer-row customer-row-expanded"><div class="customer-row-main"><strong>${escP(customer.full_name || 'عميل مسجل')}</strong><small>الهاتف: ${escP(customer.phone || 'غير مسجل')} · تاريخ التسجيل: ${escP(dateP(customer.created_at))}</small><button type="button" class="ghost activity-open" data-load-activity data-kind="customer" data-id="${escP(customer.id)}" data-target="${target}">عرض السلة وسجل النشاط</button></div><div class="customer-cart"><b>${Number(customer.cartItems || 0)} صنف</b><small>${Number(customer.cartUnits || 0)} قطعة في السلة</small></div><div id="${target}" class="customer-activity-panel" hidden></div></article>`;
  }).join('') : '<div class="empty">لا يوجد عملاء مسجلون</div>';
  document.querySelector('#guestCustomers').innerHTML = visitors.length ? visitors.map(visitor => {
    const hash = String(visitor.fingerprint_hash || ''), target = `activity-guest-${escP(visitor.id)}`;
    return `<article class="customer-row customer-row-expanded"><div class="customer-row-main"><strong>زائر · <code title="${escP(hash)}">${escP(hash.slice(0, 16))}${hash.length > 16 ? '…' : ''}</code></strong><small>أول زيارة: ${escP(dateP(visitor.first_seen_at))} · آخر نشاط: ${escP(dateP(visitor.last_seen_at))}</small><button type="button" class="ghost activity-open" data-load-activity data-kind="guest" data-id="${escP(visitor.id)}" data-target="${target}">عرض السلة وسجل النشاط</button></div><div class="customer-cart"><b>${Number(visitor.cart_items_count || 0)} صنف</b><small>${Number(visitor.cart_units || 0)} قطعة في السلة</small></div><div id="${target}" class="customer-activity-panel" hidden></div></article>`;
  }).join('') : '<div class="empty">لا يوجد زوار نشطون</div>';
}

const periodsP = { today: 'اليوم', week: 'آخر 7 أيام', month: 'آخر 30 يومًا', year: 'آخر 365 يومًا' };
function renderRankTable(rows) {
  if (!Array.isArray(rows) || !rows.length) return '<div class="empty">لا توجد بيانات في هذه الفترة</div>';
  return `<div class="activity-table-wrap"><table class="activity-table rank-table"><thead><tr><th>العطر وبياناته</th><th>مرات العملية</th><th>عدد العملاء</th></tr></thead><tbody>${rows.map(row => `<tr><td class="activity-product-cell">${productSummary(row.product)}</td><td>${numberP(row.operations)}</td><td>${numberP(row.people)}</td></tr>`).join('')}</tbody></table></div>`;
}
function renderAnalytics(actor, data) {
  const prefix = actor === 'guest' ? 'guest' : 'registered', peopleLabel = actor === 'guest' ? 'زوار لديهم نشاط' : 'عملاء مسجلون لديهم نشاط';
  document.querySelector(`#${prefix}AnalyticsRange`).textContent = `${periodsP[data.period] || periodsP.today} · ${data.startDate || '—'} – ${data.endDate || '—'}`;
  const stats = [[peopleLabel, data.people], ['جلسات نشطة الآن', data.activeSessions], ['عدد الزيارات', data.visitCount], ['الوقت النشط', durationP(data.activeSeconds)], ['مشاهدات المنتجات', data.productViews], ['نتائج بحث المنتجات', data.productSearches], ['إضافات للسلة', data.cartAdds], ['حذف/تقليل من السلة', data.cartRemoves]];
  document.querySelector(`#${prefix}AnalyticsStats`).innerHTML = stats.map((item, index) => `<div class="stat ${index === 0 ? 'gold' : ''}"><small>${item[0]}</small><b>${typeof item[1] === 'string' ? escP(item[1]) : numberP(item[1])}</b></div>`).join('');
  const ids = actor === 'guest' ? ['guestTopViewed','guestTopSearched','guestTopAdded','guestTopRemoved'] : ['registeredTopViewed','registeredTopSearched','registeredTopAdded','registeredTopRemoved'];
  [data.topViewed,data.topSearched,data.topCartAdded,data.topCartRemoved].forEach((rows,index) => { document.querySelector(`#${ids[index]}`).innerHTML = renderRankTable(rows); });
}
async function loadAnalytics(actor) {
  if (!Portal.session()) return;
  const prefix = actor === 'guest' ? 'guest' : 'registered', period = document.querySelector(`#${prefix}AnalyticsPeriod`).value || 'today';
  const response = await fetch(`/api/guest-analytics?period=${encodeURIComponent(period)}&actor=${encodeURIComponent(actor)}`, { headers: Portal.auth() }), result = await response.json();
  if (!response.ok) throw Error(result.error || 'تعذر تحميل التحليلات');
  document.querySelector(`#${prefix}AnalyticsError`).hidden = true;
  renderAnalytics(actor, result.analytics);
}
function showAnalyticsError(actor, error) {
  const box = document.querySelector(`#${actor === 'guest' ? 'guest' : 'registered'}AnalyticsError`);
  box.textContent = error && error.message ? error.message : 'تعذر تحميل التحليلات'; box.hidden = false;
}
function filterQuery() {
  const form = document.querySelector('#platformFilters'); if (!form) return '';
  const params = new URLSearchParams(); for (const [key, value] of new FormData(form)) if (value) params.set(key, value);
  const query = params.toString(); return query ? `?${query}` : '';
}
function badgeP(status) { return `<span class="badge ${status === 'completed' || status === 'matched' || status === 'delivered' ? 'green' : status === 'mismatched' || status === 'store_cancelled' || status === 'store_rejected' ? 'red' : 'blue'}">${escP(labelP[status] || status || '—')}</span>`; }
function renderOrders(orders) {
  document.querySelector('#orders').innerHTML = orders.length ? orders.map(order => {
    const events = order.order_operation_events || [], checks = order.order_reconciliation_checks || [];
    return `<article class="order"><h3>${escP(order.tracking_number)} · ${escP(order.stores && order.stores.name || '')}</h3><div class="meta">${badgeP(order.status)} ${badgeP(order.reconciliation_status)} <span>العملية الموحدة: ${escP(order.checkout_tracking_number || '—')}</span></div><div class="grid"><div><b>بيانات العميل</b><p>${escP(order.customer_name)} · ${escP(order.customer_phone)}<br>${escP(order.customer_address)}</p><p>الإجمالي: ${Number((order.total_amount ?? order.subtotal) || 0).toFixed(2)} ${escP(order.currency)}</p></div><div><b>المنتجات</b>${(order.store_order_request_items || []).map(item => `<div class="item"><span>${escP(item.product_name)} × ${item.quantity}</span><span>${Number(item.line_total || 0).toFixed(2)} ${escP(item.currency)}</span></div>`).join('')}</div></div><p class="meta">الإشعارات: ${(order.store_order_notifications || []).map(item => `${escP(labelP[item.event_type] || item.event_type)} · ${escP(labelP[item.match_status] || item.match_status)}`).join(' · ') || 'لا يوجد'} · أحداث التدقيق: ${events.length} · فحوص المطابقة: ${checks.length}</p></article>`;
  }).join('') : '<div class="empty">لا توجد طلبات</div>';
}

function activateCustomerTabs() {
  const tabs = document.querySelector('#customerTabs'); if (!tabs) return;
  tabs.addEventListener('click', event => {
    const button = event.target.closest('[data-customer-tab]'); if (!button) return;
    const guests = button.dataset.customerTab === 'visitors';
    document.querySelector('#registeredTab').setAttribute('aria-selected', String(!guests));
    document.querySelector('#visitorsTab').setAttribute('aria-selected', String(guests));
    document.querySelector('#registeredPanel').hidden = guests;
    document.querySelector('#guestPanel').hidden = !guests;
  });
}
async function loadPlatform() {
  if (!Portal.session()) return;
  document.querySelector('#login').hidden = true; document.querySelector('#app').hidden = false; document.querySelector('#logout').hidden = false;
  const headers = Portal.auth(), responses = await Promise.all([fetch('/api/dashboard-orders' + filterQuery(), { headers }), fetch('/api/platform-customers', { headers })]);
  const ordersData = await responses[0].json(), customersData = await responses[1].json();
  if (!responses[0].ok) throw Error(ordersData.error || 'تعذر تحميل بيانات الطلبات');
  if (!responses[1].ok) throw Error(customersData.error || 'تعذر تحميل بيانات العملاء');
  const orders = ordersData.orders || [];
  document.querySelector('#stats').innerHTML = [['طلبات المتاجر', orders.length], ['عملاء مسجلون', customersData.counts.registered], ['زوار نشطون', customersData.counts.visitors], ['مكتملة', orders.filter(order => ['completed','delivered'].includes(order.status)).length]].map(item => `<div class="stat"><small>${item[0]}</small><b>${numberP(item[1])}</b></div>`).join('');
  document.querySelector('#platformError').hidden = true; renderCustomers(customersData); renderOrders(orders);
  loadAnalytics('guest').catch(error => showAnalyticsError('guest', error));
  loadAnalytics('customer').catch(error => showAnalyticsError('customer', error));
}

activateCustomerTabs();
document.querySelector('#platformFilters').addEventListener('submit', event => { event.preventDefault(); loadPlatform().catch(reportError); });
document.querySelector('#refreshCustomers').addEventListener('click', () => loadPlatform().catch(reportError));
document.querySelector('#guestAnalyticsPeriod').addEventListener('change', () => loadAnalytics('guest').catch(error => showAnalyticsError('guest', error)));
document.querySelector('#registeredAnalyticsPeriod').addEventListener('change', () => loadAnalytics('customer').catch(error => showAnalyticsError('customer', error)));
document.addEventListener('click', event => {
  const more = event.target.closest('[data-more-activity]');
  if (more) {
    const panel = more.closest('.customer-activity-panel'); if (!panel) return;
    more.disabled = true; fetchCustomerDetail(panel, Number(panel.dataset.offset || 0), true).catch(error => { more.textContent = error.message || 'تعذر تحميل المزيد'; }).finally(() => { more.disabled = false; }); return;
  }
  const button = event.target.closest('[data-load-activity]'); if (!button) return;
  const panel = document.getElementById(button.dataset.target); if (!panel) return;
  if (panel.dataset.loaded === 'true') { panel.hidden = !panel.hidden; return; }
  panel.hidden = false; panel.dataset.type = button.dataset.kind; panel.dataset.id = button.dataset.id;
  panel.innerHTML = '<p class="muted">جارٍ تحميل السلة وسجل النشاط…</p>'; button.disabled = true;
  fetchCustomerDetail(panel, 0, false).then(() => { panel.dataset.loaded = 'true'; }).catch(error => { panel.innerHTML = `<p class="platform-error">${escP(error.message || 'تعذر تحميل سجل العميل')}</p>`; }).finally(() => { button.disabled = false; });
});
document.querySelector('#loginForm').addEventListener('submit', async event => {
  event.preventDefault(); try { await Portal.login(event.target); await loadPlatform(); } catch (error) { reportError(error); }
});
if (Portal.session()) loadPlatform().catch(reportError);
