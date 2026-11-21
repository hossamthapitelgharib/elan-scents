const test = require('node:test');
const assert = require('node:assert/strict');
const { read } = require('./browser-fixture');

/* Owner, 2026-11-19. The behaviour itself is proved in a real browser (tests/browser/card-fit.chromium.js); these keep the pieces it is built from from being quietly undone. */
const core = read('app-core.js'), css = read('style.css'), layer = read('design-layer.js');

test('brand cards are one function: the card holds the picture alone, the name and the sentence are in a caption under it', () => {
  assert.equal((core.match(/BR\.map\(brandCard\)/g) || []).length, 2, 'the home strip and the brands page draw brand cards the same way');
  assert.doesNotMatch(core, /card\('','<span class="gold"[^)]*t\.wait/, 'the old card, with the name and the sentence inside it, is gone');
  const fn = core.slice(core.indexOf('function brandCard('), core.indexOf('\n', core.indexOf('function brandCard(')));
  assert.match(fn, /<div class="bcap">/);
  assert.match(fn, /data-go="brand\|'\+b\+'"/);
});

test('the «awaiting the stores\' catalogs» sentence is only written once the data has arrived and no catalog is linked', () => {
  assert.match(core, /function waitNote\(\)\{return DATA_READY&&!PERFUMES\.length\?\(T\(\)\.wait\|\|''\):''\}/);
  assert.match(core, /DSIG=sig;DATA_READY=true;/, 'a successful catalog load is what makes the data ready');
  assert.match(core, /var DATA_READY=false;/);
});

test('the stylesheet draws the caption under the card and gives every card or banner with a picture the picture\'s own shape, over the older size rules', () => {
  assert.match(css, /\.card\.brandc \.bcap \{[^}]*position: absolute;[^}]*top: calc\(100% \+ 8px\);/);
  assert.match(css, /\.card\.brandc \{[^}]*overflow: visible;/, 'the caption sits outside the card\'s box');
  const fit = css.slice(css.indexOf('A picture or video fills its card or banner whole'));
  assert.match(fit, /\.card\[style\*="--cr:"\]:not\(\[data-elan-fit\]\):not\(#_f\):not\(#_g\)/, 'it wins over the !important size rules, and leaves what the editor sized (its own rule)');
  assert.match(fit, /aspect-ratio: var\(--cr\) !important;/);
  assert.match(fit, /object-fit: fill !important;/);
  assert.match(fit, /background-size: 100% 100% !important;/);
  assert.doesNotMatch(fit, /contain|blur\(|background-color|background: #/, 'no bars, no blurred copy, no colour made up behind the picture');
});

test('app-core.js keeps the shape on the card, skips product cards and anything the editor sized, and the design layer re-reads it after every repaint', () => {
  assert.match(core, /var CF_SEL='\.card:not\(\.pf\),\.elan-banner',CF_KEY='elan_card_shapes_v1',CF_SIZES=\{\};/);
  assert.match(core, /if\(!u\|\|u\.length>300\|\|\/\^\(data\|blob\):\/\.test\(u\)/, 'a picture\'s shape is remembered by its address, never a data/blob address');
  assert.match(core, /if\(k\)done\(k\[0\],k\[1\]\);/, 'a returning visitor\'s card has its final shape before the picture arrives');
  assert.match(core, /c\.classList\.contains\('pf'\)\|\|c\.hasAttribute\('data-elan-fit'\)/);
  assert.match(core, /document\.addEventListener\('load',/, 'a picture that arrives late (or is swapped) refits its card');
  assert.match(core, /window\.ElanCardFit=\{scan:cfScan,fit:cfFit\}/);
  assert.match(layer, /window\.ElanCardFit\.scan\(\)/);
});

test('an element the owner sized keeps the width he chose and takes the picture\'s shape (never cut, never stretched, no colour)', () => {
  const fit = layer.slice(layer.indexOf('function fitMedia('), layer.indexOf('function liveSize('));
  assert.match(fit, /imp\(el, 'aspect-ratio', nat\.w \+ ' \/ ' \+ nat\.h\)/);
  assert.match(fit, /imp\(n, 'object-fit', 'fill'\)/);
  assert.match(fit, /imp\(el, 'background-size', '100% 100%'\)/);
  assert.match(fit, /if \(!follows\) return;/, 'the hero and sections keep the frame chosen for them');
  assert.match(layer, /if \(h && !el\.__elanNat\)/, 'while dragging, the height is not written onto a frame that follows its picture');
});
