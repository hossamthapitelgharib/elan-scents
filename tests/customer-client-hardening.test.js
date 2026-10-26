const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.join(__dirname, '..');
const core = fs.readFileSync(path.join(root, 'app-core.js'), 'utf8');
const portal = fs.readFileSync(path.join(root, 'portal.js'), 'utf8');

test('the checkout form limits stay below the database ceilings', () => {
  const ceilings = { name: 120, phone: 32, email: 254, address: 500, notes: 1000 };
  for (const [field, ceiling] of Object.entries(ceilings)) {
    const match = core.match(new RegExp('<(?:input|textarea) name="' + field + '"[^>]*maxlength="(\\d+)"'));
    assert.ok(match, `the ${field} field has a maxlength`);
    assert.ok(Number(match[1]) <= ceiling, `${field}: ${match && match[1]} is within ${ceiling}`);
  }
});

test('a cart line is capped at 99 in the page and in what is sent to the account', () => {
  assert.match(core, /if\(want>99\)\{want=99;/);
  assert.match(core, /if\(n>99\)\{n=99;/);
  assert.match(core, /Math\.min\(99,Math\.max\(1,\+c\.q\|\|1\)\)/);
});

test('the cart is saved with the atomic database function, not a delete followed by an insert', () => {
  const push = core.match(/async function pushCartToCloud\(\)\{.*\n/)[0];
  assert.ok(push.includes('/rest/v1/rpc/replace_customer_cart'));
  assert.ok(push.includes('p_items:rows'));
  assert.ok(!push.includes("method:'DELETE'"), 'no separate delete of the stored cart');
  assert.ok(!push.includes('/rest/v1/cart_items'), 'no direct write to cart_items');
  // A page that has not loaded the catalog yet must not push an empty list over the stored cart.
  assert.match(push, /if\(snapshot\.length&&!rows\.length&&!PERFUMES\.length\)return;/);
});

test('logging out clears only the local cart cache and never the order copies', () => {
  const logout = portal.slice(portal.indexOf('logout: async'), portal.indexOf('notifications: {'));
  assert.ok(logout.includes("localStorage.removeItem('elan_cart')"));
  const removed = [...logout.matchAll(/removeItem\('([^']+)'\)/g)].map(m => m[1]).sort();
  assert.deepEqual(removed, ['elan_auth_session', 'elan_cart']);
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
  assert.match(run({ error_code: 'weak_password', msg: 'Password should be at least 6 characters' }, 'signup'), /ضعيفة/);
  assert.match(run({ error_code: 'over_request_rate_limit' }, 'login'), /محاولات كثيرة/);
  assert.equal(run({}, 'login'), 'تعذر تسجيل الدخول');
});

test('the sign-up password needs 8 characters, the sign-in one has no minimum (older 6-7 character passwords must still log in), both stop at 72', () => {
  assert.match(core, /placeholder="'\+t\.pw\+'"'\+\(k=='signup'\?' minlength="8"':''\)\+' maxlength="72" required>/);
  assert.doesNotMatch(core, /minlength="6"/);
});
