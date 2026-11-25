/* Élan Scents: the order page (steps 2 to 6 of docs/purchase-flow-final.ar.md), shown in the storefront's sheet after «تنفيذ الطلب».
   1. The page is filled from «حسابي» (read fresh every time it opens) and from the cart. It shows the order's own tracking number (reserved by
      /api/order-draft, so the number the customer saw is the number the order gets), the store, the date and time, every line with the number it
      will carry (the tracking number then -01, -02 ... in the byte order of the store product id, the same order the database numbers them in),
      the prices, the shipping (the store decides it inside its payment window) and the total of the products.
      The customer can edit here the same details «حسابي» holds (phone, address, shipping address, another recipient, delivery notes; the name
      and the e-mail are locked) and the quantities, within the stock. Edits live in the page only: nothing is written until «موافق».
   2. «موافق» first saves the details to «حسابي» (a save that fails stops everything: the order is not sent), then sends the order
      (/api/place-store-order), which the server builds from that account. «إلغاء» throws the edits away and goes back to the cart: nothing was
      saved, nothing was placed, so nothing is cancelled.
   3. The order goes to the store by itself and the store answers by itself in seconds. The page waits and shows the answer: refused (with the
      store's reason), no answer (an apology and "try again in an hour"), or approved with the store's own payment window.
   4. The store's payment window opens BY ITSELF the moment the store approves: there is no «الدفع» button, here or in «طلباتي». A browser only lets a
      page open a window inside the customer's own tap, so «موافق» reserves the empty window (pay-window.js, reserve) and the page points it at the store
      when the answer comes. Only when the browser refused to reserve it, or the customer shut it before the store answered, the page offers one button
      to open it. The window, what is inside it, its shipping cost and its duration belong to the store and its payment provider; the one clock of Élan
      Scents is the server's idle time (30 minutes, or the store's own, from the customer's last interaction) and it is not shown here. Nothing the
      browser says proves a payment: after the window the page shows "verifying" until a neutral confirmation arrives. There is no customer cancel
      button anywhere: closing the window before paying cancels the order, and the products stay in the cart.
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
      subtotal: 'إجمالي المنتجات', shipping: 'الشحن', shippingLater: 'يحدده المتجر في نافذة الدفع', total: 'إجمالي المنتجات',
      approve: 'موافق', cancel: 'إلغاء',
      hint: 'بالضغط على «موافق» تُحفظ بياناتك في «حسابي» ويصل طلبك إلى المتجر ويراجعه تلقائيًا خلال لحظات، ثم تُفتح لك نافذة الدفع الخاصة بالمتجر تلقائيًا (اسمح للموقع بفتح النوافذ إن سألك المتصفح). «إلغاء» يتجاهل أي تعديل أجريته هنا ويعيدك إلى السلة وتبقى منتجاتك فيها.',
      unavailableTitle: 'غير متاح حاليًا', unavailableText: 'تنفيذ الطلب من هذا المتجر غير متاح حاليًا. منتجاتك باقية في سلتك، حاول لاحقًا.',
      retry: 'إعادة المحاولة', backCart: 'العودة للسلة', myOrders: 'طلباتي', close: 'إغلاق', again: 'حاول مرة أخرى',
      eExpired: 'انتهت صلاحية صفحة الطلب. حدّثها ثم اضغط «موافق» من جديد.', eLoad: 'تعذر تجهيز صفحة الطلب الآن. حاول مرة أخرى.', refresh: 'تحديث الصفحة',
      waitTitle: 'جارٍ إرسال طلبك إلى المتجر', waitText: 'ننتظر ردّ المتجر على طلبك، وهذا يستغرق لحظات.', attempt: 'المحاولة', of: 'من',
      waitClose: 'أبقِ هذه الصفحة مفتوحة: تُفتح نافذة الدفع الخاصة بالمتجر تلقائيًا فور ردّه. وستجد حالة طلبك دائمًا في «طلباتي».',
      waitNoPopup: 'أبقِ هذه الصفحة مفتوحة: فور موافقة المتجر يظهر هنا زر لفتح نافذة الدفع الخاصة به. وستجد حالة طلبك دائمًا في «طلباتي».',
      payWaiting: 'جارٍ تجهيز نافذة الدفع… تُفتح هنا نافذة المتجر تلقائيًا فور موافقته على طلبك. أبقِ صفحة Élan Scents مفتوحة.',
      rejectedTitle: 'اعتذر المتجر عن تنفيذ طلبك', rejectedKeep: 'منتجاتك ما زالت في سلتك.', reasonLabel: 'سبب المتجر',
      unresponsiveTitle: 'تعذر تنفيذ طلبك الآن', unresponsive: 'نعتذر عن تنفيذ طلبك في الوقت الحالي، برجاء إعادة المحاولة بعد ساعة',
      byYouTitle: 'تم إلغاء المعاملة برغبة العميل', byYou: 'تم إلغاء المعاملة برغبة العميل. منتجاتك ما زالت في سلتك ويمكنك طلبها مرة أخرى.',
      cancelledTitle: 'أُلغي الطلب', cancelledText: 'أُلغي هذا الطلب. منتجاتك ما زالت في سلتك.',
      approvedTitle: 'قبل المتجر طلبك', approvedText: 'لم يفتح المتصفح نافذة الدفع تلقائيًا. اضغط الزر لفتح نافذة المتجر، وفيها تختار طريقة الدفع. المتجر هو من يحدد طرق الدفع وتكلفة الشحن والإجمالي النهائي.', pay: 'افتح نافذة الدفع',
      payNote: 'إغلاق نافذة الدفع قبل إتمام الدفع، أو تركها دون تفاعل لفترة، يلغي الطلب.',
      payingTitle: 'نافذة الدفع مفتوحة', payingText: 'أكمل الدفع في نافذة المتجر، وستعود إلى Élan Scents تلقائيًا.',
      ePopup: 'لم تُفتح نافذة الدفع. اسمح للموقع بفتح النوافذ ثم اضغط «افتح نافذة الدفع».', ePay: 'تعذر فتح نافذة الدفع الآن. اضغط «افتح نافذة الدفع» مرة أخرى.',
      eClosedEarly: 'أُغلقت نافذة الدفع قبل أن يردّ المتجر. اضغط «افتح نافذة الدفع».',
      payFailed: 'لم تكتمل عملية الدفع. يمكنك فتح نافذة الدفع مرة أخرى وتجربة وسيلة أخرى.',
      verifyTitle: 'نؤكد طريقة الدفع', verifyText: 'عدت من نافذة المتجر. الدفع الإلكتروني يؤكده مزود الدفع، والدفع عند الاستلام يؤكده المتجر، ولا يُعدّ طلبك مؤكدًا قبل ذلك.',
      paidTitle: 'تم تأكيد طلبك', paidText: 'وصلنا تأكيد الدفع، وسيجهّز المتجر طلبك. تابع حالته من «طلباتي».'
    },
    en: {
      title: 'Review your order', loading: 'Preparing your order page…', trackNo: 'Élan Scents tracking number', store: 'Store', when: 'Date and time',
      lines: 'Order items', lineNo: 'Line number', qtyLess: 'Decrease quantity', qtyMore: 'Increase quantity', egp: 'EGP',
      subtotal: 'Products total', shipping: 'Shipping', shippingLater: 'Set by the store in its payment window', total: 'Products total',
      approve: 'Agree', cancel: 'Cancel',
      hint: 'Pressing “Agree” saves your details to My account and sends your order to the store, which reviews it automatically within moments; then the store’s own payment window opens by itself (allow this site to open windows if your browser asks). “Cancel” discards any change you made here and takes you back to the cart; your items stay in it.',
      unavailableTitle: 'Not available right now', unavailableText: 'Placing orders with this store is not available right now. Your items stay in your cart; please try later.',
      retry: 'Try again', backCart: 'Back to cart', myOrders: 'My orders', close: 'Close', again: 'Try again',
      eExpired: 'The order page has expired. Refresh it and press “Agree” again.', eLoad: 'The order page could not be prepared right now. Please try again.', refresh: 'Refresh the page',
      waitTitle: 'Sending your order to the store', waitText: 'We are waiting for the store to answer your order. This takes a few moments.', attempt: 'Attempt', of: 'of',
      waitClose: 'Keep this page open: the store’s payment window opens by itself as soon as the store answers. You will always find your order status in My orders.',
      waitNoPopup: 'Keep this page open: as soon as the store approves, a button appears here to open its payment window. You will always find your order status in My orders.',
      payWaiting: 'Preparing the payment window… the store’s window opens here by itself as soon as it approves your order. Keep the Élan Scents page open.',
      rejectedTitle: 'The store declined your order', rejectedKeep: 'Your items are still in your cart.', reasonLabel: 'The store’s reason',
      unresponsiveTitle: 'Your order could not be placed now', unresponsive: 'We are sorry we could not place your order right now. Please try again in an hour.',
      byYouTitle: 'The transaction was cancelled at the customer’s request', byYou: 'The transaction was cancelled at the customer’s request. Your items are still in your cart and you can order them again.',
      cancelledTitle: 'Order cancelled', cancelledText: 'This order was cancelled. Your items are still in your cart.',
      approvedTitle: 'The store accepted your order', approvedText: 'Your browser did not open the payment window by itself. Press the button to open the store’s window, where you choose how to pay. The store decides the payment methods, the shipping cost and the final total.', pay: 'Open the payment window',
      payNote: 'Closing the payment window before paying, or leaving it untouched for a while, cancels the order.',
      payingTitle: 'The payment window is open', payingText: 'Complete the payment in the store’s window; you will return to Élan Scents automatically.',
      ePopup: 'The payment window did not open. Allow this site to open windows, then press “Open the payment window”.', ePay: 'The payment window could not be opened now. Press “Open the payment window” again.',
      eClosedEarly: 'The payment window was closed before the store answered. Press “Open the payment window”.',
      payFailed: 'The payment was not completed. You can open the payment window again and try another method.',
      verifyTitle: 'Confirming the payment method', verifyText: 'You are back from the store’s window. An electronic payment is confirmed by the payment provider and cash on delivery by the store; your order is not confirmed before that.',
      paidTitle: 'Your order is confirmed', paidText: 'The payment confirmation arrived and the store will prepare your order. Follow it in My orders.'
    }
  };

  var OP = { seq: 0, run: 0, store: '', storeId: '', draft: null, order: null, state: null, edits: null, paying: false, payError: '', payNotice: '', reserved: null, busy: false, failedPolls: 0, poll: 0, tick: 0 };
  var READY = { map: null, at: 0, loading: false };

  function U() { return UI[lang === 'en' ? 'en' : 'ar']; }
  function O() { return ORDER_UI[lang === 'en' ? 'en' : 'ar']; }
  function A() { return ACCT_UI[lang === 'en' ? 'en' : 'ar']; }
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
  /* The customer's details, editable. The values shown are «حسابي» as it is now, with whatever the customer has typed here on top of it
     (OP.edits survives a quantity change that redraws the page). Nothing is written to «حسابي» until «موافق». */
  function formEl() { var h = host(); return h && h.b.querySelector('[data-op-form]'); }
  function captureEdits() {
    var f = formEl(); if (!f) return;
    var e = {};
    Array.prototype.forEach.call(f.elements, function (el) { if (el.name) e[el.name] = el.type === 'checkbox' ? !!el.checked : el.value; });
    OP.edits = e;
  }
  function fieldsHTML() {
    var a = Object.assign({}, typeof acctMine === 'function' && acctMine() || {}, OP.edits || {});
    return '<form class="acct-form op-form" data-op-form novalidate><fieldset class="op-fields">' + acctSections(a, true) + '</fieldset></form>';
  }
  function clearFieldErrors() { var f = formEl(); if (f) f.querySelectorAll('.op-field-error').forEach(function (n) { n.remove(); }); }
  function showFieldError(res) {
    var f = formEl(), el = f && f.elements[res.field];
    clearFieldErrors();
    if (!f || !el) { var box = boxFor(); if (box) { box.textContent = res.error; box.hidden = false; } return; }
    var wrap = el.closest('.acct-field') || el.parentNode, p = document.createElement('p');
    p.className = 'op-field-error'; p.setAttribute('role', 'alert'); p.textContent = res.error;
    wrap.appendChild(p);
    try { el.focus(); } catch (_) { /* a hidden field cannot take focus */ }
    if (p.scrollIntoView) try { p.scrollIntoView({ block: 'nearest' }); } catch (_) { /* old browsers */ }
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
      fieldsHTML() + '<p class="orv-note">' + esc(u.hint) + '</p><p class="order-error op-error" role="alert" hidden></p>' +
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
  function stateHTML() {
    var u = U(), s = OP.state || {}, kind = kindOf(s), trk = '<p class="op-trkline">' + esc(u.trackNo) + ': <b dir="ltr">' + esc(s.trackingNumber || OP.order && OP.order.trackingNumber || '') + '</b></p>';
    if (kind === 'waiting') {
      var d = s.delivery, at = d && d.attempts ? '<p class="op-attempt">' + esc(u.attempt) + ' ' + (+d.attempts) + ' ' + esc(u.of) + ' ' + (+d.maxAttempts) + '</p>' : '';
      return card('op-wait', u.waitTitle, trk + '<div class="op-spin" role="status" aria-live="polite"></div><p>' + esc(u.waitText) + '</p>' + at + '<p class="orv-note">' + esc(OP.reserved ? u.waitClose : u.waitNoPopup) + '</p>', '');
    }
    if (kind === 'rejected') {
      return card('op-bad', u.rejectedTitle, trk + (s.failureReason ? '<p class="op-reason"><span>' + esc(u.reasonLabel) + '</span> ' + esc(s.failureReason) + '</p>' : '') + '<p>' + esc(u.rejectedKeep) + '</p>', backButtons());
    }
    if (kind === 'cancelled') {
      var why = s.cancelReason, title = u.cancelledTitle, text = u.cancelledText;
      if (why === 'store_unresponsive') { title = u.unresponsiveTitle; text = u.unresponsive; }
      else if (why) { title = u.byYouTitle; text = u.byYou; }   // every other reason (the window closed, cancelled, idle or ended at the store) is in the customer's words
      return card('op-bad', title, trk + '<p>' + esc(text) + '</p>', backButtons());
    }
    if (kind === 'approved' || kind === 'paying') {
      var err = OP.payError ? '<p class="order-error" role="alert">' + esc(OP.payError === 'popup_blocked' ? u.ePopup : OP.payError === 'window_closed_early' ? u.eClosedEarly : u.ePay) + '</p>' : '';
      if (OP.payNotice === 'failed' && kind === 'approved') err += '<p class="order-error" role="alert">' + esc(u.payFailed) + '</p>';
      if (kind === 'paying') return card('op-pay', u.payingTitle, trk + '<div class="op-spin" role="status" aria-live="polite"></div><p>' + esc(u.payingText) + '</p>' + err, '');
      return card('op-pay', u.approvedTitle, trk + '<p>' + esc(u.approvedText) + '</p>' + err + '<p class="orv-note">' + esc(u.payNote) + '</p>',
        '<button class="btn" type="button" data-op-pay>' + esc(u.pay) + '</button>');
    }
    if (kind === 'verifying') return card('op-wait', u.verifyTitle, trk + '<div class="op-spin" role="status" aria-live="polite"></div><p>' + esc(u.verifyText) + '</p>', '');
    return card('op-ok', u.paidTitle, trk + '<p>' + esc(u.paidText) + '</p>', '<a class="btn" href="/account.html">' + esc(u.myOrders) + '</a>');
  }

  /* One tick every few seconds keeps the date and time on the page current without redrawing anything. */
  function startTick(seq) {
    clearInterval(OP.tick);
    OP.tick = setInterval(function () {
      if (!mounted(seq)) { clearInterval(OP.tick); return; }
      var t = host().b.querySelector('[data-op-time]');
      if (t) { var text = nowText(); if (t.textContent !== text) t.textContent = text; }
    }, 5000);
  }

  function draw(seq) {
    if (!mounted(seq)) return;
    if (!OP.order) captureEdits();
    if (OP.order) { paint(stateHTML()); } else if (OP.draft) { paint(pageHTML()); }
    startTick(seq);
  }

  /* ---------- the store's window (reserved inside «موافق», pointed at the store when it answers) ---------- */
  function popupDir() { return lang === 'en' ? 'ltr' : 'rtl'; }
  /* Closes the reserved or open window without telling the server anything: the order was refused, cancelled or paid, or the page was left. */
  function releaseReserved() {
    var h = OP.reserved; OP.reserved = null; OP.paying = false;
    if (h) { try { h.close(); } catch (_) { /* already gone */ } }
  }
  /* The customer is back on this page: bring it forward, because the store's window or the return page may have left it behind. */
  function comeBack() { try { window.focus(); } catch (_) { /* a browser may refuse; the page is already showing the result */ } }
  function startWindow(seq, run, handle) {
    OP.paying = true; OP.payError = ''; OP.payNotice = '';
    handle.follow({
      orderId: OP.order.id,
      onState: function (state) {
        if (seq !== OP.seq) return;
        OP.paying = false; OP.reserved = null;
        if (state && state.returned === 'failed') OP.payNotice = 'failed';
        refreshState(seq, run).then(function () { if (seq === OP.seq) { draw(seq); poll(seq, run); comeBack(); } });
      },
      onError: function (key) { if (seq !== OP.seq) return; OP.paying = false; OP.reserved = null; OP.payError = key || 'network'; draw(seq); }
    });
  }
  /* What to do with the window after each answer of the server. */
  function react(seq, run) {
    var kind = kindOf(OP.state);
    if (kind === 'approved' && OP.reserved && !OP.paying) startWindow(seq, run, OP.reserved);
    else if (terminal(kind) || kind === 'verifying') {
      var had = !!OP.reserved;
      releaseReserved();
      if (had) comeBack();
    }
  }

  function refreshState(seq, run) {
    if (!OP.order) return Promise.resolve();
    var orderId = OP.order.id;
    return fetch('/api/customer-order-review', { method: 'POST', headers: headers(), body: JSON.stringify({ orderId: orderId }) })
      .then(function (r) { return r.json().catch(function () { return null; }).then(function (b) { return r.ok && b && b.ok !== false ? b : null; }); })
      .catch(function () { return null; })
      .then(function (answer) {
        if (run !== OP.run || seq !== OP.seq) return null;
        if (answer) { OP.state = answer; OP.failedPolls = 0; } else OP.failedPolls += 1;
        return answer;
      });
  }
  function poll(seq, run) {
    clearTimeout(OP.poll);
    if (run !== OP.run || seq !== OP.seq || terminal(kindOf(OP.state))) return;
    var slow = kindOf(OP.state) === 'verifying' || kindOf(OP.state) === 'approved' || kindOf(OP.state) === 'paying';
    OP.poll = setTimeout(function () {
      if (run !== OP.run) return;
      if (!mounted(seq)) { if (seq === OP.seq && !OP.paying) releaseReserved(); return; }
      refreshState(seq, run).then(function (answer) {
        if (run !== OP.run || seq !== OP.seq) return;
        if (answer) { react(seq, run); draw(seq); }
        poll(seq, run);
      });
    }, slow ? SLOW_POLL_MS : POLL_MS);
  }
  function watch(seq) { OP.run += 1; react(seq, OP.run); draw(seq); poll(seq, OP.run); }

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
    if (OP.reserved && !OP.paying) releaseReserved();   // a window already pointed at a store keeps reporting to the server by itself
    OP.reserved = null;
    var seq = ++OP.seq;
    OP.run += 1; OP.store = store; OP.storeId = storeIdFor(store); OP.draft = null; OP.order = null; OP.state = null; OP.edits = null; OP.paying = false; OP.payError = ''; OP.payNotice = ''; OP.busy = false; OP.failedPolls = 0;
    if (!(cartGroups()[store] || []).length) { sheet('cart'); return; }
    var h = host(); if (!h) return;
    h.s.hidden = false; h.s.dataset.kind = 'order'; document.body.classList.add('sheet-open');
    paint('<div class="op op-state"><h3>' + esc(U().title) + '</h3><div class="op-spin" role="status" aria-live="polite"></div><p>' + esc(U().loading) + '</p></div>');
    if (!token()) { failView(seq, 'eAuth'); return; }
    /* «حسابي» is read again every time the page opens, so what the customer saved there a moment ago is what the page shows. */
    var acctP = acctWithin(acctLoad(), 6000).then(function (r) { return { row: r, failed: false }; }, function () { return { row: acctMine(), failed: true }; });
    var draftP = fetch('/api/order-draft', { method: 'POST', headers: headers(), body: JSON.stringify({ storeId: OP.storeId }) })
      .then(function (r) { return r.json().catch(function () { return null; }).then(function (b) { return { ok: r.ok, body: b }; }); });
    Promise.all([draftP, acctP])
      .then(function (both) {
        if (!mounted(seq)) return;
        var res = both[0], acct = both[1], b = res.body;
        if (!res.ok || !b || b.ok === false || !b.draftId || !b.trackingNumber) { failView(seq, errorOf(new Error(b && (b.message || b.error) || 'draft_failed'))); return; }
        if (acct.failed && !acct.row) { failView(seq, 'load'); return; }
        if (!acct.failed && !acctComplete(acct.row)) { openAccount(store, true); return; }
        OP.draft = { id: b.draftId, trackingNumber: b.trackingNumber, expiresAt: b.expiresAt };
        draw(seq);
      })
      .catch(function () { failView(seq, 'eNet'); });
  }

  /* ---------- the customer's actions ---------- */
  function boxFor() { var h = host(); return h && h.b.querySelector('.op-error'); }
  function lock(on) {
    var h = host(); if (!h) return;
    h.b.querySelectorAll('[data-op-approve],[data-op-cancel],[data-op-q],.op-fields').forEach(function (b) { b.disabled = on; });
  }
  function fail(key) {
    var o = O(), u = U(), box = boxFor();
    releaseReserved();
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
    var form = formEl(), au = A();
    if (!form) return fail('eGen');
    var read = acctRead(form, au);
    if (read.error) { showFieldError(read); return; }
    clearFieldErrors();
    if (reconcileCart(true)) { sheet('cart'); toast(O().cartMoved, 4200); return; }
    var items = cartGroups()[store] || [];
    if (!items.length) { sheet('cart'); return; }
    if (items.some(function (x) { return x.b.review; })) return fail('eReview');
    if (items.some(function (x) { return !x.b.storeProductId; }) || !token() || !OP.storeId) return fail(token() ? 'eGen' : 'eAuth');
    var subtotal = subtotalOf(items), data;
    /* The store's window opens by itself when the store approves. A browser allows a window only inside this tap, so it is reserved now (empty,
       with a waiting text) and pointed at the store when the answer comes. If the browser refuses, the page offers a button after the answer. */
    releaseReserved();
    OP.reserved = window.ElanPay && window.ElanPay.reserve ? window.ElanPay.reserve({ text: U().payWaiting, dir: popupDir() }) : null;
    OP.busy = true; lock(true);
    /* The details are saved to «حسابي» first, and only on «موافق». If that fails nothing goes to the store. */
    try { await acctSave(read.row); } catch (err) {
      releaseReserved();
      if (seq !== OP.seq) { OP.busy = false; return; }
      OP.busy = false; lock(false);
      var sbox = boxFor();
      if (sbox) { sbox.textContent = err && err.message === 'acct_auth' ? au.eAuth : err instanceof TypeError ? au.eNet : au.eSave; sbox.hidden = false; }
      return;
    }
    if (seq !== OP.seq) { OP.busy = false; releaseReserved(); return; }
    OP.edits = null;
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
      if (seq !== OP.seq) { OP.busy = false; releaseReserved(); return; }
      return fail(errorOf(err));
    }
    OP.busy = false;
    if (seq !== OP.seq) { releaseReserved(); return; }
    OP.order = { id: data.id, trackingNumber: data.trackingNumber };
    OP.state = data.state && data.state.status ? data.state : { id: data.id, trackingNumber: data.trackingNumber, status: data.status || 'awaiting_store_confirmation', paymentStatus: data.paymentStatus || 'not_started' };
    watch(seq);
  }

  function qty(spec) {
    if (OP.busy || !OP.draft || OP.order) return;
    var seq = OP.seq;
    captureEdits();
    cartQty(spec, function () { draw(seq); });
  }

  /* The fallback: only when the browser refused to reserve the window, or the customer shut it before the store answered. The window is reserved
     and pointed at the store inside this tap. */
  function pay() {
    if (!OP.order || OP.paying || !window.ElanPay) return;
    var seq = OP.seq, run = OP.run;
    releaseReserved();
    var handle = window.ElanPay.reserve({ text: U().payWaiting, dir: popupDir() });
    if (!handle) { OP.payError = 'popup_blocked'; draw(seq); return; }
    OP.reserved = handle;
    startWindow(seq, run, handle);
    draw(seq);
  }

  document.addEventListener('click', function (e) {
    var t = e.target;
    if (!t || !t.closest) return;
    var q = t.closest('[data-op-q]');
    if (q) { e.preventDefault(); qty(q.dataset.opQ); return; }
    if (t.closest('[data-op-approve]')) { e.preventDefault(); approve(); return; }
    if (t.closest('[data-op-cancel]')) { e.preventDefault(); stopTimers(); releaseReserved(); OP.seq += 1; OP.edits = null; sheet('cart'); return; }
    if (t.closest('[data-op-pay]')) { e.preventDefault(); pay(); return; }
    if (t.closest('[data-op-retry]')) { e.preventDefault(); show(OP.store); return; }
  });

  /* The details form has no submit button of its own: «موافق» is the only way to save, and Enter in a field must not submit anything. */
  document.addEventListener('submit', function (e) { if (e.target && e.target.closest && e.target.closest('[data-op-form]')) e.preventDefault(); });
  document.addEventListener('input', function (e) {
    var t = e.target, w = t && t.closest && t.closest('[data-op-form]') && t.closest('.acct-field'), er = w && w.querySelector('.op-field-error');
    if (er) er.remove();
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
