'use strict';
/* The ONE rule that sorts a store product into "offer", "bundle" or neither (owner's definitions of 17 and 23 Nov 2026,
   docs/catalog-ingestion.ar.md section 8).

   Nothing here is picked by hand: the same function runs for every store, on the first load of a new store and on every later sync,
   and it reads only what the MERCHANT wrote (section names, labels, the product title, its description). It never looks at a price,
   a crossed-out price or a percentage: the word "discount" does not exist on the platform.

   OFFER (عرض): the merchant itself calls a section or a label an offer: the word offer / offers / deal / deals / sale / Black Friday /
   White Friday / Eid / Ramadan / Christmas / عرض / عروض / عيد / رمضان / كريسماس in the section's name (or in a label/tag). The product carries the name of EVERY such section it is in,
   written exactly as the merchant wrote it; when the merchant takes the product out of the section (or deletes the section) the next
   sync finds no section and the message goes away by itself.

   BUNDLE (باقة): a product that holds more than one perfume bottle (any sizes), or a box with a perfume bottle (or a perfume sample)
   plus anything else (sample, cosmetics, body care). The perfume bottle is the hero: a box of oils alone, or an incense set, is not a bundle.
   The merchant may also write the word bundle / باقة. The answer is one of
     'yes'     - sure: the merchant's own words or its contents list say so
     'review'  - doubtful (for example "Collection" in the name with nothing else): hidden from customers until the owner decides
     'no'      - a plain product.
   `reasons` says why, in plain words, so a doubtful item can be judged in one look; `pieces` are the lines of the merchant's own
   contents list, exactly as written (the platform adds nothing to them). */

// section / label words that make a section an OFFER (Arabic words are matched without word boundaries: JS \b does not know Arabic)
// (the owner's list of 23 Nov 2026, and the same day: an occasion word joins it - Eid, Ramadan, Christmas)
const OFFER_WORDS = /عرض|عروض|عيد|رمضان|كريسماس|كريسمس|\boffers?\b|\bdeals?\b|\bsale\b|black\s*friday|white\s*friday|\beid\b|\bramadh?an\b|\bchristmas\b|\bxmas\b/i;
// words in a SECTION name that make the section a bundle section
const BUNDLE_SECTION_WORDS = /bundle|باقة|باقات|\bsets?\b|gift|\bbox\b|\bpack\b|combo|طقم|بوكس|هدية|هدايا/i;
// words in the product TITLE or in the type part of its first description line that say "more than one thing"
const BUNDLE_WORDS = /bundle|باقة|باقات|\bsets?\b|gift|\bbox\b|\bduo\b|\btrio\b|combo|\bpack\b|\bpcs?\b|\bpieces\b|discovery|طقم|بوكس|هدية|هدايا|ديو|تريو/i;
// "3 x 100 ML", "100 ML + 20 ML", "100 ML x 2": a quantity in the size part
const QUANTITY = /\d+\s*[×x]\s*\d+\s*(ml|g)\b|\d+\s*(ml|g)\s*[×x]\s*\d|\d+\s*(ml|g)\s*\+|\b\d+\s*(pcs?|pieces?)\b/i;
// the merchant's own count of bottles in the text: "three full-size 100 ML fragrances", "Nine unique fragrances", "5 miniature fragrances"
const COUNT_PHRASE = /\b(two|three|four|five|six|seven|eight|nine|ten|eleven|twelve|[2-9]|1\d)\s+(?:[\w-]+\s+){0,3}?(?:\d+\s*ml\s+)?(fragrances|perfumes|bottles|scents|eau\s*de\s*parfums|extraits|miniatures)\b/i;
// a name that only says "Collection" (a perfume line is called that too)
const WEAK_WORDS = /\bcollection\b|مجموعة/i;
// a perfume bottle (or a perfume sample) in the text; "perfume oil" and "concentrated oil" are oils, not perfume bottles
const OIL_PHRASE = /(perfum(e|ed)|fragrance|musk|concentrated|attar)\s+oils?|concentrated\s+oils?|\boils?\b|زيت|زيوت/gi;
const PERFUME_WORDS = /eau\s*de\s*(parfum|toilette|cologne)|\bedp\b|\bedt\b|\bextrait\b|\bparfum\b|\bperfum(es?|ed)\b|\bcologne\b|\bfragrances?\b|عطر|عطور|بارفان/i;
// how a store describes a perfume bottle without the word perfume: its notes (Top / Heart / Base) or a "SIZE : 100 ML" line
const BOTTLE_SIGNS = /\b(top|heart|middle|base|opening)\s*(notes?)?\s*:|^\s*notes\s*:?\s*$|\bsize\s*:\s*\d+\s*ml\b|\bformula\b/im;

const htmlToText = (h) => String(h == null ? '' : h)
  .replace(/<\s*(script|style)\b[\s\S]*?<\s*\/\s*\1\s*>/gi, '')
  .replace(/<\s*br\b[^>]*>/gi, '\n')
  .replace(/<\/?\s*(ul|ol)\b[^>]*>/gi, '\n')
  .replace(/<\s*\/\s*(p|div|li|h[1-6]|tr|table)\s*>/gi, '\n')
  .replace(/<\s*li\b[^>]*>/gi, '• ')
  .replace(/<[^>]+>/g, '')
  .replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#0?39;/g, "'")
  .replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(Number(n)))
  .replace(/ /g, ' ')
  .split('\n').map((l) => l.replace(/[ \t\r\f\v]+/g, ' ').trim()).filter((l, i, a) => l || (i > 0 && a[i - 1]))
  .join('\n').trim();

// "THE ALPHA BUNDLE – Men": the first line is "NAME – TYPE – SIZE – GENDER"; the parts after the name say what the product is
const headParts = (text) => {
  const first = text.split('\n').find((l) => l.trim()) || '';
  return first.split(/\s+[–—-]\s+/).map((s) => s.trim()).filter(Boolean);
};

// the lines under "SET INCLUDES" / "BUNDLE INCLUDES" / "SET CONTENTS" / "THE COLLECTION INCLUDES" ... up to the next ruler, heading or paragraph
const contentsList = (text) => {
  const out = [];
  let on = false;
  let bulleted = false;
  for (const raw of text.split('\n')) {
    const s = raw.trim();
    if (!s) continue;
    if (!on) {
      if (/^(the\s+)?(set|bundle|collection|box|gift\s*set|gift\s*box)?\s*(includes|contains|contents|what.?s\s+inside|inside\s+the\s+box)\s*:?$/i.test(s)) on = true;
      continue;
    }
    if (/^[━─=_-]{3,}/.test(s)) { if (out.length) break; continue; }
    if (!s.startsWith('•') && s === s.toUpperCase() && /[A-Z]/.test(s)) { if (out.length) break; continue; }
    if (s.length > 160 && !s.startsWith('•')) { if (out.length) break; continue; }
    if (out.length && s.endsWith(':')) break;                       // the next heading ("Details:")
    if (out.length && bulleted && !s.startsWith('•')) break;       // a list of bullets ends at the first line that is not one
    if (!out.length) bulleted = s.startsWith('•');
    out.push(s.replace(/^[•\-–*·\s]+/, '').trim());
  }
  return out.filter(Boolean);
};

const labelOf = (x) => (typeof x === 'string' ? x : (x && (x.title || x.name || x.handle)) || '');
const plain = (s) => String(s || '').replace(/[-_]+/g, ' ').replace(/\s+/g, ' ').trim();

/* classifyProduct({ title, description, sections, tags })
     description: the merchant's description (HTML or plain text); sections: the merchant's sections/collections the product is in
     (strings, or {title, handle}); tags: the merchant's labels; variants: its variants (strings or {title}), optional.
   returns { offers: [section/label names], bundle: 'yes' | 'review' | 'no', reasons: [...], notes: [...], pieces: [...] } */
function classifyProduct(p) {
  const title = String((p && p.title) || '').trim();
  const text = htmlToText(p && p.description);
  const sections = ((p && p.sections) || []).map((s) => ({ title: String(labelOf(s)).trim(), words: plain((s && s.title) || '') + ' ' + plain((s && s.handle) || (typeof s === 'string' ? s : '')) })).filter((s) => s.title);
  const variants = ((p && p.variants) || []).map((v) => String(v && typeof v === 'object' ? (v.title == null ? '' : v.title) : v)).filter(Boolean);
  const labels = ((p && p.tags) || []).map((t) => String(t).trim()).filter(Boolean);

  // ---- offers: the merchant's own word, in a section name or a label; every section, written as the merchant wrote it
  const offers = [];
  for (const s of sections) if (OFFER_WORDS.test(s.words) && !offers.includes(s.title)) offers.push(s.title);
  for (const t of labels) if (OFFER_WORDS.test(plain(t)) && !offers.includes(t)) offers.push(t);

  // ---- bundle
  const parts = headParts(text);
  const typePart = parts.slice(1).join(' | ');
  const sizePart = parts.slice(1).join(' ');
  const pieces = contentsList(text);
  const sure = [];
  const secBundle = sections.filter((s) => BUNDLE_SECTION_WORDS.test(s.words)).map((s) => s.title);
  if (secBundle.length) sure.push('the merchant put it in its section: ' + secBundle.join(', '));
  if (BUNDLE_WORDS.test(title)) sure.push('the merchant\'s title says it (' + (title.match(BUNDLE_WORDS) || [''])[0] + ')');
  if (typePart && BUNDLE_WORDS.test(typePart)) sure.push('its first description line says it (' + (typePart.match(BUNDLE_WORDS) || [''])[0] + ')');
  if (QUANTITY.test(sizePart) || QUANTITY.test(title)) sure.push('a quantity or a "+" between sizes in the name or the first line');
  else if (/\+/.test(title) || /\+/.test(sizePart)) sure.push('a "+" in the name or the first description line');
  if (pieces.length >= 2) sure.push('the merchant\'s contents list has ' + pieces.length + ' lines');

  // two or more "Size: 100 ml" / "Hair perfume size: 50 ml" lines: the description gives a size to more than one bottle
  const sizeLines = (text.match(/\bsize\s*:\s*\d+\s*ml\b/gi) || []).length;
  if (sizeLines >= 2) sure.push('its description gives a size to ' + sizeLines + ' different bottles');
  // the merchant's own count of bottles in the description: sure only next to its own word "Collection", otherwise it is only a doubt
  const countWord = COUNT_PHRASE.test(text);
  if (countWord && WEAK_WORDS.test(title)) sure.push('its name says Collection and its description counts the bottles');

  let bundle = 'no';
  const reasons = [];
  const weak = WEAK_WORDS.test(title) || (typePart && WEAK_WORDS.test(typePart)) || countWord;
  // a perfume line is called "Collection" too: when the merchant itself describes ONE bottle ("Eau de Parfum – 100 ML", or its one variant
  // "Eau De Parfum / 90 ML"), the name alone does not make a box
  const bottleSizes = new Set();
  for (const m of (text + '\n' + variants.join('\n')).matchAll(/(?:eau\s*de\s*(?:parfum|toilette|cologne)|extrait(?:\s*de\s*parfum)?|\bparfum)\s*[–—\/-]\s*(\d+)\s*ml\b/gi)) bottleSizes.add(m[1]);
  const oneBottle = bottleSizes.size === 1 && !countWord && !/\+/.test(title + typePart);
  const notes = [];
  // a section called "Gift Sets" holding a lone spray proves nothing: the merchant's section alone is a bundle only when it says bundle / باقة
  const sectionOnly = sure.length === 1 && secBundle.length > 0 && !/bundle|باقة|باقات/i.test(secBundle.join(' '));
  if (sectionOnly) {
    bundle = 'review';
    reasons.push('only the merchant\'s section (' + secBundle.join(', ') + ') says it is a box: nothing in the product itself does', ...sure);
  } else if (sure.length) {
    // the perfume bottle (or a perfume sample) is the hero: judged on the name, the first line and the contents list (oils taken out), and,
    // when the name does not speak of oil, on the whole description (the word perfume, its notes, or a "SIZE : 100 ML" line)
    const oilNamed = /\boils?\b|زيت|زيوت/i.test([title, parts.join(' '), pieces.join(' ')].join(' '));
    const near = [title, parts.join(' '), pieces.join(' ')].join(' ').replace(OIL_PHRASE, ' ');
    const whole = text.replace(OIL_PHRASE, ' ');
    const hero = PERFUME_WORDS.test(near) || (!oilNamed && (PERFUME_WORDS.test(whole) || BOTTLE_SIGNS.test(text)));
    if (hero) {
      bundle = 'yes';
      reasons.push(...sure);
    } else if (oilNamed) {
      reasons.push('no perfume bottle or perfume sample in it, oils only: not a bundle', ...sure);
    } else {
      bundle = 'review';
      reasons.push('it looks like a box but no perfume bottle is named in it (oils? incense?)', ...sure);
    }
  } else if (weak && oneBottle) {
    notes.push('the merchant describes one bottle (' + [...bottleSizes][0] + ' ML): "Collection" here is a perfume line, not a box');
  } else if (weak) {
    bundle = 'review';
    reasons.push(countWord && !WEAK_WORDS.test(title) ? 'the description speaks of several bottles but nothing else says it is a box' : 'the name says "Collection" only: it may be a perfume line, not a box');
  }
  return { offers, bundle, reasons, notes, pieces: bundle === 'yes' ? pieces : [] };
}

module.exports = { classifyProduct, htmlToText, contentsList, headParts, OFFER_WORDS, BUNDLE_SECTION_WORDS, BUNDLE_WORDS };
