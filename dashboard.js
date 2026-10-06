let token = localStorage.getItem('elan_dashboard_token') || '';
let orders = [];

const $ = (id) => document.getElementById(id);
const escapeHtml = (value) => String(value == null ? '' : value).replace(/[&<>"']/g, (char) => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#039;'}[char]));
const money = (value, currency = 'EGP') => `${Number(value || 0).toFixed(2)} ${escapeHtml(currency)}`;
const statusLabel = { awaiting_store_confirmation:'بانتظار المتجر', completed:'مكتمل', store_rejected:'مرفوض من المتجر', needs_review:'يحتاج مراجعة', cancelled:'ملغى' };

function badge(text, tone = '') { return `<span class="badge ${tone}">${escapeHtml(text)}</span>`; }
function orderStatusBadge(status) {
  const tone = status === 'completed' ? 'green' : status === 'store_rejected' ? 'red' : status === 'needs_review' ? 'blue' : '';
  return badge(statusLabel[status] || status || 'غير محدد', tone);
}
function matchBadge(status) {
  const tone = status === 'matched' ? 'green' : status === 'mismatched' ? 'red' : 'blue';
  return badge(status === 'matched' ? 'مطابق' : status === 'mismatched' ? 'غير مطابق' : 'قيد المطابقة', tone);
}
function renderStats(filtered) {
  const count = (predicate) => filtered.filter(predicate).length;
  $('stats').innerHTML = [
    ['إجمالي الطلبات', filtered.length, ''],
    ['بانتظار المتجر', count((o) => o.status === 'awaiting_store_confirmation'), ''],
    ['مكتملة ومطابقة', count((o) => o.status === 'completed' && o.reconciliation_status === 'matched'), 'green'],
    ['تحتاج مراجعة', count((o) => o.reconciliation_status === 'mismatched' || o.status === 'needs_review'), 'red'],
  ].map((item) => `<div class="stat"><small>${item[0]}</small><strong class="${item[2]}">${item[1]}</strong></div>`).join('');
}
function renderOrders() {
  const query = ($('searchFilter').value || '').trim().toLowerCase();
  const status = $('statusFilter').value;
  const match = $('matchFilter').value;
  const filtered = orders.filter((order) => {
    const searchable = [order.tracking_number, order.checkout_tracking_number, order.customer_name, order.customer_phone, order.stores && order.stores.name].join(' ').toLowerCase();
    return (!status || order.status === status) && (!match || order.reconciliation_status === match) && (!query || searchable.includes(query));
  });
  renderStats(filtered);
  $('orders').innerHTML = filtered.length ? filtered.map(renderOrder).join('') : '<div class="empty">لا توجد طلبات مطابقة للفلاتر الحالية</div>';
}
function renderOrder(order) {
  const items = order.store_order_request_items || [];
  const notices = order.store_order_notifications || [];
  const store = order.stores && order.stores.name || '—';
  return `<article class="order-card"><div class="order-head"><div class="order-title"><b>${escapeHtml(store)}</b><span class="tracking">${escapeHtml(order.checkout_tracking_number || order.tracking_number)}</span><small>${escapeHtml(order.tracking_number)} · ${new Date(order.created_at).toLocaleString('ar-EG')}</small></div><div class="badges">${orderStatusBadge(order.status)}${matchBadge(order.reconciliation_status)}</div></div><div class="order-body"><div class="customer"><b>بيانات العميل</b><p>الاسم: <b>${escapeHtml(order.customer_name)}</b></p><p>الهاتف: <b>${escapeHtml(order.customer_phone)}</b></p><p>البريد: ${escapeHtml(order.customer_email || '—')}</p><p>العنوان: ${escapeHtml(order.customer_address)}</p><p>ملاحظات: ${escapeHtml(order.customer_notes || '—')}</p></div><div><b>المنتجات والتكلفة</b><div class="items">${items.map((item) => `<div class="item"><span>${escapeHtml(item.product_name)} × ${item.quantity}<small>${escapeHtml(item.brand_name || '')}</small></span><span>${money(item.line_total, item.currency)}</span></div>`).join('')}</div><div class="money"><span>الإجمالي الفرعي</span><b>${money(order.subtotal, order.currency)}</b></div><div class="money"><span>الشحن</span><b>${order.shipping_amount == null ? 'يحدده المتجر' : money(order.shipping_amount, order.currency)}</b></div><div class="money"><span>الإجمالي النهائي</span><b>${order.total_amount == null ? 'بانتظار المتجر' : money(order.total_amount, order.currency)}</b></div></div><div class="notifications"><b>سجل الإشعارات والمطابقة</b>${notices.length ? notices.map((notice) => `<div class="notice"><span>${notice.event_type === 'initial_submitted' ? 'الإشعار المبدئي' : notice.event_type === 'store_completed' ? 'إشعار الإتمام' : notice.event_type === 'store_rejected' ? 'إشعار عدم التنفيذ' : 'تحديث متجر'} · ${escapeHtml(notice.match_status)}</span><time>${new Date(notice.received_at).toLocaleString('ar-EG')}</time></div>`).join('') : '<div class="notice">لم يصل إشعار من المتجر بعد</div>'}</div></div></article>`;
}
async function loadOrders() {
  if (!token) return;
  $('refreshBtn').disabled = true;
  try {
    const response = await fetch('/api/dashboard-orders', { headers: { 'x-dashboard-token': token } });
    const data = await response.json();
    if (!response.ok) throw new Error(data.error || 'تعذر تحميل البيانات');
    orders = data.orders || [];
    $('authCard').hidden = true;
    $('dashboard').hidden = false;
    $('lastUpdated').textContent = `آخر تحديث: ${new Date().toLocaleTimeString('ar-EG')}`;
    renderOrders();
  } catch (error) {
    $('authCard').hidden = false;
    $('dashboard').hidden = true;
    $('authError').hidden = false;
    $('authError').textContent = error.message;
    localStorage.removeItem('elan_dashboard_token');
  } finally { $('refreshBtn').disabled = false; }
}
$('authForm').addEventListener('submit', (event) => { event.preventDefault(); token = $('dashboardToken').value.trim(); localStorage.setItem('elan_dashboard_token', token); loadOrders(); });
$('refreshBtn').addEventListener('click', loadOrders);
['statusFilter','matchFilter','searchFilter'].forEach((id) => $(id).addEventListener('input', renderOrders));
if (token) { $('dashboardToken').value = token; loadOrders(); }
