const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const source = fs.readFileSync(path.join(__dirname, '..', 'guest-identity.js'), 'utf8');
const KEY = 'elan_guest_browser_key_v2';
const VISIT = 'elan_visit_v1';
let counter = 0;
const uuid = () => { counter += 1; return `00000000-0000-4000-8000-${String(counter).padStart(12, '0')}`; };

function shared(opts = {}) {
  const values = new Map();
  return {
    values, cookies: new Map(),
    blocked: !!opts.blocked
  };
}
// One call = one tab. Tabs of the same browser share `browser` (storage + cookies).
function openTab(browser, now = () => Date.now()) {
  const requests = [], listeners = {};
  const localStorage = {
    getItem(k) { if (browser.blocked) throw new Error('blocked'); return browser.values.has(k) ? browser.values.get(k) : null; },
    setItem(k, v) { if (browser.blocked) throw new Error('blocked'); browser.values.set(k, String(v)); },
    removeItem(k) { if (browser.blocked) throw new Error('blocked'); browser.values.delete(k); }
  };
  const document = {
    visibilityState: 'visible', addEventListener() {},
    get cookie() { return [...browser.cookies].map(([k, v]) => `${k}=${v}`).join('; '); },
    set cookie(line) {
      const [pair] = String(line).split(';'); const i = pair.indexOf('=');
      const k = pair.slice(0, i).trim(), v = pair.slice(i + 1).trim();
      if (/max-age=0/i.test(line)) browser.cookies.delete(k); else browser.cookies.set(k, v);
    }
  };
  const window = { location: { search: '', protocol: 'https:' }, crypto: { randomUUID: uuid }, addEventListener(type, fn) { listeners[type] = fn; } };
  window.parent = window;
  const realNow = Date.now;
  const context = {
    window, document, localStorage, URLSearchParams, Date: Object.assign(function () { return new Date(now()); }, { now }),
    fetch: async (url, options = {}) => {
      const body = JSON.parse(options.body || '{}'); requests.push({ url: String(url), body });
      return { ok: true, json: async () => String(url) === '/api/guest-cart' ? { ok: true, visitorId: 'v', cart: [] } : { ok: true, tracked: true } };
    },
    setTimeout() { return 0; }, setInterval() { return 0; }
  };
  vm.runInNewContext(source, context, { filename: 'guest-identity.js' });
  return { identity: window.GuestIdentity, requests, listeners, restore: () => { Date.now = realNow; } };
}

test('two tabs opened on a first visit share one visitor key and one visit', async () => {
  const browser = shared();
  const a = openTab(browser), b = openTab(browser);
  await a.identity.resolve(); await b.identity.resolve();
  await a.identity.startSession(); await b.identity.startSession();
  const keys = new Set([...a.requests, ...b.requests].map((r) => r.body.visitorKey));
  assert.equal(keys.size, 1);
  const visits = new Set([...a.requests, ...b.requests].filter((r) => r.url === '/api/customer-activity').map((r) => r.body.sessionId));
  assert.equal(visits.size, 1);
});

test('blocked storage falls back to a cookie, so a reload is not a new visitor', async () => {
  const browser = shared({ blocked: true });
  const first = openTab(browser); await first.identity.resolve();
  const reload = openTab(browser); await reload.identity.resolve();
  assert.equal(first.requests[0].body.visitorKey, reload.requests[0].body.visitorKey);
  assert.ok(browser.cookies.get('elan_vk'));
});

test('a visit continues for 29 idle minutes and a new one starts after 31', async () => {
  const browser = shared(); let t = 1_800_000_000_000;
  const tab = openTab(browser, () => t);
  await tab.identity.startSession();
  const first = tab.requests.filter((r) => r.url === '/api/customer-activity')[0].body.sessionId;
  t += 29 * 60000;
  assert.equal(tab.identity.sessionId(true), first);
  t += 31 * 60000;
  assert.notEqual(tab.identity.sessionId(true), first);
});

test('the same product viewed twice within 30 seconds is one view', async () => {
  const browser = shared(); let t = 1_800_000_000_000;
  const tab = openTab(browser, () => t);
  const product = '245a6e52-46c6-42e9-a730-9e5bec3dd203';
  await tab.identity.track('view', product); await tab.identity.track('view', product);
  t += 31000; await tab.identity.track('view', product);
  assert.equal(tab.requests.filter((r) => r.body.eventType === 'view').length, 2);
});

test('closing one tab does not end the visit other tabs still use', async () => {
  const browser = shared();
  const tab = openTab(browser);
  await tab.identity.startSession();
  tab.listeners.pointerdown();
  await new Promise((r) => setImmediate(r));
  tab.requests.length = 0;
  tab.listeners.pagehide();
  await new Promise((r) => setImmediate(r));
  const sent = tab.requests.filter((r) => r.url === '/api/customer-activity').map((r) => r.body.sessionAction);
  assert.deepEqual(sent, ['heartbeat']);
});

test('an idle page adds no active time: the last heartbeat is skipped and a return re-opens the visit without a heartbeat', async () => {
  const browser = shared(); let t = 1_800_000_000_000;
  const tab = openTab(browser, () => t);
  await tab.identity.startSession();
  tab.listeners.pointerdown();            // first touch
  await new Promise((r) => setImmediate(r)); tab.requests.length = 0;
  t += 120000;                            // two quiet minutes
  tab.listeners.pagehide();               // leaving while idle must not add idle time
  await new Promise((r) => setImmediate(r));
  assert.equal(tab.requests.filter((r) => r.url === '/api/customer-activity').length, 0);
  tab.listeners.pointerdown();            // coming back
  await new Promise((r) => setImmediate(r));
  const sent = tab.requests.filter((r) => r.url === '/api/customer-activity').map((r) => r.body.sessionAction);
  assert.deepEqual(sent, ['start']);
});

test('automated browsers (webdriver) are never tracked', async () => {
  const sent = [];
  const context = {
    window: { location: { search: '' }, crypto: { randomUUID: uuid }, addEventListener() {} }, navigator: { webdriver: true },
    document: { visibilityState: 'visible', addEventListener() {} }, localStorage: { getItem() { return null; }, setItem() {}, removeItem() {} },
    URLSearchParams, fetch: async (...a) => { sent.push(a); return { ok: true, json: async () => ({}) }; }, setTimeout() {}, setInterval() {}
  };
  context.window.parent = context.window;
  vm.runInNewContext(source, context, { filename: 'guest-identity.js' });
  assert.equal(context.window.GuestIdentity.enabled(), false);
  await context.window.GuestIdentity.track('view', '245a6e52-46c6-42e9-a730-9e5bec3dd203');
  assert.equal(sent.length, 0);
});
