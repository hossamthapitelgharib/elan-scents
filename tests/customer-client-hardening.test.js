const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.join(__dirname, '..');
const core = fs.readFileSync(path.join(root, 'app-core.js'), 'utf8');
const portal = fs.readFileSync(path.join(root, 'portal.js'), 'utf8');

test('the order sheet has no free text field, so no customer detail can exceed the database ceilings', () => {
  // The customer's data is typed once in «حسابي» (limits checked in customer-account-page.test.js) and copied by the database.
  const review = core.split('\n').find(line => line.startsWith('function orderFormHTML('));
  assert.ok(review, 'the order sheet exists');
  assert.doesNotMatch(review, /<input|<textarea|<select/, 'the order sheet has nothing to type in');
});

test('a cart line is capped at 99 in the page and in what is sent to the account', () => {
  assert.match(core, /if\(want>99\)\{want=99;/);
  assert.match(core, /if\(n>99\)\{n=99;/);
  assert.match(core, /Math\.min\(99,Math\.max\(1,\+c\.q\|\|1\)\)/);
});

test('the cart is saved with the atomic database function, not a delete followed by an insert', () => {
  const push = core.match(/async function pushCartToCloud\(\)\{.*\n/)[0];
  assert.ok(push.includes('/api/customer-cart'));
  assert.ok(push.includes('items:rows'));
  assert.ok(!push.includes("method:'DELETE'"), 'no separate delete of the stored cart');
  assert.ok(!push.includes('/rest/v1/cart_items'), 'no direct write to cart_items');
  // A page that has not loaded the catalog yet must not push an empty list over the stored cart.
  assert.match(push, /if\(snapshot\.length&&!rows\.length&&!PERFUMES\.length\)return;/);
});

test('logging out clears only the local cart and favourites caches and never the order copies', () => {
  const logout = portal.slice(portal.indexOf('logout: async'), portal.indexOf('notifications: {'));
  assert.ok(logout.includes("localStorage.removeItem('elan_cart')"));
  assert.ok(logout.includes("localStorage.removeItem('elan_favs')"));
  const removed = [...logout.matchAll(/removeItem\('([^']+)'\)/g)].map(m => m[1]).sort();
  assert.deepEqual(removed, ['elan_auth_session', 'elan_cart', 'elan_cart_owner', 'elan_favs', 'elan_favs_owner']);
});

test('the storefront no longer carries the unreachable orders sheet that read a table clients cannot read', () => {
  assert.ok(!core.includes('loadOrdersForSheet'));
  assert.ok(!core.includes('/rest/v1/store_order_requests'));
});

test('sign-up and sign-in failures are shown in Arabic instead of the raw server text', () => {
  assert.match(core, /function authFailText\(d,mode\)/);
  assert.match(core, /toast\(authFailText\(d,mode\)\)/);
  assert.ok(!core.includes("toast(d.msg||"), 'the raw server message is not shown');
  const fn = core.match(/function authFailText\(d,mode\)\{[^\n]*\}\n/)[0];
  const run = new Function(fn + '; return authFailText;')();
  assert.match(run({ error_code: 'invalid_credentials', msg: 'Invalid login credentials' }, 'login'), /غير صحيحة/);
  assert.match(run({ id: 'x', email: 'a@b.c', confirmation_sent_at: 'now' }, 'signup'), /تم إنشاء حسابك/);
  assert.match(run({ error_code: 'user_already_exists', msg: 'User already registered' }, 'signup'), /مسجّل بالفعل/);
  // With e-mail confirmation on, Supabase answers a sign-up for an already registered address with a made-up user whose
  // identities list is empty and sends no mail. The shopper must be told that, not «check your inbox».
  assert.match(run({ id: 'x', email: 'a@b.c', identities: [] }, 'signup'), /مسجّل بالفعل/);
  assert.match(run({ id: 'x', email: 'a@b.c', identities: [{ id: 'i' }] }, 'signup'), /تم إنشاء حسابك/);
  assert.match(run({ error_code: 'weak_password', msg: 'Password should be at least 6 characters' }, 'signup'), /ضعيفة/);
  assert.match(run({ error_code: 'over_request_rate_limit' }, 'login'), /محاولات كثيرة/);
  assert.equal(run({}, 'login'), 'تعذر تسجيل الدخول');
});

test('the sign-up password needs 8 characters, the sign-in one has no minimum (older 6-7 character passwords must still log in), both stop at 72', () => {
  assert.match(core, /placeholder="'\+t\.pw\+'"'\+\(k=='signup'\?' minlength="8"':''\)\+' maxlength="72" required>/);
  assert.doesNotMatch(core, /minlength="6"/);
});
