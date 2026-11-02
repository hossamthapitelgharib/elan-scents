/* Élan Scents — the "are you a person" check (Cloudflare Turnstile) in front of the account forms.
   Once CAPTCHA protection is switched on in the Supabase Auth settings, Supabase refuses sign-up, sign-in and password-reset requests that
   arrive without a Turnstile token. This file gets that token in the visitor's own browser and does nothing else: Cloudflare's widget solves
   the check (it shows a box inside the form only when Cloudflare wants a tick, usually nothing appears), and each token works once, so every
   request asks for a fresh one.
   The public site key comes from /api/config (turnstile_site_key). Without a key the shop has no check: token() answers '' at once and the
   forms work exactly as before, which is also how the forms behave while the Supabase switch is still off.

   window.ElanTurnstile = {
     token(container)  -> Promise<string>   the token for a request made from `container` (a form or any element); '' when there is no key;
                                            rejects with an Error whose message is Arabic text for the visitor and whose .code is
                                            captcha_unavailable | captcha_timeout | captcha_failed
     warm(container)   start solving early (the form was just opened) so the token is ready when the visitor presses the button
     body(object, tk)  puts the token where Supabase Auth reads it (gotrue_meta_security.captcha_token) and returns the object
     messages          the Arabic sentences by code (captcha_failed is also what Supabase answers when it refuses a token)
   } */
(function () {
  'use strict';
  var API = 'https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit';
  var LOAD_MS = 10000;    // the Cloudflare script must arrive within this long
  var SOLVE_MS = 120000;  // a visitor who has to tick the box gets two minutes
  var KEEP_MS = 240000;   // a token lives five minutes: one that is older than four is thrown away and asked for again
  var WATCHED = 'form[data-auth-form], #loginForm, #authForm, #resetForm';

  var MESSAGES = {
    captcha_unavailable: 'تعذر تحميل التحقق الأمني. تأكد من الاتصال أو عطّل مانع الإعلانات ثم حاول مرة أخرى.',
    captcha_timeout: 'انتهت مهلة التحقق الأمني. حاول مرة أخرى.',
    captcha_failed: 'لم يكتمل التحقق الأمني. حاول مرة أخرى.'
  };
  function fail(code) { var e = new Error(MESSAGES[code] || MESSAGES.captcha_failed); e.code = code; return e; }

  var keyPromise = null;
  var apiPromise = null;
  var pending = typeof WeakMap === 'function' ? new WeakMap() : null;

  /* The public site key. A missing key is a real answer (the shop has no check) and is remembered; a network failure is not, so the next try asks again. */
  function siteKey() {
    if (!keyPromise) {
      keyPromise = fetch('/api/config')
        .then(function (r) { return r.ok ? r.json() : {}; })
        .then(function (c) { var k = c && c.turnstile_site_key; return typeof k === 'string' ? k.trim() : ''; })
        .catch(function () { keyPromise = null; return ''; });
    }
    return keyPromise;
  }

  /* Cloudflare's script, loaded once and only when a key exists. */
  function loadApi() {
    if (window.turnstile && typeof window.turnstile.render === 'function') return Promise.resolve(window.turnstile);
    if (!apiPromise) {
      apiPromise = new Promise(function (resolve, reject) {
        var script = document.createElement('script');
        var settled = false;
        var timer = setTimeout(function () { finish(fail('captcha_unavailable')); }, LOAD_MS);
        function finish(error, api) {
          if (settled) return;
          settled = true;
          clearTimeout(timer);
          if (error) {
            apiPromise = null;
            if (script.parentNode) script.parentNode.removeChild(script);
            reject(error);
          } else {
            resolve(api);
          }
        }
        script.src = API;
        script.async = true;
        script.onload = function () {
          var api = window.turnstile;
          // The explicit-render script is ready as soon as it loads and exposes render().
          // Waiting for turnstile.ready() here can hang forever on blocked/partial browser loads.
          if (!api || typeof api.render !== 'function') { finish(fail('captcha_unavailable')); return; }
          finish(null, api);
        };
        script.onerror = function () { finish(fail('captcha_unavailable')); };
        document.head.appendChild(script);
      });
    }
    return apiPromise;
  }

  function discard(container, entry) {
    if (pending && pending.get(container) === entry) pending.delete(container);
    try { if (entry.widget != null && window.turnstile && window.turnstile.remove) window.turnstile.remove(entry.widget); } catch (_) { /* already gone */ }
    if (entry.holder && entry.holder.parentNode) entry.holder.parentNode.removeChild(entry.holder);
    entry.widget = null; entry.holder = null;
  }

  function solve(entry, container, key, api) {
    return new Promise(function (resolve, reject) {
      var finished = false;
      function end(fn, value) { if (finished) return; finished = true; clearTimeout(timer); fn(value); }
      var timer = setTimeout(function () { end(reject, fail('captcha_timeout')); }, SOLVE_MS);
      var holder = document.createElement('div');
      holder.className = 'elan-turnstile';
      container.appendChild(holder);
      entry.holder = holder;
      try {
        entry.widget = api.render(holder, {
          sitekey: key,
          appearance: 'interaction-only',  // nothing is drawn unless Cloudflare needs the visitor to tick the box
          theme: 'light',
          callback: function (token) { end(resolve, String(token || '')); },
          'error-callback': function () { end(reject, fail('captcha_failed')); return true; },
          'timeout-callback': function () { end(reject, fail('captcha_timeout')); }
        });
      } catch (_) { end(reject, fail('captcha_unavailable')); }
    });
  }

  function start(container) {
    var entry = { at: Date.now(), widget: null, holder: null, promise: null };
    entry.promise = siteKey().then(function (key) {
      if (!key) return '';
      return loadApi().then(function (api) { return solve(entry, container, key, api); });
    });
    // A token that was asked for early and never used must not surface as an unhandled rejection.
    entry.promise.catch(function () { discard(container, entry); });
    if (pending) pending.set(container, entry);
    return entry;
  }

  function fresh(container) {
    var entry = pending && pending.get(container);
    if (entry && Date.now() - entry.at > KEEP_MS) { discard(container, entry); entry = null; }
    return entry;
  }

  function token(container) {
    var entry = fresh(container) || start(container);
    return entry.promise.then(
      function (value) { discard(container, entry); return value; },   // single use: the next request solves again
      function (error) { discard(container, entry); throw error; }
    );
  }

  function warm(container) {
    if (!fresh(container)) start(container);
  }

  function body(object, tk) {
    if (tk) object.gotrue_meta_security = { captcha_token: tk };
    return object;
  }

  // Start solving as soon as the visitor touches one of the account forms.
  document.addEventListener('focusin', function (event) {
    var target = event.target;
    var form = target && target.closest ? target.closest(WATCHED) : null;
    if (form) warm(form);
  });

  window.ElanTurnstile = { token: token, warm: warm, body: body, messages: MESSAGES };
})();
