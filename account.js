const escA = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#039;' }[c]));
const statusA = { awaiting_store_confirmation: ['بانتظار المتجر', 'gold'], store_confirmed: ['تم تأكيد الطلب', 'green'], processing: ['قيد التجهيز', 'blue'], shipped: ['تم الشحن', 'blue'], delivered: ['تم التسليم', 'green'], completed: ['تم التسليم', 'green'], store_rejected: ['أُلغي الطلب', 'red'], cancelled: ['أُلغي الطلب', 'red'], store_cancelled: ['أُلغي الطلب وأُعيدت المنتجات', 'red'], restored: ['عادت المنتجات إلى السلة', 'green'], needs_review: ['قيد المراجعة', 'orange'] };
const shippingA = { preparing: ['قيد التجهيز', 'gold'], handed_to_carrier: ['تم تسليمها لشركة الشحن', 'blue'], in_transit: ['في الطريق', 'blue'], out_for_delivery: ['خرجت للتسليم', 'blue'], delivered: ['تم التسليم', 'green'], delayed: ['متأخرة', 'orange'], returned: ['مرتجعة', 'red'], cancelled: ['ملغاة', 'red'] };
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
const moneyA = (amount, currency = 'EGP') => `${Number(amount || 0).toFixed(2)} ${escA(currency)}`;
const stateA = request => { const restoration = (request.store_order_cart_restorations || [])[0]; if (restoration && restoration.status === 'restored') return 'restored'; return request.status || 'awaiting_store_confirmation'; };
const shipmentA = request => (request.store_shipments || [])[0] || null;
// Cancellation is a REQUEST to the store. What the customer sees is derived from the order itself: the request is
// waiting while the store has not answered, accepted when the store rejected/cancelled the order, declined when it went on.
const cancelAskedA = request => ((request.store_order_cancellation_requests || [])[0]) || null;
const cancelEndedA = new Set(['store_rejected', 'cancelled', 'store_cancelled', 'restored']);
function cancelLine(request) {
  const state = stateA(request), asked = cancelAskedA(request);
  if (asked) {
    if (state === 'awaiting_store_confirmation') return `<div class="cancel-box cancel-pending" role="status"><b>طلب الإلغاء</b><span>تم إرسال طلب الإلغاء إلى المتجر وهو بانتظار رده. لن يُلغى الطلب إلا إذا وافق المتجر.</span></div>`;
    if (cancelEndedA.has(state)) return `<div class="cancel-box cancel-accepted" role="status"><b>طلب الإلغاء</b><span>وافق المتجر وأُلغي الطلب.</span></div>`;
    return `<div class="cancel-box cancel-declined" role="status"><b>طلب الإلغاء</b><span>أكمل المتجر تنفيذ الطلب قبل أن يصله طلب الإلغاء، فلم يُلغَ. للاستفسار تواصل مع المتجر.</span></div>`;
  }
  if (state === 'awaiting_store_confirmation') return `<div class="cancel-box"><span>تستطيع طلب الإلغاء ما دام المتجر لم يؤكد الطلب.</span><button class="ghost order-cancel" type="button" data-cancel="${escA(request.id)}">طلب إلغاء الطلب</button></div>`;
  return '';
}
const dateA = value => { try { return new Date(value).toLocaleDateString('ar-EG', { year: 'numeric', month: 'short', day: 'numeric' }); } catch (_) { return ''; } };
const dateTimeA = value => { try { return new Date(value).toLocaleString('ar-EG', { dateStyle: 'medium', timeStyle: 'short' }); } catch (_) { return ''; } };
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

function cartSnapshot() { try { return JSON.parse(localStorage.getItem('elan_cart') || '[]').reduce((total, item) => total + (Number(item.q) || 0), 0); } catch (_) { return 0; } }
function updateCartShortcut(restored = 0) { const element = document.querySelector('#cartShortcut'); if (!element) return; element.querySelector('b').textContent = cartSnapshot(); element.classList.toggle('has-restored', restored > 0); element.querySelector('span').textContent = restored ? `السلة · ${restored} مسترجع` : 'سلة Élan Scents'; }
function shipmentLine(request) {
  const shipment = shipmentA(request);
  if (!shipment) return '<div class="shipment-box shipment-empty"><b>الشحن</b><span>لم يسجل المتجر بيانات الشحن بعد.</span></div>';
  return `<div class="shipment-box"><div class="shipment-head"><div><small>شحن المتجر</small><strong>${escA(shipment.carrier_name || 'شركة الشحن غير محددة')}</strong></div>${shippingBadgeA(shipment.shipping_status)}</div><div class="shipment-meta"><span>رقم التتبع</span><b dir="ltr">${escA(shipment.tracking_code || 'لم يحدد بعد')}</b></div>${shipment.estimated_delivery_at ? `<div class="shipment-meta"><span>التسليم المتوقع</span><b>${dateA(shipment.estimated_delivery_at)}</b></div>` : ''}${shipment.status_note ? `<p class="shipment-note">${escA(shipment.status_note)}</p>` : ''}<small class="shipment-updated">آخر تحديث: ${dateTimeA(shipment.updated_at)}</small></div>`;
}
function itemLine(item) {
  const label = [item.brand_name, item.product_name, item.size_label].filter(Boolean).map(escA).join(' · ');
  const unit = item.unit_price != null && Number(item.quantity) > 1 ? ` <small class="muted">(${moneyA(item.unit_price, item.currency)} للواحدة)</small>` : '';
  return `<div><span>${label} × ${Number(item.quantity) || 0}${unit}</span><b>${moneyA(item.line_total, item.currency)}</b></div>`;
}
function requestLine(request) {
  const state = stateA(request), items = request.store_order_request_items || [];
  const names = items.slice(0, 2).map(item => `${escA(item.product_name)}${Number(item.quantity) > 1 ? ` × ${item.quantity}` : ''}`).join('، ');
  const shipping = request.shipping_amount == null ? '' : `<div><span>الشحن</span><b>${moneyA(request.shipping_amount, request.currency)}</b></div>`;
  const canReorder = items.some(item => /^[0-9a-f-]{36}$/i.test(String(item.product_size_id || '')));
  return `<article class="compact-order"><div class="compact-order-main"><div><span class="order-store">${escA(request.stores && request.stores.name || 'متجر')}</span><h3>${escA(request.tracking_number)}</h3><p>${names || 'تفاصيل المنتجات متاحة داخل الطلب'}${items.length > 2 ? ` <span class="muted">+${items.length - 2} أخرى</span>` : ''}</p></div><div class="compact-order-side">${badgeA(state)}<strong>${moneyA(request.total_amount ?? request.subtotal, request.currency)}</strong></div></div>${shipmentLine(request)}${cancelLine(request)}<div class="compact-order-foot"><span>${dateA(request.created_at)}</span><details><summary>التفاصيل</summary><div class="order-detail">${items.map(itemLine).join('')}<hr><div><span>المجموع الفرعي</span><b>${moneyA(request.subtotal, request.currency)}</b></div>${shipping}<div><span>الإجمالي</span><b>${moneyA(request.total_amount ?? request.subtotal, request.currency)}</b></div><hr><div><span>المتجر</span><b>${escA(request.stores && request.stores.name || '—')}</b></div><div><span>رقم التتبع الموحد</span><b dir="ltr">${escA(request.tracking_number)}</b></div><div><span>وقت الطلب</span><b>${dateTimeA(request.created_at)}</b></div>${canReorder ? `<button class="ghost order-reorder" type="button" data-reorder="${escA(request.id)}">اطلب مرة أخرى</button>` : ''}</div></details></div></article>`;
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
    more.hidden = !hasMore;
    document.querySelector('#login').hidden = true;
    document.querySelector('#app').hidden = false;
    document.querySelector('#logout').hidden = false;
    renderAccount(accountSessions);
    showMessage('');
    const stamp = document.querySelector('#lastUpdated');
    if (stamp) stamp.textContent = `آخر تحديث: ${new Date().toLocaleTimeString('ar-EG', { hour: '2-digit', minute: '2-digit' })}`;
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

let cancelling = false;
const cancelErrors = [
  ['no longer waiting', 'المتجر بدأ في معالجة الطلب، فلم يعد إلغاؤه ممكنًا من هنا. تواصل مع المتجر.'],
  ['Reason is too long', 'سبب الإلغاء طويل، اختصره وحاول مرة أخرى.'],
  ['Order not found', 'لم نجد هذا الطلب، حدّث الصفحة وحاول مرة أخرى.'],
  ['Authentication required', 'انتهت جلسة الدخول، سجّل الدخول من جديد.'],
  ['JWT', 'انتهت جلسة الدخول، سجّل الدخول من جديد.']
];
async function cancelOrder(requestId, button) {
  if (cancelling) return;
  const request = flatten([...accountSessions, ...archiveSessions]).find(item => String(item.id) === String(requestId));
  if (!request || stateA(request) !== 'awaiting_store_confirmation' || cancelAskedA(request)) return;
  const session = Portal.session();
  if (!session || !session.access_token) { showMessage('انتهت جلسة الدخول، سجّل الدخول من جديد.'); return; }
  const reason = window.prompt('سبب طلب الإلغاء (اختياري). سيصل الطلب إلى المتجر، ولا يُلغى الطلب إلا إذا وافق المتجر.', '');
  if (reason === null) return;
  cancelling = true; if (button) button.disabled = true;
  try {
    const config = await authConfig();
    const response = await fetch(`${config.url}/rest/v1/rpc/request_store_order_cancellation`, {
      method: 'POST',
      headers: { apikey: config.key, Authorization: `Bearer ${session.access_token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ p_request_id: request.id, p_reason: String(reason).trim().slice(0, 500) || null })
    });
    const data = await response.json().catch(() => ({}));
    if (!response.ok) {
      const text = String(data.message || data.error || '');
      const hit = cancelErrors.find(row => text.includes(row[0]));
      throw new Error(hit ? hit[1] : 'تعذر إرسال طلب الإلغاء، حاول مرة أخرى.');
    }
    await loadAccount();
  } catch (error) {
    // Refresh first (the order may have moved on), then show why the request failed: a successful refresh clears the message box.
    await loadAccount().catch(() => {});
    showMessage(error);
  } finally { cancelling = false; if (button) button.disabled = false; }
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

document.querySelector('#loginForm').addEventListener('submit', async event => { event.preventDefault(); try { await Portal.login(event.target); await loadAccount(); } catch (error) { showMessage(error); } });
document.querySelector('#archiveForm').addEventListener('submit', event => loadArchive(event).catch(showMessage));
document.querySelector('#loadMoreOrders').addEventListener('click', () => loadAccount(true).catch(showMessage));
document.querySelector('#loadMoreArchive').addEventListener('click', () => loadArchive(null, true).catch(showMessage));
document.querySelector('#refreshOrders').addEventListener('click', async event => {
  const button = event.currentTarget; button.disabled = true;
  try { await loadAccount(); } catch (error) { showMessage(error); } finally { button.disabled = false; }
});
document.addEventListener('click', event => { const button = event.target.closest('[data-reorder]'); if (button) reorder(button.dataset.reorder); });
document.addEventListener('click', event => { const button = event.target.closest('[data-cancel]'); if (button) cancelOrder(button.dataset.cancel, button); });

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
    const redirect = encodeURIComponent(`${location.origin}/account.html`);
    const response = await fetch(`${config.url}/auth/v1/recover?redirect_to=${redirect}`, {
      method: 'POST', headers: { apikey: config.key, 'Content-Type': 'application/json' }, body: JSON.stringify({ email: form.elements.email.value.trim() })
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
