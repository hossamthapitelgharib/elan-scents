const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const root = path.join(__dirname, '..');
const identitySource = fs.readFileSync(path.join(root, 'guest-identity.js'), 'utf8');
const portalSource = fs.readFileSync(path.join(root, 'portal.js'), 'utf8');
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
  const local = storage({ elan_auth_session: JSON.stringify({ access_token: 'registered-token' }), elan_visit_v1: JSON.stringify({ id: oldSessionId, last: Date.now() }) });
  const requests = [];
  let uuidIndex = 0;
  const window = { location: { search: '' }, crypto: { randomUUID: () => UUIDs[uuidIndex++ % UUIDs.length] }, addEventListener() {} };
  window.parent = window;
  const document = { visibilityState: 'visible', addEventListener() {} };
  const context = {
    window, document, localStorage: local, URLSearchParams,
    fetch: async (url, options = {}) => {
      const call = { url: String(url), options, body: JSON.parse(options.body || '{}') };
      requests.push(call);
      return call.url === '/api/guest-cart' ? response({ ok: true, visitorId: 'guest-1', cart: [] }) : response({ ok: true, tracked: true });
    },
    setTimeout() {}, setInterval() {}
  };
  vm.runInNewContext(identitySource, context, { filename: 'guest-identity.js' });
  return { identity: window.GuestIdentity, local, requests };
}

test('logout ends the registered session with its token and rotates the browser session id', async () => {
  const { identity, local, requests } = loadIdentity();
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
  assert.equal(local.getItem('elan_visit_v1'), null);

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

test('portal logout prepares activity session before removing the saved auth session', () => {
  assert.match(portalSource, /identity\.prepareLogout\(\)/);
  assert.match(portalSource, /prepareLogout\(\)[\s\S]*localStorage\.removeItem\('elan_auth_session'\)/);
});
