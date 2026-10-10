const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const source = fs.readFileSync(path.join(__dirname, '..', 'guest-identity.js'), 'utf8');
const storageKey = 'elan_guest_browser_key_v2';

function createBrowser(storage, generatedKey) {
  const requests = [];
  const localStorage = {
    getItem(key) { return storage.has(key) ? storage.get(key) : null; },
    setItem(key, value) { storage.set(key, String(value)); },
    removeItem(key) { storage.delete(key); }
  };
  const context = {
    window: { crypto: { randomUUID: () => generatedKey } },
    localStorage,
    fetch: async (_url, options) => {
      requests.push(JSON.parse(options.body));
      return new Response(JSON.stringify({ ok: true, visitorId: 'visitor', status: 'guest', cart: [] }), { status: 200 });
    },
    Response,
    setTimeout() { return 0; }
  };
  vm.runInNewContext(source, context, { filename: 'guest-identity.js' });
  return { identity: context.window.GuestIdentity, requests, storage };
}

test('same browser storage reuses its random visitor ID and another browser receives a different ID', async () => {
  const existing = new Map([['elan_auth_session', JSON.stringify({ access_token: 'test-token' })]]);
  const firstVisit = createBrowser(existing, '11111111-1111-4111-8111-111111111111');
  await firstVisit.identity.resolve();
  const sameBrowserAgain = createBrowser(existing, '22222222-2222-4222-8222-222222222222');
  await sameBrowserAgain.identity.resolve();

  const otherStorage = new Map([['elan_auth_session', JSON.stringify({ access_token: 'test-token' })]]);
  const otherBrowser = createBrowser(otherStorage, '33333333-3333-4333-8333-333333333333');
  await otherBrowser.identity.resolve();

  const firstId = firstVisit.requests[0].visitorKey;
  assert.equal(firstId, sameBrowserAgain.requests[0].visitorKey);
  assert.notEqual(firstId, otherBrowser.requests[0].visitorKey);
  assert.equal(existing.get(storageKey), firstId);
  assert.equal(otherStorage.get(storageKey), otherBrowser.requests[0].visitorKey);
});
