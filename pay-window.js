/* Élan Scents: the customer's side of the MERCHANT'S payment window (step 6 of docs/purchase-flow-final.ar.md).
   The window is the merchant's page, outside Élan's control (card, cash on delivery or financing). It opens BY ITSELF as soon as the merchant has
   approved the order: no button in «طلباتي» and none on the order page unless the browser refused to open it (see reserve below). Élan notices how the
   customer left it and says so to the server; the server decides what that means (/api/customer-order-window):
     - closing it or cancelling in it before a trusted payment confirmation = the order is cancelled at once and for good ("تم إلغاء المعاملة
       برغبة العميل"), the merchant is told, and the products stay in the cart;
     - the only clock of Élan's is the server's idle time (30 minutes, or the merchant's own) counted from the customer's last interaction; it is not
       shown here and nothing in this file keeps it: the server cancels a window nobody touched, and the next read of the order says so;
     - "success" from the browser proves nothing: only a neutral confirmation of the payment makes an order paid.
   Used by the order page (index.html, order-page.js) only. A browser lets a page open a window only inside the customer's own tap, and the merchant
   answers some seconds after the tap, so the window is RESERVED inside the tap («موافق»), left showing a short waiting text, and pointed at the merchant
   when the answer comes.
   window.ElanPay = { reserve(options) -> handle | null, open(options) -> handle, token, call }
   reserve({ text })  opens the empty window now (call it inside the tap); null = the browser refused.
   handle.follow({ orderId, onState(state), onError(key) })  asks the server for the merchant's window and points the reserved window at it.
   handle.close()  closes it without telling the server anything (the order was refused, cancelled, or the page was left).
   open(options) = reserve + follow, for a tap on the fallback button. options = { orderId, onState, onError, text }. */
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

  function reserve(options) {
    if (current) { try { current.close(); } catch (_) {} }
    // Opened empty and at once, inside the customer's tap, so the browser does not block it; it is pointed at the merchant later.
    var win = null;
    try { win = window.open('about:blank', 'elan_pay', 'popup=yes,width=520,height=780'); } catch (_) { win = null; }
    if (!win) return null;
    try {
      win.document.title = 'Élan Scents';
      win.document.documentElement.dir = (options && options.dir) || 'rtl';
      var body = win.document.body, st = body.style;
      st.margin = '0'; st.padding = '48px 24px'; st.font = '16px/1.8 sans-serif'; st.textAlign = 'center'; st.color = '#2b2118'; st.background = '#faf6ee';
      body.textContent = (options && options.text) || '';
    } catch (_) { /* the page is not ours yet */ }

    var handle = { followed: false, win: win, follow: null, close: null, stop: null };
    // close() is the page's own doing (the order was refused or cancelled, the order is paid, the page was left): the window is shut and watching it
    // stops, so a window shut by Élan is never read as the customer shutting it.
    handle.close = function () {
      if (handle.stop) handle.stop();
      if (win && !win.closed) { try { win.close(); } catch (_) {} }
      if (current === handle) current = null;
    };
    handle.follow = function (opts) {
      if (handle.followed) return;
      handle.followed = true;
      var orderId = opts && opts.orderId;
      var onState = (opts && opts.onState) || function () {};
      var onError = (opts && opts.onError) || function () {};
      if (!orderId) { handle.close(); onError('order_not_found'); return; }
      // The customer shut the waiting window before the merchant answered: nothing of the merchant's was shown, so nothing is cancelled here; the
      // order page offers to open it again.
      if (win.closed) { if (current === handle) current = null; onError('window_closed_early'); return; }

      var done = false;
      var timer = null;
      var channel = null;
      var heard = null;
      var navAt = 0;      // when the merchant's address was given to the window

      function cleanup() {
        clearInterval(timer);
        window.removeEventListener('message', onMessage);
        if (channel) { try { channel.close(); } catch (_) {} channel = null; }
      }
      handle.stop = function () { done = true; cleanup(); };
      function finish(state) {
        if (done) return;
        done = true;
        cleanup();
        if (current === handle) current = null;
        onState(state);
      }
      function report(outcome) {
        return call(orderId, { action: 'return', outcome: outcome }).then(function (answer) {
          if (!answer || answer.ok === false) { finish({ state: 'unknown', error: answer && answer.error || 'network' }); return; }
          finish(answer);
        });
      }
      // The return page (payment-return.html) reports what the customer did in the window itself and tells this page it is done: by postMessage
      // while it still has a link to the page that opened it, and on a BroadcastChannel (same origin) when the merchant's page cut that link.
      // outcome is success | cancel | failed | closed; the truth about the order is always asked of the server, never taken from here.
      function onMessage(event) {
        if (done || event.origin !== window.location.origin || !event.data || event.data.elan !== 'pay-return' || event.data.orderId !== orderId) return;
        heard = event.data;
        if (win && !win.closed) { try { win.close(); } catch (_) {} }
        call(orderId, { action: 'state' }).then(function (answer) {
          var state = answer && answer.ok !== false ? answer : { state: 'unknown' };
          finish(Object.assign({}, state, { returned: String(heard.outcome || '') }));
        });
      }
      window.addEventListener('message', onMessage);
      try {
        if (typeof BroadcastChannel === 'function') {
          channel = new BroadcastChannel('elan-pay-return');
          channel.onmessage = function (event) { onMessage({ origin: window.location.origin, data: event && event.data }); };
        }
      } catch (_) { channel = null; }

      timer = setInterval(function () {
        if (done) return;
        if (win.closed) {
          clearInterval(timer);
          if (heard) return;
          // A merchant page that cuts its link to the page that opened it (Cross-Origin-Opener-Policy) makes the window LOOK closed to us a moment
          // after it loads. A window that "closes" right after the merchant's page was given to it is therefore not taken as the customer
          // shutting it: it is no longer watched, and the order is followed by the return page's report, by the page's polling, and by what the
          // merchant reports about its own window (the customer's interactions and the end of its window: /api/merchant-window-interaction and
          // /api/merchant-window-closed), with the server's idle time behind them.
          if (navAt && Date.now() - navAt < DETACH_MS) return;
          // Closed for real without the return page having reported: the customer shut the window. The server makes that a cancellation,
          // unless a success claim or a cancellation is already on record (it ignores a later "closed" then).
          report('closed');
        }
      }, WATCH_MS);

      call(orderId, { action: 'open' }).then(function (answer) {
        if (done) return;
        if (!answer || answer.ok === false || !answer.url) {
          cleanup();
          try { win.close(); } catch (_) {}
          if (answer && answer.state === 'cancelled') { done = true; if (current === handle) current = null; onState(answer); return; }
          done = true;
          if (current === handle) current = null;
          onError(answer && answer.error || 'network');
          return;
        }
        if (/^https:\/\//i.test(answer.url)) { navAt = Date.now(); try { win.location.href = answer.url; } catch (_) { /* the closing watch reports it */ } }
        else { cleanup(); try { win.close(); } catch (_) {} done = true; if (current === handle) current = null; onError('window_unavailable'); }
      });
    };
    current = handle;
    return handle;
  }

  function open(options) {
    var onError = (options && options.onError) || function () {};
    var handle = reserve(options);
    if (!handle) { onError('popup_blocked'); return { close: function () {} }; }
    handle.follow(options);
    return handle;
  }

  window.ElanPay = { reserve: reserve, open: open, token: token, call: call };
})();
