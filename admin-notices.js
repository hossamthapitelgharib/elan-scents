/* «الإشعار الأول»: the page that reads the platform's first notice of every order (the immutable record in platform_order_notices, written after the
   trusted payment result or the choice of cash on delivery). A list on one side, the chosen notice in full on the other (on a phone, one replaces the other).
   Read only: nothing here writes. Every text that came from the database goes through escP. The page script keeps its names inside this function
   so it can share the admin panel's global scope without colliding with the other page scripts. */
const AdminNotices = (() => {
  const PAGE = 20;
  const PAYMENT_METHODS = { card: 'بطاقة', cod: 'الدفع عند الاستلام', other: 'وسيلة أخرى' };
  const PAYMENT_STATUS = { paid: 'مدفوع', cod_selected: 'دفع عند الاستلام', awaiting_payment: 'بانتظار الدفع', failed: 'فشل الدفع', not_started: 'لم يبدأ' };
  const ORDER_STATUS = {
    awaiting_store_confirmation: 'بانتظار المتجر', store_confirmed: 'أكّد المتجر', processing: 'قيد التجهيز', shipped: 'تم الشحن', delivered: 'تم التسليم',
    store_rejected: 'رفضه المتجر', store_cancelled: 'ألغاه المتجر', needs_review: 'يحتاج مراجعة', completed: 'مكتمل', cancelled: 'ملغى', pending: 'قيد الانتظار'
  };
  const SECOND = {
    waiting: { label: 'بانتظار إشعار التاجر', tone: 'wait' },
    matched: { label: 'مطابق لإشعار التاجر', tone: 'ok' },
    mismatch: { label: 'اختلاف مفتوح', tone: 'bad' }
  };
  const state = { rows: [], total: 0, hasMore: false, busy: false, selected: null, query: { q: '', store: '' }, details: new Map(), storesLoaded: false };

  const label = (map, key) => (key ? map[key] || String(key) : '—');
  function money(value, currency) {
    if (value === null || value === undefined) return '—';
    const unit = !currency || currency === 'EGP' ? 'ج.م' : String(currency);
    return `${Number(value).toLocaleString('ar-EG', { minimumFractionDigits: Number.isInteger(Number(value)) ? 0 : 2, maximumFractionDigits: 2 })} ${unit}`;
  }
  const ltr = value => (value ? `<span dir="ltr">${escP(value)}</span>` : '—');
  const chip = (text, tone) => `<span class="chip chip-${escP(tone)}">${escP(text)}</span>`;
  const secondChip = key => { const second = SECOND[key] || SECOND.waiting; return chip(second.label, second.tone); };

  function rowMarkup(notice, selected) {
    const payment = notice.paymentStatus === 'paid' || notice.paymentStatus === 'cod_selected'
      ? chip(label(PAYMENT_METHODS, notice.paymentMethod), 'pay') : chip(label(PAYMENT_STATUS, notice.paymentStatus), 'wait');
    return `<button type="button" class="notice-row${selected ? ' is-selected' : ''}" data-notice-id="${escP(notice.id)}" aria-pressed="${selected ? 'true' : 'false'}">`
      + `<span class="notice-row-main"><b dir="ltr">${escP(notice.trackingNumber || '—')}</b><span>${escP(notice.storeName || 'متجر غير معروف')}</span></span>`
      + `<span class="notice-row-money">${escP(money(notice.total, notice.currency))}<small>${escP(numberP(notice.unitCount))} ${notice.unitCount === 1 ? 'قطعة' : 'قطع'}</small></span>`
      + `<span class="notice-row-tags">${payment}${secondChip(notice.second)}</span>`
      + `<time>${escP(dateP(notice.createdAt))}</time></button>`;
  }

  function factRow(name, value) { return `<div><dt>${escP(name)}</dt><dd>${value}</dd></div>`; }

  function itemsMarkup(items) {
    if (!items.length) return '<p class="slip-note">لا توجد منتجات في هذا الإشعار.</p>';
    return `<div class="slip-table-wrap"><table class="slip-table"><thead><tr><th>المنتج</th><th>المقاس</th><th>الكمية</th><th>سعر القطعة</th><th>الإجمالي</th></tr></thead><tbody>${items.map(item => (
      `<tr><td><b>${escP(item.productName || 'منتج بلا اسم')}</b><small>${escP(item.brandName || '')}</small></td><td>${escP(item.sizeLabel || '—')}</td><td>${escP(numberP(item.quantity))}</td><td>${escP(money(item.unitPrice))}</td><td>${escP(money(item.lineTotal))}</td></tr>`
    )).join('')}</tbody></table></div>`;
  }

  /* The notice in full, as it was sent to the merchant. */
  function slipMarkup(notice) {
    const second = notice.secondNotice || { state: 'waiting', mismatches: [] };
    const currency = notice.currency;
    const delivery = notice.delivery || {};
    const payment = notice.payment || {};
    const mismatches = Array.isArray(second.mismatches) && second.mismatches.length
      ? `<p class="slip-mismatch">الحقول المختلفة: ${second.mismatches.map(field => `<code dir="ltr">${escP(field)}</code>`).join(' ')}</p>` : '';
    return `<button type="button" class="ghost slip-back" data-notice-back>الرجوع إلى القائمة</button>`
      + `<header class="slip-head"><div><h2 dir="ltr">${escP(notice.trackingNumber || '—')}</h2><p>${escP(notice.storeName || 'متجر غير معروف')}</p></div><div class="slip-tags">${secondChip(second.state)}</div></header>`
      + `<dl class="slip-facts">${factRow('وقت الإشعار', escP(dateP(notice.createdAt)))}${factRow('حالة الطلب', escP(label(ORDER_STATUS, notice.order && notice.order.status)))}${factRow('رقم جلسة الدفع', ltr(notice.checkoutTrackingNumber))}</dl>`
      + `<section class="slip-section"><h3>المنتجات</h3>${itemsMarkup(Array.isArray(notice.items) ? notice.items : [])}</section>`
      + `<section class="slip-section slip-totals"><dl>${factRow('مجموع المنتجات', escP(money(notice.subtotal, currency)))}${factRow('الشحن', escP(money(notice.shipping, currency)))}<div class="slip-grand"><dt>الإجمالي</dt><dd>${escP(money(notice.total, currency))}</dd></div></dl></section>`
      + `<section class="slip-section"><h3>الدفع</h3><dl class="slip-facts">${factRow('الطريقة', escP(label(PAYMENT_METHODS, payment.method)))}${factRow('الحالة', escP(label(PAYMENT_STATUS, payment.status)))}${factRow('المزوّد', ltr(payment.provider))}${factRow('مرجع العملية', ltr(payment.reference))}${factRow('وقت الدفع', escP(payment.paidAt ? dateP(payment.paidAt) : '—'))}</dl></section>`
      + `<section class="slip-section"><h3>المستلم كما أُرسل للتاجر</h3><dl class="slip-facts">${factRow('الاسم', escP(delivery.name || '—'))}${factRow('الموبايل', ltr(delivery.phone))}${factRow('البريد', ltr(delivery.email))}${factRow('العنوان', escP(delivery.address || '—'))}${factRow('ملاحظات التوصيل', escP(delivery.notes || '—'))}</dl></section>`
      + `<section class="slip-section"><h3>إشعار التاجر (الثاني)</h3><dl class="slip-facts">${factRow('الحالة', escP((SECOND[second.state] || SECOND.waiting).label))}${factRow('رقم الطلب عند التاجر', ltr(second.merchantOrderNumber))}${factRow('رقم الفاتورة', ltr(second.merchantInvoiceNumber))}</dl>${mismatches}</section>`
      + `<footer class="slip-foot"><p>سجل ثابت: كتبته المنصة مرة واحدة ولا يتغير بعد ذلك.</p>${notice.payloadHash ? `<p>البصمة: <code dir="ltr">${escP(notice.payloadHash)}</code></p>` : ''}</footer>`;
  }

  function showError(error) {
    const box = $('#noticesError');
    if (!box) return;
    box.textContent = errorTextP(error, 'تعذر تحميل الإشعارات الأولى، حاول مرة أخرى.');
    box.hidden = false;
  }
  const clearError = () => { const box = $('#noticesError'); if (box) box.hidden = true; };

  async function getJson(url) {
    const response = await fetch(url, { headers: Portal.auth() });
    let data = null;
    try { data = await response.json(); } catch (_) { data = null; }
    if (!response.ok) { const error = new Error((data && data.error) || 'request_failed'); error.status = response.status; throw error; }
    return data || {};
  }

  function drawList() {
    const list = $('#noticeList');
    const empty = $('#noticeEmpty');
    const more = $('#noticeMore');
    list.innerHTML = state.rows.map(row => rowMarkup(row, row.id === state.selected)).join('');
    const filtered = !!(state.query.q || state.query.store);
    empty.hidden = state.rows.length > 0;
    empty.textContent = filtered ? 'لا توجد إشعارات تطابق هذا البحث.' : 'لا توجد إشعارات أولى بعد. يظهر هنا إشعار لكل طلب بعد تأكيد دفعه أو اختيار الدفع عند الاستلام.';
    more.hidden = !state.hasMore;
  }

  function fillStores(stores) {
    const select = $('#noticeStoreFilter');
    if (!select || state.storesLoaded) return;
    state.storesLoaded = true;
    stores.filter(store => store && store.id && store.name).forEach(store => {
      const option = document.createElement('option');
      option.value = store.id;
      option.textContent = store.name;
      select.appendChild(option);
    });
  }

  async function loadList(append) {
    if (state.busy) return;
    state.busy = true;
    const more = $('#noticeMore');
    if (more) more.disabled = true;
    try {
      const params = new URLSearchParams({ limit: String(PAGE), offset: String(append ? state.rows.length : 0) });
      if (state.query.q) params.set('q', state.query.q);
      if (state.query.store) params.set('store', state.query.store);
      const data = await getJson(`/api/platform-first-notices?${params}`);
      const rows = Array.isArray(data.notices) ? data.notices : [];
      state.rows = append ? state.rows.concat(rows) : rows;
      state.total = Number(data.total) || state.rows.length;
      state.hasMore = !!data.hasMore;
      clearError();
      drawList();
      if (!state.query.q && !state.query.store) AdminAlerts.noticesSeen(state.total);
    } finally {
      state.busy = false;
      if (more) more.disabled = false;
    }
  }

  async function select(id) {
    state.selected = id;
    drawList();
    const slip = $('#noticeDetail');
    $('#noticesLayout').classList.add('show-detail');
    if (state.details.has(id)) { slip.innerHTML = slipMarkup(state.details.get(id)); return; }
    slip.innerHTML = '<p class="slip-empty">جارٍ تحميل الإشعار…</p>';
    try {
      const data = await getJson(`/api/platform-first-notices?id=${encodeURIComponent(id)}`);
      state.details.set(id, data.notice);
      if (state.selected === id) slip.innerHTML = slipMarkup(data.notice);
    } catch (error) {
      if (state.selected === id) { slip.innerHTML = '<p class="slip-empty">تعذر تحميل هذا الإشعار.</p>'; showError(error); }
    }
  }

  async function load() {
    // The store filter is a convenience: a failure to fill it never stops the list.
    if (!state.storesLoaded) getJson('/api/platform-stores').then(data => fillStores(Array.isArray(data.stores) ? data.stores : [])).catch(() => {});
    await loadList(false);
  }

  function bind() {
    const form = $('#noticeFilters');
    if (!form) return;
    form.addEventListener('submit', event => {
      event.preventDefault();
      state.query = { q: String(form.elements.q.value || '').trim(), store: String(form.elements.store.value || '') };
      state.selected = null;
      $('#noticeDetail').innerHTML = '<p class="slip-empty">اختر إشعارًا من القائمة لقراءته كاملًا.</p>';
      $('#noticesLayout').classList.remove('show-detail');
      loadList(false).catch(error => { showError(error); });
    });
    $('#noticeList').addEventListener('click', event => {
      const row = event.target.closest('[data-notice-id]');
      if (row) select(row.dataset.noticeId);
    });
    $('#noticeMore').addEventListener('click', () => { loadList(true).catch(showError); });
    $('#noticeDetail').addEventListener('click', event => {
      if (event.target.closest('[data-notice-back]')) $('#noticesLayout').classList.remove('show-detail');
    });
  }

  bind();
  AdminPages.register('notices', {
    load,
    onShow: () => { AdminAlerts.noticesSeen(); },
    onError: showError
  });
  return { rowMarkup, slipMarkup, money };
})();
