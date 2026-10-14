const escP = value => String(value ?? '').replace(/[&<>"']/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#039;' }[char]));
const eventP = { view: 'مشاهدة', search: 'ظهور في البحث', cart_add: 'إضافة للسلة', cart_remove: 'حذف/تقليل من السلة' };
const customerOffsets = { registered: 0, visitors: 0 };
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
  document.querySelector('#registeredCount').textContent = String(data.counts && data.counts.registered != null ? data.counts.registered : customers.length);
  document.querySelector('#visitorCount').textContent = String(data.counts && data.counts.visitors != null ? data.counts.visitors : visitors.length);
  document.querySelector('#registeredCustomers').innerHTML = customers.length ? customers.map(customer => {
    const target = `activity-customer-${escP(customer.id)}`;
    return `<article class="customer-row customer-row-expanded"><div class="customer-row-main"><strong>${escP(customer.full_name || 'عميل مسجل')}</strong><small>الهاتف: ${escP(customer.phone || 'غير مسجل')} · تاريخ التسجيل: ${escP(dateP(customer.created_at))}</small><button type="button" class="ghost activity-open" data-load-activity data-kind="customer" data-id="${escP(customer.id)}" data-target="${target}">عرض السلة وسجل النشاط</button></div><div class="customer-cart"><b>${Number(customer.cartItems || 0)} صنف</b><small>${Number(customer.cartUnits || 0)} قطعة في السلة</small></div><div id="${target}" class="customer-activity-panel" hidden></div></article>`;
  }).join('') : '<div class="empty">لا يوجد عملاء مسجلون</div>';
  document.querySelector('#guestCustomers').innerHTML = visitors.length ? visitors.map(visitor => {
    const hash = String(visitor.fingerprint_hash || ''), target = `activity-guest-${escP(visitor.id)}`;
    return `<article class="customer-row customer-row-expanded"><div class="customer-row-main"><strong>زائر · <code title="${escP(hash)}">${escP(hash.slice(0, 16))}${hash.length > 16 ? '…' : ''}</code></strong><small>أول زيارة: ${escP(dateP(visitor.first_seen_at))} · آخر نشاط: ${escP(dateP(visitor.last_seen_at))}</small><button type="button" class="ghost activity-open" data-load-activity data-kind="guest" data-id="${escP(visitor.id)}" data-target="${target}">عرض السلة وسجل النشاط</button></div><div class="customer-cart"><b>${Number(visitor.cart_items_count || 0)} صنف</b><small>${Number(visitor.cart_units || 0)} قطعة في السلة</small></div><div id="${target}" class="customer-activity-panel" hidden></div></article>`;
  }).join('') : '<div class="empty">لا يوجد زوار نشطون</div>';
  const pagination = data.pagination || {};
  if (pagination.registered) {
    customerOffsets.registered = Number(pagination.registered.offset) || 0;
    renderCustomerPagination('registered', pagination.registered);
  }
  if (pagination.visitors) {
    customerOffsets.visitors = Number(pagination.visitors.offset) || 0;
    renderCustomerPagination('visitors', pagination.visitors);
  }
}
function renderCustomerPagination(type, page) {
  const root = document.querySelector(type === 'registered' ? '#registeredPagination' : '#visitorPagination');
  if (!root) return;
  const offset = Math.max(0, Number(page.offset) || 0), limit = Math.max(1, Number(page.limit) || 50), total = Math.max(0, Number(page.total) || 0);
  if (!total) { root.innerHTML = '<span class="muted">لا توجد صفحات</span>'; return; }
  const currentPage = Math.floor(offset / limit) + 1, pageCount = Math.ceil(total / limit);
  const previous = Math.max(0, offset - limit), next = offset + limit;
  root.innerHTML = `<button class="ghost" type="button" data-customer-page="${type}" data-offset="${previous}" ${offset === 0 ? 'disabled' : ''}>السابق</button><span>الصفحة ${numberP(currentPage)} من ${numberP(pageCount)} · ${numberP(total)} سجل</span><button class="ghost" type="button" data-customer-page="${type}" data-offset="${next}" ${next >= total ? 'disabled' : ''}>التالي</button>`;
}

const periodsP = { today: 'اليوم', week: 'آخر 7 أيام', month: 'آخر 30 يومًا', year: 'آخر 365 يومًا' };
const rankingKeysP = { topViewed: 'view', topSearched: 'search', topCartAdded: 'cart_add', topCartRemoved: 'cart_remove' };
const analyticsStateP = { guest: null, customer: null };
const analyticsRequestP = { guest: 0, customer: 0 };
const analyticsInflightP = { guest: null, customer: null };
let activeCustomerTabP = 'registered';
function renderRankTable(rows, actor, key, page) {
  const peopleLabel = actor === 'guest' ? 'عدد الزوار' : 'عدد العملاء';
  const table = Array.isArray(rows) && rows.length
    ? `<div class="activity-table-wrap"><table class="activity-table rank-table"><thead><tr><th>العطر وبياناته</th><th>مرات العملية</th><th>${peopleLabel}</th></tr></thead><tbody>${rows.map(row => `<tr><td class="activity-product-cell">${productSummary(row.product)}</td><td>${numberP(row.operations)}</td><td>${numberP(row.people)}</td></tr>`).join('')}</tbody></table></div>`
    : '<div class="empty">لا توجد بيانات في هذه الفترة</div>';
  if (!page) return table;
  const more = page.hasMore ? `<button class="ghost" type="button" data-rank-more data-rank-actor="${actor}" data-rank-key="${key}">تحميل المزيد</button>` : '';
  return `${table}<div class="rank-pagination"><span>عرض ${numberP((rows || []).length)} من ${numberP(page.total)}</span>${more}</div>`;
}
function renderAnalytics(actor, data) {
  if (!['guest', 'customer'].includes(actor)) return;
  const prefix = actor === 'guest' ? 'guest' : 'registered';
  const personLabel = actor === 'guest' ? 'زوار لديهم نشاط' : 'عملاء مسجلون لديهم نشاط';
  const range = document.querySelector(`#${prefix}AnalyticsRange`);
  const statsBox = document.querySelector(`#${prefix}AnalyticsStats`);
  const topProducts = document.querySelector(`#${prefix}TopProducts`);
  const basketProducts = document.querySelector(`#${prefix}BasketProducts`);
  if (!range || !statsBox || !topProducts || !basketProducts) return;
  range.textContent = `${periodsP[data.period] || periodsP.today} · ${data.startDate || '—'} – ${data.endDate || '—'}`;
  const stats = [[personLabel, data.people], ['جلسات نشطة الآن', data.activeSessions], ['عدد الزيارات', data.visitCount], ['الوقت النشط', durationP(data.activeSeconds)], ['مشاهدات المنتجات', data.productViews], ['نتائج بحث المنتجات', data.productSearches], ['إضافات للسلة', data.cartAdds], ['حذف/تقليل من السلة', data.cartRemoves]];
  statsBox.innerHTML = stats.map((item, index) => `<div class="stat ${index === 0 ? 'gold' : ''}"><small>${item[0]}</small><b>${typeof item[1] === 'string' ? escP(item[1]) : numberP(item[1])}</b></div>`).join('');
  const rankings = data.rankings || {};
  topProducts.innerHTML = `<h5>الأكثر مشاهدة</h5>${renderRankTable(data.topViewed, actor, 'topViewed', rankings.topViewed)}<h5>الأكثر ظهورًا في نتائج البحث</h5>${renderRankTable(data.topSearched, actor, 'topSearched', rankings.topSearched)}`;
  basketProducts.innerHTML = `<h5>الأكثر إضافةً إلى السلة</h5>${renderRankTable(data.topCartAdded, actor, 'topCartAdded', rankings.topCartAdded)}<h5>الأكثر حذفًا أو تقليلًا من السلة</h5>${renderRankTable(data.topCartRemoved, actor, 'topCartRemoved', rankings.topCartRemoved)}`;
}
async function requestProductRanking(actor, period, eventType, offset) {
  const query = new URLSearchParams({ actor, period, eventType, limit: '20', offset: String(offset) });
  const response = await fetch(`/api/customer-product-rankings?${query}`, { headers: Portal.auth() });
  const result = await response.json();
  if (!response.ok) throw Error(result.error || 'تعذر تحميل ترتيب المنتجات');
  return result;
}
async function loadAnalytics(actor) {
  if (!['guest', 'customer'].includes(actor) || !Portal.session()) return;
  const requestId = ++analyticsRequestP[actor];
  const prefix = actor === 'guest' ? 'guest' : 'registered';
  const period = document.querySelector(`#${prefix}AnalyticsPeriod`).value || 'today';
  const response = await fetch(`/api/guest-analytics?period=${encodeURIComponent(period)}&actor=${encodeURIComponent(actor)}`, { headers: Portal.auth() }), result = await response.json();
  if (!response.ok) throw Error(result.error || 'تعذر تحميل التحليلات');
  const rankingResults = await Promise.all(Object.entries(rankingKeysP).map(async ([key, eventType]) => [key, await requestProductRanking(actor, period, eventType, 0)]));
  if (requestId !== analyticsRequestP[actor]) return;
  document.querySelector(`#${prefix}AnalyticsError`).hidden = true;
  const analytics = result.analytics;
  analytics.rankings = {};
  for (const [key, page] of rankingResults) {
    analytics[key] = page.records;
    analytics.rankings[key] = { period, eventType: rankingKeysP[key], records: page.records, total: page.total, hasMore: page.hasMore };
  }
  analyticsStateP[actor] = analytics;
  renderAnalytics(actor, analytics);
}
function ensureAnalytics(actor, force = false) {
  if (!['guest', 'customer'].includes(actor) || !Portal.session()) return Promise.resolve();
  const prefix = actor === 'guest' ? 'guest' : 'registered';
  const period = document.querySelector(`#${prefix}AnalyticsPeriod`).value || 'today';
  if (!force && analyticsStateP[actor] && analyticsStateP[actor].period === period) return Promise.resolve(analyticsStateP[actor]);
  const inFlight = analyticsInflightP[actor];
  if (!force && inFlight && inFlight.period === period) return inFlight.promise;
  const promise = loadAnalytics(actor).finally(() => {
    if (analyticsInflightP[actor] && analyticsInflightP[actor].promise === promise) analyticsInflightP[actor] = null;
  });
  analyticsInflightP[actor] = { period, promise };
  return promise;
}
async function loadMoreProductRanking(button) {
  const actor = button.dataset.rankActor, key = button.dataset.rankKey;
  if (!['guest', 'customer'].includes(actor) || !Object.prototype.hasOwnProperty.call(rankingKeysP, key)) return;
  const analytics = analyticsStateP[actor], page = analytics && analytics.rankings && analytics.rankings[key];
  const prefix = actor === 'guest' ? 'guest' : 'registered';
  const currentPeriod = document.querySelector(`#${prefix}AnalyticsPeriod`).value || 'today';
  if (!page || !page.hasMore || page.period !== currentPeriod) return;
  button.disabled = true;
  try {
    const next = await requestProductRanking(actor, page.period, page.eventType, page.records.length);
    if (analyticsStateP[actor] !== analytics || (document.querySelector(`#${prefix}AnalyticsPeriod`).value || 'today') !== page.period) return;
    page.records = page.records.concat(next.records);
    page.total = next.total;
    page.hasMore = next.hasMore;
    analytics[key] = page.records;
    renderAnalytics(actor, analytics);
  } catch (error) {
    showAnalyticsError(actor, error);
  } finally { button.disabled = false; }
}
function showAnalyticsError(actor, error) {
  const prefix = actor === 'guest' ? 'guest' : 'registered';
  const box = document.querySelector(`#${prefix}AnalyticsError`);
  if (!box) return;
  box.textContent = error && error.message ? error.message : 'تعذر تحميل التحليلات'; box.hidden = false;
}
function activateCustomerTabs() {
  const tabs = document.querySelector('#customerTabs'); if (!tabs) return;
  document.querySelector('#registeredAnalytics').hidden = false;
  document.querySelector('#guestAnalytics').hidden = true;
  tabs.addEventListener('click', event => {
    const button = event.target.closest('[data-customer-tab]'); if (!button) return;
    const guests = button.dataset.customerTab === 'visitors';
    activeCustomerTabP = guests ? 'visitors' : 'registered';
    document.querySelector('#registeredTab').setAttribute('aria-selected', String(!guests));
    document.querySelector('#visitorsTab').setAttribute('aria-selected', String(guests));
    document.querySelector('#registeredCustomers').hidden = guests;
    document.querySelector('#guestCustomers').hidden = !guests;
    document.querySelector('#registeredPagination').hidden = guests;
    document.querySelector('#visitorPagination').hidden = !guests;
    document.querySelector('#registeredAnalytics').hidden = guests;
    document.querySelector('#guestAnalytics').hidden = !guests;
    ensureAnalytics(guests ? 'guest' : 'customer').catch(error => showAnalyticsError(guests ? 'guest' : 'customer', error));
  });
}
async function loadCustomersDashboard(loadInsights = true) {
  if (!Portal.session()) return;
  document.querySelector('#login').hidden = true; document.querySelector('#app').hidden = false; document.querySelector('#logout').hidden = false;
  const query = new URLSearchParams({ registeredOffset: String(customerOffsets.registered), visitorOffset: String(customerOffsets.visitors) });
  const response = await fetch(`/api/platform-customers?${query}`, { headers: Portal.auth() }), data = await response.json();
  if (!response.ok) throw Error(data.error || 'تعذر تحميل بيانات العملاء');
  document.querySelector('#platformError').hidden = true;
  document.querySelector('#stats').innerHTML = [['العملاء المسجلون', data.counts.registered], ['العملاء الزوار', data.counts.visitors]].map(item => `<div class="stat"><small>${item[0]}</small><b>${numberP(item[1])}</b></div>`).join('');
  renderCustomers(data);
  if (loadInsights) {
    const actor = activeCustomerTabP === 'visitors' ? 'guest' : 'customer';
    ensureAnalytics(actor, true).catch(error => showAnalyticsError(actor, error));
  }
}
activateCustomerTabs();
const refreshCustomers = document.querySelector('#refreshCustomers');
if (refreshCustomers) refreshCustomers.addEventListener('click', () => loadCustomersDashboard().catch(reportError));
const guestAnalyticsPeriod = document.querySelector('#guestAnalyticsPeriod');
if (guestAnalyticsPeriod) guestAnalyticsPeriod.addEventListener('change', () => loadAnalytics('guest').catch(error => showAnalyticsError('guest', error)));
const registeredAnalyticsPeriod = document.querySelector('#registeredAnalyticsPeriod');
if (registeredAnalyticsPeriod) registeredAnalyticsPeriod.addEventListener('change', () => loadAnalytics('customer').catch(error => showAnalyticsError('customer', error)));
document.addEventListener('click', event => {
  const rankMore = event.target.closest('[data-rank-more]');
  if (rankMore) { loadMoreProductRanking(rankMore); return; }
  const more = event.target.closest('[data-more-activity]');
  if (more) {
    const panel = more.closest('.customer-activity-panel'); if (!panel) return;
    more.disabled = true; fetchCustomerDetail(panel, Number(panel.dataset.offset || 0), true).catch(error => { more.textContent = error.message || 'تعذر تحميل المزيد'; }).finally(() => { more.disabled = false; }); return;
  }
  const pageButton = event.target.closest('[data-customer-page]');
  if (pageButton) {
    const type = pageButton.dataset.customerPage, offset = Number(pageButton.dataset.offset);
    if (!['registered', 'visitors'].includes(type) || !Number.isSafeInteger(offset) || offset < 0) return;
    customerOffsets[type] = offset;
    pageButton.disabled = true;
    loadCustomersDashboard(false).catch(reportError);
    return;
  }
  const button = event.target.closest('[data-load-activity]'); if (!button) return;
  const panel = document.getElementById(button.dataset.target); if (!panel) return;
  if (panel.dataset.loaded === 'true') { panel.hidden = !panel.hidden; return; }
  panel.hidden = false; panel.dataset.type = button.dataset.kind; panel.dataset.id = button.dataset.id;
  panel.innerHTML = '<p class="muted">جارٍ تحميل السلة وسجل النشاط…</p>'; button.disabled = true;
  fetchCustomerDetail(panel, 0, false).then(() => { panel.dataset.loaded = 'true'; }).catch(error => { panel.innerHTML = `<p class="platform-error">${escP(error.message || 'تعذر تحميل سجل العميل')}</p>`; }).finally(() => { button.disabled = false; });
});
document.querySelector('#loginForm').addEventListener('submit', async event => {
  event.preventDefault(); try { await Portal.login(event.target); await loadCustomersDashboard(); } catch (error) { reportError(error); }
});
if (Portal.session()) loadCustomersDashboard().catch(reportError);
