// The visitor's choice about device signals: a browser key (storage + cookie), a hashed device fingerprint and the
// visit / product activity counters built on them. Everything the shop needs to work (basket, favourites, login,
// orders, language) is not covered by this choice and keeps working either way.
//
// window.ElanConsent = { get, analytics, decided, set, onChange, open }
// guest-identity.js starts only when analytics() is true, so the safe default for a missing or broken file is "no".
(function () {
  'use strict';

  var KEY = 'elan_consent_v1';
  var VERSION = 1;          // raise it when the policy changes in a way that needs a fresh answer
  var POLICY_URL = '/privacy.html';

  var preview = false;
  try {
    preview = !!window.parent && window.parent !== window &&
      new URLSearchParams(window.location.search).get('elan_editor') === '1';
  } catch (_) {}

  var TEXT = {
    ar: {
      label: 'الخصوصية وملفات الارتباط',
      title: 'خصوصيتك تهمّنا',
      body: 'نحفظ في متصفحك ما يلزم لتشغيل المتجر (السلة والمفضلة وتسجيل الدخول واللغة) دون حاجة إلى موافقتك. وبموافقتك نضيف معرّفًا للمتصفح وبصمة جهاز مجزّأة لنحفظ سلتك عندنا ونعدّ الزوار بدقة ونفهم أي العطور تهمّك. الرفض لا يمنعك من التسوّق أو الطلب.',
      more: 'اقرأ سياسة الخصوصية',
      accept: 'أوافق',
      reject: 'رفض غير الضروري',
      close: 'إغلاق',
      now: { yes: 'قرارك الحالي: موافق.', no: 'قرارك الحالي: رافض.' }
    },
    en: {
      label: 'Privacy and cookies',
      title: 'Your privacy matters',
      body: 'We keep in your browser what the shop needs to work (basket, favourites, sign-in, language) without asking. With your consent we also add a browser identifier and a hashed device fingerprint, to save your basket with us, count visitors accurately and learn which fragrances interest you. Declining never stops you from shopping or ordering.',
      more: 'Read the privacy policy',
      accept: 'Accept',
      reject: 'Decline non-essential',
      close: 'Close',
      now: { yes: 'Your current choice: accepted.', no: 'Your current choice: declined.' }
    }
  };

  function lang() { return String(document.documentElement.lang || 'ar').toLowerCase().indexOf('en') === 0 ? 'en' : 'ar'; }

  function read() {
    try {
      var rec = JSON.parse(localStorage.getItem(KEY) || 'null');
      if (rec && rec.v === VERSION && typeof rec.a === 'boolean') return { decided: true, analytics: rec.a, at: Number(rec.t) || 0 };
    } catch (_) {}
    return { decided: false, analytics: false, at: 0 };
  }

  var state = read();
  var listeners = [];
  var box = null, reopened = false;

  function snapshot() { return { decided: state.decided, analytics: state.decided && state.analytics === true, at: state.at }; }
  function notify() {
    var now = snapshot();
    listeners.slice().forEach(function (fn) { try { fn(now); } catch (_) {} });
  }

  // A browser that sends the Global Privacy Control signal has already said no; we honour it without asking again.
  // The person can still opt in later from "privacy settings".
  var gpc = false;
  try { gpc = navigator.globalPrivacyControl === true; } catch (_) {}
  if (!state.decided && gpc && !preview) {
    state = { decided: true, analytics: false, at: Date.now() };
    try { localStorage.setItem(KEY, JSON.stringify({ v: VERSION, a: false, t: state.at, s: 'gpc' })); } catch (_) {}
  }

  function set(value) {
    var next = value === true;
    var changed = !state.decided || state.analytics !== next;
    state = { decided: true, analytics: next, at: Date.now() };
    try { localStorage.setItem(KEY, JSON.stringify({ v: VERSION, a: next, t: state.at })); } catch (_) {}
    hide();
    if (changed) notify();
  }

  function el(tag, attrs, text) {
    var node = document.createElement(tag);
    Object.keys(attrs || {}).forEach(function (name) { node.setAttribute(name, attrs[name]); });
    if (text) node.textContent = text;
    return node;
  }

  function build() {
    var t = TEXT[lang()];
    var node = el('section', { id: 'elan-consent', 'class': 'elan-consent', role: 'region', 'aria-label': t.label, lang: lang(), dir: lang() === 'ar' ? 'rtl' : 'ltr' });
    node.appendChild(el('h2', {}, t.title));
    node.appendChild(el('p', {}, t.body));
    if (reopened && state.decided) node.appendChild(el('p', { 'class': 'elan-consent-state' }, state.analytics ? t.now.yes : t.now.no));
    var link = el('a', { href: POLICY_URL }, t.more);
    var line = el('p', {});
    line.appendChild(link);
    node.appendChild(line);
    var actions = el('div', { 'class': 'elan-consent-actions' });
    actions.appendChild(el('button', { type: 'button', 'data-consent-choice': 'accept' }, t.accept));
    actions.appendChild(el('button', { type: 'button', 'data-consent-choice': 'reject' }, t.reject));
    if (reopened && state.decided) actions.appendChild(el('button', { type: 'button', 'class': 'elan-consent-close', 'data-consent-close': '' }, t.close));
    node.appendChild(actions);
    return node;
  }

  function show(focus) {
    if (preview || !document.body) return;
    hide();
    box = build();
    document.body.appendChild(box);
    if (focus) { try { box.querySelector('button').focus(); } catch (_) {} }
  }
  function hide() {
    if (box && box.parentNode) box.parentNode.removeChild(box);
    box = null;
  }

  document.addEventListener('click', function (event) {
    var target = event.target && (event.target.nodeType === 1 ? event.target : event.target.parentElement);
    if (!target || !target.closest) return;
    var choice = target.closest('[data-consent-choice]');
    if (choice) { event.preventDefault(); set(choice.getAttribute('data-consent-choice') === 'accept'); return; }
    if (target.closest('[data-consent-close]')) { event.preventDefault(); hide(); return; }
    if (target.closest('[data-consent-open]')) { event.preventDefault(); reopened = true; show(true); }
  });

  // another tab of the same browser decided: follow it
  window.addEventListener('storage', function (event) {
    if (event.key !== KEY) return;
    var before = snapshot();
    state = read();
    var after = snapshot();
    if (state.decided) hide();
    if (before.analytics !== after.analytics) notify();
  });

  // the notice is translated with the page
  if (typeof MutationObserver === 'function') {
    try {
      new MutationObserver(function () { if (box) show(false); }).observe(document.documentElement, { attributes: true, attributeFilter: ['lang'] });
    } catch (_) {}
  }

  function start() { if (!state.decided) show(false); }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', start);
  else start();

  window.ElanConsent = {
    get: snapshot,
    analytics: function () { return snapshot().analytics; },
    decided: function () { return state.decided; },
    set: set,
    onChange: function (fn) { if (typeof fn === 'function') listeners.push(fn); },
    open: function () { reopened = true; show(true); }
  };
})();
