// consent.js: the visitor's choice about device signals. Runs the real file against a small fake browser.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const source = fs.readFileSync(path.join(__dirname, '..', 'consent.js'), 'utf8');

function makeNode(tag) {
  return {
    tagName: String(tag).toUpperCase(), nodeType: 1, attrs: {}, children: [], parentNode: null, _text: '',
    setAttribute(k, v) { this.attrs[k] = String(v); },
    getAttribute(k) { return Object.prototype.hasOwnProperty.call(this.attrs, k) ? this.attrs[k] : null; },
    appendChild(c) { c.parentNode = this; this.children.push(c); return c; },
    removeChild(c) { this.children = this.children.filter((x) => x !== c); c.parentNode = null; return c; },
    get textContent() { return this._text + this.children.map((c) => c.textContent).join(''); },
    set textContent(v) { this._text = String(v); },
    matches(sel) { const m = /^\[([a-z-]+)\]$/.exec(sel); return m ? Object.prototype.hasOwnProperty.call(this.attrs, m[1]) : this.tagName === sel.toUpperCase(); },
    closest(sel) { for (let n = this; n; n = n.parentNode) if (n.matches && n.matches(sel)) return n; return null; },
    all() { return this.children.flatMap((c) => [c, ...c.all()]); },
    querySelector(sel) { return this.all().find((n) => n.matches(sel)) || null; }
  };
}

function browser({ stored = null, search = '', framed = false, gpc, lang = 'ar', readyState = 'complete', blocked = false } = {}) {
  const store = new Map();
  if (stored !== null) store.set('elan_consent_v1', typeof stored === 'string' ? stored : JSON.stringify(stored));
  const docListeners = {}, winListeners = {};
  let observer = null, focused = null;
  const body = makeNode('body');
  const documentElement = { lang };
  const document = {
    readyState, documentElement, body,
    createElement: (tag) => { const n = makeNode(tag); n.focus = () => { focused = n; }; return n; },
    addEventListener(type, fn) { (docListeners[type] = docListeners[type] || []).push(fn); }
  };
  const window = { addEventListener(type, fn) { (winListeners[type] = winListeners[type] || []).push(fn); }, location: { search } };
  window.parent = framed ? {} : window;
  const navigator = gpc === undefined ? {} : { globalPrivacyControl: gpc };
  const context = {
    window, document, navigator, URLSearchParams,
    localStorage: {
      getItem: (k) => { if (blocked) throw new Error('storage blocked'); return store.has(k) ? store.get(k) : null; },
      setItem: (k, v) => { if (blocked) throw new Error('storage blocked'); store.set(k, String(v)); },
      removeItem: (k) => { store.delete(k); }
    },
    MutationObserver: class { constructor(fn) { observer = fn; } observe() {} }
  };
  vm.runInNewContext(source, context, { filename: 'consent.js' });
  const api = {
    window, document, store, consent: window.ElanConsent,
    banner: () => body.children.find((c) => c.attrs.id === 'elan-consent') || null,
    click(node) { (docListeners.click || []).forEach((fn) => fn({ target: node, preventDefault() {} })); },
    button(which) { return api.banner().all().find((n) => n.attrs['data-consent-choice'] === which); },
    storageEvent(key) { (winListeners.storage || []).forEach((fn) => fn({ key })); },
    relabel(next) { documentElement.lang = next; if (observer) observer(); },
    focused: () => focused
  };
  return api;
}

test('a new visitor sees the notice and nothing is switched on', () => {
  const b = browser();
  assert.equal(b.consent.decided(), false);
  assert.equal(b.consent.analytics(), false);
  const banner = b.banner();
  assert.ok(banner, 'the notice is shown');
  assert.equal(banner.attrs.lang, 'ar');
  assert.equal(banner.attrs.dir, 'rtl');
  assert.match(banner.textContent, /خصوصيتك تهمّنا/);
  assert.ok(b.button('accept') && b.button('reject'), 'accept and decline are both offered');
  assert.equal(b.button('accept').tagName, 'BUTTON');
  assert.equal(b.button('reject').tagName, 'BUTTON');
  const link = banner.all().find((n) => n.tagName === 'A');
  assert.equal(link.attrs.href, '/privacy.html');
  assert.equal(b.store.has('elan_consent_v1'), false, 'no decision is stored until the visitor makes one');
});

test('accepting stores the decision, hides the notice and tells listeners', () => {
  const b = browser();
  const seen = [];
  b.consent.onChange((s) => seen.push(s));
  b.click(b.button('accept'));
  assert.equal(b.consent.analytics(), true);
  assert.equal(b.consent.decided(), true);
  assert.equal(b.banner(), null);
  const rec = JSON.parse(b.store.get('elan_consent_v1'));
  assert.equal(rec.v, 1); assert.equal(rec.a, true); assert.ok(rec.t > 0);
  assert.deepEqual(seen.map((s) => s.analytics), [true]);
});

test('declining is recorded, hides the notice and tells listeners', () => {
  const b = browser();
  const seen = [];
  b.consent.onChange((s) => seen.push(s));
  b.click(b.button('reject'));
  assert.equal(b.consent.analytics(), false);
  assert.equal(b.consent.decided(), true);
  assert.equal(b.banner(), null);
  assert.equal(JSON.parse(b.store.get('elan_consent_v1')).a, false);
  assert.deepEqual(seen.map((s) => [s.decided, s.analytics]), [[true, false]]);
});

test('a returning visitor who accepted is not asked again', () => {
  const b = browser({ stored: { v: 1, a: true, t: 1 } });
  assert.equal(b.banner(), null);
  assert.equal(b.consent.analytics(), true);
  assert.equal(b.consent.get().decided, true);
});

test('an answer to an older policy version, or a damaged record, counts as no answer', () => {
  for (const stored of [{ v: 0, a: true, t: 1 }, { v: 1, a: 'yes', t: 1 }, '{broken']) {
    const b = browser({ stored });
    assert.equal(b.consent.analytics(), false);
    assert.equal(b.consent.decided(), false);
    assert.ok(b.banner(), 'the notice is shown again');
  }
});

test('the Global Privacy Control signal counts as a refusal without asking', () => {
  const b = browser({ gpc: true });
  assert.equal(b.banner(), null);
  assert.equal(b.consent.decided(), true);
  assert.equal(b.consent.analytics(), false);
  // the visitor can still opt in from the privacy settings
  b.consent.open();
  b.click(b.button('accept'));
  assert.equal(b.consent.analytics(), true);
});

test('the editor preview never shows the notice and never records a decision', () => {
  const b = browser({ framed: true, search: '?elan_editor=1', gpc: true });
  assert.equal(b.banner(), null);
  assert.equal(b.store.has('elan_consent_v1'), false);
  assert.equal(b.consent.analytics(), false);
});

test('the footer opener reopens the notice with the current choice and a close button', () => {
  const b = browser({ stored: { v: 1, a: true, t: 1 } });
  const opener = makeNode('button'); opener.setAttribute('data-consent-open', '');
  b.click(opener);
  const banner = b.banner();
  assert.ok(banner);
  assert.match(banner.textContent, /قرارك الحالي: موافق/);
  const close = banner.all().find((n) => 'data-consent-close' in n.attrs);
  assert.ok(close, 'a reopened notice can be closed without changing the choice');
  assert.equal(b.focused().tagName, 'BUTTON', 'keyboard focus moves into the reopened notice');
  b.click(close);
  assert.equal(b.banner(), null);
  assert.equal(b.consent.analytics(), true);
  // withdrawing from the same place
  b.click(opener);
  const seen = [];
  b.consent.onChange((s) => seen.push(s.analytics));
  b.click(b.button('reject'));
  assert.equal(b.consent.analytics(), false);
  assert.deepEqual(seen, [false]);
});

test('choosing the same answer again does not notify listeners twice', () => {
  const b = browser({ stored: { v: 1, a: true, t: 1 } });
  const seen = [];
  b.consent.onChange((s) => seen.push(s.analytics));
  b.consent.open();
  b.click(b.button('accept'));
  assert.deepEqual(seen, []);
});

test('the notice follows the page language', () => {
  const b = browser({ lang: 'en' });
  assert.equal(b.banner().attrs.lang, 'en');
  assert.equal(b.banner().attrs.dir, 'ltr');
  assert.match(b.banner().textContent, /Your privacy matters/);
  assert.equal(b.button('reject').textContent, 'Decline non-essential');
  b.relabel('ar');
  assert.match(b.banner().textContent, /خصوصيتك تهمّنا/);
  assert.equal(b.banner().attrs.dir, 'rtl');
});

test('a decision made in another tab is followed here', () => {
  const b = browser();
  const seen = [];
  b.consent.onChange((s) => seen.push(s.analytics));
  b.store.set('elan_consent_v1', JSON.stringify({ v: 1, a: true, t: 5 }));
  b.storageEvent('elan_consent_v1');
  assert.equal(b.consent.analytics(), true);
  assert.equal(b.banner(), null);
  assert.deepEqual(seen, [true]);
  b.storageEvent('some_other_key');
  assert.deepEqual(seen, [true]);
});

test('the notice waits for the page body when the script runs early', () => {
  const b = browser({ readyState: 'loading' });
  assert.equal(b.banner(), null);
});

test('blocked storage does not break the choice for the current page', () => {
  const b = browser({ blocked: true });
  assert.ok(b.banner(), 'the notice still appears');
  b.click(b.button('accept'));
  assert.equal(b.consent.analytics(), true);
  assert.equal(b.banner(), null);
});

test('the notice is built with DOM calls only, never from markup strings', () => {
  assert.doesNotMatch(source, /innerHTML|outerHTML|insertAdjacentHTML|document\.write/);
});
