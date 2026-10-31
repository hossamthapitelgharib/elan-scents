(function () {
  'use strict';
  /* The emailed recovery link brings the owner here with a short-lived token in the address after the "#" (it never reaches a server by itself).
     The token is read once, taken out of the address bar and the browser history, kept only in this page's memory, and sent with the new
     password to /api/editor-reset-password. It is never stored. */
  var MIN = 10;
  var state = document.getElementById('state'), box = document.getElementById('resetBox'), button = document.getElementById('resetBtn');
  var ERR = {
    invalid_or_expired_link: 'الرابط منتهي أو اتستخدم قبل كده. اطلب رابط جديد من صفحة الدخول.',
    weak_password: 'كلمة السر ضعيفة. استخدم ' + MIN + ' حروف أو أكتر.',
    same_password: 'ده نفس كلمة السر القديمة. اختار كلمة سر مختلفة.',
    too_many_attempts: 'محاولات كتير. استنى شوية وجرّب تاني.',
    invalid_request: 'البيانات مش مظبوطة، جرّب تاني.',
    supabase_service_configuration_missing: 'إعدادات سابابيس ناقصة على Cloudflare.',
    auth_unreachable: 'مفيش اتصال بسابابيس، جرّب تاني.',
    reset_failed: 'تعذر تغيير كلمة السر. جرّب تاني أو اطلب رابط جديد.'
  };
  function say(text, kind) { state.textContent = text; state.className = 'msg' + (kind ? ' ' + kind : ''); }

  var token = '';
  var params = new URLSearchParams(String(location.hash || '').replace(/^#/, ''));
  if (location.hash) { try { history.replaceState(null, '', location.pathname); } catch (_) { /* the address stays, the token is already in memory */ } }
  if (params.get('error') || params.get('error_code')) {
    say(ERR.invalid_or_expired_link, 'err');
  } else if (params.get('type') === 'recovery' && params.get('access_token')) {
    token = params.get('access_token');
    say('اختار كلمة السر الجديدة.');
    box.hidden = false;
  } else {
    say('الصفحة دي بتتفتح من الرابط اللي بيوصلك على البريد بعد «نسيت كلمة السر». اطلب الرابط من صفحة الدخول.');
  }

  async function save() {
    var a = document.getElementById('newPass'), b = document.getElementById('newPass2');
    if (a.value.length < MIN) { say(ERR.weak_password, 'err'); return; }
    if (a.value !== b.value) { say('كلمتين السر مش زي بعض.', 'err'); return; }
    button.disabled = true; say('جاري الحفظ...');
    try {
      var r = await fetch('/api/editor-reset-password', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ accessToken: token, password: a.value }) });
      var j = await r.json().catch(function () { return {}; });
      a.value = ''; b.value = '';
      if (r.ok && j.ok) {
        token = ''; box.hidden = true;
        say('تم تغيير كلمة السر. ادخل بالكلمة الجديدة.', 'ok');
        document.getElementById('backLink').textContent = 'دخول بكلمة السر الجديدة';
        return;
      }
      say(ERR[j.error] || 'حصلت مشكلة، جرّب تاني.', 'err');
    } catch (_) { say('مفيش اتصال، جرّب تاني.', 'err'); }
    button.disabled = false;
  }
  button.addEventListener('click', save);
  document.getElementById('newPass2').addEventListener('keydown', function (e) { if (e.key === 'Enter') save(); });
})();
