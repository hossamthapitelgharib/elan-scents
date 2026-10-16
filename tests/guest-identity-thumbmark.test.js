const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const source = fs.readFileSync(path.join(__dirname, '..', 'guest-identity.js'), 'utf8');

// Loads guest-identity.js in a fresh browser-like context, runs identify() and returns the body
// of the identify request it sent. windowExtras stands in for whatever ThumbmarkJS put on window.
async function identifyWith(windowExtras) {
  const requests = [];
  const storage = new Map();
  const context = {
    window: Object.assign({ crypto: { randomUUID: () => '44444444-4444-4444-8444-444444444444' }, addEventListener() {} }, windowExtras),
    localStorage: {
      getItem(key) { return storage.has(key) ? storage.get(key) : null; },
      setItem(key, value) { storage.set(key, String(value)); },
      removeItem(key) { storage.delete(key); }
    },
    fetch: async (url, options) => {
      if (url === '/vendor/thumbmark.js') return new Response('', { status: 404 });
      requests.push(JSON.parse(options.body));
      return new Response(JSON.stringify({ ok: true, identified: true, finalVisitorId: 'final' }), { status: 200 });
    },
    Response,
    setTimeout() { return 0; },
    setInterval() { return 0; },
    document: { visibilityState: 'visible', addEventListener() {} }
  };
  vm.runInNewContext(source, context, { filename: 'guest-identity.js' });
  await context.window.GuestIdentity.identify();
  return requests.find((body) => body.action === 'identify');
}

const HEX_FP = /^[0-9a-f]{28}$/;

test('ThumbmarkJS 0.20 class API produces the fingerprint and its logging is switched off', async () => {
  const seen = [];
  class Thumbmark {
    constructor(options) { seen.push(options); }
    async get() { return { thumbmark: 'tm-value', components: {} }; }
  }
  const body = await identifyWith({ ThumbmarkJS: { Thumbmark } });
  assert.match(body.fp, HEX_FP);
  assert.equal(seen.length, 1);
  assert.equal(seen[0].logging, false);
});

test('the older getFingerprint API still works and gets logging switched off', async () => {
  const calls = [];
  const legacy = { setOption(key, value) { calls.push([key, value]); }, async getFingerprint() { return 'tm-value'; } };
  const viaLegacy = await identifyWith({ ThumbmarkJS: legacy });
  const viaClass = await identifyWith({ ThumbmarkJS: { Thumbmark: class { async get() { return { thumbmark: 'tm-value' }; } } } });
  assert.deepEqual(calls, [['logging', false]]);
  assert.equal(viaLegacy.fp, viaClass.fp);
});

test('a global Thumbmark class works the same as the namespaced one', async () => {
  const namespaced = await identifyWith({ ThumbmarkJS: { Thumbmark: class { async get() { return { thumbmark: 'tm-value' }; } } } });
  const global = await identifyWith({ Thumbmark: class { async get() { return { thumbmark: 'tm-value' }; } } });
  assert.equal(global.fp, namespaced.fp);
});

test('without ThumbmarkJS, or when it fails, the built-in fingerprint is used and nothing breaks', async () => {
  const withLib = await identifyWith({ ThumbmarkJS: { Thumbmark: class { async get() { return { thumbmark: 'tm-value' }; } } } });
  const none = await identifyWith({});
  const broken = await identifyWith({ ThumbmarkJS: { Thumbmark: class { async get() { throw new Error('boom'); } } } });
  assert.match(none.fp, HEX_FP);
  assert.notEqual(none.fp, withLib.fp);
  assert.equal(broken.fp, none.fp);
});
