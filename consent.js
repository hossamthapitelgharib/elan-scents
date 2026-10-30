// The visitor's one choice about device signals: REFUSE (owner decision of 2026-10-29).
//
// There is no notice and no "accept" button. Device signals (a random browser key in storage and cookies, a hashed device
// fingerprint and the visit / product activity counters built on them) run by default, and the privacy policy page says so in
// plain words. A visitor who presses "refuse" there (or whose browser sends the Global Privacy Control signal) gets everything
// we hold about that browser erased, on the device and in our database, and nothing new is recorded. Browsing, the basket,
// favourites, sign-in and orders are not affected either way.
//
// window.ElanConsent = { get, analytics, refused, refuse, onChange }
// guest-identity.js starts the device signals only when analytics() is true, so a missing or broken file counts as "no".
(function () {
  'use strict';

  var KEY = 'elan_consent_v1';          // the refusal, kept in this browser
  var VERSION = 1;
  var STORAGE_KEY = 'elan_guest_browser_key_v2';
  var VISIT_KEY = 'elan_visit_v1';
  var COOKIE_NAME = 'elan_vk';
  var AUTH_KEY = 'elan_auth_session';
  var UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

  var preview = false;
  try {
    preview = !!window.parent && window.parent !== window &&
      new URLSearchParams(window.location.search).get('elan_editor') === '1';
  } catch (_) {}

  // Only a refusal is ever stored. An older "accepted" record (from the short-lived consent notice) means nothing now.
  function read() {
    try {
      var rec = JSON.parse(localStorage.getItem(KEY) || 'null');
      if (rec && rec.v === VERSION && rec.a === false) return { refused: true, at: Number(rec.t) || 0 };
    } catch (_) {}
    return { refused: false, at: 0 };
  }

  var state = read();
  var listeners = [];

  // the editor preview never records anything
  function snapshot() { return { refused: state.refused, analytics: !state.refused && !preview, at: state.at }; }
  function notify() {
    var now = snapshot();
    listeners.slice().forEach(function (fn) { try { fn(now); } catch (_) {} });
  }

  function signedIn() {
    try { var s = JSON.parse(localStorage.getItem(AUTH_KEY) || 'null'); return !!(s && s.access_token); } catch (_) { return false; }
  }
  function cookieKey() {
    try {
      var m = document.cookie.match(new RegExp('(?:^|; )' + COOKIE_NAME + '=([^;]+)'));
      return m && UUID.test(m[1]) ? m[1] : '';
    } catch (_) { return ''; }
  }
  // the browser key this page knows about: storage first, then the script cookie
  function localKey() {
    try { var v = localStorage.getItem(STORAGE_KEY); if (v && UUID.test(v)) return v; } catch (_) {}
    return cookieKey();
  }
  function wipeKeys() {
    try { localStorage.removeItem(STORAGE_KEY); } catch (_) {}
    try { document.cookie = COOKIE_NAME + '=; max-age=0; path=/; SameSite=Lax'; } catch (_) {}
  }
  // the visit id of a signed-in customer belongs to the account, so only an unregistered browser's is removed
  function wipeVisit() {
    if (!signedIn()) { try { localStorage.removeItem(VISIT_KEY); } catch (_) {} }
  }

  // Erase what the server holds about this browser, then what this browser holds. The server cookie (elan_gid) is HttpOnly,
  // so only the server can expire it, and it does that once the rows are gone. If the call fails the key stays here and the
  // next page load asks again; nothing is recorded in the meantime because the refusal is already in force.
  function erase(force) {
    var key = localKey();
    wipeVisit();
    if (!key && !force) return;           // this browser never recorded anything under a key
    try {
      var body = { action: 'forget' };
      if (key) body.visitorKey = key;
      fetch('/api/guest-cart', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body), keepalive: true })
        .then(function (response) { if (response && response.ok) wipeKeys(); })
        .catch(function () {});
    } catch (_) {}
  }

  function persist(source) {
    try { localStorage.setItem(KEY, JSON.stringify({ v: VERSION, a: false, t: state.at, s: source || 'visitor' })); } catch (_) {}
  }

  function refuse(source) {
    if (preview) return;
    var first = !state.refused;
    state = { refused: true, at: state.refused ? state.at : Date.now() };
    persist(source);
    render();
    if (first) notify();                  // everything that sends stops first ...
    erase(true);                          // ... then the erase asks the server and wipes this browser
  }

  // A browser that sends the Global Privacy Control signal has already refused: we honour it without asking.
  var gpc = false;
  try { gpc = navigator.globalPrivacyControl === true; } catch (_) {}
  if (!state.refused && gpc && !preview) {
    state = { refused: true, at: Date.now() };
    persist('gpc');
  }

  // The policy page carries both state lines in its markup; this only shows the right one. The refuse button is never hidden:
  // after a refusal it stays, and pressing it again just repeats the erase (a retry), so a visitor can always find it.
  function render() {
    if (!document.querySelectorAll) return;
    var when = document.querySelectorAll('[data-consent-when]');
    for (var i = 0; i < when.length; i++) when[i].hidden = (when[i].getAttribute('data-consent-when') === 'refused') !== state.refused;
  }

  document.addEventListener('click', function (event) {
    var target = event.target && (event.target.nodeType === 1 ? event.target : event.target.parentElement);
    if (!target || !target.closest) return;
    if (target.closest('[data-consent-refuse]')) { event.preventDefault(); refuse(); }
  });

  // another tab of the same browser refused: follow it
  window.addEventListener('storage', function (event) {
    if (event.key !== KEY) return;
    var before = snapshot();
    state = read();
    render();
    if (before.analytics !== snapshot().analytics) notify();
  });

  // a refusal already in force also removes whatever an earlier visit or a failed erase left behind
  if (state.refused && !preview) erase(false);

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', render);
  else render();

  window.ElanConsent = {
    get: snapshot,
    analytics: function () { return snapshot().analytics; },
    refused: function () { return state.refused; },
    refuse: refuse,
    onChange: function (fn) { if (typeof fn === 'function') listeners.push(fn); }
  };
})();
