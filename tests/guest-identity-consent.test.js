// guest-identity.js starts only with the visitor's consent (consent.js). Runs the real file against a fake browser.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const source = fs.readFileSync(path.join(__dirname, '..', 'guest-identity.js'), 'utf8');
const KEY = '8ac7c4ab-02f0-4c2c-9cde-b29151ee7712';
const flush = () => new Promise((resolve) => setImmediate(resolve));

function fakeConsent(initial) {            // initial: undefined = not asked yet, true / false = answered
  let state = { decided: initial !== undefined, analytics: initial === true };
  const listeners = [];
  return {
    analytics: () => state.analytics, decided: () => state.decided, onChange: (fn) => listeners.push(fn),
    set(value) { state = { decided: true, analytics: value === true }; listeners.forEach((fn) => fn({ ...state })); }
  };
}

function load({ consent, stored = {}, webdriver = false } = {}) {
  const store = new Map(Object.entries(stored));
  const writes = [], requests = [], cookieWrites = [];
  let reloads = 0;
  const listeners = {}, intervals = [];
  const on = (type, fn) => { (listeners[type] = listeners[type] || []).push(fn); };
  const window = {
    location: { search: '', protocol: 'https:', reload() { reloads += 1; } },
    crypto: { randomUUID: () => KEY }, addEventListener: on
  };
  if (consent) window.ElanConsent = consent;
  window.parent = window;
  const document = { visibilityState: 'visible', addEventListener: on, get cookie() { return ''; }, set cookie(line) { cookieWrites.push(String(line)); } };
  const context = {
    window, document, URLSearchParams, navigator: { webdriver },
    localStorage: {
      getItem: (k) => (store.has(k) ? store.get(k) : null),
      setItem: (k, v) => { writes.push(k); store.set(k, String(v)); },
      removeItem: (k) => { store.delete(k); }
    },
    fetch: async (url, options = {}) => {
      requests.push({ url: String(url), body: JSON.parse(options.body || '{}'), keepalive: options.keepalive === true });
      return { ok: true, json: async () => ({ ok: true, visitorId: 'v', cart: [], tracked: true }) };
    },
    setTimeout(fn, delay) { if (!delay) Promise.resolve().then(fn); return 0; }, setInterval(fn) { intervals.push(fn); return 0; }
  };
  vm.runInNewContext(source, context, { filename: 'guest-identity.js' });
  return {
    identity: () => window.GuestIdentity, store, writes, requests, cookieWrites, reloads: () => reloads,
    fire: (type) => (listeners[type] || []).forEach((fn) => fn({})), tick: () => intervals.forEach((fn) => fn())
  };
}

const METHODS = ['resolve', 'save', 'claim', 'track', 'search', 'identify', 'startFresh', 'startSession', 'prepareLogout'];

test('without the consent script nothing runs, is stored or is sent, and every call is still safe', async () => {
  const b = load();
  assert.equal(b.identity().enabled(), false);
  for (const name of METHODS) {
    assert.equal(typeof b.identity()[name], 'function', name + ' exists');
    assert.equal((await b.identity()[name]('x', 'y')).ok, true, name + ' resolves');
  }
  assert.equal(b.identity().sessionId(), null);
  assert.equal(b.identity().finalVisitorId(), null);
  await flush();
  assert.deepEqual(b.requests, []);
  assert.deepEqual(b.writes, []);
  assert.deepEqual(b.cookieWrites, []);
});

test('before the visitor answers nothing runs, is stored or is sent', async () => {
  const b = load({ consent: fakeConsent(undefined) });
  await flush();
  assert.equal(b.identity().enabled(), false);
  assert.deepEqual(b.requests, []);
  assert.deepEqual(b.writes, []);
  assert.deepEqual(b.cookieWrites, []);
});

test('a refusal removes leftovers from earlier visits and sends nothing', async () => {
  const b = load({
    consent: fakeConsent(false),
    stored: { elan_guest_browser_key_v2: KEY, elan_visit_v1: JSON.stringify({ id: KEY, last: Date.now() }), elan_cart: '[]' }
  });
  await flush();
  assert.equal(b.identity().enabled(), false);
  assert.equal(b.store.has('elan_guest_browser_key_v2'), false);
  assert.equal(b.store.has('elan_visit_v1'), false);
  assert.equal(b.store.get('elan_cart'), '[]', 'the basket is not touched');
  assert.ok(b.cookieWrites.some((line) => /^elan_vk=; max-age=0/.test(line)), 'the script cookie is expired');
  assert.deepEqual(b.requests, []);
});

test('with consent already given the identity starts as before', async () => {
  const b = load({ consent: fakeConsent(true) });
  await flush();
  assert.equal(b.identity().enabled(), true);
  const urls = b.requests.map((r) => r.url);
  assert.ok(urls.includes('/api/guest-cart'), 'the browser is resolved');
  assert.ok(urls.includes('/api/customer-activity'), 'the visit is started');
  assert.ok(b.store.has('elan_guest_browser_key_v2'));
});

test('saying yes later starts it without a reload', async () => {
  const consent = fakeConsent(undefined);
  const b = load({ consent });
  await flush();
  assert.equal(b.identity().enabled(), false);
  assert.deepEqual(b.requests, []);
  consent.set(true);
  await flush();
  assert.equal(b.identity().enabled(), true);
  assert.ok(b.requests.some((r) => r.url === '/api/guest-cart'));
  assert.equal(b.reloads(), 0);
});

test('withdrawing consent wipes the identifiers, expires the server cookie and reloads the page', async () => {
  const consent = fakeConsent(true);
  const b = load({ consent });
  await flush();
  assert.ok(b.store.has('elan_guest_browser_key_v2'));
  const before = b.requests.length;
  consent.set(false);
  assert.equal(b.store.has('elan_guest_browser_key_v2'), false);
  assert.equal(b.store.has('elan_visit_v1'), false);
  assert.ok(b.cookieWrites.some((line) => /^elan_vk=; max-age=0/.test(line)));
  const forget = b.requests.slice(before).find((r) => r.body.action === 'forget');
  assert.ok(forget, 'the server is asked to expire elan_gid');
  assert.equal(forget.url, '/api/guest-cart');
  assert.equal(forget.keepalive, true);
  assert.equal(b.reloads(), 1, 'running timers and listeners are stopped by a reload');
});

test('declining after being asked needs no reload but still clears the server cookie', async () => {
  const consent = fakeConsent(undefined);
  const b = load({ consent, stored: { elan_guest_browser_key_v2: KEY } });
  consent.set(false);
  await flush();
  assert.equal(b.store.has('elan_guest_browser_key_v2'), false);
  assert.deepEqual(b.requests.map((r) => r.body.action), ['forget']);
  assert.equal(b.reloads(), 0);
});

test('automated browsers stay untracked even with consent', async () => {
  const b = load({ consent: fakeConsent(true), webdriver: true });
  await flush();
  assert.equal(b.identity().enabled(), false);
  assert.equal(typeof b.identity().search, 'function');
  assert.equal(typeof b.identity().startFresh, 'function');
  assert.deepEqual(b.requests, []);
});

test('the fingerprint library is not even requested before consent', () => {
  // identification is the only place that loads it, and identification is reachable only from the consent-gated boot()
  const bootAt = source.indexOf('function boot()');
  assert.ok(bootAt > 0);
  assert.ok(source.indexOf('/vendor/thumbmark.js') > bootAt, 'the loader sits inside boot()');
  assert.ok(source.indexOf('function loadThumbmark') > bootAt);
});

test('after withdrawal the closing page sends nothing and stores nothing again', async () => {
  const consent = fakeConsent(true);
  const b = load({ consent });
  await flush();
  b.fire('pointerdown');                       // the visitor was active, so a closing heartbeat would normally be sent
  await flush();
  const before = b.requests.length;
  consent.set(false);
  b.fire('pointerdown'); b.fire('pagehide'); b.fire('pageshow'); b.fire('visibilitychange'); b.tick();
  await flush();
  assert.deepEqual(b.requests.slice(before).map((r) => r.body.action), ['forget'], 'only the cookie-expiry call is sent');
  assert.equal(b.store.has('elan_guest_browser_key_v2'), false, 'the key is not created again');
  assert.equal(b.store.has('elan_visit_v1'), false, 'the visit record is not created again');
  assert.equal(b.identity().enabled(), false, 'the page API went inert at once');
  for (const name of ['track', 'save', 'resolve', 'search']) await b.identity()[name]('x');
  await flush();
  assert.equal(b.requests.length, before + 1);
});
