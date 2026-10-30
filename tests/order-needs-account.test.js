/* Owner decision of 2026-10-30: a visitor browses without an account, but cannot buy without one. Pressing "place order" for a
   store in the cart opens the sign-up form at once with a message that an account is needed, and after signing up or in the
   visitor lands on that store's order form. The database already refuses orders from anyone who is not signed in. */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.resolve(__dirname, '..');
const read = (name) => fs.readFileSync(path.join(root, name), 'utf8');
const core = read('app-core.js'), texts = read('texts.js'), css = read('consent.css');

test('a visitor without an account who presses "place order" gets the sign-up form, not a bare login form', () => {
  assert.match(core, /function openStoreOrder\(store\)\{if\(!AUTH\)\{PENDING_STORE=store;sheet\('signup'\);return\}/);
});

test('the sign-up and login forms carry the "an account is needed to order" message while an order is waiting', () => {
  assert.match(core, /\(PENDING_STORE\?'<p class="auth-need">'\+t\.nb\+'<\/p>':''\)/);
  assert.equal((texts.match(/\bnb:'/g) || []).length, 2, 'the message exists in Arabic and English');
  assert.match(texts, /nb:'تنفيذ الطلب من المتجر يتطلب حسابًا\. أنشئ حسابك/);
  assert.match(texts, /nb:'Placing an order from the shop needs an account\./);
  assert.match(css, /\.auth-need\{/);
});

test('the waiting order is forgotten when the visitor closes the sheet or goes elsewhere, so no later login jumps to an order form', () => {
  assert.match(core, /function closeSheet\(\)\{PENDING_STORE='';/);
  assert.match(core, /function sheet\(k\)\{var t=T\(\),f=k=='login'\|\|k=='signup';if\(!f\)PENDING_STORE='';/);
});

test('after signing up or in, the visitor is taken to the order form of the store they chose', () => {
  assert.match(core, /if\(PENDING_STORE\)\{var st=PENDING_STORE;PENDING_STORE='';openStoreOrder\(st\)\}else sheet\('cart'\)/);
});

test('the database and the API refuse orders from anyone not signed in, whatever the page does', () => {
  assert.match(read('supabase/migrations/20261018215356_create_store_order_request_from_cart.sql'), /v_user_id uuid := auth\.uid\(\)[\s\S]*Authentication required/);
  assert.match(read('supabase/migrations/20261007032605_require_authenticated_checkout_requests.sql'), /revoke execute on function public\.create_store_order_request\(jsonb\) from anon/);
  assert.match(read('scripts/live-check.js'), /\/api\/customer-orders[\s\S]*orders\.status === 401/);
});
