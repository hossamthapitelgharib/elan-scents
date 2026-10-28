const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const identitySource = fs.readFileSync(path.join(__dirname, '..', 'guest-identity.js'), 'utf8');
const coreSource = fs.readFileSync(path.join(__dirname, '..', 'app-core.js'), 'utf8');

test('editor iframe preview does not start guest identity, analytics, or persisted customer actions', async () => {
  const network = [];
  const storage = [];
  const listeners = [];
  const location = { search: '?elan_editor=1' };
  const window = {
    parent: {},
    location,
    crypto: { randomUUID: () => '11111111-1111-4111-8111-111111111111' },
    addEventListener() {}
  };
  const context = {
    window,
    location,
    URLSearchParams,
    localStorage: {
      getItem(key) { storage.push(['get', key]); return null; },
      setItem(key, value) { storage.push(['set', key, value]); },
      removeItem(key) { storage.push(['remove', key]); }
    },
    sessionStorage: { getItem() { storage.push(['session-get']); return null; }, setItem() { storage.push(['session-set']); } },
    fetch: async (...args) => { network.push(args); return new Response('{}'); },
    setTimeout() { throw new Error('preview must not schedule a guest session'); },
    setInterval() { throw new Error('preview must not schedule analytics heartbeats'); },
    document: {
      addEventListener(type, listener, capture) { listeners.push({ type, listener, capture }); },
      visibilityState: 'visible'
    },
    Promise,
    Response
  };

  vm.runInNewContext(identitySource, context, { filename: 'guest-identity.js' });
  assert.equal(window.ELAN_EDITOR_PREVIEW, true);
  assert.equal(window.GuestIdentity.enabled(), false);
  await window.GuestIdentity.resolve();
  await window.GuestIdentity.save([]);
  await window.GuestIdentity.track('view', 'product-1');
  await window.GuestIdentity.claim('token');
  assert.deepEqual(network, []);
  assert.deepEqual(storage, []);
  for (const type of ['click', 'auxclick', 'submit', 'contextmenu', 'dragstart']) {
    assert.ok(listeners.some((item) => item.type === type && item.capture === true), `${type} must be inert in preview`);
  }
  assert.match(coreSource, /if\(!window\.ELAN_EDITOR_PREVIEW\)try\{CART=JSON\.parse\(localStorage\.getItem\('elan_cart'\)/);
  assert.match(coreSource, /if\(!window\.ELAN_EDITOR_PREVIEW\)try\{AUTH=JSON\.parse\(localStorage\.getItem\('elan_auth_session'\)/);
  assert.match(coreSource, /if\(window\.ELAN_EDITOR_PREVIEW\)\{[\s\S]*?AUTH=null/);
  assert.match(coreSource, /restoreCancelledStoreItemsFromToken=function\(\)\{\}/);
});

test('editor preview mode does not activate when the storefront is opened as a normal top-level page', () => {
  const window = { parent: null, location: { search: '?elan_editor=1' }, addEventListener() {}, ElanConsent: { analytics: () => true, decided: () => true, onChange() {} } };
  window.parent = window;
  const context = {
    window,
    location: window.location,
    URLSearchParams,
    localStorage: { getItem() { return null; }, setItem() {}, removeItem() {} },
    fetch: async () => new Response('{}'),
    setTimeout() { return 0; },
    setInterval() { return 0; },
    document: { visibilityState: 'visible', addEventListener() {} },
    Promise,
    Response
  };
  vm.runInNewContext(identitySource, context, { filename: 'guest-identity.js' });
  assert.equal(window.ELAN_EDITOR_PREVIEW, false);
  assert.equal(window.GuestIdentity.enabled(), true);
});
