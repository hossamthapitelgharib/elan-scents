let orders = [];
let storeSettings = [];
let orderOffset = 0;
let orderHasMore = false;
let orderLoading = false;
let orderTotal = null;
let orderSeq = 0;
let searchTimer = null;
const $ = id => document.getElementById(id);
const escapeHtml = value => String(value == null ? '' : value).replace(/[&<>"']/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#039;' }[char]));
const money = (value, currency = 'EGP') => `${Number(value || 0).toFixed(2)} ${escapeHtml(currency)}`;
const statusLabel = { awaiting_store_confirmation: 'بانتظار المتجر', completed: 'مكتمل', store_rejected: 'مرفوض من المتجر', needs_review: 'يحتاج مراجعة', store_confirmed: 'تم التأكيد', processing: 'قيد التجهيز', shipped: 'تم الشحن', delivered: 'تم التسليم', store_cancelled: 'ملغى من المتجر', cancelled: 'ملغى' };
function badge(text, tone = '') { return `<span class="badge ${tone}">${escapeHtml(text)}</span>`; }
function orderStatusBadge(status) { const tone = status === 'completed' || status === 'delivered' ? 'green' : status === 'store_rejected' || status === 'cancelled' ? 'red' : status === 'needs_review' ? 'blue' : ''; return badge(statusLabel[status] || status || 'غير محدد', tone); }
const matchLabel = { matched: 'مطابق', mismatched: 'غير مطابق', pending: 'قيد المطابقة' };
function matchBadge(status) { const tone = status === 'matched' ? 'green' : status === 'mismatched' ? 'red' : 'blue'; return badge(matchLabel[status] || matchLabel.pending, tone); }
/* The filters are sent to the server, so the numbers are the server's: every order that matches, and how many of them are on screen. */
function renderStats() {
  const shown = orders.length;
  const total = orderTotal === null ? shown : orderTotal;
  $('stats').innerHTML = [['الطلبات المطابقة للفلاتر', total.toLocaleString('ar-EG'), ''], ['المعروضة الآن', shown.toLocaleString('ar-EG'), '']].map(item => `<div class="stat"><small>${item[0]}</small><strong class="${item[2]}">${item[1]}</strong></div>`).join('');
}
function renderOrders() {
  renderStats();
  $('orders').innerHTML = orders.length ? orders.map(renderOrder).join('') : '<div class="empty">لا توجد طلبات مطابقة للفلاتر الحالية</div>';
  $('loadMoreOrders').hidden = !orderHasMore;
}
/* What the filter boxes ask the server for. */
function orderFilterParams() {
  const params = new URLSearchParams();
  const status = $('statusFilter').value;
  const match = $('matchFilter').value;
  const query = ($('searchFilter').value || '').trim();
  if (status) params.set('status', status);
  if (match) params.set('matchStatus', match);
  if (query) params.set('q', query);
  if ($('attentionFilter').checked) params.set('attention', '1');
  return params;
}
function renderOrder(order) {
  const items = order.store_order_request_items || [];
  const notices = order.store_order_notifications || [];
  const store = order.stores && order.stores.name || '—';
  return `<article class="order-card"><div class="order-head"><div class="order-title"><b>${escapeHtml(store)}</b><span class="tracking">${escapeHtml(order.checkout_tracking_number || order.tracking_number)}</span><small>${escapeHtml(order.tracking_number)} · ${new Date(order.created_at).toLocaleString('ar-EG')}</small></div><div class="badges">${orderStatusBadge(order.status)}${matchBadge(order.reconciliation_status)}</div></div><div class="order-body"><div class="customer"><b>بيانات العميل</b><p>الاسم: <b>${escapeHtml(order.customer_name)}</b></p><p>الهاتف: <b>${escapeHtml(order.customer_phone)}</b></p><p>البريد: ${escapeHtml(order.customer_email || '—')}</p><p>العنوان: ${escapeHtml(order.customer_address)}</p><p>ملاحظات: ${escapeHtml(order.customer_notes || '—')}</p></div><div><b>المنتجات والتكلفة</b><div class="items">${items.map(item => `<div class="item"><span>${escapeHtml(item.product_name)} × ${item.quantity}<small>${escapeHtml(item.brand_name || '')}</small></span><span>${money(item.line_total, item.currency)}</span></div>`).join('')}</div><div class="money"><span>الإجمالي الفرعي</span><b>${money(order.subtotal, order.currency)}</b></div><div class="money"><span>الشحن</span><b>${order.shipping_amount == null ? 'يحدده المتجر' : money(order.shipping_amount, order.currency)}</b></div><div class="money"><span>الإجمالي النهائي</span><b>${order.total_amount == null ? 'بانتظار المتجر' : money(order.total_amount, order.currency)}</b></div></div><div class="notifications"><b>سجل الإشعارات والمطابقة</b>${notices.length ? notices.map(notice => `<div class="notice"><span>${notice.event_type === 'initial_submitted' ? 'الإشعار المبدئي' : notice.event_type === 'store_completed' ? 'إشعار الإتمام' : notice.event_type === 'store_rejected' ? 'إشعار عدم التنفيذ' : 'تحديث متجر'} · ${escapeHtml(matchLabel[notice.match_status] || notice.match_status)}</span><time>${new Date(notice.received_at).toLocaleString('ar-EG')}</time></div>`).join('') : '<div class="notice">لم يصل إشعار من المتجر بعد</div>'}</div></div></article>`;
}
function errorMessage(error, fallback = 'تعذر تحميل البيانات، حاول مرة أخرى.') {
  return typeof Portal.errorText === 'function' ? Portal.errorText(error, fallback) : (error && error.message) || fallback;
}
function setAuthError(error) {
  const box = $('authError');
  box.textContent = errorMessage(error);
  box.hidden = false;
}
// Once the orders are on screen a failed refresh or "load more" is shown above them: it must not throw the admin back to the sign-in card.
function setOrdersError(error) {
  const box = $('ordersError');
  box.textContent = errorMessage(error);
  box.hidden = false;
}
async function loadOrders(append = false) {
  if (append && orderLoading) return;
  if (!Portal.session()) {
    $('authCard').hidden = false;
    $('dashboard').hidden = true;
    return;
  }
  /* A newer load (the filters changed) makes an older answer stale: only the latest one is shown. */
  const seq = ++orderSeq;
  orderLoading = true;
  const button = $('loadMoreOrders');
  if (button) button.disabled = true;
  try {
    const offset = append ? orderOffset : 0;
    const params = orderFilterParams();
    params.set('limit', '100');
    params.set('offset', String(offset));
    const response = await fetch(`/api/dashboard-orders?${params}`, { headers: Portal.auth() });
    const data = await response.json();
    if (seq !== orderSeq) return;
    if (!response.ok) throw new Error(data.error || 'تعذر تحميل الطلبات');
    const rows = Array.isArray(data.orders) ? data.orders : [];
    orders = append ? orders.concat(rows) : rows;
    const page = data.pagination || {};
    orderOffset = offset + rows.length;
    orderHasMore = Boolean(page.hasMore);
    orderTotal = Number.isFinite(page.total) ? page.total : null;
    $('authCard').hidden = true;
    $('dashboard').hidden = false;
    $('logout').hidden = false;
    $('authError').hidden = true;
    $('ordersError').hidden = true;
    $('lastUpdated').textContent = `آخر تحديث: ${new Date().toLocaleTimeString('ar-EG')}`;
    renderOrders();
    // The store settings are a separate tab: if they fail to load the orders stay usable.
    if (!append) await loadStoreSettings().catch(error => showSettingsError(error));
  } catch (error) {
    if (seq !== orderSeq) return;
    if ($('dashboard').hidden) {
      $('authCard').hidden = false;
      setAuthError(error);
    } else setOrdersError(error);
  } finally {
    if (seq === orderSeq) {
      if (button) button.disabled = false;
      orderLoading = false;
    }
  }
}
function inputField(label, key, value, placeholder = '', type = 'text') {
  return `<label class="field"><span>${label}</span><input data-setting="${key}" type="${type}" value="${escapeHtml(value || '')}" placeholder="${escapeHtml(placeholder)}"></label>`;
}
function renderStoreSettings() {
  $('storeSettings').innerHTML = storeSettings.length ? storeSettings.map((store, index) => `<article class="store-setting" data-index="${index}"><div class="store-setting-head"><div><h3>${escapeHtml(store.name)}</h3><p>${escapeHtml(store.shortDescription || 'بيانات تكامل المتجر')}</p></div><label class="switch"><input data-setting="enabled" type="checkbox" ${store.enabled ? 'checked' : ''}><span></span><em>التكامل مفعّل</em></label></div><div class="fields-grid">${inputField('رابط المتجر الأساسي', 'baseUrl', store.baseUrl, 'https://store.example')}${inputField('رابط سلة/Checkout بعد الربط', 'cartUrl', store.cartUrl, 'يُحدد مع التاجر')}${inputField('رابط API الأساسي', 'apiBaseUrl', store.apiBaseUrl, 'https://api.store.example')}${inputField('Endpoint الكتالوج والأسعار', 'catalogEndpoint', store.catalogEndpoint, '/products أو رابط كامل')}${inputField('API Key', 'apiKey', '', store.hasApiKey ? `محفوظ: ${store.apiKeyMasked}` : 'أدخل المفتاح عند توفره', 'password')}${inputField('Webhook Secret', 'webhookSecret', '', store.hasWebhookSecret ? `محفوظ: ${store.webhookSecretMasked}` : 'أدخل السر عند توفره', 'password')}</div><label class="field full"><span>Webhook URL الذي سيستقبله التاجر</span><div class="copy-row"><input data-webhook-url readonly value="${escapeHtml(store.webhookUrl)}"><button type="button" class="secondary" data-copy>نسخ</button></div></label>${inputField('ملاحظات الربط', 'notes', store.notes, 'مثال: Shopify / WooCommerce / طريقة تمرير السلة')}</article>`).join('') : '<div class="empty">لا توجد متاجر في الكتالوج.</div>';
}
function showSettingsError(error, fallback = 'تعذر تحميل إعدادات المتاجر، حاول مرة أخرى.') {
  const notice = $('settingsNotice');
  notice.textContent = errorMessage(error, fallback);
  notice.className = 'notice-banner error';
  notice.hidden = false;
}
async function loadStoreSettings() {
  const response = await fetch('/api/store-integrations', { headers: Portal.auth() });
  const data = await response.json();
  if (!response.ok) throw new Error(data.error || 'تعذر تحميل إعدادات المتاجر');
  storeSettings = data.stores || [];
  renderStoreSettings();
}
function collectStoreSettings() {
  return storeSettings.map((store, index) => {
    const card = document.querySelector(`.store-setting[data-index="${index}"]`);
    const get = key => card.querySelector(`[data-setting="${key}"]`);
    return { name: store.name, enabled: get('enabled').checked, baseUrl: get('baseUrl').value, cartUrl: get('cartUrl').value, apiBaseUrl: get('apiBaseUrl').value, catalogEndpoint: get('catalogEndpoint').value, apiKey: get('apiKey').value, webhookSecret: get('webhookSecret').value, notes: get('notes').value };
  });
}
async function saveStoreSettings() {
  const button = $('saveSettingsBtn'), notice = $('settingsNotice');
  button.disabled = true;
  notice.hidden = true;
  try {
    const response = await fetch('/api/store-integrations', { method: 'PUT', headers: { ...Portal.auth(), 'Content-Type': 'application/json' }, body: JSON.stringify({ stores: collectStoreSettings() }) });
    const data = await response.json();
    if (!response.ok) throw new Error(data.error || 'تعذر حفظ الإعدادات');
    notice.textContent = 'تم حفظ إعدادات المتاجر بنجاح. المفاتيح السرية محفوظة ولا تظهر كاملة.';
    notice.className = 'notice-banner success';
    notice.hidden = false;
    await loadStoreSettings();
  } catch (error) {
    showSettingsError(error, 'تعذر حفظ الإعدادات، حاول مرة أخرى.');
  } finally { button.disabled = false; }
}

$('authForm').addEventListener('submit', async event => {
  event.preventDefault();
  $('authError').hidden = true;
  try { await Portal.login(event.target); await loadOrders(); } catch (error) { setAuthError(error); }
});
$('refreshBtn').addEventListener('click', () => loadOrders().catch(setAuthError));
$('loadMoreOrders').addEventListener('click', () => loadOrders(true));
$('saveSettingsBtn').addEventListener('click', saveStoreSettings);
// The selects and the checkbox search at once; the text box waits for a pause in typing.
['statusFilter', 'matchFilter', 'attentionFilter'].forEach(id => $(id).addEventListener('change', () => loadOrders().catch(setAuthError)));
$('searchFilter').addEventListener('input', () => {
  clearTimeout(searchTimer);
  searchTimer = setTimeout(() => loadOrders().catch(setAuthError), 350);
});
document.querySelectorAll('.tab').forEach(tab => tab.addEventListener('click', () => {
  document.querySelectorAll('.tab').forEach(item => item.classList.remove('active'));
  tab.classList.add('active');
  document.querySelectorAll('#ordersPanel,#settingsPanel').forEach(panel => { panel.hidden = panel.id !== tab.dataset.panel; });
}));
document.addEventListener('click', event => {
  const button = event.target.closest('[data-copy]');
  if (!button) return;
  const input = button.parentElement.querySelector('input');
  navigator.clipboard?.writeText(input.value);
  button.textContent = 'تم النسخ';
  setTimeout(() => { button.textContent = 'نسخ'; }, 1500);
});
if (Portal.session()) loadOrders().catch(setAuthError);
