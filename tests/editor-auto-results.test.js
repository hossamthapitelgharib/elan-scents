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

test('store-filtered sections keep only the global offer when that store owns it', () => {
  assert.match(renderer, /globalOffer\(p\)/);
  assert.match(renderer, /storeOwnsGlobalOffer\(p, storeId\)/);
  assert.doesNotMatch(renderer, /var offerSource = f\.store \? \(p\.allOffers \|\| \[\]\)/);
  assert.match(storefront, /stores!inner\(status\).*is_available=eq\.true.*stock_quantity=gt\.0.*sync_status=eq\.synced/);
  assert.match(storefront, /allOffers:allOffers\[o\.product_size_id\]\|\|\[\]/);
});

test('public storefront table reads paginate using stable ordered keys rather than one implicit result page', () => {
  assert.match(storefront, /limit='\+step\+'&offset='\+from/);
  assert.match(storefront, /cheapest_offers\?select=product_size_id,product_id,store_id,store_name,price,currency,stock_quantity,price_includes_tax,price_includes_shipping&order=product_size_id\.asc/);
  assert.match(storefront, /public_products\?select=id,name,brand_name,sales_count,views_count,search_count,request_count,average_rating,short_description,official_description,composition&order=id\.asc/);
});
