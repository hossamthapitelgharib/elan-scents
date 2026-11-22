/* Élan Scents: the customer's side of the MERCHANT'S payment window (step 6 of docs/purchase-flow-final.ar.md).
   The window is the merchant's page, outside Élan's control (card, cash on delivery or financing). Élan only opens it, notices how the
   customer left it, and says so to the server; the server decides what that means (/api/customer-order-window):
     - closing it or cancelling in it before a trusted payment confirmation = the order is cancelled at once and for good ("تم إلغاء المعاملة
       برغبة العميل"), the merchant is told, and the products stay in the cart; Élan keeps no clock for the window, its time is the merchant's;
     - "success" from the browser proves nothing: only a neutral confirmation of the payment makes an order paid.
   Shared by the order page (index.html, order-page.js) and «طلباتي» (account.html). Loaded first by both and used from a click handler:
   a browser lets a page open a window only inside the customer's own tap, so the window is opened first and pointed at the merchant after.
   window.ElanPay = { open(options) -> { close() } }, options = { orderId, onState(state), onError(key) }. */
(function () {
  'use strict';
  if (window.ElanPay) return;

  var WATCH_MS = 500;
  var DETACH_MS = 8000;
  var current = null;

  function token() {
    try { var s = JSON.parse(localStorage.getItem('elan_auth_session') || 'null'); return s && s.access_token || ''; } catch (_) { return ''; }
  }

  function call(orderId, body) {
    var payload = { orderId: orderId };
    Object.keys(body).forEach(function (key) { payload[key] = body[key]; });
    return fetch('/api/customer-order-window', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + token() },
      body: JSON.stringify(payload)
    }).then(function (response) {
      return response.json().catch(function () { return { ok: false, error: 'bad_response' }; });
    }).catch(function () { return { ok: false, error: 'network' }; });
  }

  function open(options) {
    var orderId = options && options.orderId;
    var onState = (options && options.onState) || function () {};
    var onError = (options && options.onError) || function () {};
    if (!orderId) { onError('order_not_found'); return { close: function () {} }; }
    if (current) { try { current.close(); } catch (_) {} }

    // Opened empty and at once, inside the customer's tap, so the browser does not block it; it is pointed at the merchant below.
    var win = null;
    try { win = window.open('about:blank', 'elan_pay', 'popup=yes,width=520,height=780'); } catch (_) { win = null; }
    if (!win) { onError('popup_blocked'); return { close: function () {} }; }
    try { win.document.title = 'Élan Scents'; } catch (_) { /* the page is not ours yet */ }

    var done = false;
    var timer = null;
    var heard = null;
    var navAt = 0;      // when the merchant's address was given to the window

    function finish(state) {
      if (done) return;
      done = true;
      clearInterval(timer);
      window.removeEventListener('message', onMessage);
      if (current === handle) current = null;
      onState(state);
    }
    function report(outcome) {
      return call(orderId, { action: 'return', outcome: outcome }).then(function (answer) {
        if (!answer || answer.ok === false) { finish({ state: 'unknown', error: answer && answer.error || 'network' }); return; }
        finish(answer);
      });
    }
    // The return page (payment-return.html) reports what the customer did in the window itself and tells this page it is done.
    function onMessage(event) {
      if (event.origin !== window.location.origin || !event.data || event.data.elan !== 'pay-return' || event.data.orderId !== orderId) return;
      heard = event.data;
      if (win && !win.closed) { try { win.close(); } catch (_) {} }
      call(orderId, { action: 'state' }).then(function (answer) { finish(answer && answer.ok !== false ? answer : { state: 'unknown' }); });
    }
    window.addEventListener('message', onMessage);

    timer = setInterval(function () {
      if (done) return;
      if (win.closed) {
        clearInterval(timer);
        if (heard) return;
        // A merchant page that cuts its link to the page that opened it (Cross-Origin-Opener-Policy) makes the window LOOK closed to us a moment
        // after it loads. A window that "closes" right after the merchant's page was given to it is therefore not taken as the customer
        // shutting it: it is no longer watched, and the order is followed by the return page's report, by the page's polling, and by what the
        // merchant reports about its own window (it says when its window ended: /api/merchant-window-closed).
        if (navAt && Date.now() - navAt < DETACH_MS) return;
        // Closed for real without the return page having reported: the customer shut the window. The server makes that a cancellation,
        // unless a success claim or a cancellation is already on record (it ignores a later "closed" then).
        report('closed');
      }
    }, WATCH_MS);

    call(orderId, { action: 'open' }).then(function (answer) {
      if (done) return;
      if (!answer || answer.ok === false || !answer.url) {
        clearInterval(timer);
        try { win.close(); } catch (_) {}
        if (answer && answer.state === 'cancelled') { finish(answer); return; }
        done = true;
        window.removeEventListener('message', onMessage);
        if (current === handle) current = null;
        onError(answer && answer.error || 'network');
        return;
      }
      if (/^https:\/\//i.test(answer.url)) { navAt = Date.now(); try { win.location.href = answer.url; } catch (_) { /* the closing watch reports it */ } }
      else { clearInterval(timer); try { win.close(); } catch (_) {} done = true; onError('window_unavailable'); }
    });

    var handle = { close: function () { if (win && !win.closed) { try { win.close(); } catch (_) {} } } };
    current = handle;
    return handle;
  }

  window.ElanPay = { open: open, token: token, call: call };
})();
