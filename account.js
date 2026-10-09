const escA = (s) =>
  String(s ?? "").replace(
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
const statusA = {
  open: ["مفتوحة", "gold"],
  transferred: ["تم نقلها للمتاجر", "blue"],
  partially_cancelled: ["جزء منها أُلغي", "red"],
  completed: ["مكتملة", "green"],
  closed: ["مغلقة", "muted"],
  needs_review: ["قيد المراجعة", "orange"],
  awaiting_store_confirmation: ["بانتظار تأكيد المتجر", "gold"],
  store_confirmed: ["تم تأكيد الطلب", "green"],
  processing: ["المتجر يجهز الطلب", "blue"],
  shipped: ["تم شحن الطلب", "blue"],
  delivered: ["تم التسليم", "green"],
  store_rejected: ["رفض المتجر الطلب", "red"],
  store_cancelled: ["أُلغي الطلب واستُرجعت المنتجات", "red"],
  restored: ["عادت المنتجات إلى سلتك", "green"],
};
const badgeA = (s) => {
  const x = statusA[s] || [s || "غير محدد", "muted"];
  return `<span class="badge ${x[1]}">${x[0]}</span>`;
};
const moneyA = (n, c = "EGP") => `${Number(n || 0).toFixed(2)} ${escA(c)}`;
const stepsA = ["added", "transferred", "store", "result", "restored"];
const labelsA = {
  added: "أضيفت للسلة",
  transferred: "تم النقل",
  store: "في سلة المتجر",
  result: "نتيجة المتجر",
  restored: "عادت للمنصة",
};
function requestState(r) {
  const restoration = (r.store_order_cart_restorations || [])[0];
  if (restoration && restoration.status === "restored") return "restored";
  return r.status || "awaiting_store_confirmation";
}
function stepIndex(r) {
  const s = requestState(r);
  if (s === "restored") return 4;
  if (s === "store_cancelled" || s === "store_rejected") return 3;
  if (["store_confirmed", "processing", "shipped", "delivered"].includes(s))
    return 3;
  if (s === "awaiting_store_confirmation") return 2;
  return 1;
}
function timelineA(r) {
  const active = stepIndex(r),
    cancelled = r.status === "store_cancelled" || r.status === "store_rejected",
    labels = cancelled
      ? [
          "أضيفت للسلة",
          "تم النقل",
          "في سلة المتجر",
          "أُلغي الطلب",
          "عادت للمنصة",
        ]
      : stepsA.map((x) => labelsA[x]);
  return `<div class="basket-timeline ${cancelled ? "cancelled" : ""}">${labels.map((label, i) => `<div class="timeline-step ${i <= active ? "active" : ""} ${i === active ? "current" : ""}"><span>${i < active ? "✓" : i + 1}</span><small>${label}</small></div>`).join("")}</div><div class="timeline-line"><i style="width:${Math.min((active / 4) * 100, 100)}%"></i></div>`;
}
function cartSnapshot() {
  try {
    const cart = JSON.parse(localStorage.getItem("elan_cart") || "[]");
    return cart.reduce((n, x) => n + (Number(x.q) || 0), 0);
  } catch (_) {
    return 0;
  }
}
function updateCartShortcut(restored = 0) {
  const el = document.querySelector("#cartShortcut");
  if (!el) return;
  const count = cartSnapshot();
  el.querySelector("b").textContent = count;
  el.classList.toggle("has-restored", restored > 0);
  el.querySelector("span").textContent = restored
    ? `سلة Élan Scents · ${restored} مسترجع`
    : "سلة Élan Scents";
}
function renderItems(r) {
  const items = r.store_order_request_items || [];
  return `<div class="transferred-box"><div class="transferred-head"><b>المنتجات الموجودة في سلة المتجر</b><span>${items.length} منتج</span></div>${items.map((i) => `<div class="account-item"><div><b>${escA(i.product_name)}</b><small>${escA(i.size_label || "")} · الكمية ${i.quantity}</small></div><strong>${moneyA(i.line_total, i.currency)}</strong></div>`).join("")}</div>`;
}
function renderRequest(r) {
  const restoration = (r.store_order_cart_restorations || [])[0],
    state = requestState(r),
    restored = restoration && restoration.status === "restored";
  return `<article class="store-basket-card ${state === "store_cancelled" ? "is-cancelled" : ""}"><div class="store-card-top"><div><span class="store-kicker">${state === "restored" ? "عادت من سلة المتجر" : "سلة المتجر"}</span><h3>${escA((r.stores && r.stores.name) || "متجر")}</h3></div>${badgeA(state)}</div><div class="store-meta"><span>رقم التتبع: <b>${escA(r.tracking_number)}</b></span><span>${new Date(r.created_at).toLocaleString("ar-EG")}</span></div>${timelineA(r)}${renderItems(r)}<div class="store-total"><span>الإجمالي الأولي</span><b>${moneyA(r.subtotal, r.currency)}</b></div>${restored ? `<div class="restore-success"><b>تمت إعادة ${restoration.items?.length || r.store_order_request_items?.length || 0} منتج إلى سلة Élan Scents</b><a href="/">الانتقال إلى السلة</a></div>` : ""}${r.reconciliation_status === "mismatched" ? '<div class="review-note">تم الإلغاء، لكن توجد بيانات مالية تحتاج مراجعة.</div>' : ""}<details class="details-toggle"><summary>عرض تفاصيل العملية</summary><div class="details-grid"><span>حالة المطابقة</span><b>${r.reconciliation_status === "matched" ? "مطابقة" : "تحتاج مراجعة"}</b><span>سبب الإلغاء</span><b>${escA(r.failure_reason || "—")}</b><span>المنتجات المسترجعة</span><b>${restored ? "تمت الإعادة" : "لم تتم الإعادة بعد"}</b></div></details></article>`;
}
function renderSession(s) {
  const requests = s.store_order_requests || [],
    restored = requests.filter((r) => requestState(r) === "restored").length;
  return `<article class="checkout-card"><div class="checkout-head"><div><span class="eyebrow">عملية شراء موحدة</span><h2>${escA(s.tracking_number)}</h2><small>${new Date(s.created_at).toLocaleString("ar-EG")}</small></div>${badgeA(s.status)}</div><div class="checkout-summary"><span><b>${requests.length}</b> متاجر</span><span><b>${requests.filter((r) => r.status === "completed" || r.status === "delivered").length}</b> مكتملة</span><span><b>${requests.filter((r) => r.status === "awaiting_store_confirmation").length}</b> بانتظار المتجر</span><span><b>${restored}</b> مسترجعة</span></div><div class="store-baskets">${requests.length ? requests.map(renderRequest).join("") : '<div class="empty">لا توجد سلال مرتبطة بهذه العملية</div>'}</div></article>`;
}
async function loadAccount() {
  const s = Portal.session();
  if (!s) return;
  document.querySelector("#login").hidden = true;
  document.querySelector("#app").hidden = false;
  document.querySelector("#logout").hidden = false;
  const r = await fetch("/api/customer-orders", { headers: Portal.auth() });
  const d = await r.json();
  if (!r.ok) throw Error(d.error || "تعذر تحميل الطلبات");
  const sessions = d.sessions || [],
    requests = sessions.flatMap((x) => x.store_order_requests || []),
    restored = requests.filter((r) => requestState(r) === "restored").length;
  document.querySelector("#stats").innerHTML = [
    ["العمليات", sessions.length, "gold"],
    ["السلال المنتقلة", requests.length, "blue"],
    [
      "قيد المتابعة",
      requests.filter(
        (x) =>
          !["completed", "delivered", "store_cancelled", "restored"].includes(
            requestState(x),
          ),
      ).length,
      "orange",
    ],
    ["تم استرجاعها", restored, "green"],
  ]
    .map(
      (x) =>
        `<div class="stat ${x[2]}"><small>${x[0]}</small><b>${x[1]}</b></div>`,
    )
    .join("");
  document.querySelector("#orders").innerHTML = sessions.length
    ? sessions.map(renderSession).join("")
    : '<div class="empty">لا توجد عمليات مرتبطة بحسابك</div>';
  updateCartShortcut(restored);
}
document.querySelector("#loginForm").addEventListener("submit", async (e) => {
  e.preventDefault();
  try {
    await Portal.login(e.target);
    loadAccount();
  } catch (err) {
    document.querySelector("#message").textContent = err.message;
  }
});
if (Portal.session())
  loadAccount().catch(
    (e) => (document.querySelector("#message").textContent = e.message),
  );
setInterval(() => {
  if (Portal.session()) loadAccount().catch(() => {});
}, 30000);
