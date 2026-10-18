window.Portal = {
  session() {
    try { return JSON.parse(localStorage.getItem('elan_auth_session') || 'null'); }
    catch (_) { return null; }
  },
  login: async form => {
    const cfg = await fetch('/api/config').then(response => response.json());
    const response = await fetch(`${cfg.url}/auth/v1/token?grant_type=password`, {
      method: 'POST',
      headers: { apikey: cfg.key, 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: form.email.value.trim(), password: form.password.value })
    });
    const data = await response.json();
    if (!response.ok || !data.access_token) throw new Error(data.msg || 'تعذر تسجيل الدخول');
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
    location.reload();
  },
  notifications: { items: [], timer: null, lastSeen: null }
};

Portal.escape = value => String(value ?? '').replace(/[&<>"']/g, character => ({
  '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#039;'
}[character]));

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
  Portal.notifications.timer = setInterval(() => Portal.refreshNotifications(true), 30000);
};

document.addEventListener('click', event => {
  if (event.target.id === 'logout') Portal.logout();
});
window.addEventListener('elan-auth-expired', () => {
  Portal.toast('انتهت جلسة الدخول، سجّل الدخول من جديد', 'warning');
  setTimeout(() => location.reload(), 2500);
});
document.addEventListener('DOMContentLoaded', () => Portal.startNotifications());
