// consent.js: the visitor's one choice, REFUSE (owner decision of 2026-10-29). There is no notice and no accept button:
// device signals run by default, and a refusal erases what was recorded about the browser and stops recording.
// Runs the real file against a small fake browser.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const source = fs.readFileSync(path.join(__dirname, '..', 'consent.js'), 'utf8');
const KEY = '8ac7c4ab-02f0-4c2c-9cde-b29151ee7712';
const flush = () => new Promise((resolve) => setImmediate(resolve));

function makeNode(attrs = {}) {
  return {
    nodeType: 1, attrs: { ...attrs }, hidden: attrs.hidden === '' ? true : false,
    getAttribute(k) { return Object.prototype.hasOwnProperty.call(this.attrs, k) ? this.attrs[k] : null; },
    closest(sel) { const m = /^\[([a-z-]+)\]$/.exec(sel); return m && Object.prototype.hasOwnProperty.call(this.attrs, m[1]) ? this : null; }
  };
}

function browser({ stored = null, extra = {}, cookie = '', search = '', framed = false, gpc, readyState = 'complete', blocked = false, server = 'ok', page = true } = {}) {
  const store = new Map(Object.entries(extra));
  if (stored !== null) store.set('elan_consent_v1', typeof stored === 'string' ? stored : JSON.stringify(stored));
  const docListeners = {}, winListeners = {}, cookieWrites = [], requests = [], writes = [];
  const openState = makeNode({ 'data-consent-when': 'open' });
  const refusedState = makeNode({ 'data-consent-when': 'refused', hidden: '' });
  const button = makeNode({ 'data-consent-refuse': '' });
  const nodes = page ? [openState, refusedState, button] : [];
  const document = {
    readyState,
    get cookie() { return cookie; }, set cookie(line) { cookieWrites.push(String(line)); },
    querySelectorAll: (sel) => nodes.filter((n) => (sel === '[data-consent-when]' ? n.attrs['data-consent-when'] !== undefined : sel === '[data-consent-refuse]' ? n.attrs['data-consent-refuse'] !== undefined : false)),
    addEventListener(type, fn) { (docListeners[type] = docListeners[type] || []).push(fn); }
  };
  const window = { addEventListener(type, fn) { (winListeners[type] = winListeners[type] || []).push(fn); }, location: { search } };
  window.parent = framed ? {} : window;
  const navigator = gpc === undefined ? {} : { globalPrivacyControl: gpc };
  const context = {
    window, document, navigator, URLSearchParams,
    localStorage: {
      getItem: (k) => { if (blocked) throw new Error('storage blocked'); return store.has(k) ? store.get(k) : null; },
      setItem: (k, v) => { if (blocked) throw new Error('storage blocked'); writes.push(k); store.set(k, String(v)); },
      removeItem: (k) => { store.delete(k); }
    },
    fetch: (url, options = {}) => {
      requests.push({ url: String(url), body: JSON.parse(options.body || '{}'), keepalive: options.keepalive === true, method: options.method });
      if (server === 'down') return Promise.reject(new Error('network'));
      return Promise.resolve({ ok: server === 'ok', status: server === 'ok' ? 200 : 502 });
    }
  };
  vm.runInNewContext(source, context, { filename: 'consent.js' });
  return {
    window, store, writes, requests, cookieWrites, consent: window.ElanConsent, nodes: { openState, refusedState, button },
    click(node) { (docListeners.click || []).forEach((fn) => fn({ target: node, preventDefault() {} })); },
    storageEvent(key) { (winListeners.storage || []).forEach((fn) => fn({ key })); },
    ready() { (docListeners.DOMContentLoaded || []).forEach((fn) => fn()); }
  };
}

test('a new visitor is never asked: device signals are on by default, nothing is stored and nothing is sent', () => {
  const b = browser();
  assert.equal(b.consent.analytics(), true);
  assert.equal(b.consent.refused(), false);
  assert.equal(b.consent.get().refused, false);
  assert.deepEqual(b.writes, []);
  assert.deepEqual(b.requests, []);
  assert.deepEqual(b.cookieWrites, []);
});

test('there is no notice and no accept button anywhere in the script', () => {
  const code = source.replace(/\/\/.*$/gm, '');          // the comments explain the decision and may use the word
  assert.doesNotMatch(code, /createElement|appendChild|innerHTML|insertAdjacentHTML/, 'it builds no interface at all');
  assert.doesNotMatch(code, /accept|data-consent-choice|data-consent-open|elan-consent/i, 'no accept choice and no notice');
  assert.deepEqual(Object.keys(browser().consent).sort(), ['analytics', 'get', 'onChange', 'refuse', 'refused'], 'there is a refuse() and no accept');
});

test('refusing stores only the refusal, tells listeners once, erases on the server with the browser key and then wipes this browser', async () => {
  const b = browser({ extra: { elan_guest_browser_key_v2: KEY, elan_visit_v1: JSON.stringify({ id: KEY, last: 1 }), elan_cart: '[]', elan_favs: '["a"]' }, cookie: 'elan_vk=' + KEY });
  const heard = [];
  b.consent.onChange((s) => heard.push(s));
  b.consent.refuse();
  assert.equal(b.consent.analytics(), false);
  assert.equal(b.consent.refused(), true);
  assert.equal(heard.length, 1);
  assert.equal(heard[0].analytics, false);
  const rec = JSON.parse(b.store.get('elan_consent_v1'));
  assert.deepEqual({ v: rec.v, a: rec.a, s: rec.s }, { v: 1, a: false, s: 'visitor' });
  assert.ok(rec.t > 0);
  assert.equal(b.requests.length, 1);
  assert.deepEqual(b.requests[0], { url: '/api/guest-cart', body: { action: 'forget', visitorKey: KEY }, keepalive: true, method: 'POST' });
  assert.equal(b.store.has('elan_visit_v1'), false, 'the visit id of an unregistered browser is removed at once');
  await flush();
  assert.equal(b.store.has('elan_guest_browser_key_v2'), false, 'the key is wiped after the server answered');
  assert.ok(b.cookieWrites.some((line) => /^elan_vk=; max-age=0/.test(line)), 'the script cookie is expired');
  assert.equal(b.store.get('elan_cart'), '[]', 'the basket is not touched');
  assert.equal(b.store.get('elan_favs'), '["a"]', 'the favourites are not touched');
  b.consent.refuse();
  assert.equal(heard.length, 1, 'refusing twice notifies once');
});

test('refusing with no key in this browser still asks the server (the HttpOnly cookie travels with the request)', async () => {
  const b = browser();
  b.consent.refuse();
  await flush();
  assert.deepEqual(b.requests.map((r) => r.body), [{ action: 'forget' }]);
});

test('the script cookie alone is enough to find the key', async () => {
  const b = browser({ cookie: 'x=1; elan_vk=' + KEY });
  b.consent.refuse();
  assert.equal(b.requests[0].body.visitorKey, KEY);
});

test('if the server cannot be reached the refusal still holds, the key stays, and the next page load asks again', async () => {
  const first = browser({ extra: { elan_guest_browser_key_v2: KEY }, server: 'down' });
  first.consent.refuse();
  await flush();
  assert.equal(first.consent.analytics(), false);
  assert.equal(first.store.has('elan_guest_browser_key_v2'), true, 'kept so that the erase can be retried');
  const failedStatus = browser({ extra: { elan_guest_browser_key_v2: KEY }, server: 'bad' });
  failedStatus.consent.refuse();
  await flush();
  assert.equal(failedStatus.store.has('elan_guest_browser_key_v2'), true, 'a 502 answer keeps the key too');
  // the next page load of a browser that already refused
  const later = browser({ stored: { v: 1, a: false, t: 1 }, extra: { elan_guest_browser_key_v2: KEY } });
  assert.deepEqual(later.requests.map((r) => r.body), [{ action: 'forget', visitorKey: KEY }]);
  await flush();
  assert.equal(later.store.has('elan_guest_browser_key_v2'), false);
});

test('a browser that refused and holds no key sends nothing when a page loads', () => {
  const b = browser({ stored: { v: 1, a: false, t: 1 } });
  assert.equal(b.consent.analytics(), false);
  assert.deepEqual(b.requests, []);
});

test('a signed-in customer who refuses keeps the visit id of the account', async () => {
  const b = browser({ extra: { elan_auth_session: JSON.stringify({ access_token: 't' }), elan_visit_v1: JSON.stringify({ id: KEY, last: 1 }), elan_guest_browser_key_v2: KEY } });
  b.consent.refuse();
  await flush();
  assert.equal(b.store.has('elan_visit_v1'), true);
  assert.equal(b.store.has('elan_guest_browser_key_v2'), false, 'but the device key goes');
  assert.ok(b.store.has('elan_auth_session'));
});

test('an older "accepted" record, another version or a damaged record means no refusal', () => {
  for (const stored of [{ v: 1, a: true, t: 1 }, { v: 0, a: false, t: 1 }, { v: 2, a: false }, '{not json', { a: false }, 'null']) {
    const b = browser({ stored });
    assert.equal(b.consent.analytics(), true, JSON.stringify(stored));
    assert.deepEqual(b.requests, []);
  }
  assert.equal(browser({ stored: { v: 1, a: false, t: 5 } }).consent.get().at, 5);
});

test('the Global Privacy Control signal counts as a refusal, is remembered as such, and erases leftovers', async () => {
  const b = browser({ gpc: true, extra: { elan_guest_browser_key_v2: KEY } });
  assert.equal(b.consent.analytics(), false);
  assert.equal(b.consent.refused(), true);
  assert.equal(JSON.parse(b.store.get('elan_consent_v1')).s, 'gpc');
  assert.deepEqual(b.requests.map((r) => r.body), [{ action: 'forget', visitorKey: KEY }]);
  const off = browser({ gpc: false });
  assert.equal(off.consent.analytics(), true);
  const clean = browser({ gpc: true });
  assert.deepEqual(clean.requests, [], 'nothing to erase, nothing sent');
});

test('the editor preview never records and never refuses or erases anything', () => {
  const b = browser({ search: '?elan_editor=1', framed: true, gpc: true, extra: { elan_guest_browser_key_v2: KEY } });
  assert.equal(b.consent.analytics(), false);
  b.consent.refuse();
  assert.deepEqual(b.writes, []);
  assert.deepEqual(b.requests, []);
  assert.equal(b.store.has('elan_guest_browser_key_v2'), true, 'the preview does not touch a real visitor key');
});

test('the refuse button on the policy page refuses, hides itself and swaps the state line', () => {
  const b = browser({ readyState: 'loading' });
  b.ready();
  assert.equal(b.nodes.openState.hidden, false);
  assert.equal(b.nodes.refusedState.hidden, true);
  assert.equal(b.nodes.button.hidden, false);
  b.click(b.nodes.button);
  assert.equal(b.consent.refused(), true);
  assert.equal(b.nodes.openState.hidden, true);
  assert.equal(b.nodes.refusedState.hidden, false);
  assert.equal(b.nodes.button.hidden, true, 'there is nothing to press once refused, and no way to accept');
  // a click anywhere else does nothing
  const other = browser();
  other.click(makeNode({ class: 'x' }));
  assert.equal(other.consent.refused(), false);
  assert.deepEqual(other.requests, []);
});

test('a page that loads already refused shows the refused state', () => {
  const b = browser({ stored: { v: 1, a: false, t: 1 } });
  assert.equal(b.nodes.openState.hidden, true);
  assert.equal(b.nodes.refusedState.hidden, false);
  assert.equal(b.nodes.button.hidden, true);
});

test('a refusal made in another tab is followed here and listeners hear it once', () => {
  const b = browser();
  const heard = [];
  b.consent.onChange((s) => heard.push(s.analytics));
  b.storageEvent('something_else');
  assert.deepEqual(heard, []);
  b.store.set('elan_consent_v1', JSON.stringify({ v: 1, a: false, t: 9 }));
  b.storageEvent('elan_consent_v1');
  assert.equal(b.consent.analytics(), false);
  assert.deepEqual(heard, [false]);
  b.storageEvent('elan_consent_v1');
  assert.deepEqual(heard, [false], 'the same state is not announced again');
  assert.deepEqual(b.requests, [], 'the other tab does the erasing, this one only follows');
});

test('blocked storage does not break the refusal for the current page', async () => {
  const b = browser({ blocked: true });
  assert.equal(b.consent.analytics(), true);
  assert.doesNotThrow(() => b.consent.refuse());
  assert.equal(b.consent.analytics(), false);
  assert.equal(b.consent.refused(), true);
});

test('a listener that throws does not stop the others', () => {
  const b = browser();
  const heard = [];
  b.consent.onChange(() => { throw new Error('boom'); });
  b.consent.onChange((s) => heard.push(s.analytics));
  assert.doesNotThrow(() => b.consent.refuse());
  assert.deepEqual(heard, [false]);
});

test('consent.js knows the same storage names the identity script and the policy page use', () => {
  const identity = fs.readFileSync(path.join(__dirname, '..', 'guest-identity.js'), 'utf8');
  for (const name of ['elan_guest_browser_key_v2', 'elan_visit_v1', 'elan_vk']) {
    assert.ok(source.includes("'" + name + "'"), name + ' is wiped by consent.js');
    assert.ok(identity.includes("'" + name + "'"), name + ' is used by guest-identity.js');
  }
  assert.match(source, /action: 'forget'/);
  assert.match(source, /keepalive: true/);
});
