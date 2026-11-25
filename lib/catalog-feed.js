'use strict';
/* Turns the answer of the automatic rule (lib/catalog-classify.js) into the items the ONE entry point public.catalog_receive_items takes
   (migration supabase/migrations/20261125122045_catalog_rule_link.sql). It decides nothing about WHAT a product is: the rule does, and the owner's
   answer on a doubtful product (table catalog_owner_decisions) wins over the rule. The same functions serve a trial store today and a linked
   store's every sync later.

   finalKind(classification, decision)
       'bundle'   the product goes to the entry point as a bundle item (the rule is sure, or the owner said bundle)
       'doubtful' it goes as a bundle item the entry point keeps as a hidden draft until the owner answers
       'plain'    it is an ordinary perfume (the rule says no, or the owner said not_bundle): the caller sends its perfume items, each carrying
                  perfumeOffers(classification) when the merchant has it in an offer section
   bundleItem({ product, classification, base, stock })
       the item for the entry point: the merchant's own title and FULL text, its contents lines, its price and availability, the offer sections;
       null when the product has no handle or no usable price (the caller reports it, nothing is guessed). */

const { htmlToText, contentsList } = require('./catalog-classify.js');

const finalKind = (classification, decision) => {
  if (decision === 'bundle') return 'bundle';
  if (decision === 'not_bundle') return 'plain';
  const c = classification && classification.bundle;
  if (c === 'yes') return 'bundle';
  if (c === 'review') return 'doubtful';
  return 'plain';
};

// the offer sections of a perfume item (a copy: the caller may keep the rule's answer)
const perfumeOffers = (classification) => (classification && Array.isArray(classification.offers) ? classification.offers.slice() : []);

function bundleItem({ product, classification, base = '', stock } = {}) {
  if (!product || !product.handle) return null;
  const variants = Array.isArray(product.variants) ? product.variants : [];
  const open = variants.filter((v) => v && v.available);
  const pool = open.length ? open : variants;
  const prices = pool.map((v) => Number(v && v.price)).filter((n) => Number.isFinite(n) && n > 0);
  if (!prices.length) return null;
  const available = open.length > 0;
  const text = htmlToText(product.body_html);
  const pieces = classification && classification.pieces && classification.pieces.length ? classification.pieces : contentsList(text);
  const item = {
    kind: 'bundle',
    source_key: String(product.handle),
    title: String(product.title || '').trim(),
    description: text,
    price: Math.min(...prices),
    // a trial store has no stock figure: a placeholder that follows availability; a linked store passes its real number
    stock_quantity: typeof stock === 'function' ? stock(product, variants) : (available ? 10 : 0),
    available,
    bundle: classification && classification.bundle === 'yes' ? 'yes' : 'review',
    offers: perfumeOffers(classification),
    reasons: classification && Array.isArray(classification.reasons) ? classification.reasons.slice() : [],
    pieces,
  };
  if (base) item.product_url = String(base) + String(product.handle);
  return item;
}

// the entry point takes at most 1000 items per call
const chunk = (items, size = 500) => {
  const out = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
};

module.exports = { finalKind, perfumeOffers, bundleItem, chunk };
