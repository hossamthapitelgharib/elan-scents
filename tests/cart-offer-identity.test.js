const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const core = fs.readFileSync(path.join(__dirname, '..', 'app-core.js'), 'utf8');

test('authenticated cart hydration preserves the exact store_product_id through the server API', () => {
  assert.match(core, /fetch\('\/api\/customer-cart',\{headers:\{Authorization:'Bearer '\+\(AUTH&&AUTH\.access_token\|\|''\)\}\}\)/);
  assert.match(core, /function customerCartRows\(items\).*storeProductId=String\(x&&x\.storeProductId\|\|''\).*quantity/);
  assert.match(core, /storeProductId:storeProductId,q:Math\.max\(1,\+x\.quantity\|\|1\)/);
  assert.match(core, /expectedRevision:CART_SERVER_REVISION/);
  assert.doesNotMatch(core, /rest\/v1\/cart_items/);
});

test('guest cart hydration preserves offer identity and observed pricing metadata', () => {
  assert.match(core, /row\.storeProductId/);
  assert.match(core, /storeId:row\.storeId\|\|old\.storeId\|\|''/);
  assert.match(core, /observedPrice:row\.observedPrice==null\?old\.observedPrice:row\.observedPrice/);
  assert.match(core, /storeProductId:cloud\[sid\]\.storeProductId/);
});

test('cancelled-order restoration keeps the server-confirmed offer identity', () => {
  assert.match(core, /storeProductId:x\.storeProductId\|\|storeProductIdFor\(id\)/);
  assert.match(core, /if\(x\.storeProductId\)it\.storeProductId=x\.storeProductId/);
});

test('cart rendering still rejects a line whose canonical offer changed', () => {
  assert.match(core, /String\(current\.storeProductId\)==String\(c\.storeProductId\)/);
  assert.match(core, /review:!b\|\|/);
});
