(function () {
  'use strict';
  /* A recovery link that lands on the login page (the project's redirect list sends it here) goes on to the reset page, token and all. */
  if (/[#&]type=recovery(&|$)/.test(location.hash) && /access_token=/.test(location.hash)) { location.replace('/editor-reset' + location.hash); return; }
  var msg = document.getElementById('msg');
  var ERR = {
    invalid_credentials: 'البريد أو كلمة السر غلط.', forbidden: 'الحساب ده مش مسموح له بالإديتور.',
    role_check_failed: 'تعذر التحقق من صلاحية الحساب بعد تسجيل الدخول. جرّبي تاني.',
    too_many_attempts: 'محاولات كتير. استني شوية وجرّبي تاني.', supabase_service_configuration_missing: 'إعدادات سابابيس ناقصة على Cloudflare.',
    auth_unreachable: 'مفيش اتصال بسابابيس، جرّبي تاني.'
  };
  function say(t, bad) { msg.textContent = t; msg.className = 'msg' + (bad ? ' err' : ''); }
  async function go() {
    say('جاري الدخول...');
    try {
      var r = await fetch('/api/editor-login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ email: document.getElementById('email').value, password: document.getElementById('pass').value }) });
      var j = await r.json().catch(function () { return {}; });
      document.getElementById('pass').value = '';
      if (r.ok && j.ok) { location.replace('/editor'); return; }
      say(ERR[j.error] || 'حصلت مشكلة، جرّبي تاني.', true);
    } catch (_) { say('مفيش اتصال، جرّبي تاني.', true); }
  }
  /* Forgotten password: the same box asks for the email; the answer is always the same, so it never says whether the account exists. */
  var forgotBox = document.getElementById('forgotBox'), forgotMsg = document.getElementById('forgotMsg'), loginBox = [document.getElementById('loginBtn'), document.getElementById('msg')];
  function sayForgot(t, bad) { forgotMsg.textContent = t; forgotMsg.className = 'msg' + (bad ? ' err' : ' ok'); }
  function showForgot(on) {
    forgotBox.hidden = !on;
    Array.prototype.forEach.call(document.querySelectorAll('main > label, main > .aside, #loginBtn, #msg, main > h2'), function (n) { n.hidden = on; });
    forgotBox.querySelectorAll('.aside').forEach(function (n) { n.hidden = false; });
    if (on) { document.getElementById('forgotEmail').value = document.getElementById('email').value; document.getElementById('forgotEmail').focus(); }
  }
  var FORGOT_ERR = { invalid_request: 'اكتب البريد بشكل صحيح.', too_many_attempts: 'محاولات كتير. استنى شوية وجرّب تاني.', supabase_service_configuration_missing: 'إعدادات سابابيس ناقصة على Cloudflare.', auth_unreachable: 'مفيش اتصال بسابابيس، جرّب تاني.' };
  async function forgot() {
    var email = document.getElementById('forgotEmail').value.trim();
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) { sayForgot('اكتب البريد بشكل صحيح.', true); return; }
    var button = document.getElementById('forgotBtn');
    button.disabled = true; sayForgot('جاري الإرسال...');
    try {
      var r = await fetch('/api/editor-forgot-password', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ email: email }) });
      var j = await r.json().catch(function () { return {}; });
      if (r.ok && j.ok) sayForgot('لو فيه حساب بالبريد ده هيوصلك دلوقتي رابط مؤقت. افتحه من نفس الجهاز، وراجع الرسائل غير المهمة (Spam) لو ما ظهرش.');
      else sayForgot(FORGOT_ERR[j.error] || 'حصلت مشكلة، جرّب تاني.', true);
    } catch (_) { sayForgot('مفيش اتصال، جرّب تاني.', true); }
    button.disabled = false;
  }
  document.getElementById('forgotLink').addEventListener('click', function (e) { e.preventDefault(); showForgot(true); });
  document.getElementById('forgotBack').addEventListener('click', function (e) { e.preventDefault(); showForgot(false); });
  document.getElementById('forgotBtn').addEventListener('click', forgot);
  document.getElementById('forgotEmail').addEventListener('keydown', function (e) { if (e.key === 'Enter') forgot(); });
  document.getElementById('loginBtn').addEventListener('click', go);
  document.getElementById('pass').addEventListener('keydown', function (e) { if (e.key === 'Enter') go(); });
})();
