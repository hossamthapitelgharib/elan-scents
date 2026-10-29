// guest-identity.js: device signals run by default and stop when the visitor refuses (consent.js; owner decision of 2026-10-29).
// A signed-in customer's own activity is independent of that choice. Runs the real file against a fake browser.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const source = fs.readFileSync(path.join(__dirname, '..', 'guest-identity.js'), 'utf8');
const KEY = '8ac7c4ab-02f0-4c2c-9cde-b29151ee7712';
const flush = () => new Promise((resolve) => setImmediate(resolve));

function fakeConsent(refused) {            // refused: true = the visitor refused; anything else = no refusal (the default)
  let state = { refused: refused === true };
  const listeners = [];
  return {
    analytics: () => !state.refused, refused: () => state.refused, onChange: (fn) => listeners.push(fn),
    refuse() { if (state.refused) return; state = { refused: true }; listeners.forEach((fn) => fn({ analytics: false })); }
  };
}

function load({ consent, stored = {}, webdriver = false, token = '' } = {}) {
  const store = new Map(Object.entries(stored));
  if (token) store.set('elan_auth_session', JSON.stringify({ access_token: token }));
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
      requests.push({ url: String(url), body: JSON.parse(options.body || '{}'), keepalive: options.keepalive === true, auth: (options.headers || {}).Authorization || '' });
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

test('with no refusal the identity starts at once, with no question asked', async () => {
  const b = load({ consent: fakeConsent() });
  await flush();
  assert.equal(b.identity().enabled(), true);
  const urls = b.requests.map((r) => r.url);
  assert.ok(urls.includes('/api/guest-cart'), 'the browser is resolved');
  assert.ok(urls.includes('/api/customer-activity'), 'the visit is started');
  assert.ok(b.store.has('elan_guest_browser_key_v2'));
  assert.equal(b.reloads(), 0);
});

test('a visitor who refused earlier: nothing runs, is stored or is sent from this script (consent.js does the erasing)', async () => {
  const b = load({
    consent: fakeConsent(true),
    stored: { elan_guest_browser_key_v2: KEY, elan_cart: '[]' }
  });
  await flush();
  assert.equal(b.identity().enabled(), false);
  assert.deepEqual(b.requests, []);
  assert.deepEqual(b.writes, []);
  assert.deepEqual(b.cookieWrites, []);
  assert.equal(b.store.get('elan_guest_browser_key_v2'), KEY, 'the key is left for consent.js to erase on the server first');
  for (const name of METHODS) assert.equal((await b.identity()[name]('x', 'y')).ok, true, name + ' resolves');
  assert.equal(b.identity().sessionId(), null);
  assert.deepEqual(b.requests, []);
});

test('a refusal made in another tab stops this page at once and reloads it', async () => {
  const consent = fakeConsent();
  const b = load({ consent });
  await flush();
  assert.ok(b.store.has('elan_guest_browser_key_v2'));
  const before = b.requests.length;
  consent.refuse();
  assert.equal(b.identity().enabled(), false, 'the page API went inert at once');
  assert.equal(b.reloads(), 1, 'running timers and listeners are stopped by a reload');
  assert.equal(b.requests.length, before, 'this script sends nothing itself, consent.js asks the server to erase');
});

test('automated browsers stay untracked', async () => {
  const b = load({ consent: fakeConsent(), webdriver: true });
  await flush();
  assert.equal(b.identity().enabled(), false);
  assert.equal(typeof b.identity().search, 'function');
  assert.equal(typeof b.identity().startFresh, 'function');
  assert.deepEqual(b.requests, []);
});

test('the fingerprint library is not even requested after a refusal', () => {
  // identification is the only place that loads it, and identification is reachable only from the boot() that a refusal prevents
  const bootAt = source.indexOf('function boot()');
  assert.ok(bootAt > 0);
  assert.ok(source.indexOf('/vendor/thumbmark.js') > bootAt, 'the loader sits inside boot()');
  assert.ok(source.indexOf('function loadThumbmark') > bootAt);
});

test('after a refusal the closing page sends nothing and stores nothing again', async () => {
  const consent = fakeConsent();
  const b = load({ consent });
  await flush();
  b.fire('pointerdown');                       // the visitor was active, so a closing heartbeat would normally be sent
  await flush();
  const before = b.requests.length;
  b.store.delete('elan_guest_browser_key_v2'); b.store.delete('elan_visit_v1');   // what consent.js erased
  consent.refuse();
  b.fire('pointerdown'); b.fire('pagehide'); b.fire('pageshow'); b.fire('visibilitychange'); b.tick();
  await flush();
  assert.equal(b.requests.length, before, 'no final heartbeat, no new visit');
  assert.equal(b.store.has('elan_guest_browser_key_v2'), false, 'the key is not created again');
  assert.equal(b.store.has('elan_visit_v1'), false, 'the visit record is not created again');
  assert.equal(b.identity().enabled(), false, 'the page API went inert at once');
  for (const name of ['track', 'save', 'resolve', 'search']) await b.identity()[name]('x');
  await flush();
  assert.equal(b.requests.length, before);
});

// ---- a signed-in customer: the account's own activity does not depend on the visitor's refusal (owner decision of 2026-10-28) ----
const PRODUCT = '45a6e52c-46c6-42e9-a730-9e5bec3dd201';
const isDeviceCall = (r) => r.url === '/api/guest-cart';

test('a signed-in customer who refused is tracked with the account token, and never with a device signal', async () => {
  const b = load({ consent: fakeConsent(true), token: 'account-token' });
  await flush();
  const sessions = b.requests.filter((r) => r.url === '/api/customer-activity');
  assert.ok(sessions.length >= 1 && sessions.every((r) => r.auth === 'Bearer account-token' && r.body.action === 'session'), 'the visit starts with the account token');
  assert.ok(sessions.every((r) => !('visitorKey' in r.body)), 'no browser key is sent');
  assert.deepEqual(b.requests.filter(isDeviceCall), [], 'no guest-cart call');
  assert.equal(b.store.has('elan_guest_browser_key_v2'), false, 'no browser key stored');
  assert.deepEqual(b.cookieWrites, [], 'no cookie written');
  assert.ok(b.store.has('elan_visit_v1'), 'the visit id of the account is kept');
  assert.equal(b.identity().enabled(), false, 'device signals are off');
  await b.identity().track('view', PRODUCT);
  await b.identity().search('oud', [{ id: PRODUCT }]);
  const sent = b.requests.filter((r) => r.url === '/api/customer-activity').map((r) => r.body.action);
  assert.ok(sent.includes('track') && sent.includes('search'), 'views and searches are recorded for the account: ' + sent);
});

test('a signed-in customer who has not refused is tracked with the token too, with no extra device call', async () => {
  const b = load({ consent: fakeConsent(), token: 'account-token' });
  await flush();
  const sessions = b.requests.filter((r) => r.url === '/api/customer-activity');
  assert.ok(sessions.length >= 1 && sessions.every((r) => r.auth === 'Bearer account-token'));
  assert.deepEqual(b.requests.filter(isDeviceCall), [], 'identification is skipped for an account, no basket to claim');
});

test('the heartbeat of a signed-in customer who refused still works', async () => {
  const b = load({ consent: fakeConsent(true), token: 'account-token' });
  await flush();
  b.fire('pointerdown');
  const before = b.requests.length;
  b.tick();
  await flush();
  const beat = b.requests.slice(before).filter((r) => r.url === '/api/customer-activity');
  assert.ok(beat.length >= 1 && beat.every((r) => r.auth === 'Bearer account-token'), 'a heartbeat goes out with the account token');
  assert.deepEqual(b.requests.filter(isDeviceCall), []);
});

test('logging in on a page that started refused starts the account visit and nothing else', async () => {
  const b = load({ consent: fakeConsent(true) });
  await flush();
  assert.deepEqual(b.requests, []);
  b.store.set('elan_auth_session', JSON.stringify({ access_token: 'fresh-token' }));
  const result = await b.identity().claim('fresh-token');      // what the page calls right after a login
  await flush();
  assert.equal(result.ok, true);
  const calls = b.requests.filter((r) => r.url === '/api/customer-activity');
  assert.ok(calls.length >= 1 && calls.every((r) => r.auth === 'Bearer fresh-token'));
  assert.deepEqual(b.requests.filter(isDeviceCall), [], 'no guest basket is claimed because none was ever stored');
  assert.equal(b.store.has('elan_guest_browser_key_v2'), false);
  assert.deepEqual(b.cookieWrites.filter((line) => !/max-age=0/.test(line)), []);
  await b.identity().track('cart_add', PRODUCT, null, null, 1);
  assert.ok(b.requests.some((r) => r.body.action === 'track' && r.auth === 'Bearer fresh-token'));
});

test('a customer who refused and signs out is not tracked afterwards', async () => {
  const b = load({ consent: fakeConsent(true), token: 'account-token' });
  await flush();
  b.store.delete('elan_auth_session');                        // signed out, page not reloaded
  const before = b.requests.length;
  await b.identity().track('view', PRODUCT);
  await b.identity().search('oud', []);
  await b.identity().resolve().catch(() => {});
  await b.identity().startFresh();
  b.fire('pointerdown'); b.fire('pagehide'); b.tick();
  await flush();
  assert.deepEqual(b.requests.slice(before), []);
  assert.equal(b.store.has('elan_guest_browser_key_v2'), false);
});

test('a signed-in customer who refuses in another tab: a running device session stops with a reload, the account visit is kept', async () => {
  const consent = fakeConsent();
  const b = load({ consent, token: 'account-token', stored: { elan_guest_browser_key_v2: KEY } });
  await flush();
  assert.ok(b.store.has('elan_visit_v1'), 'the account visit was started');
  consent.refuse();
  assert.ok(b.store.has('elan_visit_v1'), 'the visit id of the account is kept');
  assert.equal(b.reloads(), 1);
});

test('a signed-in customer on a page that never ran device signals needs no reload and keeps the account tracking', async () => {
  const consent = fakeConsent(true);
  const b = load({ consent, token: 'account-token' });
  await flush();
  const before = b.requests.length;
  consent.refuse();                                          // already refused: nothing changes
  assert.equal(b.reloads(), 0, 'nothing device-level was running, so nothing to stop');
  await b.identity().track('view', PRODUCT);
  b.fire('pointerdown');
  b.tick();
  await flush();
  const sent = b.requests.slice(before);
  assert.ok(sent.some((r) => r.body.action === 'track' && r.auth === 'Bearer account-token'), 'account activity goes on');
  assert.deepEqual(sent.filter(isDeviceCall), []);
});

test('automated browsers are not tracked even when signed in', async () => {
  const b = load({ consent: fakeConsent(), token: 'account-token', webdriver: true });
  await flush();
  await b.identity().track('view', PRODUCT);
  assert.deepEqual(b.requests, []);
});
