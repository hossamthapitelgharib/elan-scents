const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const core = fs.readFileSync(path.join(__dirname, '..', 'app-core.js'), 'utf8');

test('authenticated cart hydration preserves the exact store_product_id', () => {
  assert.match(core, /select=store_product_id,quantity/);
  assert.match(core, /var storeProductId=String\(x\.store_product_id\|\|'\'\),sid=sidForStoreProduct\(storeProductId\)/);
  assert.match(core, /storeProductId:cloud\[sid\]\.storeProductId,q:cloud\[sid\]\.q/);
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
