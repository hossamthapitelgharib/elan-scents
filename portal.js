window.Portal = {
  session() {
    try { return JSON.parse(localStorage.getItem('elan_auth_session') || 'null'); }
    catch (_) { return null; }
  },
  login: async form => {
    let response, data;
    try {
      const cfg = await fetch('/api/config').then(result => result.json());
      response = await fetch(`${cfg.url}/auth/v1/token?grant_type=password`, {
        method: 'POST',
        headers: { apikey: cfg.key, 'Content-Type': 'application/json' },
        body: JSON.stringify({ email: form.email.value.trim(), password: form.password.value })
      });
      data = await response.json();
    } catch (_) {
      throw new Error('تعذر الاتصال بالخدمة، تحقق من الإنترنت وحاول مرة أخرى.');
    }
    if (!response.ok || !data.access_token) {
      throw new Error(Portal.errorMessages[data.error_code] || Portal.errorMessages[data.error] || 'تعذر تسجيل الدخول، حاول مرة أخرى.');
    }
    localStorage.setItem('elan_auth_session', JSON.stringify(data));
    return data;
  },
  auth() {
    const session = Portal.session();
    return session && session.access_token ? { Authorization: `Bearer ${session.access_token}` } : {};
  },
  logout: async () => {
    try {
      const identity = window.GuestIdentity;
      if (identity && typeof identity.prepareLogout === 'function') {
        await Promise.race([identity.prepareLogout(), new Promise(resolve => setTimeout(resolve, 1500))]);
      }
    } catch (_) {}
    try { if (window.ElanAuth) await window.ElanAuth.signOut(); } catch (_) {}
    localStorage.removeItem('elan_auth_session');
    // The cart is saved in the account, so the browser's copy of it is only a cache. A later sign-in on a shared device
    // would merge it into somebody else's cart, so it goes. The orders copy (elan_orders) is left as it is: the
    // order history lives in the database and logging out never touches it.
    try { localStorage.removeItem('elan_cart'); } catch (_) {}
    location.reload();
  },
  notifications: { items: [], timer: null, lastSeen: null }
};

Portal.escape = value => String(value ?? '').replace(/[&<>"']/g, character => ({
  '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#039;'
}[character]));

// The API and Supabase answer with English codes; the portals are Arabic, so a person never sees a raw code.
Portal.errorMessages = {
  invalid_credentials: 'البريد الإلكتروني أو كلمة المرور غير صحيحة.',
  invalid_grant: 'البريد الإلكتروني أو كلمة المرور غير صحيحة.',
  email_not_confirmed: 'لم يتم تأكيد البريد الإلكتروني بعد، افتح رسالة التأكيد أولًا.',
  over_request_rate_limit: 'محاولات كثيرة، انتظر قليلًا ثم حاول مرة أخرى.',
  over_email_send_rate_limit: 'محاولات كثيرة، انتظر قليلًا ثم حاول مرة أخرى.',
  too_many_requests: 'محاولات كثيرة، انتظر قليلًا ثم حاول مرة أخرى.',
  unauthorized: 'انتهت جلسة الدخول، سجّل الدخول من جديد.',
  login_required: 'انتهت جلسة الدخول، سجّل الدخول من جديد.',
  forbidden: 'هذا الحساب غير مصرح له بفتح هذه الصفحة.',
  role_check_failed: 'تعذر التحقق من صلاحية الحساب الآن، حاول بعد قليل.',
  supabase_service_configuration_missing: 'الخدمة غير مهيأة حاليًا، تواصل مع مسؤول المنصة.',
  invalid_page: 'رقم الصفحة المطلوبة غير صحيح.',
  customer_data_unavailable: 'تعذر تحميل بيانات العملاء الآن، حاول بعد قليل.',
  customer_cart_data_unavailable: 'تعذر تحميل سلال العملاء الآن، حاول بعد قليل.',
  customer_activity_unavailable: 'تعذر تحميل سجل النشاط الآن، حاول بعد قليل.',
  customer_search_history_unavailable: 'تعذر تحميل سجل البحث الآن، حاول بعد قليل.',
  customer_not_found: 'لم يعد هذا العميل موجودًا، حدّث القائمة.',
  invalid_customer: 'بيانات العميل المطلوبة غير صحيحة.',
  guest_analytics_unavailable: 'تعذر تحميل التحليلات الآن، حاول بعد قليل.',
  store_order_read_failed: 'تعذر تحميل الطلبات الآن، حاول بعد قليل.',
  dashboard_read_failed: 'تعذر تحميل الطلبات الآن، حاول بعد قليل.',
  supabase_read_failed: 'تعذر تحميل الطلبات الآن، حاول بعد قليل.',
  customer_dashboard_failed: 'تعذر تحميل طلباتك الآن، حاول بعد قليل.',
  method_not_allowed: 'الطلب غير مدعوم.',
  invalid_status: 'حالة الطلب المطلوبة غير صحيحة.',
  invalid_match_status: 'حالة المطابقة المطلوبة غير صحيحة.',
  invalid_date: 'التاريخ المدخل غير صحيح.',
  store_access_denied: 'هذا الطلب لا يتبع متجرك.',
  store_access_check_failed: 'تعذر التحقق من ربط حسابك بالمتجر الآن، حاول بعد قليل.',
  store_dashboard_failed: 'تعذر تحميل طلبات المتجر الآن، حاول بعد قليل.',
  invalid_status_transition: 'لا يمكن نقل الطلب إلى هذه الحالة من حالته الحالية.',
  order_status_changed: 'تغيّرت حالة الطلب قبل تنفيذ التحديث.',
  financial_update_locked: 'لا يمكن تعديل المبالغ بعد شحن الطلب.',
  order_not_found: 'هذا الطلب لم يعد موجودًا.',
  invalid_request_id: 'رقم الطلب غير صحيح.',
  invalid_amount: 'المبلغ المدخل غير صحيح.',
  store_update_failed: 'تعذر تحديث الطلب الآن، حاول بعد قليل.',
  supabase_update_failed: 'تعذر حفظ التحديث الآن، حاول بعد قليل.',
  order_not_shippable: 'لا يمكن تسجيل شحن لطلب مرفوض أو ملغى.',
  invalid_shipping_transition: 'لا يمكن الرجوع إلى حالة شحن سابقة.',
  shipment_read_failed: 'تعذر قراءة بيانات الشحن الآن، حاول بعد قليل.',
  shipment_save_failed: 'تعذر حفظ بيانات الشحن الآن، حاول بعد قليل.',
  shipment_update_failed: 'تعذر حفظ بيانات الشحن الآن، حاول بعد قليل.',
  'estimatedDeliveryAt is invalid': 'تاريخ التسليم المتوقع غير صحيح.',
  'requestId and valid status are required': 'بيانات التحديث غير مكتملة، حدّث الصفحة وحاول مرة أخرى.',
  'requestId and valid shippingStatus are required': 'بيانات الشحن غير مكتملة، حدّث الصفحة وحاول مرة أخرى.',
  invalid_store_id: 'المتجر المطلوب غير صحيح.',
  request_failed: 'تعذر تحميل البيانات، حاول مرة أخرى.',
  order_summary_unavailable: 'تعذر تحميل ملخص الطلبات الآن، حاول بعد قليل.',
  customer_summary_unavailable: 'تعذر تحميل ملخص العملاء الآن، حاول بعد قليل.',
  store_data_unavailable: 'تعذر تحميل بيانات المتاجر الآن، حاول بعد قليل.',
  store_summary_incomplete: 'ملخص المتاجر غير مكتمل الآن، حدّث الصفحة بعد قليل.',
  unlinked_store_data_unavailable: 'تعذر تحميل سجلات التشغيل غير المرتبطة الآن، حاول بعد قليل.',
  audit_log_unavailable: 'تعذر تحميل سجل العمليات الآن، حاول بعد قليل.',
  store_detail_unavailable: 'تعذر تحميل تفاصيل المتجر الآن، حاول بعد قليل.',
  store_not_found: 'هذا المتجر لم يعد موجودًا، حدّث القائمة.',
  invalid_store_detail_request: 'طلب تفاصيل المتجر غير صحيح، حدّث الصفحة.',
  invalid_unlinked_record_type: 'نوع السجلات المطلوب غير صحيح، حدّث الصفحة.',
  invalid_order_status: 'حالة الطلب المطلوبة غير صحيحة.',
  invalid_reconciliation_status: 'حالة المطابقة المطلوبة غير صحيحة.',
  invalid_commission_status: 'حالة العمولة المطلوبة غير صحيحة.',
  weak_password: 'كلمة المرور ضعيفة، اختر كلمة أطول وأصعب في التخمين.',
  same_password: 'كلمة المرور الجديدة يجب أن تختلف عن القديمة.',
  email_address_invalid: 'البريد الإلكتروني غير صحيح.',
  validation_failed: 'البيانات المدخلة غير صحيحة.',
  session_not_found: 'انتهت صلاحية الرابط، اطلب رابطًا جديدًا.',
  bad_jwt: 'انتهت صلاحية الرابط، اطلب رابطًا جديدًا.'
};
Portal.errorText = (error, fallback) => {
  const raw = String(error && error.message !== undefined ? error.message : error == null ? '' : error).trim();
  if (Portal.errorMessages[raw]) return Portal.errorMessages[raw];
  if (/[؀-ۿ]/.test(raw)) return raw;
  if (/failed to fetch|networkerror|load failed|network request failed/i.test(raw)) return 'تعذر الاتصال بالخدمة، تحقق من الإنترنت وحاول مرة أخرى.';
  const text = fallback || 'حدث خطأ غير متوقع، حاول مرة أخرى.';
  // An API code we have no sentence for is kept in brackets, so support can still tell what failed.
  return /^[a-z][a-z0-9_]{2,60}$/.test(raw) ? `${text} (${raw})` : text;
};

Portal.toast = (text, kind = 'info') => {
  let box = document.querySelector('#portalToast');
  if (!box) {
    box = document.createElement('div');
    box.id = 'portalToast';
    document.body.appendChild(box);
  }
  const item = document.createElement('div');
  item.className = `portal-toast ${kind}`;
  item.textContent = text;
  box.appendChild(item);
  setTimeout(() => item.remove(), 5000);
};

Portal.renderNotifications = () => {
  const wrap = document.querySelector('#portalNotifications');
  if (!wrap) return;
  const list = Portal.notifications.items;
  const unread = list.filter(notification => !notification.is_read).length;
  const count = wrap.querySelector('[data-notification-count]');
  count.textContent = unread > 99 ? '99+' : String(unread);
  count.hidden = unread === 0;
  wrap.querySelector('[data-notification-list]').innerHTML = list.length
    ? list.map(notification => `<button class="notification-row ${notification.is_read ? 'read' : 'unread'}" data-notification-id="${Portal.escape(notification.id)}"><span class="notification-dot"></span><span><b>${Portal.escape(notification.title)}</b><small>${Portal.escape(notification.body)}</small><em>${new Date(notification.created_at).toLocaleString('ar-EG')}</em></span></button>`).join('')
    : '<p class="notification-empty">لا توجد إشعارات</p>';
};

Portal.refreshNotifications = async (announce = false) => {
  if (!Portal.session()) return;
  try {
    const response = await fetch('/api/notifications?limit=50', { headers: Portal.auth() });
    const data = await response.json();
    if (!response.ok || !Array.isArray(data.notifications)) return;
    const previous = Portal.notifications.lastSeen;
    Portal.notifications.items = data.notifications;
    Portal.notifications.lastSeen = Portal.notifications.items[0]?.id || previous;
    Portal.renderNotifications();
    if (announce && previous && Portal.notifications.items[0]?.id !== previous) {
      Portal.toast(Portal.notifications.items[0].title, 'warning');
    }
  } catch (_) {}
};

Portal.startNotifications = async () => {
  if (document.querySelector('#portalNotifications')) return;
  const header = document.querySelector('header');
  if (!header) return;
  const box = document.createElement('div');
  box.id = 'portalNotifications';
  box.innerHTML = '<button class="notification-bell" aria-label="الإشعارات" data-notification-toggle>الإشعارات <span data-notification-count hidden>0</span></button><div class="notification-popover" hidden><div class="notification-head"><b>الإشعارات</b><button data-notification-close>×</button></div><div data-notification-list></div></div>';
  header.appendChild(box);
  box.addEventListener('click', async event => {
    if (event.target.closest('[data-notification-toggle]')) {
      box.querySelector('.notification-popover').hidden = !box.querySelector('.notification-popover').hidden;
      return;
    }
    if (event.target.closest('[data-notification-close]')) {
      box.querySelector('.notification-popover').hidden = true;
      return;
    }
    const row = event.target.closest('[data-notification-id]');
    if (!row) return;
    try {
      const response = await fetch('/api/notifications', {
        method: 'PATCH',
        headers: { ...Portal.auth(), 'Content-Type': 'application/json' },
        body: JSON.stringify({ id: row.dataset.notificationId })
      });
      if (!response.ok) return;
      const item = Portal.notifications.items.find(notification => notification.id === row.dataset.notificationId);
      if (item) item.is_read = true;
      Portal.renderNotifications();
    } catch (_) {}
  });
  await Portal.refreshNotifications();
  if (Portal.notifications.timer) clearInterval(Portal.notifications.timer);
  Portal.notifications.timer = setInterval(() => { if (!document.hidden) Portal.refreshNotifications(true); }, 30000);
};

document.addEventListener('click', event => {
  if (event.target.id === 'logout') Portal.logout();
});
window.addEventListener('elan-auth-expired', () => {
  Portal.toast('انتهت جلسة الدخول، سجّل الدخول من جديد', 'warning');
  setTimeout(() => location.reload(), 2500);
});
document.addEventListener('DOMContentLoaded', () => Portal.startNotifications());
