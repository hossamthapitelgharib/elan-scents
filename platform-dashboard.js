const escP = value => String(value ?? '').replace(/[&<>"']/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#039;' }[char]));
const labelP = { awaiting_store_confirmation: 'بانتظار المتجر', store_confirmed: 'تم التأكيد', processing: 'قيد التجهيز', shipped: 'تم الشحن', delivered: 'تم التسليم', completed: 'مكتمل', store_rejected: 'مرفوض', store_cancelled: 'ملغى', restored: 'مسترجع', needs_review: 'يحتاج مراجعة', matched: 'مطابقة', mismatched: 'غير مطابقة', pending: 'قيد الفحص' };
const badgeP = status => `<span class="badge ${status === 'completed' || status === 'matched' || status === 'delivered' ? 'green' : status === 'mismatched' || status === 'store_cancelled' || status === 'store_rejected' ? 'red' : 'blue'}">${escP(labelP[status] || status || '—')}</span>`;
const dateP = value => { try { return value ? new Date(value).toLocaleString('ar-EG') : '—'; } catch (_) { return '—'; } };

function reportError(error) {
  const message = error && error.message ? error.message : 'تعذر تحميل البيانات';
  const box = document.querySelector('#platformError');
  if (box) { box.textContent = message; box.hidden = false; }
  else document.querySelector('#message').textContent = message;
}

function renderCustomers(data) {
  const customers = data.registeredCustomers || [];
  const visitors = data.guestVisitors || [];
  document.querySelector('#registeredCount').textContent = customers.length;
  document.querySelector('#visitorCount').textContent = visitors.length;
  document.querySelector('#registeredCustomers').innerHTML = customers.length ? customers.map(customer => `<article class="customer-row"><div class="customer-row-main"><strong>${escP(customer.full_name || 'عميل مسجل')}</strong><small>الهاتف: ${escP(customer.phone || 'غير مسجل')} · تاريخ التسجيل: ${escP(dateP(customer.created_at))}</small></div><div class="customer-cart"><b>${Number(customer.cartItems || 0)} صنف</b><small>${Number(customer.cartUnits || 0)} قطعة في السلة</small></div></article>`).join('') : '<div class="empty">لا يوجد عملاء مسجلون</div>';
  document.querySelector('#guestCustomers').innerHTML = visitors.length ? visitors.map(visitor => {
    const hash = String(visitor.fingerprint_hash || '');
    return `<article class="customer-row"><div class="customer-row-main"><strong>زائر · <code title="${escP(hash)}">${escP(hash.slice(0, 16))}${hash.length > 16 ? '…' : ''}</code></strong><small>أول زيارة: ${escP(dateP(visitor.first_seen_at))} · آخر نشاط: ${escP(dateP(visitor.last_seen_at))}</small></div><div class="customer-cart"><b>${Number(visitor.cart_items_count || 0)} صنف</b><small>${Number(visitor.cart_units || 0)} قطعة في السلة</small></div></article>`;
  }).join('') : '<div class="empty">لا يوجد زوار نشطون</div>';
}

function renderOrders(orders) {
  document.querySelector('#orders').innerHTML = orders.length ? orders.map(order => {
    const events = order.order_operation_events || [];
    const checks = order.order_reconciliation_checks || [];
    return `<article class="order"><h3>${escP(order.tracking_number)} · ${escP(order.stores && order.stores.name || '')}</h3><div class="meta">${badgeP(order.status)} ${badgeP(order.reconciliation_status)} <span>العملية الموحدة: ${escP(order.checkout_tracking_number || '—')}</span></div><div class="grid"><div><b>بيانات العميل</b><p>${escP(order.customer_name)} · ${escP(order.customer_phone)}<br>${escP(order.customer_address)}</p><p>الإجمالي: ${Number((order.total_amount ?? order.subtotal) || 0).toFixed(2)} ${escP(order.currency)}</p></div><div><b>المنتجات</b>${(order.store_order_request_items || []).map(item => `<div class="item"><span>${escP(item.product_name)} × ${item.quantity}</span><span>${Number(item.line_total || 0).toFixed(2)} ${escP(item.currency)}</span></div>`).join('')}</div></div><p class="meta">الإشعارات: ${(order.store_order_notifications || []).map(item => `${escP(labelP[item.event_type] || item.event_type)} · ${escP(labelP[item.match_status] || item.match_status)}`).join(' · ') || 'لا يوجد'} · أحداث التدقيق: ${events.length} · فحوص المطابقة: ${checks.length}</p></article>`;
  }).join('') : '<div class="empty">لا توجد طلبات</div>';
}

function activateCustomerTabs() {
  const tabs = document.querySelector('#customerTabs');
  if (!tabs) return;
  tabs.addEventListener('click', event => {
    const button = event.target.closest('[data-customer-tab]');
    if (!button) return;
    const guests = button.dataset.customerTab === 'visitors';
    document.querySelector('#registeredTab').setAttribute('aria-selected', String(!guests));
    document.querySelector('#visitorsTab').setAttribute('aria-selected', String(guests));
    document.querySelector('#registeredCustomers').hidden = guests;
    document.querySelector('#guestCustomers').hidden = !guests;
  });
}

async function loadPlatform() {
  if (!Portal.session()) return;
  document.querySelector('#login').hidden = true;
  document.querySelector('#app').hidden = false;
  document.querySelector('#logout').hidden = false;
  const headers = Portal.auth();
  const responses = await Promise.all([
    fetch('/api/dashboard-orders', { headers }),
    fetch('/api/platform-customers', { headers })
  ]);
  const ordersData = await responses[0].json();
  const customersData = await responses[1].json();
  if (!responses[0].ok) throw Error(ordersData.error || 'تعذر تحميل بيانات الطلبات');
  if (!responses[1].ok) throw Error(customersData.error || 'تعذر تحميل بيانات العملاء');
  const orders = ordersData.orders || [];
  document.querySelector('#stats').innerHTML = [
    ['طلبات المتاجر', orders.length],
    ['عملاء مسجلون', customersData.counts.registered],
    ['زوار نشطون', customersData.counts.visitors],
    ['مكتملة', orders.filter(order => ['completed', 'delivered'].includes(order.status)).length]
  ].map(item => `<div class="stat"><small>${item[0]}</small><b>${item[1]}</b></div>`).join('');
  document.querySelector('#platformError').hidden = true;
  renderCustomers(customersData);
  renderOrders(orders);
}

activateCustomerTabs();
document.querySelector('#refreshCustomers').addEventListener('click', () => loadPlatform().catch(reportError));
document.querySelector('#loginForm').addEventListener('submit', async event => {
  event.preventDefault();
  try { await Portal.login(event.target); await loadPlatform(); }
  catch (error) { reportError(error); }
});
if (Portal.session()) loadPlatform().catch(reportError);
