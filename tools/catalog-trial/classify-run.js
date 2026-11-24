#!/usr/bin/env node
'use strict';
/* Dry run of the automatic offer/bundle rule (lib/catalog-classify.js) on a store's PUBLIC pages. Writes NOTHING to any database.
   Run:  CATALOG_FEEDS_DIR=feeds CATALOG_SECTIONS_DIR=sections node tools/catalog-trial/classify-run.js [store ...]
   (default stores: afnan-egypt emarati-scents)
   CATALOG_FEEDS_DIR     <store>-page-N.json : the store's products.json pages
   CATALOG_SECTIONS_DIR  <store>-collections.json : the store's section list [{handle,title,...}] and
                         <store>-col-*.json : {handle, products:[{handle,...}]} for the sections to read
   Prints, per store: the sections whose NAME carries an offer word or a bundle word (and whether their file was read, so a missing section
   is seen), the offers found, the bundles found (sure / doubtful) with the reason, and writes classified_<store>.json. */
const fs = require('node:fs');
const path = require('node:path');
const { classifyProduct, OFFER_WORDS, BUNDLE_SECTION_WORDS } = require('../../lib/catalog-classify.js');

const FEEDS = process.env.CATALOG_FEEDS_DIR || 'feeds';
const SECTIONS = process.env.CATALOG_SECTIONS_DIR || 'sections';
const stores = process.argv.slice(2).length ? process.argv.slice(2) : ['afnan-egypt', 'emarati-scents'];
const readJson = (f) => JSON.parse(fs.readFileSync(f, 'utf8'));
const files = (dir, re) => fs.readdirSync(dir).filter((f) => re.test(f)).sort((a, b) => a.localeCompare(b, 'en', { numeric: true }));
const plain = (s) => String(s || '').replace(/[-_]+/g, ' ');

for (const store of stores) {
  const products = [];
  for (const f of files(FEEDS, new RegExp('^' + store + '-page-\\d+\\.json$'))) {
    const d = readJson(path.join(FEEDS, f));
    products.push(...(Array.isArray(d) ? d : d.products));
  }
  const list = fs.existsSync(path.join(SECTIONS, store + '-collections.json')) ? readJson(path.join(SECTIONS, store + '-collections.json')) : [];
  const titleOf = new Map(list.map((c) => [c.handle, c.title]));
  const memberOf = new Map();   // product handle -> [{title, handle}]
  const read = [];
  for (const f of files(SECTIONS, new RegExp('^' + store + '-col-.*\\.json$'))) {
    const c = readJson(path.join(SECTIONS, f));
    const sec = { title: titleOf.get(c.handle) || c.handle, handle: c.handle };
    read.push({ ...sec, n: c.products.length });
    for (const p of c.products) memberOf.set(p.handle, [...(memberOf.get(p.handle) || []), sec]);
  }
  console.log('\n==================== ' + store + ' — ' + products.length + ' products, ' + list.length + ' sections in the store\'s list');
  console.log('-- sections whose NAME carries an offer word or a bundle word:');
  for (const c of list) {
    const w = plain(c.title) + ' ' + plain(c.handle);
    const kinds = [OFFER_WORDS.test(w) ? 'offer' : '', BUNDLE_SECTION_WORDS.test(w) ? 'bundle' : ''].filter(Boolean).join('+');
    if (!kinds) continue;
    const got = read.find((r) => r.handle === c.handle);
    console.log('   ' + kinds.padEnd(13) + String(c.title).padEnd(44) + ' store says ' + String(c.products_count).padStart(3) + ' | public products read: ' + (got ? got.n : 'NOT READ'));
  }
  const out = [];
  for (const p of products) {
    const r = classifyProduct({ title: p.title, description: p.body_html, sections: memberOf.get(p.handle) || [], tags: p.tags || [], variants: (p.variants || []).map((x) => x.title) });
    out.push({ handle: p.handle, title: p.title, ...r });
  }
  const offers = out.filter((x) => x.offers.length);
  const byOffer = {};
  for (const x of offers) for (const o of x.offers) byOffer[o] = (byOffer[o] || 0) + 1;
  console.log('-- OFFERS: ' + offers.length + ' products carry an offer message');
  for (const [k, v] of Object.entries(byOffer)) console.log('   ' + String(v).padStart(4) + '  ' + k);
  const yes = out.filter((x) => x.bundle === 'yes'), review = out.filter((x) => x.bundle === 'review');
  const notBundle = out.filter((x) => x.bundle === 'no' && x.reasons.length);
  console.log('-- BUNDLES: ' + yes.length + ' sure, ' + review.length + ' doubtful (waiting for the owner), ' + notBundle.length + ' not a bundle because the perfume bottle is missing');
  for (const x of yes) console.log('   SURE   ' + x.title.slice(0, 52).padEnd(54) + x.reasons.map((r) => r.replace(/^the merchant('s)? /, '')).join(' | ').slice(0, 90));
  for (const x of review) console.log('   REVIEW ' + x.title.slice(0, 52).padEnd(54) + x.reasons.join(' | '));
  for (const x of notBundle) console.log('   NO     ' + x.title.slice(0, 52).padEnd(54) + x.reasons[0]);
  fs.writeFileSync('classified_' + store + '.json', JSON.stringify(out, null, 1));
}
