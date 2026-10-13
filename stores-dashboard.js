const escStore = value => String(value ?? '').replace(/[&<>"']/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#039;' }[char]));
const nStore = value => Math.max(0, Number(value) || 0).toLocaleString('ar-EG');
const dateStore = value => { try { return value ? new Date(value).toLocaleString('ar-EG') : '—'; } catch (_) { return '—'; } };
const labelsStore = {
  active: 'نشط', inactive: 'غير نشط', available: 'متاح', unavailable: 'غير متاح',
  awaiting_store_confirmation: 'بانتظار المتجر', store_confirmed: 'تم التأكيد', processing: 'قيد التجهيز',
  shipped: 'تم الشحن', delivered: 'تم التسليم', store_rejected: 'مرفوض', store_cancelled: 'ملغى',
  needs_review: 'يحتاج مراجعة', completed: 'مكتمل', cancelled: 'ملغى', preparing: 'قيد التجهيز',
  handed_to_carrier: 'سُلّم لشركة الشحن', in_transit: 'في الطريق', out_for_delivery: 'خرج للتسليم',
  delayed: 'متأخر', returned: 'مرتجع', pending: 'قيد الانتظار', payable: 'مستحق', paid: 'مدفوع',
  matched: 'مطابق', mismatched: 'غير مطابق', unmatched: 'غير مربوط', percentage: 'نسبة مئوية',
  fixed: 'مبلغ ثابت', package: 'باقة', success: 'ناجح', failed: 'فشل', running: 'جارٍ', skipped: 'تم التخطي'
};
const sectionLabels = {
  overview: 'الملخص والحسابات', catalog: 'الكتالوج والمخزون', offers: 'العروض', orders: 'الطلبات',
  shipments: 'الشحن', commissions: 'العمولات', sync: 'المزامنة', reconciliation: 'المطابقة والتدقيق'
};
const stateStore = { stores: [], selected: null, section: 'overview', offset: 0, limit: 50, hasMore: false, busy: false, unlinked: { notifications: { offset: 0, hasMore: false, busy: false }, events: { offset: 0, hasMore: false, busy: false } } };
function labelValue(value) { return escStore(labelsStore[value] || value || '—'); }
function safeLink(value, label) {
  try {
    const url = new URL(String(value || ''));
    if (!['https:', 'http:'].includes(url.protocol)) return escStore(label || value);
    return `<a href="${escStore(url.href)}" target="_blank" rel="noopener noreferrer">${escStore(label || url.hostname)}</a>`;
  } catch (_) { return escStore(label || value || '—'); }
}
function moneyStore(amount, currency) {
  const n = Number(amount);
  return `${Number.isFinite(n) ? n.toLocaleString('ar-EG', { maximumFractionDigits: 2 }) : '—'} ${escStore(currency || '')}`.trim();
}
function summaryValue(store, key) { return Number(store.summary && store.summary[key]) || 0; }
function renderStoreStats(stores) {
  const sum = key => stores.reduce((total, store) => total + summaryValue(store, key), 0);
  const cards = [
    ['إجمالي المتاجر', stores.length], ['متاجر نشطة', stores.filter(store => store.status === 'active').length],
    ['منتجات متاحة', sum('available_product_count')], ['عروض نشطة', sum('active_offer_count')],
    ['طلبات مفتوحة', sum('open_order_count')], ['طلبات تحتاج مراجعة', sum('review_order_count')]
  ];
  document.querySelector('#storeStats').innerHTML = cards.map((item, index) => `<div class="stat ${index === 0 ? 'gold' : ''}"><small>${item[0]}</small><b>${nStore(item[1])}</b></div>`).join('');
}
function storeRow(store) {
  const summary = store.summary || {};
  const status = labelValue(store.status);
  const website = store.website_url ? `<small>${safeLink(store.website_url, 'الموقع الرسمي')}</small>` : '';
  const commission = store.commission_rate == null ? '—' : `${nStore(store.commission_rate)}%`;
  return `<tr><td><strong>${escStore(store.name || 'متجر')}</strong><small>${escStore(store.slug || '')}</small>${website}<small>${escStore(store.short_description || '')}</small></td><td>${status}</td><td>${nStore(summary.linked_accounts)}</td><td>${nStore(summary.available_product_count)} / ${nStore(summary.product_count)}</td><td>${nStore(summary.active_offer_count)}</td><td>${nStore(summary.open_order_count)} / ${nStore(summary.order_request_count)}</td><td>${nStore(summary.review_order_count)}</td><td>${nStore(summary.shipment_count)}</td><td>${escStore(commission)}</td><td><button class="ghost store-detail-open" type="button" data-store-detail="${escStore(store.id)}">فتح التفاصيل</button></td></tr>`;
}
function renderStoreList() {
  const form = document.querySelector('#storeFilters');
  const search = String(form.elements.search.value || '').trim().toLocaleLowerCase();
  const status = form.elements.status.value;
  const stores = stateStore.stores.filter(store => (!status || store.status === status) && (!search || `${store.name || ''} ${store.slug || ''} ${store.website_url || ''}`.toLocaleLowerCase().includes(search)));
  document.querySelector('#storesBody').innerHTML = stores.length ? stores.map(storeRow).join('') : '<tr><td colspan="10" class="empty">لا توجد متاجر مطابقة</td></tr>';
}
function showStoreError(error) {
  const message = error && error.message ? error.message : 'تعذر تحميل بيانات المتاجر';
  if (document.querySelector('#login') && !document.querySelector('#login').hidden) {
    document.querySelector('#message').textContent = message;
    return;
  }
  const box = document.querySelector('#storeError');
  box.textContent = message;
  box.hidden = false;
}
function showDetailError(error) {
  const box = document.querySelector('#storeDetailError');
  box.textContent = error && error.message ? error.message : 'تعذر تحميل تفاصيل المتجر';
  box.hidden = false;
}
function renderUnlinkedRows(type, records) {
  if (type === 'notifications') return records.map(row => `<tr><td dir="ltr">${escStore(row.tracking_number || '—')}</td><td>${labelValue(row.event_type)}</td><td>${labelValue(row.store_status)}</td><td>${labelValue(row.match_status)}</td><td>${Array.isArray(row.mismatch_fields) && row.mismatch_fields.length ? row.mismatch_fields.map(escStore).join('، ') : '—'}</td><td>${escStore(dateStore(row.received_at))}</td></tr>`).join('');
  return records.map(row => `<tr><td><code>${escStore(row.checkout_session_id || '—')}</code></td><td>${labelValue(row.event_type)}</td><td>${labelValue(row.source)}</td><td>${labelValue(row.actor_role)}</td><td>${escStore(dateStore(row.created_at))}</td></tr>`).join('');
}
async function loadUnlinked(type, append = false) {
  const state = stateStore.unlinked[type];
  if (!state || state.busy) return;
  state.busy = true;
  const body = document.querySelector(type === 'notifications' ? '#unlinkedNotificationsBody' : '#unlinkedEventsBody');
  const more = document.querySelector(type === 'notifications' ? '#unlinkedNotificationsMore' : '#unlinkedEventsMore');
  const offset = append ? state.offset : 0;
  more.disabled = true;
  if (!append) body.innerHTML = `<tr><td colspan="${type === 'notifications' ? 6 : 5}" class="muted">جارٍ التحميل…</td></tr>`;
  try {
    const params = new URLSearchParams({ type, limit: '50', offset: String(offset) });
    const response = await fetch(`/api/platform-store-unlinked?${params}`, { headers: Portal.auth() });
    const data = await response.json();
    if (!response.ok) throw new Error(data.error || 'تعذر تحميل سجلات التشغيل غير المرتبطة');
    const records = Array.isArray(data.records) ? data.records : [];
    const html = renderUnlinkedRows(type, records);
    if (append) { if (html) body.insertAdjacentHTML('beforeend', html); }
    else body.innerHTML = html || `<tr><td colspan="${type === 'notifications' ? 6 : 5}" class="empty">لا توجد سجلات</td></tr>`;
    state.offset = offset + records.length;
    state.hasMore = Boolean(data.hasMore);
    more.hidden = !state.hasMore;
  } catch (error) {
    const box = document.querySelector('#unlinkedStoreError');
    box.textContent = error && error.message ? error.message : 'تعذر تحميل سجلات التشغيل غير المرتبطة';
    box.hidden = false;
    if (!append) body.innerHTML = '';
  } finally {
    more.disabled = false;
    state.busy = false;
  }
}
async function loadStores() {
  if (!Portal.session()) return;
  document.querySelector('#login').hidden = true;
  document.querySelector('#app').hidden = false;
  document.querySelector('#logout').hidden = false;
  const response = await fetch('/api/platform-stores', { headers: Portal.auth() });
  const data = await response.json();
  if (!response.ok) throw new Error(data.error || 'تعذر تحميل بيانات المتاجر');
  stateStore.stores = Array.isArray(data.stores) ? data.stores : [];
  document.querySelector('#storeError').hidden = true;
  document.querySelector('#unlinkedStoreError').hidden = true;
  renderStoreStats(stateStore.stores);
  renderStoreList();
  loadUnlinked('notifications');
  loadUnlinked('events');
}
function detailFilterParams() {
  const form = document.querySelector('#storeDetailFilters');
  const params = new URLSearchParams();
  const status = form.elements.status && form.elements.status.value;
  if (status) params.set('status', status);
  return params;
}
function setDetailFilterOptions(section) {
  const form = document.querySelector('#storeDetailFilters');
  const select = document.querySelector('#storeDetailStatus');
  const label = document.querySelector('#storeDetailStatusLabel');
  const options = section === 'orders'
    ? [['', 'كل حالات الطلب'], ['awaiting_store_confirmation', 'بانتظار المتجر'], ['store_confirmed', 'تم التأكيد'], ['processing', 'قيد التجهيز'], ['shipped', 'تم الشحن'], ['delivered', 'تم التسليم'], ['needs_review', 'يحتاج مراجعة'], ['store_rejected', 'مرفوض'], ['store_cancelled', 'ملغى'], ['completed', 'مكتمل'], ['cancelled', 'ملغى']]
    : section === 'commissions'
      ? [['', 'كل حالات العمولة'], ['pending', 'قيد الانتظار'], ['payable', 'مستحقة'], ['paid', 'مدفوعة']]
      : [];
  form.hidden = options.length === 0;
  if (!options.length) return;
  label.textContent = section === 'orders' ? 'حالة الطلب' : 'حالة العمولة';
  select.innerHTML = options.map(([value, text]) => `<option value="${value}">${text}</option>`).join('');
}
function tableMarkup(headers, rows, empty = 'لا توجد سجلات في هذا القسم') {
  return `<div class="activity-table-wrap"><table class="activity-table store-detail-table"><thead><tr>${headers.map(value => `<th>${value}</th>`).join('')}</tr></thead><tbody data-section-rows>${rows || `<tr><td colspan="${headers.length}" class="empty">${empty}</td></tr>`}</tbody></table></div>`;
}
function detailInfoMarkup(fields) {
  return `<div class="store-detail-info">${fields.map(([label, value, trustedHtml]) => `<div><b>${escStore(label)}</b><span>${trustedHtml ? value : escStore(value ?? '—')}</span></div>`).join('')}</div>`;
}
function renderOverview(data) {
  const store = data.store || {};
  const summary = data.summary || {};
  const cards = [
    ['المنتجات', `${nStore(summary.available_product_count)} متاح من ${nStore(summary.product_count)}`],
    ['العروض النشطة', nStore(summary.active_offer_count)],
    ['الطلبات', `${nStore(summary.open_order_count)} مفتوح من ${nStore(summary.order_request_count)}`],
    ['الشحن', nStore(summary.shipment_count)], ['تحتاج مراجعة', nStore(summary.review_order_count)],
    ['العمولة الافتراضية', `${nStore(store.commission_rate)}%`]
  ].map(([label, value]) => `<div class="store-detail-kpi"><small>${escStore(label)}</small><b>${escStore(value)}</b></div>`).join('');
  const info = detailInfoMarkup([
    ['معرّف المتجر', store.id], ['حالة المتجر', labelsStore[store.status] || store.status], ['الرابط المختصر', store.slug],
    ['الموقع الرسمي', store.website_url ? safeLink(store.website_url) : '—', true], ['الشعار', store.logo_url ? safeLink(store.logo_url, 'فتح الشعار') : '—', true],
    ['صورة المتجر', store.image_url ? safeLink(store.image_url, 'فتح الصورة') : '—', true], ['ترتيب الظهور', store.priority_rank],
    ['نسبة العمولة الافتراضية', `${store.commission_rate ?? '—'}%`], ['تاريخ الإنشاء', dateStore(store.created_at)],
    ['آخر تحديث', dateStore(store.updated_at)], ['الوصف', store.short_description]
  ]);
  const accounts = data.accounts || [];
  const accountRows = accounts.map(account => `<tr><td><code>${escStore(account.id)}</code></td><td><code>${escStore(account.user_id)}</code></td><td>${labelValue(account.role)}</td><td>${escStore(dateStore(account.created_at))}</td><td>${escStore(dateStore(account.updated_at))}</td></tr>`).join('');
  return `<div class="store-detail-kpis">${cards}</div><section class="store-detail-block"><h3>بيانات المتجر</h3>${info}</section><section class="store-detail-block"><h3>الحسابات المرتبطة</h3><p class="muted">تظهر أدوار الحسابات ومعرّفاتها الداخلية فقط؛ لا تُعرض بيانات دخول أو رموز اعتماد.</p>${tableMarkup(['معرّف الربط', 'معرّف المستخدم الداخلي', 'الدور', 'مرتبط منذ', 'آخر تحديث'], accountRows, 'لا توجد حسابات مرتبطة بهذا المتجر')}</section>`;
}
function renderCatalogRows(rows) {
  return (rows || []).map(row => {
    const product = row.product || {}, brand = row.brand || {}, size = row.size || {};
    const available = row.is_available ? 'متاح' : 'غير متاح';
    const price = moneyStore(row.price, row.currency);
    const stock = row.stock_quantity == null ? 'غير محدد' : nStore(row.stock_quantity);
    const technical = detailInfoMarkup([
      ['معرّف سجل المتجر', row.id], ['معرّف الحجم', row.product_size_id], ['نسبة الخصم', row.discount_percentage == null ? '—' : `${row.discount_percentage}%`],
      ['السعر يشمل الضريبة', row.price_includes_tax ? 'نعم' : 'لا'], ['السعر يشمل الشحن', row.price_includes_shipping ? 'نعم' : 'لا'],
      ['الأكثر مبيعًا بالكتالوج', row.is_catalog_bestseller ? 'نعم' : 'لا'], ['تاريخ الإضافة', dateStore(row.created_at)], ['آخر تحديث', dateStore(row.updated_at)]
    ]);
    return `<tr><td><strong>${escStore(product.name || 'منتج غير مرتبط')}</strong><small>${escStore(product.slug || '')}</small></td><td>${escStore(brand.name || '—')}</td><td>${escStore(size.size_label || (size.size_ml ? `${size.size_ml} مل` : '—'))}</td><td>${price}<small>${row.original_price == null ? '' : `السعر قبل الخصم: ${moneyStore(row.original_price, row.currency)}`}</small></td><td>${stock}</td><td>${available}${row.is_new_arrival ? '<small>وصول جديد</small>' : ''}${row.is_coming_soon ? '<small>قريبًا</small>' : ''}<details class="store-audit-details"><summary>تفاصيل السجل</summary>${technical}</details></td><td>${labelValue(row.sync_status)}<small>${escStore(row.data_source || '—')}</small></td><td>${escStore(dateStore(row.last_synced_at))}</td><td>${row.product_url ? safeLink(row.product_url, 'فتح') : '—'}</td></tr>`;
  }).join('');
}
function renderOfferRows(rows) {
  return (rows || []).map(row => {
    const extra = detailInfoMarkup([['معرّف العرض', row.id], ['معرّف الحجم', row.product_size_id], ['أُنشئ في', dateStore(row.created_at)], ['آخر تحديث', dateStore(row.updated_at)]]);
    return `<tr><td><strong>${escStore(row.title || 'عرض')}</strong><small>${escStore(row.description || '')}</small><details class="store-audit-details"><summary>تفاصيل السجل</summary>${extra}</details></td><td>${escStore(row.product && row.product.name || 'كل منتجات المتجر')}</td><td>${escStore(row.brand && row.brand.name || '—')}</td><td>${labelValue(row.discount_type)} · ${nStore(row.discount_value)}</td><td>${row.is_active ? 'نشط' : 'غير نشط'}</td><td>${escStore(dateStore(row.start_date))}</td><td>${escStore(dateStore(row.end_date))}</td></tr>`;
  }).join('');
}
function renderOrderRows(rows) {
  return (rows || []).map(order => {
    const items = (order.items || []).map(item => `<div class="store-detail-line"><span>${escStore(item.product_name)} ${item.brand_name ? `· ${escStore(item.brand_name)}` : ''} ${item.size_label ? `· ${escStore(item.size_label)}` : ''} × ${nStore(item.quantity)}<small>سعر الوحدة: ${moneyStore(item.unit_price, item.currency)} · أُضيف: ${escStore(dateStore(item.created_at))}</small></span><b>${moneyStore(item.line_total, item.currency)}</b></div>`).join('') || '<p class="muted">لا توجد بنود محفوظة.</p>';
    const shipments = (order.shipments || []).map(shipment => `${labelValue(shipment.shipping_status)}${shipment.carrier_name ? ` · ${escStore(shipment.carrier_name)}` : ''}${shipment.tracking_code ? ` · ${escStore(shipment.tracking_code)}` : ''}${shipment.updated_at ? ` · ${escStore(dateStore(shipment.updated_at))}` : ''}`).join('؛ ') || 'لا يوجد سجل شحن';
    const events = (order.notifications || []).map(item => `${labelValue(item.event_type)} · ${labelValue(item.store_status)} · ${labelValue(item.match_status)} · ${escStore(dateStore(item.received_at))}`).join('؛ ') || 'لا توجد إشعارات مسجلة';
    const checks = (order.checks || []).map(item => `${labelValue(item.match_status)} · ${labelValue(item.event_type)} · ${escStore(dateStore(item.checked_at))}${Array.isArray(item.mismatch_fields) && item.mismatch_fields.length ? ` (${item.mismatch_fields.map(escStore).join('، ')})` : ''}`).join('؛ ') || 'لا توجد فحوص';
    const audit = (order.audit || []).map(item => `${labelValue(item.event_type)} · ${labelValue(item.actor_role)} · ${labelValue(item.source)} · ${escStore(dateStore(item.created_at))}`).join('؛ ') || 'لا توجد أحداث تشغيل';
    return `<article class="store-admin-order"><div class="store-admin-order-head"><div><small>رقم التتبع</small><strong dir="ltr">${escStore(order.tracking_number || '—')}</strong><small>معرّف الطلب: <code>${escStore(order.id)}</code></small></div><div>${labelValue(order.status)} · ${labelValue(order.reconciliation_status)}</div></div><div class="store-detail-overview"><span>المجموع الفرعي: <b>${moneyStore(order.subtotal, order.currency)}</b></span><span>الشحن: <b>${moneyStore(order.shipping_amount, order.currency)}</b></span><span>الإجمالي: <b>${moneyStore(order.total_amount ?? order.subtotal, order.currency)}</b></span><span>تاريخ الطلب: <b>${escStore(dateStore(order.created_at))}</b></span><span>مرجع المتجر: <b>${escStore(order.store_order_reference || '—')}</b></span><span>تتبع الطلب الموحد: <b dir="ltr">${escStore(order.checkout_tracking_number || '—')}</b></span></div><div class="store-detail-lines">${items}</div><details class="store-audit-details"><summary>الشحن والإشعارات والمطابقة والتدقيق</summary><div class="store-detail-info"><div><b>الشحن</b><span>${shipments}</span></div><div><b>الإشعارات</b><span>${events}</span></div><div><b>فحوص المطابقة</b><span>${checks}</span></div><div><b>أحداث التشغيل</b><span>${audit}</span></div>${order.failure_reason ? `<div><b>سبب الإخفاق</b><span>${escStore(order.failure_reason)}</span></div>` : ''}</div></details></article>`;
  }).join('');
}
function renderShipmentRows(rows) {
  return (rows || []).map(row => `<tr><td dir="ltr">${escStore(row.order && row.order.tracking_number || row.request_id)}<small>${escStore(row.request_id)}</small></td><td>${labelValue(row.order && row.order.status)}</td><td>${escStore(row.carrier_name || '—')}</td><td dir="ltr">${escStore(row.tracking_code || '—')}</td><td>${labelValue(row.shipping_status)}</td><td>${escStore(dateStore(row.estimated_delivery_at))}</td><td>${escStore(dateStore(row.delivered_at))}</td><td>${escStore(row.status_note || '—')}</td><td>${escStore(dateStore(row.created_at))}<small>آخر تحديث: ${escStore(dateStore(row.updated_at))}</small></td></tr>`).join('');
}
function renderCommissionRows(rows) {
  return (rows || []).map(row => `<tr><td>${labelValue(row.status)}<small>معرّف العمولة: <code>${escStore(row.id)}</code></small></td><td>${nStore(row.rate)}%</td><td>${moneyStore(row.amount, row.item && row.item.product && row.item.product.currency)}</td><td>${escStore(row.item && row.item.product && row.item.product.product && row.item.product.product.name || '—')}</td><td>${nStore(row.item && row.item.quantity)}</td><td>${moneyStore(row.item && row.item.price_at_time, row.item && row.item.product && row.item.product.currency)}</td><td dir="ltr">${escStore(row.order && row.order.id || '—')}<small>${labelValue(row.order && row.order.status)}</small></td><td>${escStore(dateStore(row.created_at))}<small>آخر تحديث: ${escStore(dateStore(row.updated_at))}</small></td></tr>`).join('');
}
function renderSyncRows(rows) {
  return (rows || []).map(row => `<tr><td>${labelValue(row.status)}</td><td>${nStore(row.records_count)}</td><td>${escStore(dateStore(row.created_at))}</td><td>${escStore(dateStore(row.updated_at))}</td></tr>`).join('');
}
function renderReconciliationRows(rows) {
  const checks = (rows || []).flatMap(request => {
    const related = request.checks || [];
    return related.length ? related.map(check => ({ ...check, order: request })) : [{ tracking_number: request.tracking_number, event_type: '—', match_status: request.reconciliation_status || 'pending', mismatch_fields: [], checked_at: null, order: request }];
  });
  return checks.map(row => `<tr><td dir="ltr">${escStore(row.tracking_number || '—')}<small>${escStore(row.order && row.order.id || '—')}</small></td><td>${labelValue(row.event_type)}<small>${escStore(row.notification_id || '—')}</small></td><td>${labelValue(row.match_status)}</td><td>${Array.isArray(row.mismatch_fields) && row.mismatch_fields.length ? row.mismatch_fields.map(escStore).join('، ') : '—'}</td><td>${labelValue(row.order && row.order.status)}</td><td>${escStore(dateStore(row.checked_at))}<small>آخر تعديل للطلب: ${escStore(dateStore(row.order && row.order.updated_at))}</small></td></tr>`).join('');
}
function renderSectionRecords(section, records) {
  if (section === 'catalog') return renderCatalogRows(records);
  if (section === 'offers') return renderOfferRows(records);
  if (section === 'orders') return renderOrderRows(records);
  if (section === 'shipments') return renderShipmentRows(records);
  if (section === 'commissions') return renderCommissionRows(records);
  if (section === 'sync') return renderSyncRows(records);
  if (section === 'reconciliation') return renderReconciliationRows(records);
  return '';
}
function renderSection(data) {
  const rows = renderSectionRecords(data.section, data.records || []);
  if (data.section === 'overview') return renderOverview(data);
  const tableHeaders = {
    catalog: ['العطر', 'العلامة', 'الحجم', 'السعر', 'المخزون', 'التوفر', 'المزامنة والمصدر', 'آخر مزامنة', 'الرابط'],
    offers: ['العرض', 'العطر', 'العلامة', 'الخصم', 'الحالة', 'يبدأ', 'ينتهي'],
    shipments: ['رقم الطلب', 'حالة الطلب', 'شركة الشحن', 'رقم التتبع', 'حالة الشحن', 'التسليم المتوقع', 'تم التسليم', 'ملاحظة التشغيل', 'تاريخ السجل والتحديث'],
    commissions: ['الحالة', 'النسبة', 'قيمة العمولة', 'العطر', 'الكمية', 'سعر الوحدة', 'رقم الطلب', 'تاريخ التسجيل'],
    sync: ['الحالة', 'عدد السجلات', 'بدأت/سُجلت', 'آخر تحديث'],
    reconciliation: ['رقم التتبع', 'نوع الحدث', 'نتيجة المطابقة', 'الحقول المختلفة', 'حالة الطلب', 'وقت الفحص']
  };
  if (data.section === 'orders') return `<div class="store-admin-order-list" data-section-rows>${rows || '<p class="empty">لا توجد طلبات في هذا القسم</p>'}</div>`;
  return tableMarkup(tableHeaders[data.section] || [], rows);
}
async function loadStoreSection(section, append = false) {
  if (!stateStore.selected || stateStore.busy) return;
  stateStore.busy = true;
  stateStore.section = section;
  const panel = document.querySelector('#storeDetail');
  panel.hidden = false;
  document.querySelector('#storeDetailTitle').textContent = `تفاصيل ${stateStore.selected.name || 'المتجر'} · ${sectionLabels[section]}`;
  document.querySelector('#storeDetailSummary').textContent = 'بيانات إدارية للقراءة فقط؛ تفاصيل اتصال العملاء والحمولات الخام غير معروضة هنا.';
  document.querySelector('#storeDetailError').hidden = true;
  document.querySelector('#storeDetailMore').disabled = true;
  document.querySelector('#storeDetailMore').hidden = true;
  setDetailFilterOptions(section);
  for (const button of document.querySelectorAll('[data-store-section]')) button.setAttribute('aria-selected', String(button.dataset.storeSection === section));
  const offset = append ? stateStore.offset : 0;
  if (!append) {
    stateStore.offset = 0;
    document.querySelector('#storeDetailContent').innerHTML = '<p class="muted">جارٍ تحميل بيانات القسم…</p>';
  }
  try {
    const params = new URLSearchParams({ storeId: stateStore.selected.id, section, limit: String(stateStore.limit), offset: String(offset) });
    if (section === 'orders' || section === 'commissions') {
      const filters = detailFilterParams();
      for (const [key, value] of filters) if (value) params.set(key, value);
    }
    const response = await fetch(`/api/platform-store-detail?${params.toString()}`, { headers: Portal.auth() });
    const data = await response.json();
    if (!response.ok) throw new Error(data.error || 'تعذر تحميل التفاصيل');
    const html = renderSection(data);
    if (!append) document.querySelector('#storeDetailContent').innerHTML = html;
    else {
      const rowsContainer = document.querySelector('#storeDetailContent [data-section-rows]');
      const rowsHtml = renderSectionRecords(section, data.records || []);
      if (rowsContainer && rowsHtml) rowsContainer.insertAdjacentHTML('beforeend', rowsHtml);
    }
    stateStore.offset = offset + (data.records || []).length;
    stateStore.hasMore = Boolean(data.hasMore);
    const more = document.querySelector('#storeDetailMore');
    more.hidden = !stateStore.hasMore;
    more.disabled = false;
  } catch (error) {
    if (!append) document.querySelector('#storeDetailContent').innerHTML = '';
    showDetailError(error);
    document.querySelector('#storeDetailMore').disabled = false;
  } finally {
    stateStore.busy = false;
  }
}
function openStore(storeId) {
  const store = stateStore.stores.find(item => item.id === storeId);
  if (!store) return;
  stateStore.selected = store;
  stateStore.offset = 0;
  document.querySelector('#storeDetail').hidden = false;
  loadStoreSection('overview');
  document.querySelector('#storeDetail').scrollIntoView({ behavior: 'smooth', block: 'start' });
}
function showStoreError(error) {
  if (document.querySelector('#login') && !document.querySelector('#login').hidden) {
    document.querySelector('#message').textContent = error && error.message || 'تعذر تسجيل الدخول';
    return;
  }
  const box = document.querySelector('#storeError');
  box.textContent = error && error.message || 'تعذر تحميل بيانات المتاجر';
  box.hidden = false;
}

document.querySelector('#refreshStores').addEventListener('click', () => loadStores().catch(showStoreError));
document.querySelector('#storeFilters').addEventListener('submit', event => { event.preventDefault(); renderStoreList(); });
document.querySelector('#storeFilters').elements.search.addEventListener('input', renderStoreList);
document.addEventListener('click', event => {
  const open = event.target.closest('[data-store-detail]');
  if (open) return openStore(open.dataset.storeDetail);
  const tab = event.target.closest('[data-store-section]');
  if (tab) return loadStoreSection(tab.dataset.storeSection);
  if (event.target.closest('#storeDetailMore')) return loadStoreSection(stateStore.section, true);
  if (event.target.closest('#unlinkedNotificationsMore')) return loadUnlinked('notifications', true);
  if (event.target.closest('#unlinkedEventsMore')) return loadUnlinked('events', true);
  if (event.target.closest('#closeStoreDetail')) document.querySelector('#storeDetail').hidden = true;
});
document.querySelector('#storeDetailFilters').addEventListener('submit', event => {
  event.preventDefault();
  stateStore.offset = 0;
  loadStoreSection(stateStore.section);
});
document.querySelector('#loginForm').addEventListener('submit', async event => {
  event.preventDefault();
  try { await Portal.login(event.target); await loadStores(); } catch (error) { showStoreError(error); }
});
if (Portal.session()) loadStores().catch(showStoreError);
