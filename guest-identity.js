(function () {
  'use strict';
  var CONSENT_KEY = 'elan_guest_fingerprint_consent';
  function storedChoice() { try { return localStorage.getItem(CONSENT_KEY) || ''; } catch (_) { return ''; } }
  function consent() { return storedChoice() === 'yes'; }
  function fingerprint() {
    var screen = window.screen || {};
    var timezone = '';
    try { timezone = Intl.DateTimeFormat().resolvedOptions().timeZone || ''; } catch (_) {}
    return {
      platform: navigator.platform || '', language: navigator.language || '', timezone: timezone,
      screenWidth: screen.width || 0, screenHeight: screen.height || 0, colorDepth: screen.colorDepth || 0,
      pixelRatio: window.devicePixelRatio || 0, cores: navigator.hardwareConcurrency || 0,
      memory: navigator.deviceMemory || 0, touchPoints: navigator.maxTouchPoints || 0
    };
  }
  async function request(action, data, token) {
    var response = await fetch('/api/guest-cart', {
      method: 'POST', headers: Object.assign({ 'Content-Type': 'application/json' }, token ? { Authorization: 'Bearer ' + token } : {}),
      body: JSON.stringify(Object.assign({ action: action, fingerprint: fingerprint() }, data || {}))
    });
    var body = await response.json().catch(function () { return {}; });
    if (!response.ok) throw new Error(body.error || 'guest_sync_failed');
    return body;
  }
  function removeBanner() { var banner = document.getElementById('guestConsent'); if (banner) banner.remove(); }
  function showBanner() {
    if (consent() || storedChoice() === 'no' || document.getElementById('guestConsent')) return;
    var banner = document.createElement('aside');
    banner.id = 'guestConsent'; banner.className = 'guest-consent'; banner.setAttribute('role', 'dialog'); banner.setAttribute('aria-label', 'مزامنة سلة الزائر');
    banner.innerHTML = '<div class="guest-consent-copy"><strong>مزامنة سلة الزائر</strong><p>للتعرّف على زيارتك من متصفح آخر، نرسل خصائص تقنية عامة للجهاز إلى خادم المنصة لاشتقاق بصمة رقمية؛ تُخزَّن البصمة المشتقة فقط ولا تُحفظ الخصائص الخام. قد لا تتطابق البصمة عند تغيير الجهاز أو الإعدادات، وقد تتشابه أجهزة مشتركة؛ عندها يمكنك المتابعة على هذا المتصفح فقط.</p></div><div class="guest-consent-actions"><button type="button" data-guest-consent="yes">موافق، فعّل المزامنة</button><button type="button" data-guest-consent="no">المتابعة على هذا المتصفح فقط</button></div>';
    document.body.appendChild(banner);
    banner.addEventListener('click', function (event) {
      var choice = event.target.closest('[data-guest-consent]');
      if (!choice) return;
      try { localStorage.setItem(CONSENT_KEY, choice.dataset.guestConsent); } catch (_) {}
      removeBanner();
      if (choice.dataset.guestConsent === 'yes') window.dispatchEvent(new Event('elan-guest-consent'));
    });
  }
  window.GuestIdentity = {
    enabled: consent,
    resolve: function () { return consent() ? request('resolve') : Promise.resolve(null); },
    save: function (items) { return consent() ? request('save', { items: items }) : Promise.resolve(null); },
    claim: function (token) { return consent() ? request('claim', {}, token) : Promise.resolve(null); },
    showConsent: function () { try { localStorage.removeItem(CONSENT_KEY); } catch (_) {} showBanner(); }
  };
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', showBanner, { once: true }); else showBanner();
})();
