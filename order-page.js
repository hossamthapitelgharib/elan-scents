/* Élan Scents: the order page (steps 2 to 6 of docs/purchase-flow-final.ar.md), shown in the storefront's sheet after «تنفيذ الطلب».
   1. The page is filled from «حسابي» and from the cart. It shows the order's own tracking number (reserved by /api/order-draft, so the number
      the customer saw is the number the order gets), the store, the date and time, every line with the number it will carry (the tracking number
      then -01, -02 ... in the byte order of the store product id, the same order the database numbers them in), the prices, the shipping
      ("يُحدَّد لاحقًا") and the total. Only the quantity is editable here, within the stock; the customer's own details change in «حسابي».
   2. «موافق» sends the order (/api/place-store-order). «إلغاء» only goes back to the cart: nothing was placed, so nothing is cancelled.
   3. The order goes to the store by itself and the store answers by itself in seconds. The page waits and shows the answer: refused (with the
      store's reason), no answer (an apology and "try again in an hour"), or approved with the store's own payment window and its countdown.
   4. «الدفع» opens that window (pay-window.js). Nothing the browser says proves a payment: after the window the page shows "verifying" until a
      neutral confirmation arrives. There is no customer cancel button anywhere: closing the window before paying cancels the order, and the
      products stay in the cart.
   Everything shown that came from the catalog, the account or the store goes through esc(). The functions it uses (cartGroups, esc, sheet...) are
   the storefront's, defined in app-core.js and looked up when called. window.ElanOrderPage = { show(store), ready(storeId), warm(), strings, state() }. */
(function () {
  'use strict';
  if (window.ElanOrderPage) return;

  var POLL_MS = 3000;
  var SLOW_POLL_MS = 5000;
  var READY_TTL_MS = 60000;

  var UI = {
    ar: {
      title: 'مراجعة طلبك', loading: 'جارٍ تجهيز صفحة طلبك…', trackNo: 'رقم تتبع Élan Scents', store: 'المتجر', when: 'التاريخ والوقت',
      lines: 'منتجات الطلب', lineNo: 'رقم السطر', qtyLess: 'إنقاص الكمية', qtyMore: 'زيادة الكمية', egp: 'ج.م',
      subtotal: 'إجمالي المنتجات', shipping: 'الشحن', shippingLater: 'يُحدَّد لاحقًا', total: 'الإجمالي (قبل الشحن)',
      mine: 'بياناتك', locked: 'من حسابك ولا تُعدَّل هنا', name: 'الاسم', email: 'البريد الإلكتروني', phone: 'رقم الهاتف', address: 'عنوان الشحن', recipient: 'المستلم', notes: 'ملاحظات التوصيل',
      editAcct: 'تعديل بياناتي', approve: 'موافق', cancel: 'إلغاء',
      hint: 'بالضغط على «موافق» يصل طلبك إلى المتجر ويراجعه تلقائيًا خلال لحظات. «إلغاء» يعيدك إلى السلة وتبقى منتجاتك فيها.',
      unavailableTitle: 'غير متاح حاليًا', unavailableText: 'تنفيذ الطلب من هذا المتجر غير متاح حاليًا. منتجاتك باقية في سلتك، حاول لاحقًا.',
      retry: 'إعادة المحاولة', backCart: 'العودة للسلة', myOrders: 'طلباتي', close: 'إغلاق', again: 'حاول مرة أخرى',
      eExpired: 'انتهت صلاحية صفحة الطلب. حدّثها ثم اضغط «موافق» من جديد.', eLoad: 'تعذر تجهيز صفحة الطلب الآن. حاول مرة أخرى.', refresh: 'تحديث الصفحة',
      waitTitle: 'جارٍ إرسال طلبك إلى المتجر', waitText: 'ننتظر ردّ المتجر على طلبك، وهذا يستغرق لحظات.', attempt: 'المحاولة', of: 'من',
      waitClose: 'يمكنك إغلاق هذه النافذة، وستجد حالة طلبك في «طلباتي».',
      rejectedTitle: 'اعتذر المتجر عن تنفيذ طلبك', rejectedKeep: 'منتجاتك ما زالت في سلتك.', reasonLabel: 'سبب المتجر',
      unresponsiveTitle: 'تعذر تنفيذ طلبك الآن', unresponsive: 'نعتذر عن تنفيذ طلبك في الوقت الحالي، برجاء إعادة المحاولة بعد ساعة',
      byYouTitle: 'ملغاة من طرفك', byYou: 'أُلغي الطلب لأن نافذة الدفع أُغلقت أو أُلغي الدفع فيها. منتجاتك ما زالت في سلتك ويمكنك طلبها مرة أخرى.',
      expiredTitle: 'انتهت مهلة الدفع', expired: 'انتهت مهلة نافذة الدفع قبل إتمام الدفع فأُلغي الطلب. منتجاتك ما زالت في سلتك ويمكنك طلبها مرة أخرى.',
      cancelledTitle: 'أُلغي الطلب', cancelledText: 'أُلغي هذا الطلب. منتجاتك ما زالت في سلتك.',
      approvedTitle: 'قبل المتجر طلبك', approvedText: 'أكمل الدفع من نافذة المتجر. الوقت المتبقي:', pay: 'الدفع',
      payNote: 'إغلاق نافذة الدفع قبل إتمام الدفع يلغي الطلب.', timeUp: 'انتهت المهلة، ننتظر إغلاق الطلب…',
      payingTitle: 'نافذة الدفع مفتوحة', payingText: 'أكمل الدفع في نافذة المتجر، وستعود إلى Élan Scents تلقائيًا. الوقت المتبقي:',
      ePopup: 'لم تُفتح نافذة الدفع. اسمح للموقع بفتح النوافذ ثم اضغط «الدفع» مرة أخرى.', ePay: 'تعذر فتح نافذة الدفع الآن. اضغط «الدفع» مرة أخرى.',
      verifyTitle: 'نتحقق من الدفع', verifyText: 'عدت من نافذة الدفع. ننتظر تأكيد الدفع من جهة محايدة ولا يُعدّ الطلب مدفوعًا قبل ذلك.',
      paidTitle: 'تم تأكيد طلبك', paidText: 'وصلنا تأكيد الدفع، وسيجهّز المتجر طلبك. تابع حالته من «طلباتي».'
    },
    en: {
      title: 'Review your order', loading: 'Preparing your order page…', trackNo: 'Élan Scents tracking number', store: 'Store', when: 'Date and time',
      lines: 'Order items', lineNo: 'Line number', qtyLess: 'Decrease quantity', qtyMore: 'Increase quantity', egp: 'EGP',
      subtotal: 'Products total', shipping: 'Shipping', shippingLater: 'Set later', total: 'Total (before shipping)',
      mine: 'Your details', locked: 'From your account; not editable here', name: 'Name', email: 'Email', phone: 'Phone', address: 'Shipping address', recipient: 'Recipient', notes: 'Delivery notes',
      editAcct: 'Edit my details', approve: 'Agree', cancel: 'Cancel',
      hint: 'Pressing “Agree” sends your order to the store, which reviews it automatically within moments. “Cancel” takes you back to the cart and your items stay in it.',
      unavailableTitle: 'Not available right now', unavailableText: 'Placing orders with this store is not available right now. Your items stay in your cart; please try later.',
      retry: 'Try again', backCart: 'Back to cart', myOrders: 'My orders', close: 'Close', again: 'Try again',
      eExpired: 'The order page has expired. Refresh it and press “Agree” again.', eLoad: 'The order page could not be prepared right now. Please try again.', refresh: 'Refresh the page',
      waitTitle: 'Sending your order to the store', waitText: 'We are waiting for the store to answer your order. This takes a few moments.', attempt: 'Attempt', of: 'of',
      waitClose: 'You can close this window; you will find your order status in My orders.',
      rejectedTitle: 'The store declined your order', rejectedKeep: 'Your items are still in your cart.', reasonLabel: 'The store’s reason',
      unresponsiveTitle: 'Your order could not be placed now', unresponsive: 'We are sorry we could not place your order right now. Please try again in an hour.',
      byYouTitle: 'Cancelled by you', byYou: 'The order was cancelled because the payment window was closed or payment was cancelled in it. Your items are still in your cart and you can order them again.',
      expiredTitle: 'Payment time is over', expired: 'The payment window timed out before payment was completed, so the order was cancelled. Your items are still in your cart and you can order them again.',
      cancelledTitle: 'Order cancelled', cancelledText: 'This order was cancelled. Your items are still in your cart.',
      approvedTitle: 'The store accepted your order', approvedText: 'Complete the payment in the store’s window. Time left:', pay: 'Pay',
      payNote: 'Closing the payment window before paying cancels the order.', timeUp: 'Time is up; waiting for the order to be closed…',
      payingTitle: 'The payment window is open', payingText: 'Complete the payment in the store’s window; you will return to Élan Scents automatically. Time left:',
      ePopup: 'The payment window did not open. Allow this site to open windows, then press “Pay” again.', ePay: 'The payment window could not be opened now. Press “Pay” again.',
      verifyTitle: 'Verifying the payment', verifyText: 'You are back from the payment window. We are waiting for a neutral confirmation of the payment; the order is not paid before that.',
      paidTitle: 'Your order is confirmed', paidText: 'The payment confirmation arrived and the store will prepare your order. Follow it in My orders.'
    }
  };

  var OP = { seq: 0, run: 0, store: '', storeId: '', draft: null, order: null, state: null, paying: false, payError: '', busy: false, failedPolls: 0, poll: 0, tick: 0 };
  var READY = { map: null, at: 0, loading: false };

  function U() { return UI[lang === 'en' ? 'en' : 'ar']; }
  function O() { return ORDER_UI[lang === 'en' ? 'en' : 'ar']; }
  function host() { var s = document.getElementById('sheet'), b = document.getElementById('sheetB'); return s && b ? { s: s, b: b } : null; }
  function mounted(seq) { var h = host(); return !!h && seq === OP.seq && !h.s.hidden && h.s.dataset.kind === 'order'; }
  function paint(html) { var h = host(); if (h) h.b.innerHTML = sheetX() + html; }
  function stopTimers() { clearTimeout(OP.poll); clearInterval(OP.tick); OP.poll = 0; OP.tick = 0; }
  function token() { return AUTH && AUTH.access_token || ''; }
  function headers() { return { Authorization: 'Bearer ' + token(), 'Content-Type': 'application/json' }; }
  function pad2(n) { return (n < 10 ? '0' : '') + n; }
  function money(n) { var v = Number(n) || 0; return v.toLocaleString('en-US', { minimumFractionDigits: v % 1 ? 2 : 0, maximumFractionDigits: 2 }) + ' ' + U().egp; }
  function nowText() {
    try {
      var p = {};
      new Intl.DateTimeFormat('en-GB', { timeZone: 'Africa/Cairo', day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' })
        .formatToParts(new Date()).forEach(function (x) { p[x.type] = x.value; });
      return p.day + '/' + p.month + '/' + p.year + ' ' + p.hour + ':' + p.minute;
    } catch (_) { return new Date().toISOString().slice(0, 16).replace('T', ' '); }
  }
  function clock(ms) { var s = Math.max(0, Math.ceil(ms / 1000)); return pad2(Math.floor(s / 60)) + ':' + pad2(s % 60); }

  function storeIdFor(store) {
    var row = ST.filter(function (x) { return String(x[2]) === String(store); })[0] || ST.filter(function (x) { return x[0] === store; })[0] || [];
    return row[2] || store;
  }
  /* The lines in the order the database numbers them: byte order of the store product id (plain string order for these ASCII ids). */
  function lineList(store) {
    return (cartGroups()[store] || []).slice().sort(function (a, b) {
      var x = String(a.b.storeProductId), y = String(b.b.storeProductId);
      return x < y ? -1 : x > y ? 1 : 0;
    });
  }
  function subtotalOf(items) { return +items.reduce(function (a, x) { return a + +(x.b.price * x.c.q).toFixed(2); }, 0).toFixed(2); }

  /* ---------- the order page ---------- */
  function row(label, value, locked) {
    if (!value) return '';
    return '<div class="op-row"><span>' + esc(label) + '</span><b>' + esc(value) + (locked ? ' <i class="op-lock" title="' + esc(U().locked) + '" aria-label="' + esc(U().locked) + '">🔒</i>' : '') + '</b></div>';
  }
  function accountBlock() {
    var u = U(), a = typeof acctMine === 'function' && acctMine() || {}, pf = acctOrderPrefill(), email = AUTH && AUTH.user && AUTH.user.email || pf.email || '';
    var rn = a.recipient_name || '', rp = a.recipient_phone || '';
    return '<section class="op-acct"><h4>' + esc(u.mine) + '</h4>' + row(u.name, a.full_name || pf.name, true) + row(u.email, email, true) + row(u.phone, a.phone || pf.phone) +
      row(u.address, String(pf.address || '').split('\n')[0]) + ((rn || rp) ? row(u.recipient, [rn, rp].filter(Boolean).join(' - ')) : '') + row(u.notes, a.delivery_notes) +
      '<button class="back-cart" type="button" data-acct-edit="' + esc(OP.store) + '">' + esc(u.editAcct) + '</button></section>';
  }
  function pageHTML() {
    var u = U(), items = lineList(OP.store), trk = OP.draft.trackingNumber, sub = subtotalOf(items), name = items[0] && items[0].b.store || OP.store;
    var lines = items.map(function (x, i) {
      var q = +x.c.q, stock = x.b.stock, max = Math.min(99, stock != null ? stock : 99), line = +(x.b.price * q).toFixed(2);
      return '<li class="op-line"><span class="op-no" title="' + esc(u.lineNo) + '">' + esc(trk + '-' + pad2(i + 1)) + '</span>' +
        '<div class="op-name"><b>' + esc(x.p.name) + '</b><small>' + esc(x.p.brand + (x.p.sz ? ' · ' + x.p.sz : '')) + '</small></div>' +
        '<div class="op-q"><button type="button" data-op-q="' + esc(x.c.sid) + '|-1" aria-label="' + esc(u.qtyLess) + '"' + (q <= 1 ? ' disabled' : '') + '>−</button><span>' + q +
        '</span><button type="button" data-op-q="' + esc(x.c.sid) + '|1" aria-label="' + esc(u.qtyMore) + '"' + (q >= max ? ' disabled' : '') + '>+</button></div>' +
        '<div class="op-amt"><small>' + money(x.b.price) + ' × ' + q + '</small><b>' + money(line) + '</b></div></li>';
    }).join('');
    return '<div class="op"><h3>' + esc(u.title) + '</h3>' +
      '<div class="op-meta"><div><span>' + esc(u.trackNo) + '</span><b class="op-trk" dir="ltr">' + esc(trk) + '</b></div><div><span>' + esc(u.store) + '</span><b>' + esc(name) + '</b></div>' +
      '<div><span>' + esc(u.when) + '</span><b dir="ltr" data-op-time>' + esc(nowText()) + '</b></div></div>' +
      '<ul class="op-lines" aria-label="' + esc(u.lines) + '">' + lines + '</ul>' +
      '<div class="op-totals"><div><span>' + esc(u.subtotal) + '</span><b>' + money(sub) + '</b></div><div><span>' + esc(u.shipping) + '</span><b>' + esc(u.shippingLater) + '</b></div>' +
      '<div class="op-total"><span>' + esc(u.total) + '</span><b>' + money(sub) + '</b></div></div>' +
      accountBlock() + '<p class="orv-note">' + esc(u.hint) + '</p><p class="order-error op-error" role="alert" hidden></p>' +
      '<div class="op-actions"><button class="btn" type="button" data-op-approve>' + esc(u.approve) + '</button><button class="btn ghost" type="button" data-op-cancel>' + esc(u.cancel) + '</button></div></div>';
  }

  /* ---------- where the order stands ---------- */
  function kindOf(s) {
    if (!s) return 'waiting';
    if (s.status === 'store_rejected') return 'rejected';
    if (s.status === 'cancelled') return 'cancelled';
    if (s.status === 'awaiting_store_confirmation') return 'waiting';
    if (s.paymentStatus === 'paid' || s.paymentStatus === 'cod_selected') return 'paid';
    if (s.status === 'store_confirmed') {
      var w = s.window && s.window.state;
      if (w === 'success_claimed') return 'verifying';
      return OP.paying ? 'paying' : 'approved';
    }
    return 'waiting';
  }
  function terminal(kind) { return kind === 'rejected' || kind === 'cancelled' || kind === 'paid'; }
  function card(cls, title, body, actions) {
    return '<div class="op op-state ' + cls + '"><h3>' + esc(title) + '</h3>' + body + '<div class="op-actions">' + (actions || '') + '</div></div>';
  }
  function backButtons() {
    var u = U();
    return '<button class="btn" type="button" data-back-cart>' + esc(u.backCart) + '</button><a class="btn ghost op-link" href="/account.html">' + esc(u.myOrders) + '</a>';
  }
  function remaining(s) { var t = s && s.window && Date.parse(s.window.expiresAt); return t ? t - Date.now() : null; }
  function countText(s) { var r = remaining(s); return r == null ? '' : r > 0 ? clock(r) : '00:00'; }

  function stateHTML() {
    var u = U(), s = OP.state || {}, kind = kindOf(s), trk = '<p class="op-trkline">' + esc(u.trackNo) + ': <b dir="ltr">' + esc(s.trackingNumber || OP.order && OP.order.trackingNumber || '') + '</b></p>';
    if (kind === 'waiting') {
      var d = s.delivery, at = d && d.attempts ? '<p class="op-attempt">' + esc(u.attempt) + ' ' + (+d.attempts) + ' ' + esc(u.of) + ' ' + (+d.maxAttempts) + '</p>' : '';
      return card('op-wait', u.waitTitle, trk + '<div class="op-spin" role="status" aria-live="polite"></div><p>' + esc(u.waitText) + '</p>' + at + '<p class="orv-note">' + esc(u.waitClose) + '</p>', '');
    }
    if (kind === 'rejected') {
      return card('op-bad', u.rejectedTitle, trk + (s.failureReason ? '<p class="op-reason"><span>' + esc(u.reasonLabel) + '</span> ' + esc(s.failureReason) + '</p>' : '') + '<p>' + esc(u.rejectedKeep) + '</p>', backButtons());
    }
    if (kind === 'cancelled') {
      var why = s.cancelReason, title = u.cancelledTitle, text = u.cancelledText;
      if (why === 'store_unresponsive') { title = u.unresponsiveTitle; text = u.unresponsive; }
      else if (why === 'payment_window_cancelled' || why === 'payment_window_closed' || why === 'customer_requested_before_payment') { title = u.byYouTitle; text = u.byYou; }
      else if (why === 'payment_window_expired') { title = u.expiredTitle; text = u.expired; }
      return card('op-bad', title, trk + '<p>' + esc(text) + '</p>', backButtons());
    }
    if (kind === 'approved' || kind === 'paying') {
      var left = remaining(s), over = left != null && left <= 0, err = OP.payError ? '<p class="order-error" role="alert">' + esc(OP.payError === 'popup_blocked' ? u.ePopup : u.ePay) + '</p>' : '';
      var count = left == null ? '' : '<b class="op-count" dir="ltr" data-op-count>' + esc(countText(s)) + '</b>';
      if (kind === 'paying') return card('op-pay', u.payingTitle, trk + '<div class="op-spin" role="status" aria-live="polite"></div><p>' + esc(u.payingText) + ' ' + count + '</p>' + err, '');
      return card('op-pay', u.approvedTitle, trk + '<p>' + esc(over ? u.timeUp : u.approvedText) + ' ' + (over ? '' : count) + '</p>' + err + '<p class="orv-note">' + esc(u.payNote) + '</p>',
        over ? '' : '<button class="btn" type="button" data-op-pay>' + esc(u.pay) + '</button>');
    }
    if (kind === 'verifying') return card('op-wait', u.verifyTitle, trk + '<div class="op-spin" role="status" aria-live="polite"></div><p>' + esc(u.verifyText) + '</p>', '');
    return card('op-ok', u.paidTitle, trk + '<p>' + esc(u.paidText) + '</p>', '<a class="btn" href="/account.html">' + esc(u.myOrders) + '</a>');
  }

  /* One tick a second keeps the clock on the page and the countdown moving without redrawing anything. */
  function startTick(seq) {
    clearInterval(OP.tick);
    OP.tick = setInterval(function () {
      if (!mounted(seq)) { clearInterval(OP.tick); return; }
      var h = host(), t = h.b.querySelector('[data-op-time]'), c = h.b.querySelector('[data-op-count]');
      if (t) { var text = nowText(); if (t.textContent !== text) t.textContent = text; }
      if (c) {
        var text2 = countText(OP.state);
        if (c.textContent !== text2) c.textContent = text2;
        if (text2 === '00:00' && !OP.timeUp) { OP.timeUp = true; draw(seq); }
      }
    }, 1000);
  }

  function draw(seq) {
    if (!mounted(seq)) return;
    if (OP.order) { paint(stateHTML()); } else if (OP.draft) { paint(pageHTML()); }
    startTick(seq);
  }

  function refreshState(seq, run) {
    if (!OP.order) return Promise.resolve();
    var orderId = OP.order.id;
    return fetch('/api/customer-order-review', { method: 'POST', headers: headers(), body: JSON.stringify({ orderId: orderId }) })
      .then(function (r) { return r.json().catch(function () { return null; }).then(function (b) { return r.ok && b && b.ok !== false ? b : null; }); })
      .catch(function () { return null; })
      .then(function (answer) {
        if (run !== OP.run || seq !== OP.seq) return null;
        if (answer) { OP.state = answer; OP.failedPolls = 0; if (kindOf(answer) !== 'approved') OP.timeUp = false; } else OP.failedPolls += 1;
        return answer;
      });
  }
  function poll(seq, run) {
    clearTimeout(OP.poll);
    if (run !== OP.run || seq !== OP.seq || terminal(kindOf(OP.state))) return;
    var slow = kindOf(OP.state) === 'verifying' || kindOf(OP.state) === 'approved' || kindOf(OP.state) === 'paying';
    OP.poll = setTimeout(function () {
      if (!mounted(seq) || run !== OP.run) return;
      refreshState(seq, run).then(function (answer) {
        if (run !== OP.run || seq !== OP.seq) return;
        if (answer) draw(seq);
        poll(seq, run);
      });
    }, slow ? SLOW_POLL_MS : POLL_MS);
  }
  function watch(seq) { OP.run += 1; OP.timeUp = false; draw(seq); poll(seq, OP.run); }

  /* ---------- opening the page ---------- */
  function errorOf(err) {
    var m = String(err && err.message || '');
    if (/store_not_connected|Store is not connected/i.test(m)) return 'unavailable';
    if (/order_page_expired|Order page expired/i.test(m)) return 'expired';
    return orderErrorKey(err);
  }
  function failView(seq, key) {
    if (!mounted(seq)) return;
    var u = U(), o = O();
    if (key === 'unavailable') { paint(card('op-bad', u.unavailableTitle, '<p>' + esc(u.unavailableText) + '</p>', '<button class="btn" type="button" data-back-cart>' + esc(u.backCart) + '</button>')); return; }
    var msg = key === 'load' ? u.eLoad : (o[key] || u.eLoad);
    paint(card('op-bad', u.title, '<p class="order-error" role="alert">' + esc(msg) + '</p>', '<button class="btn" type="button" data-op-retry>' + esc(u.retry) + '</button><button class="btn ghost" type="button" data-back-cart>' + esc(u.backCart) + '</button>'));
  }

  function show(store) {
    if (window.ELAN_EDITOR_PREVIEW) return;
    stopTimers();
    var seq = ++OP.seq;
    OP.run += 1; OP.store = store; OP.storeId = storeIdFor(store); OP.draft = null; OP.order = null; OP.state = null; OP.paying = false; OP.payError = ''; OP.busy = false; OP.failedPolls = 0; OP.timeUp = false;
    if (!(cartGroups()[store] || []).length) { sheet('cart'); return; }
    var h = host(); if (!h) return;
    h.s.hidden = false; h.s.dataset.kind = 'order'; document.body.classList.add('sheet-open');
    paint('<div class="op op-state"><h3>' + esc(U().title) + '</h3><div class="op-spin" role="status" aria-live="polite"></div><p>' + esc(U().loading) + '</p></div>');
    if (!token()) { failView(seq, 'eAuth'); return; }
    fetch('/api/order-draft', { method: 'POST', headers: headers(), body: JSON.stringify({ storeId: OP.storeId }) })
      .then(function (r) { return r.json().catch(function () { return null; }).then(function (b) { return { ok: r.ok, body: b }; }); })
      .then(function (res) {
        if (!mounted(seq)) return;
        var b = res.body;
        if (!res.ok || !b || b.ok === false || !b.draftId || !b.trackingNumber) { failView(seq, errorOf(new Error(b && (b.message || b.error) || 'draft_failed'))); return; }
        OP.draft = { id: b.draftId, trackingNumber: b.trackingNumber, expiresAt: b.expiresAt };
        draw(seq);
      })
      .catch(function () { failView(seq, 'eNet'); });
  }

  /* ---------- the customer's actions ---------- */
  function boxFor() { var h = host(); return h && h.b.querySelector('.op-error'); }
  function lock(on) {
    var h = host(); if (!h) return;
    h.b.querySelectorAll('[data-op-approve],[data-op-cancel],[data-op-q],[data-acct-edit]').forEach(function (b) { b.disabled = on; });
  }
  function fail(key) {
    var o = O(), u = U(), box = boxFor();
    OP.busy = false; lock(false);
    if (key === 'expired') { if (box) { box.textContent = u.eExpired; box.hidden = false; } return; }
    if (key === 'unavailable') { failView(OP.seq, 'unavailable'); return; }
    if (box) { box.textContent = o[key] || o.eGen; box.hidden = false; }
    if (key === 'ePrice' || key === 'eStock') loadData();
  }

  async function approve() {
    if (OP.busy || !OP.draft) return;
    var seq = OP.seq, store = OP.store, box = boxFor();
    if (box) box.hidden = true;
    if (reconcileCart(true)) { sheet('cart'); toast(O().cartMoved, 4200); return; }
    var items = cartGroups()[store] || [];
    if (!items.length) { sheet('cart'); return; }
    if (items.some(function (x) { return x.b.review; })) return fail('eReview');
    if (items.some(function (x) { return !x.b.storeProductId; }) || !token() || !OP.storeId) return fail(token() ? 'eGen' : 'eAuth');
    var subtotal = subtotalOf(items), data;
    OP.busy = true; lock(true);
    try {
      if (!(await cartFlush())) { var unsaved = new Error('cart_not_saved'); unsaved.network = true; throw unsaved; }
      var response = await fetch('/api/place-store-order', {
        method: 'POST', headers: headers(),
        body: JSON.stringify({ payload: { storeId: OP.storeId, idempotencyKey: 'd-' + String(OP.draft.id).replace(/-/g, ''), expectedSubtotal: subtotal, draftId: OP.draft.id } })
      });
      data = await response.json().catch(function () { return null; });
      if (!response.ok || !data || !data.id || !data.trackingNumber) throw new Error(data && (data.message || data.error) || 'place_store_order_failed');
    } catch (err) {
      if (err instanceof TypeError) err.network = true;
      if (seq !== OP.seq) { OP.busy = false; return; }
      return fail(errorOf(err));
    }
    OP.busy = false;
    if (seq !== OP.seq) return;
    OP.order = { id: data.id, trackingNumber: data.trackingNumber };
    OP.state = data.state && data.state.status ? data.state : { id: data.id, trackingNumber: data.trackingNumber, status: data.status || 'awaiting_store_confirmation', paymentStatus: data.paymentStatus || 'not_started' };
    watch(seq);
  }

  function qty(spec) {
    if (OP.busy || !OP.draft || OP.order) return;
    var seq = OP.seq;
    cartQty(spec, function () { draw(seq); });
  }

  function pay() {
    if (!OP.order || OP.paying || !window.ElanPay) return;
    var seq = OP.seq, run = OP.run;
    OP.paying = true; OP.payError = '';
    window.ElanPay.open({
      orderId: OP.order.id,
      onState: function () {
        if (seq !== OP.seq) return;
        OP.paying = false;
        refreshState(seq, run).then(function () { if (seq === OP.seq) { OP.timeUp = false; draw(seq); poll(seq, run); } });
      },
      onError: function (key) { if (seq !== OP.seq) return; OP.paying = false; OP.payError = key || 'network'; draw(seq); }
    });
    draw(seq);
  }

  document.addEventListener('click', function (e) {
    var t = e.target;
    if (!t || !t.closest) return;
    var q = t.closest('[data-op-q]');
    if (q) { e.preventDefault(); qty(q.dataset.opQ); return; }
    if (t.closest('[data-op-approve]')) { e.preventDefault(); approve(); return; }
    if (t.closest('[data-op-cancel]')) { e.preventDefault(); stopTimers(); OP.seq += 1; sheet('cart'); return; }
    if (t.closest('[data-op-pay]')) { e.preventDefault(); pay(); return; }
    if (t.closest('[data-op-retry]')) { e.preventDefault(); show(OP.store); return; }
  });

  /* ---------- which stores can take an order at all (the cart's button says so before the customer tries) ---------- */
  function warm() {
    if (READY.loading || (READY.map && Date.now() - READY.at < READY_TTL_MS)) return;
    READY.loading = true;
    fetch('/api/store-order-readiness').then(function (r) { return r.ok ? r.json() : null; }).then(function (b) {
      READY.loading = false; READY.at = Date.now();
      if (!b || !b.stores || typeof b.stores !== 'object') return;
      var changed = JSON.stringify(b.stores) !== JSON.stringify(READY.map || {});
      READY.map = b.stores;
      var h = host();
      if (changed && h && !h.s.hidden && h.s.dataset.kind === 'cart') sheet('cart');
    }).catch(function () { READY.loading = false; READY.at = Date.now(); });
  }
  /* Unknown means "try": only a store the server says is not connected is locked. */
  function ready(storeId) { return !(READY.map && storeId && READY.map[storeId] === false); }

  window.ElanOrderPage = { show: show, ready: ready, warm: warm, strings: UI, state: function () { return OP; } };
})();
