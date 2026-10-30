const AUDIT_PAGE = 20;
const state = { auditOffset: 0, auditHasMore: false, auditBusy: false };

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
    request(`/api/platform-audit-log?limit=${AUDIT_PAGE}&offset=0`)
  ]);
  $('#refresh').disabled = false;
  const refused = settled.find(result => result.status === 'rejected' && (result.reason.status === 401 || result.reason.status === 403));
  if (refused) return sessionProblem(refused.reason);
  renderStats(settled[0], settled[1]);
  renderStores(settled[2]);
  renderAudit(settled[3], false);
}

$('#loginForm').addEventListener('submit', async event => {
  event.preventDefault();
  $('#message').textContent = '';
  try { await Portal.login(event.target); await loadPlatform(); }
  catch (error) { reportError(error); }
});
$('#refresh').addEventListener('click', () => loadPlatform().catch(reportError));
$('#platformAuditMore').addEventListener('click', () => loadMoreAudit().catch(reportError));
if (Portal.session()) loadPlatform().catch(reportError);
