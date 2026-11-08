// Several tabs of one browser (owner, 8 Nov 2026: four tabs open while registering). The session lives in localStorage, so when one tab signs in,
// switches account or signs out, every other tab has to follow at once instead of keeping the old account's cart and hearts in memory.
// app-core.js is one long file, so the function under test is cut out and run against a fake page.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const CORE = fs.readFileSync(path.join(__dirname, '..', 'app-core.js'), 'utf8');
const FN = CORE.slice(CORE.indexOf('function crossTabAuth('), CORE.indexOf('function readConfirmLink('));
const KEY = 'elan_auth_session';

function tab({ auth = null, cart = [{ sid: 's1', q: 2 }], favs = ['f1', 'f2'], cartOwner = '', favOwner = '', preview = false, loggingOut = false } = {}) {
  const log = { reloads: 0, menus: 0, adopted: [], cartSync: [], favSync: 0 };
  const context = vm.createContext({
    AUTH: auth, CART: cart, FAVS: favs, CART_OWNER: cartOwner, FAV_OWNER: favOwner, CART_REV: 0, FAV_REV: 0, LOGGING_OUT: loggingOut, CART_FIRST_SYNC_DONE: false,
    location: { reload: () => { log.reloads++; } }, JSON,
    buildMenu: () => { log.menus++; }, adoptAccountLists: (id) => log.adopted.push(id),
    syncCartFromCloud: (merge) => { log.cartSync.push(merge); }, syncFavsFromCloud: () => { log.favSync++; }
  });
  context.window = context;
  if (preview) context.ELAN_EDITOR_PREVIEW = true;
  vm.runInContext('var AUTH_ID=function(){return AUTH&&AUTH.user&&AUTH.user.id||""};' + FN.replace(/authUserId\(\)/g, 'AUTH_ID()'), context, { filename: 'app-core.js (cross tab)' });
  const fire = (key, value) => vm.runInContext('crossTabAuth', context)({ key, newValue: value });
  return { fire, log, context };
}
const session = (id) => JSON.stringify({ access_token: 't-' + id, user: { id } });

test('another tab signed out: this tab drops the lists from memory, stops writing and reloads as a visitor', () => {
  const t = tab({ auth: { access_token: 't', user: { id: 'u1' } }, cartOwner: 'u1', favOwner: 'u1' });
  t.fire(KEY, null);
  assert.equal(t.context.AUTH, null);
  assert.equal(t.context.LOGGING_OUT, true, 'no cart or favourites write can happen between now and the reload');
  assert.deepEqual(Array.from(t.context.CART), []);
  assert.deepEqual(Array.from(t.context.FAVS), []);
  assert.equal(t.log.reloads, 1);
});

test('another tab signed in while this one was a visitor: this tab\'s own lists join the account at once', () => {
  const t = tab({ auth: null });
  t.fire(KEY, session('u1'));
  assert.equal(t.context.AUTH.user.id, 'u1');
  assert.deepEqual(t.log.adopted, ['u1']);
  assert.deepEqual(t.log.cartSync, [true], 'first sync of this tab merges what the visitor had');
  assert.equal(t.log.favSync, 1);
  assert.equal(t.log.reloads, 0);
  assert.equal(t.log.menus, 1);
  assert.equal(t.context.CART.length, 1, 'nothing is thrown away here; adoptAccountLists decides about another owner\'s lists');
});

test('another tab switched to a different account: the lists are adopted for the new account (the old account\'s are dropped by adoptAccountLists)', () => {
  const t = tab({ auth: { access_token: 't', user: { id: 'u1' } }, cartOwner: 'u1', favOwner: 'u1' });
  t.fire(KEY, session('u2'));
  assert.deepEqual(t.log.adopted, ['u2']);
  assert.equal(t.log.reloads, 0);
});

test('a refreshed token of the same account only updates the session: no reload and no sync', () => {
  const t = tab({ auth: { access_token: 'old', user: { id: 'u1' } } });
  t.fire(KEY, session('u1'));
  assert.equal(t.context.AUTH.access_token, 't-u1');
  assert.deepEqual(t.log.adopted, []);
  assert.deepEqual(t.log.cartSync, []);
  assert.equal(t.log.reloads, 0);
  assert.equal(t.log.menus, 1);
});

test('other keys, the editor preview, a tab that is itself signing out, and a broken value are all safe', () => {
  const other = tab({ auth: { user: { id: 'u1' } } });
  other.fire('elan_cart', '[]');
  assert.equal(other.log.menus, 0);
  assert.equal(other.context.AUTH.user.id, 'u1');
  const preview = tab({ auth: { user: { id: 'u1' } }, preview: true });
  preview.fire(KEY, null);
  assert.equal(preview.context.AUTH.user.id, 'u1', 'the editor preview never follows the session');
  const busy = tab({ auth: { user: { id: 'u1' } }, loggingOut: true });
  busy.fire(KEY, null);
  assert.equal(busy.log.reloads, 0, 'the tab that is signing out reloads by itself, once');
  const broken = tab({ auth: { user: { id: 'u1' } } });
  broken.fire(KEY, '{not json');
  assert.equal(broken.context.AUTH, null, 'an unreadable session counts as signed out');
  assert.equal(broken.log.reloads, 1);
});

test('the page listens for the session key with this function', () => {
  assert.match(CORE, /window\.addEventListener\('storage',crossTabAuth\);/);
});
