const escStore = value => String(value ?? '').replace(/[&<>"']/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#039;' }[char]));
const nStore = value => Math.max(0, Number(value) || 0).toLocaleString('ar-EG');
function renderStoreStats(stores) {
  const sum = key => stores.reduce((total, store) => total + Number(store.summary && store.summary[key] || 0), 0);
  const cards = [
    ['إجمالي المتاجر', stores.length],
    ['متاجر نشطة', stores.filter(store => store.status === 'active').length],
    ['منتجات متاحة', sum('available_product_count')],
    ['عروض نشطة', sum('active_offer_count')],
    ['طلبات مفتوحة', sum('open_order_count')],
    ['طلبات تحتاج مراجعة', sum('review_order_count')],
  ];
  document.querySelector('#storeStats').innerHTML = cards.map((item, i) => `<div class="stat ${i === 0 ? 'gold' : ''}"><small>${item[0]}</small><b>${nStore(item[1])}</b></div>`).join('');
}
function storeRow(store) {
  const s = store.summary || {};
  const status = store.status === 'active' ? 'نشط' : store.status === 'inactive' ? 'غير نشط' : store.status || '—';
  const website = store.website_url ? `<small>الموقع: ${escStore(store.website_url)}</small>` : '';
  const commission = store.commission_rate == null ? '—' : `${nStore(store.commission_rate)}%`;
  return `<tr><td><strong>${escStore(store.name || 'متجر')}</strong><small>${escStore(store.slug || '')}</small>${website}<small>${escStore(store.short_description || '')}</small></td><td>${escStore(status)}</td><td>${nStore(s.linked_accounts)}</td><td>${nStore(s.available_product_count)} / ${nStore(s.product_count)}</td><td>${nStore(s.active_offer_count)}</td><td>${nStore(s.open_order_count)} / ${nStore(s.order_request_count)}</td><td>${nStore(s.review_order_count)}</td><td>${nStore(s.shipment_count)}</td><td>${escStore(commission)}</td></tr>`;
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
async function loadStores() {
  if (!Portal.session()) return;
  document.querySelector('#login').hidden = true;
  document.querySelector('#app').hidden = false;
  document.querySelector('#logout').hidden = false;
  const response = await fetch('/api/platform-stores', { headers: Portal.auth() });
  const data = await response.json();
  if (!response.ok) throw new Error(data.error || 'تعذر تحميل بيانات المتاجر');
  const stores = Array.isArray(data.stores) ? data.stores : [];
  document.querySelector('#storeError').hidden = true;
  document.querySelector('#storesBody').innerHTML = stores.length ? stores.map(storeRow).join('') : '<tr><td colspan="9" class="empty">لا توجد متاجر</td></tr>';
  renderStoreStats(stores);
}
document.querySelector('#refreshStores').addEventListener('click', () => loadStores().catch(showStoreError));
document.querySelector('#loginForm').addEventListener('submit', async event => {
  event.preventDefault();
  try { await Portal.login(event.target); await loadStores(); } catch (error) { showStoreError(error); }
});
if (Portal.session()) loadStores().catch(showStoreError);
