(function () {
  'use strict';
  function hasSavedSession() {
    try { return !!(JSON.parse(localStorage.getItem('elan_auth_session') || 'null') || {}).access_token; }
    catch (_) { return false; }
  }
  function fingerprint() {
    var screen = window.screen || {};
    var timezone = '';
    try { timezone = Intl.DateTimeFormat().resolvedOptions().timeZone || ''; } catch (_) {}
    var ua = navigator.userAgent || '';
    var platform = navigator.platform || '';
    if (/Android/i.test(ua)) platform = 'Android';
    else if (/iPhone|iPad|iPod/i.test(ua) || (/MacIntel/i.test(platform) && (navigator.maxTouchPoints || 0) > 1)) platform = 'iOS';
    else if (/Windows/i.test(ua) || /Win/i.test(platform)) platform = 'Windows';
    else if (/Mac/i.test(ua) || /Mac/i.test(platform)) platform = 'macOS';
    else if (/Linux/i.test(ua) || /Linux/i.test(platform)) platform = 'Linux';
    var language = (navigator.language || '').split('-')[0];
    return {
      platform: platform, language: language, timezone: timezone,
      screenWidth: screen.width || 0, screenHeight: screen.height || 0, colorDepth: screen.colorDepth || 0,
      pixelRatio: window.devicePixelRatio || 0, cores: navigator.hardwareConcurrency || 0,
      touchPoints: navigator.maxTouchPoints || 0
    };
  }
  async function request(action, data, token) {
    var headers = { 'Content-Type': 'application/json' };
    if (token) headers.Authorization = 'Bearer ' + token;
    var response = await fetch('/api/guest-cart', {
      method: 'POST', headers: headers,
      body: JSON.stringify(Object.assign({ action: action, fingerprint: fingerprint() }, data || {}))
    });
    var body = await response.json().catch(function () { return {}; });
    if (!response.ok) throw new Error(body.error || 'guest_sync_failed');
    return body;
  }
  var identification = null;
  function resolve() {
    if (!identification) identification = request('resolve').catch(function (error) { identification = null; throw error; });
    return identification;
  }
  window.GuestIdentity = {
    enabled: function () { return true; },
    resolve: resolve,
    save: function (items) { return request('save', { items: items }); },
    claim: function (token) { return request('claim', {}, token); }
  };
  // Signed-in customers only claim a prior guest basket; new visitors get a server-side record immediately.
  if (!hasSavedSession()) setTimeout(function () { resolve().catch(function () {}); }, 0);
})();
