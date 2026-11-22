const test = require('node:test');
const assert = require('node:assert/strict');
const { read } = require('./browser-fixture');

/* Owner, 2026-11-19 (brand cards, the sentence) and 2026-11-21 (the picture adapts to the frame, not the frame to the picture). The behaviour itself is proved in a real browser
   (tests/browser/card-fit.chromium.js); these keep the pieces it is built from from being quietly undone. */
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

test('the stylesheet draws the caption under the card, keeps one frame for every brand card, and resizes a picture to fill its frame whole', () => {
  assert.match(css, /\.card\.brandc \.bcap \{[^}]*position: absolute;[^}]*top: calc\(100% \+ 8px\);/);
  assert.match(css, /\.card\.brandc \{[^}]*width: 150px;[^}]*height: 120px;[^}]*overflow: visible;/, 'one frame for every brand card; the caption sits outside the card\'s box');
  const fitAll = css.slice(css.indexOf('A picture or video adapts to its frame and fills it whole'));
  const fit = fitAll.slice(0, fitAll.indexOf('A brand card is a logo on its white card'));
  assert.match(fit, /\.elan-banner \{[^}]*background-size: 100% 100% !important;/);
  assert.match(fitAll, /\.card\.brandc \{\s*background-color: #fff !important;\s*background-size: contain !important;/, 'owner 2026-11-22: a brand card shows its whole logo on white, never stretched (Armaf, Amouage, Maison Alhambra and Lattafa were squeezed)');
  assert.match(fit, /\.card\.art \.artbg video \{[^}]*object-fit: fill !important;/);
  assert.doesNotMatch(css, /--cr|--crn|aspect-ratio: var\(/, 'the frame never takes the picture\'s shape any more');
  assert.doesNotMatch(fit, /contain|blur\(|background-color|background: #/, 'no bars, no blurred copy, no colour made up behind the picture');
  assert.match(css, /\.card\.art \.artbg img,\s*\.card\.art \.artbg svg \{[^}]*object-fit: fill !important;/, 'art cards (occasions, notes, categories)');
  assert.match(css, /#cats > \.cb > \.card\.art \.artbg img,\s*#cats > \.cb > \.card\.art \.artbg svg \{\s*object-fit: fill !important;/);
  assert.match(css, /\.cb > \.card\.msel \{[^}]*background-size: 100% 100% !important;/, 'the masterpieces card');
  assert.doesNotMatch(css, /\.card[^{}]*\{[^}]*background-size: cover/, 'no card rule in the page stylesheet crops a card picture any more (the hero keeps its own)');
});

test('app-core.js no longer measures pictures or writes their shape on cards', () => {
  assert.doesNotMatch(core, /ElanCardFit|CF_SEL|cfFit|elan_card_shapes_v1/);
  assert.doesNotMatch(layer, /ElanCardFit|__elanNat/);
});

test('an element the owner sized keeps the width AND height he chose, and its picture or video is resized to fill it (the hero and sections keep their own way)', () => {
  const fit = layer.slice(layer.indexOf('function fitMedia('), layer.indexOf('function liveSize('));
  assert.match(fit, /var fills = !el\.classList\.contains\('brandc'\) && \(entry\.kind === 'card' \|\| entry\.kind === 'block' \|\| entry\.kind === 'image-el'\);/, 'cards, banners and pictures fill; a brand card (a logo) never does');
  assert.match(layer, /el\.classList\.contains\('brandc'\) \? 'contain' : entry\.kind === 'card'/, 'a logo put in a brand card by the editor is contained too');
  assert.match(fit, /imp\(n, 'object-fit', fills \? 'fill' : 'contain'\)/);
  assert.match(fit, /imp\(el, 'background-size', fills \? '100% 100%' : 'contain'\)/);
  assert.doesNotMatch(fit, /aspect-ratio/, 'the frame does not take the picture\'s shape');
  assert.match(layer, /if \(h\) \{ el\.style\.setProperty\('height', h \+ 'px', 'important'\)/, 'the height he chose is written');
  assert.match(layer, /\.elan-banner\{[^}]*background-size:100% 100%/, 'a banner\'s picture');
  assert.match(layer, /\.elan-banner>\.elan-bgvideo\{[^}]*object-fit:fill/, 'a banner\'s video');
});

test('brand names are not shown to visitors but stay in the card and in the editor; the category cards carry no writing; the Masterpieces arrow sits under its title (owner, 22 Nov 2026)', () => {
  assert.match(css, /html:not\(\.elan-editing\) \.card\.brandc \.bcap h4 \{[^}]*clip: rect\(0 0 0 0\) !important;/, 'the name is clipped away for visitors, not deleted');
  assert.doesNotMatch(css, /\.card\.brandc \.bcap h4[^{]*\{[^}]*display: none/, 'never display:none: screen readers still read it');
  assert.match(css, /html:not\(\.elan-editing\) \.card\.brandc:not\(\.nw\) \{ margin-bottom: 40px; \}/);
  assert.match(read('edit-boot.js'), /classList\.add\('elan-editing'\)/, 'the editor marks the page so the names show there');
  assert.match(css, /#cats > \.cb > \.card\.art h4,\s*#cats > \.cb > \.card\.art small,\s*#cats > \.cb > \.card\.art \.st \{[^}]*clip: rect\(0 0 0 0\) !important;/, 'the name, the line and the button of a category card are not drawn');
  assert.match(css, /#cats > \.cb > \.card\.art::after \{ display: none !important; \}/, 'nor the dark fade that only helped read them');
  assert.match(core, /function masterBlock\(\)\{return '<div class="cb"><div class="card msel"[^']*"><\/div><div class="strip">'/, 'the arrow is no longer under the Masterpieces card');
  assert.doesNotMatch(core, /s\[0\]=='cats'\|\|s\[0\]=='master'\|\|s\[0\]=='notes'/, 'the section arrow of «master» is shown, under its title, like every other section');
});
