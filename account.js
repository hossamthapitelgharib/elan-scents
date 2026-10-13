const escA = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#039;' }[c]));
const statusA = { awaiting_store_confirmation: ['بانتظار المتجر', 'gold'], store_confirmed: ['تم تأكيد الطلب', 'green'], processing: ['قيد التجهيز', 'blue'], shipped: ['تم الشحن', 'blue'], delivered: ['تم التسليم', 'green'], completed: ['تم التسليم', 'green'], store_rejected: ['أُلغي الطلب', 'red'], store_cancelled: ['أُلغي الطلب وأُعيدت المنتجات', 'red'], restored: ['عادت المنتجات إلى السلة', 'green'], needs_review: ['قيد المراجعة', 'orange'] };
const shippingA = { preparing: ['قيد التجهيز', 'gold'], handed_to_carrier: ['تم تسليمها لشركة الشحن', 'blue'], in_transit: ['في الطريق', 'blue'], out_for_delivery: ['خرجت للتسليم', 'blue'], delivered: ['تم التسليم', 'green'], delayed: ['متأخرة', 'orange'], returned: ['مرتجعة', 'red'], cancelled: ['ملغاة', 'red'] };
const terminalA = new Set(['completed', 'delivered', 'store_cancelled', 'store_rejected', 'restored', 'closed']);
const badgeA = status => { const value = statusA[status] || ['قيد المتابعة', 'muted']; return `<span class="badge ${value[1]}">${value[0]}</span>`; };
const shippingBadgeA = status => { const value = shippingA[status] || ['غير مسجل', 'muted']; return `<span class="badge ${value[1]}">${value[0]}</span>`; };
const moneyA = (amount, currency = 'EGP') => `${Number(amount || 0).toFixed(2)} ${escA(currency)}`;
const stateA = request => { const restoration = (request.store_order_cart_restorations || [])[0]; if (restoration && restoration.status === 'restored') return 'restored'; return request.status || 'awaiting_store_confirmation'; };
const shipmentA = request => (request.store_shipments || [])[0] || null;
const dateA = value => { try { return new Date(value).toLocaleDateString('ar-EG', { year: 'numeric', month: 'short', day: 'numeric' }); } catch (_) { return ''; } };
const dateTimeA = value => { try { return new Date(value).toLocaleString('ar-EG', { dateStyle: 'medium', timeStyle: 'short' }); } catch (_) { return ''; } };
const PAGE_SIZE = 100;
let guestCartClaimed = false;
let accountSessions = [];
let accountOffset = 0;
let accountTotal = null;
let accountLoading = false;
let archiveSessions = [];
let archiveOffset = 0;
let archiveTotal = null;
let archiveQuery = {};
let archiveLoading = false;

function cartSnapshot() { try { return JSON.parse(localStorage.getItem('elan_cart') || '[]').reduce((total, item) => total + (Number(item.q) || 0), 0); } catch (_) { return 0; } }
function updateCartShortcut(restored = 0) { const element = document.querySelector('#cartShortcut'); if (!element) return; element.querySelector('b').textContent = cartSnapshot(); element.classList.toggle('has-restored', restored > 0); element.querySelector('span').textContent = restored ? `السلة · ${restored} مسترجع` : 'سلة Élan Scents'; }
function shipmentLine(request) {
  const shipment = shipmentA(request);
  if (!shipment) return '<div class="shipment-box shipment-empty"><b>الشحن</b><span>لم يسجل المتجر بيانات الشحن بعد.</span></div>';
  return `<div class="shipment-box"><div class="shipment-head"><div><small>شحن المتجر</small><strong>${escA(shipment.carrier_name || 'شركة الشحن غير محددة')}</strong></div>${shippingBadgeA(shipment.shipping_status)}</div><div class="shipment-meta"><span>رقم التتبع</span><b dir="ltr">${escA(shipment.tracking_code || 'لم يحدد بعد')}</b></div>${shipment.estimated_delivery_at ? `<div class="shipment-meta"><span>التسليم المتوقع</span><b>${dateA(shipment.estimated_delivery_at)}</b></div>` : ''}${shipment.status_note ? `<p class="shipment-note">${escA(shipment.status_note)}</p>` : ''}<small class="shipment-updated">آخر تحديث: ${dateTimeA(shipment.updated_at)}</small></div>`;
}
function requestLine(request) {
  const state = stateA(request), items = request.store_order_request_items || [];
  const names = items.slice(0, 2).map(item => `${escA(item.product_name)}${Number(item.quantity) > 1 ? ` × ${item.quantity}` : ''}`).join('، ');
  return `<article class="compact-order"><div class="compact-order-main"><div><span class="order-store">${escA(request.stores && request.stores.name || 'متجر')}</span><h3>${escA(request.tracking_number)}</h3><p>${names || 'تفاصيل المنتجات متاحة داخل الطلب'}${items.length > 2 ? ` <span class="muted">+${items.length - 2} أخرى</span>` : ''}</p></div><div class="compact-order-side">${badgeA(state)}<strong>${moneyA(request.total_amount ?? request.subtotal, request.currency)}</strong></div></div>${shipmentLine(request)}<div class="compact-order-foot"><span>${dateA(request.created_at)}</span><details><summary>التفاصيل</summary><div class="order-detail">${items.map(item => `<div><span>${escA(item.product_name)} × ${item.quantity}</span><b>${moneyA(item.line_total, item.currency)}</b></div>`).join('')}<hr><div><span>المتجر</span><b>${escA(request.stores && request.stores.name || '—')}</b></div><div><span>رقم التتبع الموحد</span><b>${escA(request.tracking_number)}</b></div>${shipmentLine(request)}</div></details></div></article>`;
}
function flatten(sessions) { return sessions.flatMap(session => (session.store_order_requests || []).map(request => ({ ...request, session }))); }
function mergeSessions(newer, older) {
  const seen = new Set();
  return [...newer, ...older].filter(session => { const key = String(session.id || session.tracking_number || ''); if (!key || seen.has(key)) return false; seen.add(key); return true; });
}
function renderList(element, requests, empty) { element.innerHTML = requests.length ? requests.map(requestLine).join('') : `<div class="empty">${empty}</div>`; }
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
  const completed = requests.filter(request => ['completed', 'delivered'].includes(stateA(request))).sort((a, b) => new Date(b.created_at) - new Date(a.created_at));
  const restored = requests.filter(request => stateA(request) === 'restored').length;
  document.querySelector('#ordersCount').textContent = `${requests.length} طلب`;
  document.querySelector('#stats').innerHTML = [['قيد المتابعة', active.length, 'orange'], ['تم التسليم', completed.length, 'green'], ['مسترجعة', restored, 'blue']].map(item => `<div class="stat ${item[2]}"><small>${item[0]}</small><b>${item[1]}</b></div>`).join('');
  renderList(document.querySelector('#activeOrders'), active, 'لا توجد طلبات حالية تحتاج متابعة');
  renderList(document.querySelector('#recentOrders'), completed.slice(0, 5), 'لا توجد طلبات مكتملة بعد');
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
    archiveQuery = { q: document.querySelector('#archiveSearch').value.trim(), year: document.querySelector('#archiveYear').value };
    archiveSessions = []; archiveOffset = 0; archiveTotal = null;
    const box = document.querySelector('#archiveOrders'); box.hidden = false; box.innerHTML = '<div class="muted">جارٍ البحث…</div>';
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
    const box = document.querySelector('#archiveOrders'); box.hidden = false; renderList(box, requests, 'لا توجد طلبات مطابقة للبحث');
    more.hidden = archiveTotal !== null ? archiveSessions.length >= archiveTotal : !page.hasMore;
  } finally { more.disabled = false; archiveLoading = false; }
}
async function loadAccount(append = false) {
  const session = Portal.session();
  if (!session || accountLoading) return;
  if (!guestCartClaimed && window.GuestIdentity) { try { await GuestIdentity.claim(session.access_token); guestCartClaimed = true; } catch (_) {} }
  accountLoading = true;
  const offset = append ? accountOffset : 0;
  const more = document.querySelector('#loadMoreOrders'); more.disabled = true;
  try {
    const page = await fetchSessions({ offset });
    accountSessions = append ? mergeSessions(accountSessions, page.sessions) : mergeSessions(page.sessions, accountSessions);
    if (append) accountOffset = offset + page.sessions.length;
    else accountOffset = Math.max(accountOffset, page.sessions.length);
    accountTotal = page.total;
    const hasMore = accountTotal !== null ? accountSessions.length < accountTotal : page.hasMore;
    more.hidden = !hasMore;
    document.querySelector('#login').hidden = true;
    document.querySelector('#app').hidden = false;
    document.querySelector('#logout').hidden = false;
    renderAccount(accountSessions);
  } finally { more.disabled = false; accountLoading = false; }
}

document.querySelector('#loginForm').addEventListener('submit', async event => { event.preventDefault(); try { await Portal.login(event.target); await loadAccount(); } catch (error) { document.querySelector('#message').textContent = error.message; } });
document.querySelector('#archiveForm').addEventListener('submit', event => loadArchive(event).catch(error => { document.querySelector('#message').textContent = error.message; }));
document.querySelector('#loadMoreOrders').addEventListener('click', () => loadAccount(true).catch(error => { document.querySelector('#message').textContent = error.message; }));
document.querySelector('#loadMoreArchive').addEventListener('click', () => loadArchive(null, true).catch(error => { document.querySelector('#message').textContent = error.message; }));
if (Portal.session()) loadAccount().catch(error => { document.querySelector('#message').textContent = error.message; });
setInterval(() => { if (Portal.session()) loadAccount().catch(() => {}); }, 30000);
