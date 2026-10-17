function numberP(value) { return Math.max(0, Number(value) || 0).toLocaleString('ar-EG'); }

function reportError(error) {
  const message = error && error.message ? error.message : 'تعذر تحميل البيانات';
  const box = document.querySelector('#platformError');
  if (box) { box.textContent = message; box.hidden = false; }
  else document.querySelector('#message').textContent = message;
}

async function loadPlatform() {
  if (!Portal.session()) return;
  document.querySelector('#login').hidden = true;
  document.querySelector('#app').hidden = false;
  document.querySelector('#logout').hidden = false;

  const headers = Portal.auth();
  const responses = await Promise.all([
    fetch('/api/platform-order-summary', { headers }),
    fetch('/api/platform-customer-summary', { headers }),
    fetch('/api/platform-stores', { headers }).catch(() => null),
  ]);
  const ordersData = await responses[0].json();
  const customersData = await responses[1].json();
  if (!responses[0].ok) throw Error(ordersData.error || 'تعذر تحميل ملخص الطلبات');
  if (!responses[1].ok) throw Error(customersData.error || 'تعذر تحميل ملخص العملاء');

  const orders = ordersData.counts || {};
  document.querySelector('#stats').innerHTML = [
    ['طلبات المتاجر', orders.orders], ['مكتملة', orders.completed],
    ['مفتوحة', orders.open], ['تحتاج مراجعة', orders.needsReview],
    ['عملاء مسجلون', customersData.counts.registered], ['الزوار', customersData.counts.visitors],
  ].map(item => `<div class="stat"><small>${item[0]}</small><b>${numberP(item[1])}</b></div>`).join('');

  const storeError = document.querySelector('#platformStoreError');
  const storeStats = document.querySelector('#platformStoreStats');
  try {
    if (!responses[2]) throw Error('تعذر الاتصال ببيانات المتاجر');
    const storesData = await responses[2].json();
    if (!responses[2].ok) throw Error(storesData.error || 'تعذر تحميل ملخص المتاجر');
    const stores = Array.isArray(storesData.stores) ? storesData.stores : [];
    const sum = key => stores.reduce((total, store) => total + Math.max(0, Number(store.summary && store.summary[key]) || 0), 0);
    const storeCards = [
      ['المتاجر النشطة', stores.filter(store => store.status === 'active').length],
      ['المنتجات المتاحة', sum('available_product_count')],
      ['العروض النشطة', sum('active_offer_count')],
      ['الطلبات المفتوحة', sum('open_order_count')],
      ['تحتاج مراجعة', sum('review_order_count')],
    ];
    storeStats.innerHTML = storeCards.map((item, index) => `<div class="stat ${index === 0 ? 'gold' : ''}"><small>${item[0]}</small><b>${numberP(item[1])}</b></div>`).join('');
    storeError.hidden = true;
  } catch (error) {
    storeStats.innerHTML = '';
    storeError.textContent = error && error.message ? error.message : 'تعذر تحميل ملخص المتاجر';
    storeError.hidden = false;
  }
  document.querySelector('#platformError').hidden = true;
}

document.querySelector('#loginForm').addEventListener('submit', async event => {
  event.preventDefault();
  try { await Portal.login(event.target); await loadPlatform(); }
  catch (error) { reportError(error); }
});
if (Portal.session()) loadPlatform().catch(reportError);
