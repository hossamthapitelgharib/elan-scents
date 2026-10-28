(function () {
  'use strict';

  var IS_EDITOR_PREVIEW = false;
  try {
    IS_EDITOR_PREVIEW = !!window.parent && window.parent !== window &&
      new URLSearchParams(window.location.search).get('elan_editor') === '1';
  } catch (_) {}
  window.ELAN_EDITOR_PREVIEW = IS_EDITOR_PREVIEW;
  if (IS_EDITOR_PREVIEW) {
    var noWrite = function () { return Promise.resolve({ ok: true, preview: true, tracked: false, cart: [] }); };
    window.GuestIdentity = {
      enabled: function () { return false; },
      resolve: noWrite, save: noWrite, claim: noWrite, track: noWrite, identify: noWrite, finalVisitorId: function () { return null; },
      sessionId: function () { return null; }, startSession: noWrite
    };
    ['click', 'auxclick', 'submit', 'contextmenu', 'dragstart'].forEach(function (type) {
      document.addEventListener(type, function (event) {
        var target = event.target && (event.target.nodeType === 1 ? event.target : event.target.parentElement);
        if (target && target.closest && target.closest('#elan-eo-root')) return;
        event.preventDefault();
        event.stopPropagation();
      }, true);
    });
    return;
  }

  // Device signals run only with the visitor's consent (consent.js). Without it every call is a harmless no-op,
  // nothing is stored in the browser and nothing is sent. A missing consent script counts as "no".
  var STORAGE_KEY = 'elan_guest_browser_key_v2';
  var VISIT_KEY = 'elan_visit_v1';
  var COOKIE_NAME = 'elan_vk';

  function inertApi() {
    var inert = function () { return Promise.resolve({ ok: true, tracked: false, cart: [] }); };
    return {
      enabled: function () { return false; },
      resolve: inert, save: inert, claim: inert, track: inert, search: inert, identify: inert, startFresh: inert,
      finalVisitorId: function () { return null; }, sessionId: function () { return null; }, startSession: inert, prepareLogout: inert
    };
  }

  var AUTOMATED = false;
  try { AUTOMATED = typeof navigator !== 'undefined' && navigator.webdriver === true; } catch (_) {}
  if (AUTOMATED) {
    window.GuestIdentity = inertApi();
    return;
  }

  var consent = window.ElanConsent;
  var booted = false;
  function allowed() {
    try { return !!(consent && consent.analytics() === true); } catch (_) { return false; }
  }
  function wipeLocal() {
    try { localStorage.removeItem(STORAGE_KEY); } catch (_) {}
    try { localStorage.removeItem(VISIT_KEY); } catch (_) {}
    try { document.cookie = COOKIE_NAME + '=; max-age=0; path=/; SameSite=Lax'; } catch (_) {}
  }
  // The server cookie is HttpOnly, so only the server can expire it.
  function forgetOnServer() {
    try {
      fetch('/api/guest-cart', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ action: 'forget' }), keepalive: true }).catch(function () {});
    } catch (_) {}
  }

  function boot() {
    if (booted) return;
    booted = true;

    var UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
    var cachedKey = null;
    var identification = null;
    var saveQueue = Promise.resolve();
    var cachedSessionId = null;
    var sessionStarted = false;
    var startingSession = null;

    function savedSession() {
      try { return JSON.parse(localStorage.getItem('elan_auth_session') || 'null'); }
      catch (_) { return null; }
    }

    function accessToken() {
      var session = savedSession();
      return session && session.access_token || '';
    }

    function createKey() {
      var cryptoApi = window.crypto;
      if (cryptoApi && typeof cryptoApi.randomUUID === 'function') return cryptoApi.randomUUID();
      var bytes = new Uint8Array(16);
      if (cryptoApi && typeof cryptoApi.getRandomValues === 'function') cryptoApi.getRandomValues(bytes);
      else for (var i = 0; i < bytes.length; i++) bytes[i] = Math.floor(Math.random() * 256);
      bytes[6] = (bytes[6] & 15) | 64;
      bytes[8] = (bytes[8] & 63) | 128;
      var hex = Array.from(bytes, function (byte) { return byte.toString(16).padStart(2, '0'); }).join('');
      return hex.slice(0, 8) + '-' + hex.slice(8, 12) + '-' + hex.slice(12, 16) + '-' + hex.slice(16, 20) + '-' + hex.slice(20);
    }

    var VISIT_IDLE_MS = 30 * 60 * 1000;       // a new visit starts only after 30 quiet minutes
    var lastStartedVisit = null;
    var recentViews = {};
    var ACTIVE_MS = 30000;                    // time counts only while the person is really using the page
    var lastInteraction = 0;
    function recentlyActive() { return Date.now() - lastInteraction < ACTIVE_MS; }
    function interacted() {
      if (!allowed()) return;
      var now = Date.now(), wasIdle = now - lastInteraction >= ACTIVE_MS;
      if (lastInteraction) behaviorStats.activeMs += Math.min(now - lastInteraction, 5000);
      behaviorStats.interactions += 1;
      lastInteraction = now;
      if (behaviorStats.activeMs >= 5000 && behaviorStats.interactions >= 1 && identifiedFor !== sessionId(false)) identify();
      if (wasIdle && sessionStarted) sendSession('resume').catch(function () {});
    }

    function readCookie() {
      try {
        var m = document.cookie.match(new RegExp('(?:^|; )' + COOKIE_NAME + '=([^;]+)'));
        return m && UUID.test(m[1]) ? m[1] : null;
      } catch (_) { return null; }
    }
    function writeCookie(value) {
      try { document.cookie = COOKIE_NAME + '=' + value + '; max-age=34560000; path=/; SameSite=Lax' + (window.location && window.location.protocol === 'https:' ? '; Secure' : ''); } catch (_) {}
    }
    function readStoredKey() {
      try { var v = localStorage.getItem(STORAGE_KEY); if (v && UUID.test(v)) return v; } catch (_) {}
      return readCookie();
    }

    // One browser = one key. Storage is tried first, then a cookie, so a blocked storage area
    // does not turn every page load into a new visitor. After writing we read back and adopt
    // whatever won, so two tabs opened together on a first visit end up with the same key.
    function visitorKey() {
      var stored = readStoredKey();
      if (stored) { cachedKey = stored; return stored; }
      if (cachedKey) return cachedKey;
      var fresh = createKey();
      try { localStorage.setItem(STORAGE_KEY, fresh); } catch (_) {}
      writeCookie(fresh);
      cachedKey = readStoredKey() || fresh;
      return cachedKey;
    }

    // A visit is shared by every tab of the same browser and rolls over after 30 idle minutes.
    function sessionId(touch) {
      var now = Date.now(), rec = null;
      try { rec = JSON.parse(localStorage.getItem(VISIT_KEY) || 'null'); } catch (_) {}
      if (!rec || !UUID.test(rec.id || '') || !(now - rec.last < VISIT_IDLE_MS)) {
        if (!touch && cachedSessionId) return cachedSessionId;
        rec = { id: createKey(), last: now };
        try { localStorage.setItem(VISIT_KEY, JSON.stringify(rec)); } catch (_) {}
        try { var again = JSON.parse(localStorage.getItem(VISIT_KEY) || 'null'); if (again && UUID.test(again.id || '')) rec = again; } catch (_) {}
      } else if (touch) {
        rec.last = now;
        try { localStorage.setItem(VISIT_KEY, JSON.stringify(rec)); } catch (_) {}
      }
      cachedSessionId = rec.id;
      return rec.id;
    }


    /* ---------- device signals (for counting people, never for moving baskets) ---------- */
    var behaviorStats = { interactions: 0, activeMs: 0, pages: 1 };
    var identifiedFor = null, identifying = null, identifyAttempts = {}, finalVisitorId = null, lastCartSig = '', fingerprintPromise = null;

    function smallHash(str) {                 // cyrb53: fast, well spread, 14 hex characters
      var h1 = 0xdeadbeef, h2 = 0x41c6ce57;
      for (var i = 0; i < str.length; i++) {
        var ch = str.charCodeAt(i);
        h1 = Math.imul(h1 ^ ch, 2654435761); h2 = Math.imul(h2 ^ ch, 1597334677);
      }
      h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^ Math.imul(h2 ^ (h2 >>> 13), 3266489909);
      h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^ Math.imul(h1 ^ (h1 >>> 13), 3266489909);
      return ('00000000000000' + (4294967296 * (2097151 & h2) + (h1 >>> 0)).toString(16)).slice(-14);
    }

    function osFamily() {
      var raw = '';
      try { raw = String((navigator.userAgentData && navigator.userAgentData.platform) || navigator.platform || '').toLowerCase(); } catch (_) {}
      if (/iphone|ipad|ipod|ios/.test(raw)) return 'ios';
      if (/android/.test(raw)) return 'android';
      if (/win/.test(raw)) return 'win';
      if (/mac/.test(raw)) return 'mac';
      if (/linux|x11|cros/.test(raw)) return 'linux';
      return raw ? smallHash(raw) : '';
    }

    function gpuName() {
      try {
        var canvas = document.createElement('canvas');
        var gl = canvas.getContext('webgl') || canvas.getContext('experimental-webgl');
        if (!gl) return '';
        var ext = gl.getExtension('WEBGL_debug_renderer_info');
        return ext ? String(gl.getParameter(ext.UNMASKED_RENDERER_WEBGL) || '') : '';
      } catch (_) { return ''; }
    }

    function canvasSignature() {
      try {
        var c = document.createElement('canvas'); c.width = 200; c.height = 40;
        var x = c.getContext('2d'); if (!x) return '';
        x.textBaseline = 'top'; x.font = '16px Arial'; x.fillStyle = '#c8962a'; x.fillRect(4, 4, 80, 20);
        x.fillStyle = '#222'; x.fillText('Élan Scents 123 عطر', 8, 8);
        return c.toDataURL();
      } catch (_) { return ''; }
    }

    function fontsSignature() {
      try {
        var list = ['Arial', 'Verdana', 'Times New Roman', 'Courier New', 'Georgia', 'Tahoma', 'Trebuchet MS', 'Impact', 'Segoe UI', 'Helvetica', 'Roboto', 'Menlo', 'Noto Sans Arabic', 'IBM Plex Sans Arabic'];
        var span = document.createElement('span');
        span.style.cssText = 'position:absolute;left:-9999px;top:-9999px;font-size:72px;visibility:hidden';
        span.textContent = 'mmmmmmmmmmlliWWعطر';
        document.body.appendChild(span);
        span.style.fontFamily = 'monospace'; var base = span.offsetWidth;
        var found = list.filter(function (name) { span.style.fontFamily = '"' + name + '",monospace'; return span.offsetWidth !== base; });
        document.body.removeChild(span);
        return found.join(',');
      } catch (_) { return ''; }
    }

    function collectParts() {
      var parts = {}, put = function (key, value) { if (value) parts[key] = smallHash(String(value)); };
      try { var w = Math.max(screen.width, screen.height), h = Math.min(screen.width, screen.height); put('screen', w + 'x' + h + 'x' + screen.colorDepth); } catch (_) {}
      try { put('tz', Intl.DateTimeFormat().resolvedOptions().timeZone); } catch (_) {}
      try { put('hw', navigator.hardwareConcurrency); } catch (_) {}
      try { put('lang', String(navigator.language || '').split('-')[0].toLowerCase()); } catch (_) {}
      put('platform', osFamily());
      put('gpu', gpuName());
      put('canvas', canvasSignature());
      put('fonts', fontsSignature());
      return parts;
    }

    // ThumbmarkJS is used when its official build is present at /vendor/thumbmark.js. Without it,
    // the built-in signals above produce the overall fingerprint.
    function loadThumbmark() {
      if (window.ThumbmarkJS || window.Thumbmark) return Promise.resolve(true);
      return new Promise(function (done) {
        var settled = false;
        var timer = setTimeout(function () { finish(false); }, 3000);
        function finish(ok) {
          if (settled) return;
          settled = true;
          if (typeof clearTimeout === 'function') clearTimeout(timer);
          done(ok);
        }
        try {
          var el = document.createElement('script');
          el.async = true;
          el.src = '/vendor/thumbmark.js';
          el.onload = function () { finish(!!(window.ThumbmarkJS || window.Thumbmark)); };
          el.onerror = function () { finish(false); };
          document.head.appendChild(el);
        } catch (_) { finish(false); }
      });
    }
    // ThumbmarkJS 0.20+ is used as new ThumbmarkJS.Thumbmark(options).get(); older builds expose
    // getFingerprint(). Both work. Its sampled usage logging is switched off, so nothing about a
    // visitor is sent to a third party.
    function runThumbmark(lib) {
      var Ctor = typeof lib.Thumbmark === 'function' ? lib.Thumbmark : (typeof lib === 'function' ? lib : null);
      if (Ctor) return new Ctor({ logging: false }).get();
      if (typeof lib.getFingerprint === 'function') {
        try { if (typeof lib.setOption === 'function') lib.setOption('logging', false); } catch (_) {}
        return lib.getFingerprint();
      }
      return '';
    }
    function thumbmarkHash() {
      return loadThumbmark().then(function (ok) {
        if (!ok) return '';
        var run = runThumbmark(window.ThumbmarkJS || window.Thumbmark);
        return Promise.resolve(run).then(function (result) {
          var value = result && typeof result === 'object' ? (result.thumbmark || result.hash || JSON.stringify(result)) : result;
          return value ? smallHash(String(value)) + smallHash(String(value) + '#') : '';
        });
      }).catch(function () { return ''; });
    }

    function collectFingerprint() {
      if (!fingerprintPromise) fingerprintPromise = thumbmarkHash().then(function (tm) {
        var parts = collectParts();
        var own = smallHash(Object.keys(parts).sort().map(function (k) { return k + parts[k]; }).join('|'));
        return { fp: tm || (own + smallHash(own + '#')), parts: parts, thumbmark: !!tm };
      });
      return fingerprintPromise;
    }

    function behaviorSnapshot() {
      return { interactions: behaviorStats.interactions, activeSeconds: Math.round(behaviorStats.activeMs / 1000), pages: behaviorStats.pages };
    }

    // One identification per visit, only after the person really used the page (5 active seconds
    // and an interaction), so bots and instant bounces do not create or link anything.
    function identify() {
      if (accessToken()) return Promise.resolve({ ok: true, identified: false });
      var visit = sessionId(false);
      if (identifying) return identifying;
      if (identifiedFor === visit || (identifyAttempts[visit] || 0) >= 3) return Promise.resolve({ ok: true, identified: false });
      identifyAttempts[visit] = (identifyAttempts[visit] || 0) + 1;
      identifying = resolve().then(collectFingerprint).then(function (info) {
        return request('identify', { fp: info.fp, parts: info.parts, behavior: behaviorSnapshot(), cartSig: lastCartSig });
      }).then(function (result) {
        if (result && result.ok) { identifiedFor = visit; if (result.identified) finalVisitorId = result.finalVisitorId || finalVisitorId; }
        return result;
      }).catch(function () { return { ok: false, identified: false }; }).then(function (result) { identifying = null; return result; });
      return identifying;
    }

    async function request(action, data, token) {
      if (!allowed()) throw new Error('consent_required');
      var headers = { 'Content-Type': 'application/json' };
      if (token) headers.Authorization = 'Bearer ' + token;
      var payload = Object.assign({}, data || {}, { action: action, visitorKey: visitorKey() });
      var response = await fetch('/api/guest-cart', { method: 'POST', headers: headers, body: JSON.stringify(payload) });
      var body = await response.json().catch(function () { return {}; });
      if (!response.ok) throw new Error(body.error || 'guest_sync_failed');
      return body;
    }

    function resolve() {
      if (!identification) identification = request('resolve').then(function (body) {
        // the server may have merged this browser into the key it already knew
        if (body && body.visitorKey && UUID.test(body.visitorKey) && body.visitorKey !== visitorKey()) {
          try { localStorage.setItem(STORAGE_KEY, body.visitorKey); } catch (_) {}
          writeCookie(body.visitorKey);
          cachedKey = body.visitorKey;
        }
        return body;
      }).catch(function (error) {
        identification = null;
        throw error;
      });
      return identification;
    }

    function save(items) {
      var snapshot = Array.isArray(items) ? items.map(function (item) {
        return { sid: item.sid, storeProductId: item.storeProductId || null, q: item.q || item.quantity || 1 };
      }) : [];
      lastCartSig = snapshot.length ? smallHash(snapshot.map(function (i) { return i.sid + ':' + i.q; }).sort().join('|')) + smallHash(snapshot.length + '#') : '';
      saveQueue = saveQueue.catch(function () {}).then(function () { return request('save', { items: snapshot }); });
      return saveQueue;
    }

    function sendActivity(action, data, token, keepalive) {
      if (!allowed()) return Promise.reject(new Error('consent_required'));
      var headers = { 'Content-Type': 'application/json' };
      if (token) headers.Authorization = 'Bearer ' + token;
      var payload = Object.assign({}, data || {}, { action: action, sessionId: sessionId(true) });
      if (!token) payload.visitorKey = visitorKey();
      return fetch('/api/customer-activity', {
        method: 'POST', headers: headers, body: JSON.stringify(payload), keepalive: !!keepalive
      }).then(function (response) {
        return response.json().catch(function () { return {}; }).then(function (body) {
          if (!response.ok) throw new Error(body.error || 'activity_unavailable');
          return body;
        });
      });
    }

    function sendSession(action, keepalive) {
      if (!allowed()) return Promise.resolve({ ok: true, tracked: false });
      var token = accessToken();
      if (action === 'resume') {
        // coming back after an idle gap re-opens the visit without adding the idle minutes to its active time
        var reopen = function () { return sendActivity('session', { sessionAction: 'start' }, token || null); };
        return token ? reopen() : resolve().then(reopen);
      }
      if (action === 'heartbeat' && sessionId(true) !== lastStartedVisit) {
        sessionStarted = false;
        return startSession();
      }
      var send = function () { return sendActivity('session', { sessionAction: action }, token, keepalive); };
      return token ? send() : resolve().then(send);
    }

    function startSession(token) {
      if (!allowed()) return Promise.resolve({ ok: true, tracked: false });
      if (sessionStarted && lastStartedVisit === sessionId(false)) return Promise.resolve({ ok: true });
      if (startingSession) return startingSession;
      var authToken = token || accessToken();
      var start = function () {
        return sendActivity('session', { sessionAction: 'start' }, authToken || null).then(function (result) {
          sessionStarted = !!result.tracked;
          lastStartedVisit = sessionStarted ? sessionId(false) : null;
          return result;
        });
      };
      startingSession = authToken ? start() : resolve().then(start);
      startingSession = startingSession.catch(function (error) { sessionStarted = false; throw error; }).finally(function () { startingSession = null; });
      return startingSession;
    }

    function prepareLogout() {
      var token = accessToken();
      var ending = Promise.resolve({ ok: true });
      if (sessionStarted) {
        try { ending = sendActivity('session', { sessionAction: 'end' }, token || null, true); }
        catch (_) { ending = Promise.resolve({ ok: false }); }
      }
      // Rotate immediately, so a slow end request cannot make the next guest reuse
      // a session_id that the database already bound to the authenticated user.
      sessionStarted = false;
      startingSession = null;
      cachedSessionId = null;
      lastStartedVisit = null;
      try { localStorage.removeItem(VISIT_KEY); } catch (_) {}
      return Promise.resolve(ending).catch(function () { return { ok: false }; });
    }

    function clearKey() {
      try { localStorage.removeItem(STORAGE_KEY); } catch (_) {}
      try { document.cookie = COOKIE_NAME + '=; max-age=0; path=/; SameSite=Lax'; } catch (_) {}
      cachedKey = null;
      identification = null;
    }

    // "Not your basket?": a new person on a shared browser starts as a new guest. The previous
    // person's record stays as it was (an abandoned basket); nothing is merged back into it.
    function startFresh() {
      return Promise.resolve(prepareLogout()).then(function () {
        var fresh = createKey();
        try { localStorage.setItem(STORAGE_KEY, fresh); } catch (_) {}
        writeCookie(fresh);
        cachedKey = fresh;
        identification = null;
        recentViews = {};
        identification = request('resolve', { fresh: true }).catch(function (error) { identification = null; throw error; });
        return identification;
      }).then(function (body) { return startSession().catch(function () {}).then(function () { return body; }); });
    }

    function claim(token) {
      return saveQueue.catch(function () {}).then(function () { return request('claim', {}, token); }).then(function (result) {
        if (result && result.ok) clearKey();
        return startSession(token).catch(function () { return result; }).then(function () { return result; });
      });
    }

    function track(eventType, productId, productSizeId, storeProductId, quantity) {
      if (!['view', 'search', 'cart_add', 'cart_remove'].includes(eventType) || !productId) return Promise.resolve({ ok: true, tracked: false });
      if (eventType === 'view') {
        var now = Date.now(), seen = recentViews[productId];
        if (seen && now - seen < 30000) return Promise.resolve({ ok: true, tracked: false });
        recentViews[productId] = now;
      }
      var token = accessToken();
      var data = {
        eventType: eventType,
        productId: String(productId),
        productSizeId: productSizeId ? String(productSizeId) : null,
        storeProductId: storeProductId ? String(storeProductId) : null,
        quantity: quantity == null ? null : Number(quantity)
      };
      var send = function () { return sendActivity('track', data, token || null); };
      return token ? send() : resolve().then(send);
    }

    function search(searchText, products) {
      var token = accessToken();
      var results = (Array.isArray(products) ? products : []).slice(0, 10).map(function (item) {
        return {
          productId: String(item.id || item.productId || ''),
          productSizeId: item.sizeId || item.productSizeId || null,
          storeProductId: item.storeProductId || null
        };
      });
      var data = { searchText: String(searchText || '').trim(), results: results };
      var send = function () { return sendActivity('search', data, token || null); };
      return token ? send() : resolve().then(send);
    }

    window.GuestIdentity = {
      enabled: function () { return true; },
      resolve: resolve,
      save: save,
      claim: claim,
      track: track,
      search: search,
      sessionId: sessionId,
      startSession: startSession,
      prepareLogout: prepareLogout,
      startFresh: startFresh,
      identify: identify,
      finalVisitorId: function () { return finalVisitorId; }
    };

    var session = savedSession();
    if (session && session.access_token) {
      try {
        if (localStorage.getItem(STORAGE_KEY)) setTimeout(function () { claim(session.access_token).catch(function () { startSession(session.access_token).catch(function () {}); }); }, 0);
        else setTimeout(function () { startSession(session.access_token).catch(function () {}); }, 0);
      } catch (_) { setTimeout(function () { startSession(session.access_token).catch(function () {}); }, 0); }
    } else {
      setTimeout(function () { startSession().catch(function () {}); }, 0);
    }

    setInterval(function () {
      if (allowed() && sessionStarted && document.visibilityState !== 'hidden' && recentlyActive()) sendSession('heartbeat').catch(function () {});
    }, 30000);
    window.addEventListener('pagehide', function () {
      if (!allowed() || !sessionStarted || !recentlyActive()) return;
      sendSession('heartbeat', true).catch(function () {});
    });
    window.addEventListener('pageshow', function () {
      if (allowed() && !sessionStarted) startSession().catch(function () {});
    });
    document.addEventListener('visibilitychange', function () {
      if (document.visibilityState === 'visible' && allowed()) {
        if (!sessionStarted || lastStartedVisit !== sessionId(false)) { sessionStarted = false; startSession().catch(function () {}); }
      }
    });
    ['pointerdown', 'keydown', 'touchstart', 'wheel', 'scroll'].forEach(function (type) {
      window.addEventListener(type, interacted, { capture: true, passive: true });
    });
    ['hashchange', 'popstate'].forEach(function (type) {
      window.addEventListener(type, function () { behaviorStats.pages += 1; });
    });
    window.addEventListener('storage', function (e) {
      if (e.key === STORAGE_KEY && e.newValue && UUID.test(e.newValue)) cachedKey = e.newValue;
    });
  }

  window.GuestIdentity = inertApi();
  if (allowed()) boot();
  else if (consent && consent.decided && consent.decided()) wipeLocal();

  if (consent && typeof consent.onChange === 'function') {
    consent.onChange(function () {
      if (allowed()) { boot(); return; }
      var wasRunning = booted;
      window.GuestIdentity = inertApi();     // the page's own calls go inert at once, before anything else
      wipeLocal();
      forgetOnServer();
      // timers and listeners of a running session are simplest to stop by reloading the page
      if (wasRunning) { try { window.location.reload(); } catch (_) {} }
    });
  }
})();
