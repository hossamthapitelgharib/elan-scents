const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const root = path.join(__dirname, '..');
const identitySource = fs.readFileSync(path.join(root, 'guest-identity.js'), 'utf8');
const portalSource = fs.readFileSync(path.join(root, 'portal.js'), 'utf8');
const coreSource = fs.readFileSync(path.join(root, 'app-core.js'), 'utf8');
const oldSessionId = '8ac7c4ab-02f0-4c2c-9cde-b29151ee7712';
const UUIDs = [
  '045a6e52-46c6-42e9-a730-9e5bec3dd201',
  '145a6e52-46c6-42e9-a730-9e5bec3dd202',
  '245a6e52-46c6-42e9-a730-9e5bec3dd203'
];
function storage(seed = {}) {
  const values = new Map(Object.entries(seed));
  return { values, getItem: key => values.has(key) ? values.get(key) : null, setItem: (key, value) => values.set(key, String(value)), removeItem: key => values.delete(key) };
}
function response(body) { return { ok: true, json: async () => body }; }
function loadIdentity() {
  const local = storage({ elan_auth_session: JSON.stringify({ access_token: 'registered-token' }) });
  const session = storage({ elan_customer_activity_session_v1: oldSessionId });
  const requests = [];
  let uuidIndex = 0;
  const window = { location: { search: '' }, crypto: { randomUUID: () => UUIDs[uuidIndex++ % UUIDs.length] }, addEventListener() {} };
  window.parent = window;
  const document = { visibilityState: 'visible', addEventListener() {} };
  const context = {
    window, document, localStorage: local, sessionStorage: session, URLSearchParams,
    fetch: async (url, options = {}) => {
      const call = { url: String(url), options, body: JSON.parse(options.body || '{}') };
      requests.push(call);
      return call.url === '/api/guest-cart' ? response({ ok: true, visitorId: 'guest-1', cart: [] }) : response({ ok: true, tracked: true });
    },
    setTimeout() {}, setInterval() {}
  };
  vm.runInNewContext(identitySource, context, { filename: 'guest-identity.js' });
  return { identity: window.GuestIdentity, local, session, requests };
}

test('logout ends the registered session with its token and rotates the browser session id', async () => {
  const { identity, local, session, requests } = loadIdentity();
  await identity.startSession('registered-token');
  assert.equal(requests[0].body.sessionAction, 'start');
  assert.equal(requests[0].body.sessionId, oldSessionId);
  assert.equal(requests[0].options.headers.Authorization, 'Bearer registered-token');

  await identity.prepareLogout();
  const ending = requests[1];
  assert.equal(ending.body.sessionAction, 'end');
  assert.equal(ending.body.sessionId, oldSessionId);
  assert.equal(ending.options.headers.Authorization, 'Bearer registered-token');
  assert.equal(ending.options.keepalive, true);
  assert.equal(session.getItem('elan_customer_activity_session_v1'), null);

  local.removeItem('elan_auth_session');
  local.removeItem('elan_guest_browser_key_v2');
  await identity.startSession();
  const resolve = requests.find(call => call.url === '/api/guest-cart');
  const guestStart = requests.at(-1);
  assert.ok(resolve);
  assert.equal(guestStart.url, '/api/customer-activity');
  assert.equal(guestStart.body.sessionAction, 'start');
  assert.notEqual(guestStart.body.sessionId, oldSessionId);
  assert.equal(guestStart.options.headers.Authorization, undefined);
  assert.match(guestStart.body.visitorKey, /^[0-9a-f-]{36}$/i);
});

test('storefront wires view, search, add and remove events with product, size and store offer for guests and customers', async () => {
  const events = [
    ['view', 1], ['search', 1], ['cart_add', 2], ['cart_remove', 2]
  ];
  const productId = 'b674011e-50e9-4731-a984-4c8fec18f64a';
  const productSizeId = '76aeaf77-94c9-4382-9f54-93b3c5d70d67';
  const storeProductId = '29249de1-83ec-47ab-92cf-785cf1c41aa3';

  for (const actor of ['guest', 'customer']) {
    const { identity, local, requests } = loadIdentity();
    if (actor === 'guest') local.removeItem('elan_auth_session');

    for (const [eventType, quantity] of events) {
      await identity.track(eventType, productId, productSizeId, storeProductId, quantity);
    }

    const activityCalls = requests.filter(call => call.url === '/api/customer-activity');
    assert.equal(activityCalls.length, 4, `${actor} should send one event for each storefront action`);
    for (let index = 0; index < events.length; index++) {
      const [eventType, quantity] = events[index];
      const call = activityCalls[index];
      assert.equal(call.body.action, 'track');
      assert.equal(call.body.eventType, eventType);
      assert.equal(call.body.productId, productId);
      assert.equal(call.body.productSizeId, productSizeId);
      assert.equal(call.body.storeProductId, storeProductId);
      assert.equal(call.body.quantity, quantity);
      assert.match(call.body.sessionId, /^[0-9a-f-]{36}$/i);
      if (actor === 'guest') {
        assert.equal(call.options.headers.Authorization, undefined);
        assert.match(call.body.visitorKey, /^[0-9a-f-]{36}$/i);
      } else {
        assert.equal(call.options.headers.Authorization, 'Bearer registered-token');
        assert.equal(Object.hasOwn(call.body, 'visitorKey'), false);
      }
    }
    assert.equal(requests.filter(call => call.url === '/api/guest-cart').length, actor === 'guest' ? 1 : 0);
  }

  for (const eventType of ['view', 'search', 'cart_add', 'cart_remove']) {
    assert.match(coreSource, new RegExp(`trackGuestProduct\\(['\"]${eventType}['\"]`), `storefront should wire ${eventType}`);
  }
});

test('portal logout prepares activity session before removing the saved auth session', () => {
  assert.match(portalSource, /identity\.prepareLogout\(\)/);
  assert.match(portalSource, /prepareLogout\(\)[\s\S]*localStorage\.removeItem\('elan_auth_session'\)/);
});
