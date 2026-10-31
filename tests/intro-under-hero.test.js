'use strict';
/* The title "سحر الخليج بين يديك", its arrow and the brand / store / perfume counters sit on the white page right under the hero
   (before the brands), not over the picture; plus the owner's header and menu colour requests of the same round. */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { designBrowser } = require('./browser-fixture');

const root = path.join(__dirname, '..');
const read = (f) => fs.readFileSync(path.join(root, f), 'utf8');
const html = read('index.html');
const top = read('style.css');
const base = read('style-3.css');

function luminance(hex) {
  const c = hex.replace('#', '').match(/../g).map((h) => parseInt(h, 16) / 255).map((v) => (v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4));
  return 0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2];
}
const contrastOnWhite = (hex) => 1.05 / (luminance(hex) + 0.05);

test('the hero holds only the picture or video and its veil; the title, arrow and counters follow it, before the brands', () => {
  const hero = html.slice(html.indexOf('<div id="hero">'), html.indexOf('<div id="intro">'));
  assert.match(hero, /<video id="heroVideo"/);
  assert.match(hero, /<div class="hero-overlay"><\/div>/);
  assert.doesNotMatch(hero, /magic|counters|cbn|csn|cnt/, 'nothing of the title or the counters is left on the hero');
  const intro = html.slice(html.indexOf('<div id="intro">'), html.indexOf('<main id="main">'));
  assert.match(intro, /<div class="magic" data-go="sec\|all"><h2 data-i="magic"><\/h2><p class="sub" data-i="view"><\/p><\/div>/, 'title and arrow, still opening the whole collection');
  assert.match(intro, /<b id="cbn">[^<]*<\/b><span data-i="cb">[\s\S]*<b id="csn">[^<]*<\/b><span data-i="cs">[\s\S]*<b id="cnt">[^<]*<\/b><span data-i="cp">/, 'brands, stores and perfumes counters, in that order');
  assert.ok(html.indexOf('<div id="hero">') < html.indexOf('<div id="intro">') && html.indexOf('<div id="intro">') < html.indexOf('<main id="main">'), 'hero, then the intro, then the brands section in main');
});

test('the intro is on the white page with readable colours instead of the white text it had over the picture', () => {
  const intro = (top.match(/#intro \{[^}]*\}/) || [''])[0];
  assert.match(intro, /background: #fff/);
  const title = (top.match(/#intro \.magic h2 \{[^}]*\}/) || [''])[0];
  const colour = /color: (#[0-9a-f]{6})/.exec(title);
  assert.ok(colour, 'the title has its own colour');
  assert.ok(contrastOnWhite(colour[1]) >= 7, 'title is dark on white');
  const label = /#intro \.counters span \{[^}]*color: (#[0-9a-f]{6})/.exec(top);
  assert.ok(label && contrastOnWhite(label[1]) >= 4.5, 'counter words are readable on white');
  assert.match(top, /#intro \.counters b \{[^}]*linear-gradient\([^)]*#d4a940[^)]*#8a6a1f[^)]*\)[^}]*background-clip: text/, 'the numbers use the logo gold');
  assert.match(top, /#intro \.magic \{[^}]*animation: none/, 'the title no longer floats');
  for (const sel of ['#intro .magic h2', '#intro .counters b', '#intro .counters span']) {
    const block = new RegExp('\\n' + sel.replace(/[.]/g, '\\.') + ' \\{([^}]*)\\}').exec(top);
    assert.ok(block, sel);
    assert.doesNotMatch(block[1], /!important/, sel + ': no !important, so a colour chosen in the editor still wins');
  }
  assert.doesNotMatch(top, /#hero \.(?:magic|counters)/, 'no rule is left for text on the hero');
});

test('the veil over the hero only keeps the header readable now that no text sits at its bottom', () => {
  const veil = /#hero \.hero-overlay \{[^}]*\}/.exec(top)[0];
  assert.match(veil, /rgba\(20, 12, 4, 0\.35\) 0%/);
  assert.match(veil, /rgba\(20, 12, 4, 0\) 100%/, 'clear at the bottom');
});

test('the editor still finds the title and the counters under their old ids', () => {
  const layer = read('design-layer.js');
  assert.match(layer, /add\('hero:magic', document\.querySelector\('#intro \.magic'\), 'hero-text'/);
  assert.match(layer, /add\('hero:counters', document\.querySelector\('#intro \.counters'\), 'hero-counters'/);
  const b = designBrowser();
  b.layer.set({ version: 1, edits: { all: { 'hero:magic': { style: { fontFamily: 'Tahoma' } } } } });
  b.layer.applyEdits();
  assert.match(b.document.querySelector('#intro .magic').style.fontFamily, /Tahoma/);
});

test('the saved home design carries no white colour or old offset for the moved title and counters', () => {
  const design = JSON.parse(read('design/home.json'));
  for (const [device, edits] of Object.entries(design.edits)) {
    for (const id of ['hero:magic', 'hero:counters']) assert.equal(edits[id], undefined, `${id} (${device}) was set for white text over the picture`);
  }
});

test('header: the word Scents and the tagline are white over the hero and black after it', () => {
  // Black everywhere by default (header, menu page, About), exactly as before.
  assert.match(base, /header \.logo small,#menu \.logo small,\.alogo \.logo small\{[^}]*color:#000!important/);
  assert.match(base, /\.logo span\{font-size:16px;color:#111/);
  // White only in the same states as the icons: over a hero that has its picture/video and is not still loading.
  const gates = [
    'html:not(.hero-pending) body.hd-over:not(.inner):has(#hero[data-media]) header .logo',
    'html.hero-img:not(.hero-pending) body.hd-over:not(.inner) header .logo',
  ];
  for (const gate of gates) {
    assert.ok(base.includes(gate + ' span{color:#fff;-webkit-text-fill-color:#fff}'), gate + ' span');
    assert.ok(base.includes(gate + ' small{color:#fff!important;-webkit-text-fill-color:#fff!important;-webkit-text-stroke-color:#fff}'), gate + ' small');
  }
  assert.doesNotMatch(base, /#menu[^{]*\.logo (?:small|span)[^{]*hd-over/, 'the menu page keeps its black tagline');
});

test('the cart icon in the header is smaller than the others, the heart and the rest stay', () => {
  assert.match(base, /header \.ic button\[data-sheet="cart"\] svg\{width:20px!important;height:20px!important\}/);
  assert.match(top, /header \.ic svg \{ width: 24px !important; height: 24px !important; \}/, 'the other icons keep their size');
});

test('the lines between the menu page items are black', () => {
  assert.match(base, /\n#menu a\{border-bottom-color:#000\}/);
  assert.match(base, /#menu a\{[^}]*border-bottom:1px solid #eadfc6/, 'the width and style of the line are unchanged; only its colour is overridden');
});
