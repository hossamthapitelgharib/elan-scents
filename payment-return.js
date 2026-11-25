/* Élan Scents: where the merchant's payment windows send the customer back (docs/purchase-flow-final.ar.md, step 6).
   The address carries only the order (o) and what the customer did in the window (r):
     success  the customer's claim that the payment went through (recorded as a claim: only a neutral confirmation makes an order paid)
     cancel   the customer cancelled in the merchant's window or the provider's
     closed   the window was shut
     failed   the provider could not take the payment (nothing is reported: the truth comes from the provider's own confirmation, and the order
              stays open for another try)
   cancel and closed cancel the order at once (the products stay in the cart). The page reports it from the customer's own signed-in browser, then
   tells the page that opened the window, by postMessage while that link exists and on a BroadcastChannel when the merchant's page cut it
   (Cross-Origin-Opener-Policy), and closes itself. It never leaves the customer stranded: whatever happens it shows a link back to Élan Scents
   and one to «طلباتي». If reporting fails it stays open and retries, because closing the window without a report would be read as the customer
   shutting it. */
(function () {
  'use strict';
  var UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
  var RESULTS = { success: 'success', cancel: 'cancel', closed: 'closed', failed: 'failed' };
  var params = new URLSearchParams(location.search);
  var orderId = String(params.get('o') || '');
  var result = String(params.get('r') || '');
  var title = document.getElementById('prTitle');
  var text = document.getElementById('prText');
  var spin = document.getElementById('prSpin');
  var retry = document.getElementById('prRetry');
  var home = document.getElementById('prHome');
  var orders = document.getElementById('prOrders');

  function say(head, body, opts) {
    title.textContent = head; text.textContent = body;
    spin.hidden = !(opts && opts.busy);
    retry.hidden = !(opts && opts.retry);
    var links = !!(opts && opts.links);
    home.hidden = !links; orders.hidden = !links;
  }
  function token() { try { var s = JSON.parse(localStorage.getItem('elan_auth_session') || 'null'); return s && s.access_token || ''; } catch (_) { return ''; } }
  function wait(ms) { return new Promise(function (resolve) { setTimeout(resolve, ms); }); }

  function report(outcome) {
    return fetch('/api/customer-order-window', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + token() },
      body: JSON.stringify({ orderId: orderId, action: 'return', outcome: outcome })
    }).then(function (r) { return r.json().catch(function () { return null; }).then(function (b) { return { status: r.status, body: b }; }); })
      .catch(function () { return { status: 0, body: null }; });
  }

  /* Tells the Élan page that opened this window (or any Élan page of this browser following this order) that the customer is back. */
  function tellOpener(outcome) {
    var message = { elan: 'pay-return', orderId: orderId, outcome: outcome };
    try { if (window.opener && !window.opener.closed) window.opener.postMessage(message, location.origin); } catch (_) { /* the broadcast below still goes out */ }
    try {
      if (typeof BroadcastChannel === 'function') { var channel = new BroadcastChannel('elan-pay-return'); channel.postMessage(message); setTimeout(function () { try { channel.close(); } catch (_) {} }, 1500); }
    } catch (_) { /* the page watches the order by polling as well */ }
  }

  var COPY = {
    success: { head: 'تم استلام عودتك من نافذة المتجر', body: 'نتحقق من إتمام الدفع ونعيدك إلى Élan Scents…', done: 'عدت إلى Élan Scents. يؤكد مزود الدفع أو المتجر طلبك ونُعلمك به في «طلباتي».' },
    cancel: { head: 'تم إلغاء المعاملة برغبة العميل', body: 'منتجاتك ما زالت في سلتك. نعيدك إلى Élan Scents…', done: 'منتجاتك ما زالت في سلتك ويمكنك طلبها مرة أخرى.' },
    closed: { head: 'تم إلغاء المعاملة برغبة العميل', body: 'منتجاتك ما زالت في سلتك. نعيدك إلى Élan Scents…', done: 'منتجاتك ما زالت في سلتك ويمكنك طلبها مرة أخرى.' },
    failed: { head: 'لم تكتمل عملية الدفع', body: 'يمكنك فتح نافذة الدفع مرة أخرى وتجربة وسيلة أخرى. نعيدك إلى Élan Scents…', done: 'لم تكتمل عملية الدفع. عد إلى صفحة طلبك في Élan Scents لتجربة وسيلة أخرى.' }
  };

  async function run() {
    var outcome = RESULTS[result];
    if (!UUID.test(orderId) || !outcome) {
      say('تعذر قراءة رابط العودة', 'يمكنك العودة إلى Élan Scents ومتابعة طلبك من «طلباتي».', { links: true });
      return;
    }
    var copy = COPY[outcome];
    // A failed payment is not reported to anyone: the order is not cancelled and nothing is decided here. The page only tells the Élan page to read it again.
    if (outcome !== 'failed') {
      if (!token()) { say('سجّل الدخول أولًا', 'افتح Élan Scents وسجّل الدخول ثم تابع طلبك من «طلباتي».', { links: true }); return; }
      say(copy.head, copy.body, { busy: true });
      var answer = null;
      for (var attempt = 0; attempt < 3; attempt += 1) {
        answer = await report(outcome);
        // 2xx: recorded. 409: the order is already past this step (for example cancelled or already claimed), which is a final answer too.
        if (answer.status === 200 || answer.status === 409 || answer.status === 404) break;
        await wait(1200 * (attempt + 1));
      }
      if (!answer || (answer.status !== 200 && answer.status !== 409 && answer.status !== 404)) {
        say('تعذر تسجيل عودتك الآن', 'اتصالك بالموقع ضعيف. اضغط إعادة المحاولة ولا تغلق هذه النافذة.', { retry: true });
        return;
      }
    } else {
      say(copy.head, copy.body, { busy: true });
    }
    tellOpener(outcome);
    say(copy.head, copy.done, { links: true });
    try { window.close(); } catch (_) { /* the links stay */ }
  }

  retry.addEventListener('click', function () { say('جارٍ إعادة المحاولة…', 'لحظات.', { busy: true }); run(); });
  run();
})();
