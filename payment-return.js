/* Élan Scents: where the merchant's payment window sends the customer back (docs/purchase-flow-final.ar.md, step 6).
   The address carries only the order (o) and what the customer did in the window (r = success | cancel). Nothing here proves a payment:
   "success" is only the customer's claim, recorded as such; a neutral confirmation is what makes an order paid. Cancel cancels the order
   (the products stay in the cart). The page reports it from the customer's own signed-in browser, tells the page that opened the window
   (same origin) and closes itself; if it cannot close, it shows a link to «طلباتي». If reporting fails it stays open and retries, because
   closing the window without a report would be read as the customer shutting it. */
(function () {
  'use strict';
  var UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
  var params = new URLSearchParams(location.search);
  var orderId = String(params.get('o') || '');
  var result = String(params.get('r') || '');
  var title = document.getElementById('prTitle');
  var text = document.getElementById('prText');
  var spin = document.getElementById('prSpin');
  var retry = document.getElementById('prRetry');
  var orders = document.getElementById('prOrders');

  function say(head, body, opts) {
    title.textContent = head; text.textContent = body;
    spin.hidden = !(opts && opts.busy);
    retry.hidden = !(opts && opts.retry);
    orders.hidden = !(opts && opts.orders);
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

  async function run() {
    if (!UUID.test(orderId) || (result !== 'success' && result !== 'cancel')) {
      say('تعذر قراءة رابط العودة', 'يمكنك متابعة طلبك من «طلباتي».', { orders: true });
      return;
    }
    if (!token()) { say('سجّل الدخول أولًا', 'افتح Élan Scents وسجّل الدخول ثم تابع طلبك من «طلباتي».', { orders: true }); return; }
    var outcome = result === 'success' ? 'success' : 'cancel';
    say(outcome === 'success' ? 'تم استلام عودتك من نافذة المتجر' : 'تم إلغاء الدفع',
      outcome === 'success' ? 'نتحقق من إتمام الدفع ونعيدك إلى Élan Scents…' : 'سيُلغى الطلب وتبقى منتجاتك في سلتك. نعيدك إلى Élan Scents…', { busy: true });
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
    if (window.opener && !window.opener.closed) {
      try { window.opener.postMessage({ elan: 'pay-return', orderId: orderId, outcome: outcome }, location.origin); } catch (_) { /* the opener watches the window anyway */ }
      say('تمت العودة إلى Élan Scents', 'يمكنك إغلاق هذه النافذة.', { orders: true });
      try { window.close(); } catch (_) { /* the link below stays */ }
      return;
    }
    say('تمت العودة', 'تابع حالة طلبك من «طلباتي».', { orders: true });
  }

  retry.addEventListener('click', function () { say('جارٍ إعادة المحاولة…', 'لحظات.', { busy: true }); run(); });
  run();
})();
