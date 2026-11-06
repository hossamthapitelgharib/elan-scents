const AUDIT_PAGE = 20;
const SETTLEMENT_PAGE = 100;
/* The registered-customers card follows new sign-ups without a page reload: it re-reads the (cheap) count this often while the tab is visible. */
const LIVE_COUNT_MS = 20000;
const state = { auditOffset: 0, auditHasMore: false, auditBusy: false, settlements: [], settlementOffset: 0, settlementHasMore: false, settlementBusy: false, settlementMutationBusy: false, orders: null, liveTimer: null, countBusy: false };

/* The page may be opened with the API codes only; Portal.errorText turns each into a sentence (and keeps an unknown code in brackets). */
function errorTextP(error, fallback) {
  return typeof Portal.errorText === 'function' ? Portal.errorText(error, fallback) : (error && error.message) || fallback;
}
function escP(value) {
  return String(value == null ? '' : value).replace(/[&<>"']/g, character => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#039;' }[character]));
}
function numberP(value) { return Math.max(0, Number(value) || 0).toLocaleString('ar-EG'); }
function dateP(value) {
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? '—' : date.toLocaleString('ar-EG');
}
function $(selector) { return document.querySelector(selector); }

/* One request: the JSON answer, or an Error whose message is the API code and whose status is the HTTP status. */
async function request(url) {
  const response = await fetch(url, { headers: Portal.auth() });
  let data = null;
  try { data = await response.json(); } catch (_) { data = null; }
  if (!response.ok) {
    const error = new Error((data && data.error) || 'request_failed');
    error.status = response.status;
    throw error;
  }
  return data || {};
}

function reportError(error) {
  const message = errorTextP(error, 'تعذر تحميل البيانات، حاول مرة أخرى.');
  const box = $('#platformError');
  if (box && !$('#app').hidden) { box.textContent = message; box.hidden = false; }
  else $('#message').textContent = message;
}

/* A signed-out or wrong-role account goes back to the sign-in card with the reason (as the customers dashboard does); a dead session is removed,
   a wrong-role one is kept and the admin simply signs in with the right account. */
function sessionProblem(error) {
  if (error.status === 401) {
    try { localStorage.removeItem('elan_auth_session'); } catch (_) {}
  }
  $('#logout').hidden = true;
  $('#app').hidden = true;
  $('#refresh').hidden = true;
  $('#login').hidden = false;
  $('#message').textContent = errorTextP(error, 'تعذر فتح لوحة المنصة بهذا الحساب.');
}

function statMarkup(items) {
  return items.map(item => `<div class="stat ${escP(item[2] || '')}"><small>${escP(item[0])}</small><b>${escP(item[1])}</b></div>`).join('');
}

const SETTLEMENT_COLUMNS = [
  ['payable', 'مستحقة', 'gold'], ['payment_requested', 'مطلوب تحويله', 'blue'],
  ['payment_submitted', 'بانتظار التحقق', 'orange'], ['payment_verified', 'تم التحقق', 'green'],
  ['paid', 'مدفوعة', 'green'], ['rejected', 'مرفوضة', 'orange'], ['cancelled', 'ملغاة', '']
];
function settlementStatusLabel(status) { return (SETTLEMENT_COLUMNS.find(column => column[0] === status) || ['', status, ''])[1]; }
function settlementActionMarkup(record) {
  if (record.status === 'payable') return `<button class="primary settlement-action" type="button" data-settlement-action="request" data-commission-id="${escP(record.commissionId)}">إنشاء تسوية</button>`;
  if (record.status === 'payment_requested') return `<form class="settlement-form" data-settlement-form="submit" data-settlement-id="${escP(record.id)}"><input name="paymentReference" maxlength="160" placeholder="مرجع التحويل" required><input name="evidenceReference" maxlength="200" placeholder="مرجع الإثبات" required><button class="primary" type="submit">تسجيل التحويل</button></form>`;
  if (record.status === 'payment_submitted') return `<button class="primary settlement-action" type="button" data-settlement-action="verify" data-settlement-id="${escP(record.id)}">اعتماد الإثبات</button>`;
  if (record.status === 'payment_verified') return `<form class="settlement-form" data-settlement-form="paid" data-settlement-id="${escP(record.id)}"><input name="paymentReference" maxlength="160" placeholder="مرجع التحويل النهائي"><button class="primary" type="submit">تأكيد الدفع</button></form>`;
  return '';
}
function settlementRowMarkup(record) {
  const name = record.storeName || 'متجر غير معروف';
  const id = record.commissionId || record.id || '—';
  return `<article class="platform-settlement-row"><div class="platform-settlement-main"><b>${escP(name)}</b><small>العمولة: <code>${escP(id)}</code></small><small>آخر تحديث: ${escP(dateP(record.updatedAt || record.createdAt))}</small></div><div class="platform-settlement-amount"><strong>${escP(numberP(record.amount))} ${escP(record.currency || 'EGP')}</strong><span>${escP(settlementStatusLabel(record.status))}</span></div><div class="platform-settlement-actions">${settlementActionMarkup(record)}</div></article>`;
}
function renderSettlements(result, append = false) {
  const error = $('#platformSettlementError');
  const board = $('#platformSettlementBoard');
  const more = $('#platformSettlementMore');
  const stats = $('#platformSettlementStats');
  if (!error || !board || !more || !stats) return;
  if (result.status !== 'fulfilled') {
    error.textContent = errorTextP(result.reason, 'تعذر تحميل تسويات العمولات.');
    error.hidden = false;
    if (!append) board.innerHTML = '';
    return;
  }
  const rows = Array.isArray(result.value.settlements) ? result.value.settlements : [];
  state.settlements = append ? state.settlements.concat(rows) : rows;
  state.settlementOffset = state.settlements.length;
  state.settlementHasMore = Boolean(result.value.hasMore);
  const counts = Object.fromEntries(SETTLEMENT_COLUMNS.map(column => [column[0], state.settlements.filter(row => row.status === column[0]).length]));
  stats.innerHTML = statMarkup(SETTLEMENT_COLUMNS.map(column => [column[1], numberP(counts[column[0]]), column[2]]));
  board.innerHTML = SETTLEMENT_COLUMNS.map(column => {
    const columnRows = state.settlements.filter(row => row.status === column[0]);
    return `<section class="platform-settlement-column"><header><h3>${escP(column[1])}</h3><b>${escP(numberP(columnRows.length))}</b></header><div>${columnRows.length ? columnRows.map(settlementRowMarkup).join('') : '<p class="platform-settlement-empty">لا توجد سجلات</p>'}</div></section>`;
  }).join('');
  more.hidden = !state.settlementHasMore;
  error.hidden = true;
}

function renderStats(orders, customers) {
  const cards = [];
  const problems = [];
  if (orders.status === 'fulfilled') {
    const counts = orders.value.counts || {};
    cards.push(['طلبات المتاجر', numberP(counts.orders)], ['مكتملة', numberP(counts.completed)], ['مفتوحة', numberP(counts.open)],
      ['مرفوضة أو ملغاة', numberP(counts.cancelled)], ['تحتاج مراجعة', numberP(counts.needsReview), Number(counts.needsReview) > 0 ? 'orange' : '']);
  } else problems.push(errorTextP(orders.reason, 'تعذر تحميل ملخص الطلبات.'));
  if (customers.status === 'fulfilled') {
    const counts = customers.value.counts || {};
    cards.push(['عملاء مسجلون', numberP(counts.registered)], ['الزوار', numberP(counts.visitors)]);
  } else problems.push(errorTextP(customers.reason, 'تعذر تحميل ملخص العملاء.'));
  $('#stats').innerHTML = statMarkup(cards);
  const box = $('#platformError');
  box.textContent = problems.join(' ');
  box.hidden = problems.length === 0;
}

function renderStores(result) {
  const error = $('#platformStoreError');
  const stats = $('#platformStoreStats');
  if (result.status !== 'fulfilled') {
    stats.innerHTML = '';
    error.textContent = errorTextP(result.reason, 'تعذر تحميل ملخص المتاجر.');
    error.hidden = false;
    return;
  }
  const stores = Array.isArray(result.value.stores) ? result.value.stores : [];
  const sum = key => stores.reduce((total, store) => total + Math.max(0, Number(store.summary && store.summary[key]) || 0), 0);
  const active = stores.filter(store => store.status === 'active').length;
  const withoutAccount = stores.filter(store => !(Number(store.summary && store.summary.linked_accounts) > 0)).length;
  stats.innerHTML = statMarkup([
    ['المتاجر النشطة', `${numberP(active)} من ${numberP(stores.length)}`, 'gold'],
    ['متاجر بلا حساب مربوط', numberP(withoutAccount), withoutAccount > 0 ? 'orange' : ''],
    ['المنتجات المتاحة', numberP(sum('available_product_count'))],
    ['العروض النشطة', numberP(sum('active_offer_count'))]
  ]);
  error.hidden = true;
}

/* One sentence per audit entry. Every database text goes through escP. */
const AUDIT_ACTIONS = {
  store_account_linked: entry => `ربط ${accountName(entry)} بمتجر ${storeName(entry)}${entry.detail && entry.detail.previousRole === 'customer' ? ' (تحوّل من عميل إلى مدير متجر)' : ''}`,
  store_account_unlinked: entry => `فك ربط ${accountName(entry)} من متجر ${storeName(entry)}${entry.detail && entry.detail.roleBackToCustomer ? ' (عاد الحساب عميلًا)' : ''}`
};
function accountName(entry) { return entry.subjectEmail ? `الحساب ${entry.subjectEmail}` : 'حساب لم يعد موجودًا'; }
function storeName(entry) { return entry.storeName || 'لم يعد موجودًا'; }

function auditRowMarkup(entry) {
  const describe = AUDIT_ACTIONS[entry.action];
  const text = describe ? describe(entry) : `عملية غير معروفة (${entry.action})`;
  const actor = entry.actorEmail || 'مفتاح دخول مؤقت';
  return `<article class="platform-audit-row"><div><b>${escP(text)}</b><small>بواسطة ${escP(actor)}</small></div><time>${escP(dateP(entry.createdAt))}</time></article>`;
}

function renderAudit(result, append) {
  const error = $('#platformAuditError');
  const list = $('#platformAuditList');
  const more = $('#platformAuditMore');
  if (result.status !== 'fulfilled') {
    error.textContent = errorTextP(result.reason, 'تعذر تحميل سجل العمليات.');
    error.hidden = false;
    if (!append) list.innerHTML = '';
    more.hidden = !append || !state.auditHasMore;
    return;
  }
  const entries = Array.isArray(result.value.entries) ? result.value.entries : [];
  const markup = entries.map(auditRowMarkup).join('');
  if (append) list.innerHTML += markup;
  else list.innerHTML = markup || '<p class="platform-audit-empty">لا توجد عمليات مسجّلة بعد.</p>';
  state.auditOffset = (append ? state.auditOffset : 0) + entries.length;
  state.auditHasMore = Boolean(result.value.hasMore);
  more.hidden = !state.auditHasMore;
  error.hidden = true;
}

async function loadMoreAudit() {
  if (state.auditBusy) return;
  state.auditBusy = true;
  const more = $('#platformAuditMore');
  more.disabled = true;
  try {
    const settled = await Promise.allSettled([request(`/api/platform-audit-log?limit=${AUDIT_PAGE}&offset=${state.auditOffset}`)]);
    if (settled[0].status === 'rejected' && (settled[0].reason.status === 401 || settled[0].reason.status === 403)) return sessionProblem(settled[0].reason);
    renderAudit(settled[0], true);
  } finally {
    more.disabled = false;
    state.auditBusy = false;
  }
}

async function loadMoreSettlements(append = false) {
  if (state.settlementBusy) return;
  state.settlementBusy = true;
  const more = $('#platformSettlementMore');
  more.disabled = true;
  try {
    const result = await Promise.allSettled([request(`/api/platform-commission-settlement?limit=${SETTLEMENT_PAGE}&offset=${append ? state.settlementOffset : 0}`)]);
    if (result[0].status === 'rejected' && (result[0].reason.status === 401 || result[0].reason.status === 403)) return sessionProblem(result[0].reason);
    renderSettlements(result[0], append);
  } finally {
    more.disabled = false;
    state.settlementBusy = false;
  }
}

async function mutateSettlement(action, data) {
  if (state.settlementMutationBusy) return;
  state.settlementMutationBusy = true;
  try {
    const response = await fetch('/api/platform-commission-settlement', { method: 'POST', headers: { ...Portal.auth(), 'Content-Type': 'application/json' }, body: JSON.stringify({ action, ...data }) });
    let result = null; try { result = await response.json(); } catch (_) { result = null; }
    if (!response.ok) { const error = new Error((result && result.error) || 'commission_settlement_failed'); error.status = response.status; throw error; }
    await loadMoreSettlements(false);
  } catch (error) {
    if (error.status === 401 || error.status === 403) sessionProblem(error);
    else { const box = $('#platformSettlementError'); box.textContent = errorTextP(error, 'تعذر تحديث التسوية.'); box.hidden = false; }
  } finally {
    state.settlementMutationBusy = false;
  }
}

async function loadPlatform() {
  if (!Portal.session()) return;
  $('#login').hidden = true;
  $('#app').hidden = false;
  $('#logout').hidden = false;
  $('#refresh').hidden = false;
  $('#refresh').disabled = true;
  $('#message').textContent = '';

  const settled = await Promise.allSettled([
    request('/api/platform-order-summary'),
    request('/api/platform-customer-summary'),
    request('/api/platform-stores'),
    request(`/api/platform-audit-log?limit=${AUDIT_PAGE}&offset=0`),
    request(`/api/platform-commission-settlement?limit=${SETTLEMENT_PAGE}&offset=0`)
  ]);
  $('#refresh').disabled = false;
  const refused = settled.find(result => result.status === 'rejected' && (result.reason.status === 401 || result.reason.status === 403));
  if (refused) return sessionProblem(refused.reason);
  state.orders = settled[0];
  renderStats(settled[0], settled[1]);
  renderStores(settled[2]);
  renderAudit(settled[3], false);
  renderSettlements(settled[4], false);
  startLiveCount();
}

/* Only the customer count is re-read: a failed read leaves the numbers on screen and the next tick tries again; a dead session goes back to sign-in. */
async function refreshCustomerCount() {
  if (state.countBusy || !state.orders || !Portal.session() || $('#app').hidden || document.hidden) return;
  state.countBusy = true;
  try {
    const [customers] = await Promise.allSettled([request('/api/platform-customer-summary')]);
    if (customers.status === 'rejected') {
      if (customers.reason.status === 401 || customers.reason.status === 403) sessionProblem(customers.reason);
      return;
    }
    renderStats(state.orders, customers);
  } finally {
    state.countBusy = false;
  }
}

function startLiveCount() {
  if (state.liveTimer || typeof setInterval !== 'function') return;
  state.liveTimer = setInterval(() => { refreshCustomerCount().catch(() => {}); }, LIVE_COUNT_MS);
  // Node (the tests) must not be held open by this timer; a browser's timer id is a number and has no unref.
  if (state.liveTimer && typeof state.liveTimer.unref === 'function') state.liveTimer.unref();
}

$('#loginForm').addEventListener('submit', async event => {
  event.preventDefault();
  $('#message').textContent = '';
  try { await Portal.login(event.target); await loadPlatform(); }
  catch (error) { reportError(error); }
});
$('#refresh').addEventListener('click', () => loadPlatform().catch(reportError));
$('#platformAuditMore').addEventListener('click', () => loadMoreAudit().catch(reportError));
const settlementRefreshButton = $('#platformSettlementsRefresh');
if (settlementRefreshButton) settlementRefreshButton.addEventListener('click', () => loadMoreSettlements(false).catch(reportError));
const settlementMoreButton = $('#platformSettlementMore');
if (settlementMoreButton) settlementMoreButton.addEventListener('click', () => loadMoreSettlements(true).catch(reportError));
const settlementBoard = $('#platformSettlementBoard');
if (settlementBoard) settlementBoard.addEventListener('click', event => {
  const button = event.target.closest && event.target.closest('[data-settlement-action]');
  if (!button) return;
  const action = button.dataset.settlementAction;
  mutateSettlement(action, action === 'request' ? { commissionId: button.dataset.commissionId } : { settlementId: button.dataset.settlementId });
});
if (settlementBoard) settlementBoard.addEventListener('submit', event => {
  const form = event.target.closest && event.target.closest('[data-settlement-form]');
  if (!form) return;
  event.preventDefault();
  const values = new FormData(form);
  const data = { settlementId: form.dataset.settlementId, paymentReference: String(values.get('paymentReference') || '').trim() };
  if (form.dataset.settlementForm === 'submit') data.evidenceReference = String(values.get('evidenceReference') || '').trim();
  mutateSettlement(form.dataset.settlementForm, data);
});
if (Portal.session()) loadPlatform().catch(reportError);
