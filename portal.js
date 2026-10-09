window.Portal = {
  session: () => {
    try {
      return JSON.parse(localStorage.getItem("elan_auth_session") || "null");
    } catch (_) {
      return null;
    }
  },
  login: async (form) => {
    const cfg = await fetch("/api/config").then((r) => r.json());
    const r = await fetch(cfg.url + "/auth/v1/token?grant_type=password", {
      method: "POST",
      headers: { apikey: cfg.key, "Content-Type": "application/json" },
      body: JSON.stringify({
        email: form.email.value.trim(),
        password: form.password.value,
      }),
    });
    const d = await r.json();
    if (!r.ok || !d.access_token) throw new Error(d.msg || "تعذر تسجيل الدخول");
    localStorage.setItem("elan_auth_session", JSON.stringify(d));
    return d;
  },
  auth: () => {
    const s = Portal.session();
    return s && s.access_token
      ? { Authorization: "Bearer " + s.access_token }
      : {};
  },
  logout: () => {
    localStorage.removeItem("elan_auth_session");
    location.reload();
  },
  notifications: { items: [], timer: null, channel: null, lastSeen: null },
};
Portal.escape = function (s) {
  return String(s ?? "").replace(
    /[&<>"']/g,
    (c) =>
      ({
        "&": "&amp;",
        "<": "&lt;",
        ">": "&gt;",
        '"': "&quot;",
        "'": "&#039;",
      })[c],
  );
};
Portal.toast = function (text, kind = "info") {
  let box = document.querySelector("#portalToast");
  if (!box) {
    box = document.createElement("div");
    box.id = "portalToast";
    document.body.appendChild(box);
  }
  const item = document.createElement("div");
  item.className = "portal-toast " + kind;
  item.textContent = text;
  box.appendChild(item);
  setTimeout(() => item.remove(), 5000);
};
Portal.loadRealtime = function (cfg) {
  return new Promise((resolve) => {
    if (window.supabase) return resolve();
    const script = document.createElement("script");
    script.src = "https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2";
    script.onload = () => resolve();
    script.onerror = () => resolve();
    document.head.appendChild(script);
  }).then(() => {
    const s = Portal.session();
    if (!s || !window.supabase) return;
    try {
      const client = window.supabase.createClient(cfg.url, cfg.key, {
        global: { headers: { Authorization: "Bearer " + s.access_token } },
      });
      Portal.notifications.channel = client
        .channel("portal-notifications-" + s.user?.id)
        .on(
          "postgres_changes",
          { event: "INSERT", schema: "public", table: "notifications" },
          (payload) => {
            const n = payload.new;
            if (!n) return;
            Portal.refreshNotifications(true);
          },
        )
        .subscribe();
    } catch (_) {}
  });
};
Portal.renderNotifications = function () {
  const wrap = document.querySelector("#portalNotifications");
  if (!wrap) return;
  const list = Portal.notifications.items;
  const unread = list.filter((n) => !n.is_read).length;
  wrap.querySelector("[data-notification-count]").textContent =
    unread > 99 ? "99+" : String(unread);
  wrap.querySelector("[data-notification-count]").hidden = unread === 0;
  wrap.querySelector("[data-notification-list]").innerHTML = list.length
    ? list
        .map(
          (n) =>
            `<button class="notification-row ${n.is_read ? "read" : "unread"}" data-notification-id="${Portal.escape(n.id)}"><span class="notification-dot"></span><span><b>${Portal.escape(n.title)}</b><small>${Portal.escape(n.body)}</small><em>${new Date(n.created_at).toLocaleString("ar-EG")}</em></span></button>`,
        )
        .join("")
    : '<p class="notification-empty">لا توجد إشعارات</p>';
};
Portal.refreshNotifications = async function (announce = false) {
  const s = Portal.session();
  if (!s) return;
  try {
    const r = await fetch("/api/notifications?limit=50", {
      headers: Portal.auth(),
    });
    const d = await r.json();
    if (!r.ok) return;
    const previous = Portal.notifications.lastSeen;
    Portal.notifications.items = d.notifications || [];
    Portal.notifications.lastSeen =
      Portal.notifications.items[0]?.id || previous;
    Portal.renderNotifications();
    if (announce && previous && Portal.notifications.items[0]?.id !== previous)
      Portal.toast(Portal.notifications.items[0].title, "warning");
  } catch (_) {}
};
Portal.startNotifications = async function () {
  if (document.querySelector("#portalNotifications")) return;
  const header = document.querySelector("header");
  if (!header) return;
  const box = document.createElement("div");
  box.id = "portalNotifications";
  box.innerHTML =
    '<button class="notification-bell" aria-label="الإشعارات" data-notification-toggle>الإشعارات <span data-notification-count hidden>0</span></button><div class="notification-popover" hidden><div class="notification-head"><b>الإشعارات</b><button data-notification-close>×</button></div><div data-notification-list></div></div>';
  header.appendChild(box);
  box.addEventListener("click", async (e) => {
    if (e.target.closest("[data-notification-toggle]")) {
      box.querySelector(".notification-popover").hidden = !box.querySelector(
        ".notification-popover",
      ).hidden;
      return;
    }
    if (e.target.closest("[data-notification-close]")) {
      box.querySelector(".notification-popover").hidden = true;
      return;
    }
    const row = e.target.closest("[data-notification-id]");
    if (row) {
      await fetch("/api/notifications", {
        method: "PATCH",
        headers: { ...Portal.auth(), "Content-Type": "application/json" },
        body: JSON.stringify({ id: row.dataset.notificationId }),
      });
      const item = Portal.notifications.items.find(
        (n) => n.id === row.dataset.notificationId,
      );
      if (item) item.is_read = true;
      Portal.renderNotifications();
    }
  });
  const cfg = await fetch("/api/config")
    .then((r) => r.json())
    .catch(() => null);
  if (!cfg) return;
  await Portal.refreshNotifications();
  if (Portal.notifications.timer) clearInterval(Portal.notifications.timer);
  Portal.notifications.timer = setInterval(
    () => Portal.refreshNotifications(true),
    30000,
  );
  Portal.loadRealtime(cfg);
};
document.addEventListener("click", (e) => {
  if (e.target.id === "logout") Portal.logout();
});
document.addEventListener("DOMContentLoaded", () =>
  Portal.startNotifications(),
);
