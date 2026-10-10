(function () {
  'use strict';
  var msg = document.getElementById('msg');
  var ERR = {
    invalid_credentials: 'البريد أو كلمة السر غلط.', forbidden: 'الحساب ده مش مسموح له بالإديتور.',
    too_many_attempts: 'محاولات كتير. استني شوية وجرّبي تاني.', supabase_service_configuration_missing: 'إعدادات سابابيس ناقصة على Railway.',
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
  document.getElementById('loginBtn').addEventListener('click', go);
  document.getElementById('pass').addEventListener('keydown', function (e) { if (e.key === 'Enter') go(); });
})();
