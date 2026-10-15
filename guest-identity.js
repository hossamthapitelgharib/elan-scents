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
      resolve: noWrite, save: noWrite, claim: noWrite, track: noWrite,
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

  var AUTOMATED = false;
  try { AUTOMATED = typeof navigator !== 'undefined' && navigator.webdriver === true; } catch (_) {}
  if (AUTOMATED) {
    var inert = function () { return Promise.resolve({ ok: true, tracked: false, cart: [] }); };
    window.GuestIdentity = { enabled: function () { return false; }, resolve: inert, save: inert, claim: inert, track: inert, sessionId: function () { return null; }, startSession: inert, prepareLogout: inert };
    return;
  }

  var STORAGE_KEY = 'elan_guest_browser_key_v2';
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

  var COOKIE_NAME = 'elan_vk';
  var VISIT_KEY = 'elan_visit_v1';
  var VISIT_IDLE_MS = 30 * 60 * 1000;       // a new visit starts only after 30 quiet minutes
  var lastStartedVisit = null;
  var recentViews = {};
  var ACTIVE_MS = 30000;                    // time counts only while the person is really using the page
  var lastInteraction = 0;
  function recentlyActive() { return Date.now() - lastInteraction < ACTIVE_MS; }
  function interacted() {
    var now = Date.now(), wasIdle = now - lastInteraction >= ACTIVE_MS;
    lastInteraction = now;
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

  async function request(action, data, token) {
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
    saveQueue = saveQueue.catch(function () {}).then(function () { return request('save', { items: snapshot }); });
    return saveQueue;
  }

  function sendActivity(action, data, token, keepalive) {
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

  window.GuestIdentity = {
    enabled: function () { return true; },
    resolve: resolve,
    save: save,
    claim: claim,
    track: track,
    sessionId: sessionId,
    startSession: startSession,
    prepareLogout: prepareLogout
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
    if (sessionStarted && document.visibilityState !== 'hidden' && recentlyActive()) sendSession('heartbeat').catch(function () {});
  }, 30000);
  window.addEventListener('pagehide', function () {
    if (!sessionStarted || !recentlyActive()) return;
    sendSession('heartbeat', true).catch(function () {});
  });
  window.addEventListener('pageshow', function () {
    if (!sessionStarted) startSession().catch(function () {});
  });
  document.addEventListener('visibilitychange', function () {
    if (document.visibilityState === 'visible') {
      if (!sessionStarted || lastStartedVisit !== sessionId(false)) { sessionStarted = false; startSession().catch(function () {}); }
    }
  });
  ['pointerdown', 'keydown', 'touchstart', 'wheel', 'scroll'].forEach(function (type) {
    window.addEventListener(type, interacted, { capture: true, passive: true });
  });
  window.addEventListener('storage', function (e) {
    if (e.key === STORAGE_KEY && e.newValue && UUID.test(e.newValue)) cachedKey = e.newValue;
  });
})();
