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

  var STORAGE_KEY = 'elan_guest_browser_key_v2';
  var SESSION_KEY = 'elan_customer_activity_session_v1';
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

  function visitorKey() {
    if (cachedKey) return cachedKey;
    try {
      var stored = localStorage.getItem(STORAGE_KEY);
      if (stored && UUID.test(stored)) return (cachedKey = stored);
      cachedKey = createKey();
      localStorage.setItem(STORAGE_KEY, cachedKey);
      return cachedKey;
    } catch (_) {
      cachedKey = createKey();
      return cachedKey;
    }
  }

  function sessionId() {
    if (cachedSessionId) return cachedSessionId;
    try {
      var stored = sessionStorage.getItem(SESSION_KEY);
      if (stored && UUID.test(stored)) return (cachedSessionId = stored);
      cachedSessionId = createKey();
      sessionStorage.setItem(SESSION_KEY, cachedSessionId);
      return cachedSessionId;
    } catch (_) {
      cachedSessionId = createKey();
      return cachedSessionId;
    }
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
    if (!identification) identification = request('resolve').catch(function (error) {
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
    var payload = Object.assign({}, data || {}, { action: action, sessionId: sessionId() });
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
    var send = function () { return sendActivity('session', { sessionAction: action }, token, keepalive); };
    return token ? send() : resolve().then(send);
  }

  function startSession(token) {
    if (sessionStarted) return Promise.resolve({ ok: true });
    if (startingSession) return startingSession;
    var authToken = token || accessToken();
    var start = function () {
      return sendActivity('session', { sessionAction: 'start' }, authToken || null).then(function (result) {
        sessionStarted = !!result.tracked;
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
    try { sessionStorage.removeItem(SESSION_KEY); } catch (_) {}
    return Promise.resolve(ending).catch(function () { return { ok: false }; });
  }

  function clearKey() {
    try { localStorage.removeItem(STORAGE_KEY); } catch (_) {}
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
    if (sessionStarted && document.visibilityState !== 'hidden') sendSession('heartbeat').catch(function () {});
  }, 30000);
  window.addEventListener('pagehide', function () {
    if (!sessionStarted) return;
    sessionStarted = false;
    sendSession('end', true).catch(function () {});
  });
  window.addEventListener('pageshow', function () {
    if (!sessionStarted) startSession().catch(function () {});
  });
  document.addEventListener('visibilitychange', function () {
    if (document.visibilityState === 'visible' && !sessionStarted) startSession().catch(function () {});
  });
})();
