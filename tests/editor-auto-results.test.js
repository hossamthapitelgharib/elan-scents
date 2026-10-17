const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const root = path.resolve(__dirname, '..');
const renderer = fs.readFileSync(path.join(root, 'design-layer.js'), 'utf8');
const storefront = fs.readFileSync(path.join(root, 'app-core.js'), 'utf8');

test('automatic sections apply size filters and do not truncate matching product-size results', () => {
  assert.match(renderer, /f\.size_ml != null[\s\S]*?Number\(p\.sizeMl\) !== Number\(f\.size_ml\)/);
  assert.match(renderer, /sameCatalogName\(nmOf\('cats', i\), f\.cat\)/);
  assert.match(renderer, /sameCatalogName\(nmOf\('occ', i\), f\.occ\)/);
  assert.match(renderer, /sameCatalogName\(nmOf\('notes', i\), f\.note\)/);
  assert.match(renderer, /return l;\s*\}/);
  assert.doesNotMatch(renderer, /return l\.slice\(0, Math\.max\(1, Math\.min\(24/);
  assert.match(storefront, /product_sizes\?select=id,size_label,size_ml,product_id&order=id\.asc/);
  assert.match(storefront, /sizeMl:z\?Number\(z\.size_ml\):null/);
});

test('store-filtered sections use an available offer from that store, not only the global cheapest offer', () => {
  assert.match(renderer, /var offerSource = f\.store \? \(p\.allOffers \|\| \[\]\) : \(p\.offers \|\| \[\]\)/);
  assert.match(storefront, /store_products\?select=id,store_id,product_size_id,price,currency,stock_quantity,is_available,is_new_arrival,price_includes_tax,price_includes_shipping,sync_status,is_catalog_bestseller&order=id\.asc/);
  assert.match(storefront, /allOffers:allOffers\[o\.product_size_id\]\|\|\[\]/);
});

test('public storefront table reads paginate using stable ordered keys rather than one implicit result page', () => {
  assert.match(storefront, /limit='\+step\+'&offset='\+from/);
  assert.match(storefront, /cheapest_offers\?select=product_size_id,product_id,store_id,store_name,price,currency,stock_quantity,price_includes_tax,price_includes_shipping&order=product_size_id\.asc/);
  assert.match(storefront, /public_products\?select=id,name,brand_name,sales_count,views_count,search_count,request_count,average_rating,short_description,official_description,composition&order=id\.asc/);
});
