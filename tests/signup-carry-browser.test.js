// The browser half of the signup carry (owner, 9 Nov 2026): the cart and hearts of the browser where an account was created reach the account even
// when the confirmation link opens in another browser. app-core.js is one long file, so only the functions under test are cut out and run against a fake
// page and a fake server (no network, no real addresses). The end-to-end order (claim answered before the cart is read) is journey 20 in tests/browser.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const CORE = fs.readFileSync(path.join(__dirname, '..', 'app-core.js'), 'utf8');
const lineOf = (start) => { const i = CORE.indexOf(start); assert.ok(i >= 0, start + ' exists'); return CORE.slice(i, CORE.indexOf('\n', i)); };
const STASH = lineOf('function carryStash(') + '\n' + lineOf('function carryStashNow(');
const CLAIM = lineOf('function carryClaim(');
const ISUUID = lineOf('function isUuid(');

const SZ1 = 'e0000000-0000-4000-8000-0000000000c1', SZ2 = 'e0000000-0000-4000-8000-0000000000c2';
const SP1 = 'e0000000-0000-4000-8000-0000000000b1', SP2 = 'e0000000-0000-4000-8000-0000000000b2';
const NEW_USER = 'e0000000-0000-4000-8000-0000000000a1';
const HOUR = 3600 * 1000;

function build({ cart = [], favs = [], preview = false, answer = { ok: true, json: async () => ({ ok: true, claimed: true, cart: 1, favs: 0 }) }, fail = false, never = false } = {}) {
  const log = { requests: [], timers: [] };
  const context = vm.createContext({
    CART: cart, FAVS: favs, window: preview ? { ELAN_EDITOR_PREVIEW: true } : {}, Date, Math, JSON, Promise, Array, String, Number, isNaN,
    storeProductIdFor: (sid) => ({ [SZ2]: SP2 }[sid] || ''),
    fetch: (url, init) => {
      log.requests.push({ url, init, body: JSON.parse(init.body) });
      if (fail) return Promise.reject(new Error('offline'));
      return never ? new Promise(() => {}) : Promise.resolve(answer);
    },
    setTimeout: (fn, ms) => { log.timers.push({ fn, ms }); return log.timers.length; }
  });
  context.window.ELAN_EDITOR_PREVIEW = preview || undefined;
  vm.runInContext(ISUUID + '\n' + STASH + '\n' + CLAIM, context, { filename: 'app-core.js (carry)' });
  return { stash: (id) => vm.runInContext('carryStash', context)(id), claim: (tk, user) => vm.runInContext('carryClaim', context)(tk, user), log, context };
}

test('stash: the lists leave with the new account\'s id and nothing that identifies the browser', async () => {
  const s = build({
    cart: [{ sid: SZ1, storeProductId: SP1, q: 2, storeName: 'Test Store', observedPrice: 99 }, { sid: SZ2, q: 120 }, { sid: 'x', storeProductId: 'not-a-uuid', q: 1 }, { sid: 'y', q: 1 }],
    favs: [SZ1, 'junk', SZ2]
  });
  await s.stash(NEW_USER);
  assert.equal(s.log.requests.length, 1);
  const call = s.log.requests[0];
  assert.equal(call.url, '/api/signup-carry');
  assert.equal(call.init.method, 'POST');
  assert.deepEqual(Object.keys(call.init.headers), ['Content-Type'], 'no token, no browser key');
  assert.deepEqual(call.body, {
    action: 'stash', userId: NEW_USER,
    cart: [{ sid: SZ1, storeProductId: SP1, q: 2 }, { sid: SZ2, storeProductId: SP2, q: 99 }],
    favs: [SZ1, SZ2]
  });
});

test('stash: nothing to leave, a bad id, the editor preview, an offline network or a missing helper never throw and never reach the server', async () => {
  const empty = build({}); await empty.stash(NEW_USER); assert.equal(empty.log.requests.length, 0);
  const onlyBad = build({ cart: [{ sid: 'y', q: 1 }], favs: ['junk'] }); await onlyBad.stash(NEW_USER); assert.equal(onlyBad.log.requests.length, 0);
  const noId = build({ favs: [SZ1] }); await noId.stash(undefined); await noId.stash('nope'); assert.equal(noId.log.requests.length, 0);
  const preview = build({ favs: [SZ1], preview: true }); await preview.stash(NEW_USER); assert.equal(preview.log.requests.length, 0, 'the editor preview sends nothing');
  const offline = build({ favs: [SZ1], fail: true }); assert.equal(await offline.stash(NEW_USER), undefined, 'a failed request is swallowed');
  const broken = build({ favs: [SZ1] }); delete broken.context.isUuid; vm.runInContext('isUuid = undefined', broken.context);
  assert.equal(await broken.stash(NEW_USER), undefined, 'a problem inside the hand-over can never break the sign-up notice');
});

test('claim: with the account\'s token, once, and the answer only says whether something was taken', async () => {
  const s = build();
  assert.equal(await s.claim('new-token'), true);
  assert.equal(s.log.requests.length, 1);
  assert.equal(s.log.requests[0].url, '/api/signup-carry');
  assert.equal(s.log.requests[0].init.headers.Authorization, 'Bearer new-token');
  assert.deepEqual(s.log.requests[0].body, { action: 'claim' }, 'it names no account: the token decides');
  const none = build({ answer: { ok: true, json: async () => ({ ok: true, claimed: false, cart: 0, favs: 0 }) } });
  assert.equal(await none.claim('new-token'), false);
  const refused = build({ answer: { ok: false, json: async () => ({}) } });
  assert.equal(await refused.claim('new-token'), false);
  const noToken = build(); assert.equal(await noToken.claim(''), false); assert.equal(noToken.log.requests.length, 0);
  const preview = build({ preview: true }); assert.equal(await preview.claim('new-token'), false); assert.equal(preview.log.requests.length, 0);
  const offline = build({ fail: true }); assert.equal(await offline.claim('new-token'), false, 'a failed request never rejects');
});

test('claim at sign-in: only an account made in the last three days asks; an old one or one of unknown age does not', async () => {
  const fresh = (ms) => ({ created_at: new Date(Date.now() - ms).toISOString() });
  const young = build(); assert.equal(await young.claim('tok', fresh(HOUR)), true); assert.equal(young.log.requests.length, 1);
  const edge = build(); await edge.claim('tok', fresh(71 * HOUR)); assert.equal(edge.log.requests.length, 1, 'just under three days');
  const old = build(); assert.equal(await old.claim('tok', fresh(73 * HOUR)), false); assert.equal(old.log.requests.length, 0);
  const unknown = build(); assert.equal(await unknown.claim('tok', {}), false); assert.equal(await unknown.claim('tok', { created_at: 'garbage' }), false); assert.equal(unknown.log.requests.length, 0);
  const link = build(); await link.claim('tok'); assert.equal(link.log.requests.length, 1, 'the confirmation link passes no user and always asks');
});

test('claim: a slow server is waited for four seconds at most, then the page goes on', async () => {
  const s = build({ never: true });
  const pending = s.claim('new-token');
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(s.log.timers.length, 1);
  assert.equal(s.log.timers[0].ms, 4000);
  s.log.timers[0].fn();
  assert.equal(await pending, false);
});

test('the wiring: stash after a sign-up that waits for the e-mail, claim before the other syncs at the link and at a sign-in', () => {
  const pending = lineOf('function authSubmit(');
  const at = pending.indexOf("signupPending(d)){");
  assert.ok(at > 0);
  const branch = pending.slice(at, pending.indexOf('return}', at));
  assert.ok(branch.indexOf('carryStash(d.id)') > 0 && branch.indexOf('carryStash(d.id)') < branch.indexOf("sheetNotice('signupDone'"), 'the stash is fired (not awaited) before the notice');
  assert.doesNotMatch(branch, /await carryStash/, 'the notice never waits for it');
  const signIn = pending.slice(pending.indexOf("else welcomeNotice();"));
  const order = ["carryClaim(d.access_token,d.user)", 'await GuestIdentity.claim', 'await syncCartFromCloud', 'await syncFavsFromCloud'].map((m) => { const i = signIn.indexOf(m); assert.ok(i >= 0, m); return i; });
  assert.deepEqual(order, [...order].sort((x, y) => x - y), 'carried lists, guest claim, then the syncs');
  assert.match(signIn, /if\(mode=='login'\)await carryClaim/, 'only a sign-in asks (a sign-up that gets a session at once has its lists in this very browser)');
  const link = lineOf('function readConfirmLink(');
  const li = link.indexOf('try{await carryClaim(d.access_token);');
  assert.ok(li > 0 && li < link.indexOf('await GuestIdentity.claim') && li < link.indexOf('await syncCartFromCloud(true)'), 'at the confirmation link the carried lists are taken first');
  assert.match(link, /mailEvent\('registered',tk\);try\{await carryClaim/);
});

test('the hand-over uses no browser key, cookie, fingerprint or stored device list: it belongs to the account the customer just made', () => {
  for (const fn of [STASH, CLAIM]) {
    assert.doesNotMatch(fn, /GuestIdentity|ElanConsent|document\.cookie|elan_guest|elan_vk|elan_gid|localStorage|sessionStorage|fingerprint/i);
  }
  assert.match(STASH, /ELAN_EDITOR_PREVIEW/);
  assert.match(CLAIM, /ELAN_EDITOR_PREVIEW/);
});
