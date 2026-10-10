(function () {
  'use strict';

  var STORAGE_KEY = 'elan_guest_browser_key_v2';
  var UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
  var cachedKey = null;
  var identification = null;
  var saveQueue = Promise.resolve();

  function savedSession() {
    try { return JSON.parse(localStorage.getItem('elan_auth_session') || 'null'); }
    catch (_) { return null; }
  }

  function hasSavedSession() {
    return !!(savedSession() || {}).access_token;
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

  async function request(action, data, token) {
    var headers = { 'Content-Type': 'application/json' };
    if (token) headers.Authorization = 'Bearer ' + token;
    var payload = Object.assign({}, data || {}, { action: action, visitorKey: visitorKey() });
    var response = await fetch('/api/guest-cart', {
      method: 'POST',
      headers: headers,
      body: JSON.stringify(payload)
    });
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

  function clearKey() {
    try { localStorage.removeItem(STORAGE_KEY); } catch (_) {}
    cachedKey = null;
    identification = null;
  }

  function claim(token) {
    return saveQueue.catch(function () {}).then(function () { return request('claim', {}, token); }).then(function (result) {
      if (result && result.ok) clearKey();
      return result;
    });
  }

  function track(eventType, productId) {
    if (hasSavedSession()) return Promise.resolve({ ok: true, tracked: false });
    return resolve().then(function () {
      return request('track', { eventType: eventType, productId: productId });
    });
  }

  window.GuestIdentity = {
    enabled: function () { return true; },
    resolve: resolve,
    save: save,
    claim: claim,
    track: track
  };

  // Existing visitors keep their basket; each browser profile gets its own stable key.
  var session = savedSession();
  if (session && session.access_token) {
    try {
      if (localStorage.getItem(STORAGE_KEY)) setTimeout(function () { claim(session.access_token).catch(function () {}); }, 0);
    } catch (_) {}
  } else {
    setTimeout(function () { resolve().catch(function () {}); }, 0);
  }
})();
