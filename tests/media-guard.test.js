'use strict';
/* THE GUARD of everything the owner asked for about pictures, videos and the text drawn over them (2026-11-21 to 2026-11-23), so a later change cannot bring the bad look back without a
   test failing. Each pin names the owner's decision it protects (recorded in CLAUDE.md under «الصورة تتكيّف…» and «ملاحظات المالك 22 نوفمبر»; the map is docs/media-guard.ar.md).
   The real-Chromium checks live in tests/browser/{card-fit,editor-sizes,editor-fit,text-format}.chromium.js; these are the quick ones that run with `npm test`, and they cover what
   the browser files only reach in CI (a mutation run on 2026-11-22 showed which changes slipped past `npm test`: these pins close those).
   They pin the NEED, not a layout value: when the owner decides otherwise, change the pin together with the decision in CLAUDE.md, never alone. */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const root = path.join(__dirname, '..');
const read = (f) => fs.readFileSync(path.join(root, f), 'utf8');
const css = read('style.css'), layer = read('design-layer.js'), core = read('app-core.js'), mode = read('edit-mode.js'), boot = read('edit-boot.js'), media = read('editor/editor-media.js');
const schema = read('design-schema.js');
const G = require('../editor/editor-geometry.js');
const block = (text, selector) => { const i = text.indexOf(selector); assert.ok(i !== -1, 'missing: ' + selector); return text.slice(i, text.indexOf('}', i) + 1); };

test('a picture or a video fills the whole frame of its element: no cut, no cover (fill everywhere except the hero and the brand logos)', () => {
  for (const sel of ['.card.art .artbg video', '#cats > .cb > .card.art .artbg img', '.elan-banner > .elan-bgvideo']) assert.match(block(css, sel), /object-fit:\s*fill\s*!important/, sel + ' fills its frame (owner, 21 Nov: the picture adapts to the frame, stretching is accepted)');
  assert.match(block(css, '.elan-banner {'), /background-size:\s*100% 100%\s*!important/, 'a banner picture fills the banner');
  assert.match(layer, /\.elan-banner\{[^}]*background-size:100% 100%/, 'the page-injected banner css says the same');
  assert.match(layer, /\.elan-banner>\.elan-bgvideo\{[^}]*object-fit:fill/, 'and so does its video');
  assert.match(layer, /swap\.style\.cssText = '[^']*object-fit:fill'/, 'a picture uploaded to a card replaces the old one and fills the frame');
  assert.match(layer, /object-fit:fill;z-index:0;pointer-events:none/, 'a video uploaded to a card fills the frame');
  assert.match(layer, /fills \? '100% 100%' : 'contain'/, 'an element the owner gave a size draws its background to that size');
  assert.match(layer, /fills \? 'fill' : 'contain'/, 'and its picture');
});

test('the hero keeps its own look: the video covers the hero (it is not stretched, it is a full-width cover)', () => {
  assert.match(block(css, '#hero video,\n#heroVideo {'), /object-fit:\s*cover\s*!important/, 'the hero video covers the hero');
});

test('brand cards show the logo whole on a white card (never stretched), at one frame for every brand, and the brand name is for the editor only', () => {
  const brand = block(css, '.card.brandc {\n  background-color');
  assert.match(brand, /background-color:\s*#fff\s*!important/);
  assert.match(brand, /background-size:\s*contain\s*!important/, 'owner, 22 Nov: the logos of Armaf, Amouage, Maison Alhambra and Lattafa were squeezed');
  assert.match(block(css, '.card.brandc {\n  flex'), /width:\s*150px;\s*height:\s*120px/, 'one frame for all brands');
  assert.match(layer, /el\.classList\.contains\('brandc'\) \? 'contain'/, 'a logo set through the editor is contained too');
  assert.match(layer, /var fills = !el\.classList\.contains\('brandc'\) &&/, 'and a size given to a brand card does not stretch it');
  assert.match(css, /html:not\(\.elan-editing\) \.card\.brandc \.bcap h4 \{/, 'the name is hidden from visitors, and only while the editor is not open');
  assert.match(boot, /classList\.add\('elan-editing'\)/, 'the editor marks the page, so the names show there');
});

test('the category cards carry no writing, and the Masterpieces arrow is under its title, not under its card', () => {
  assert.match(css, /#cats > \.cb > \.card\.art h4,\s*#cats > \.cb > \.card\.art small,/, 'the writing of the category cards is hidden (it stays in the page for screen readers and the editor)');
  assert.match(css, /#cats > \.cb > \.card\.art::after \{ display: none !important; \}/, 'and so is the fade');
  const master = core.slice(core.indexOf('function masterBlock'), core.indexOf('\n', core.indexOf('function masterBlock')));
  assert.doesNotMatch(master, /class="sub"|class='sub'/, 'no arrow under the Masterpieces card');
  assert.match(core, /s\[0\]=='cats'\|\|s\[0\]=='notes'\|\|s\[0\]=='occ'\?/, 'only these titles hide their arrow: Masterpieces shows it, under its title');
  assert.doesNotMatch(core, /s\[0\]=='[a-z]+'\|\|s\[0\]=='master'/, 'Masterpieces is not in the list of titles that hide the arrow');
});

test('a new banner is created empty, an empty banner is invisible to visitors and a plain frame in the editor, and a picture or video ends the emptiness', () => {
  assert.doesNotMatch(mode, /type: 'banner'[^;]{0,120}title: \{ ar: 'عنوان جديد' \}/, 'no placeholder title on a new banner');
  assert.doesNotMatch(mode, /سطر تعريفي قصير/, 'no placeholder line');
  assert.match(layer, /\.elan-banner\.elan-empty\{display:none\}/, 'visitors see nothing for an empty banner');
  assert.match(layer, /\.elan-empty-edit\{[^}]*min-height:140px/, 'the editor shows the frame');
  assert.match(layer, /if \(!t && !s && !b\.image && !b\.video\) root\.classList/, 'a banner with no words, picture or video is marked empty');
  assert.match(layer, /window\.ELAN_EDITOR_PREVIEW \? 'elan-empty-edit' : 'elan-empty'/, 'in the editor the mark is the one that shows the frame');
  assert.match(layer, /classList\.remove\('elan-empty', 'elan-empty-edit'\)/, 'a banner that gets a picture or video is no longer empty');
  assert.doesNotMatch(schema, /banner needs a title/, 'the design file accepts an empty banner');
});

test('the dimensions window marks the element\'s current size, lists a size that is in no list, and offers the shapes the owner measured on the reference stores', () => {
  const has = (w, h) => G.RATIOS.some((r) => r.w === w && r.h === h);
  assert.ok(has(1, 1) && has(5, 7) && has(11, 9), '1:1 (category card), 5:7 («تسوّق حسب احتياجك») and 11:9 (brand card) are in the list');
  assert.match(G.RATIOS.find((r) => r.w === 5 && r.h === 7).label, /تسوّق حسب احتياجك/);
  assert.match(G.RATIOS.find((r) => r.w === 11 && r.h === 9).label, /براند/);
  assert.match(mode, /d\.current = true/, 'the shape the element has is flagged');
  assert.match(mode, /keep: true, current: true/, 'a size that is none of the shapes is listed as the current one');
  assert.match(mode, /if \(cur && !now && !sizes\.some\(/, 'the entry is added only when no listed shape is the current one');
  assert.match(mode, /sizes\.splice\(own \? 1 : 0, 0, \{ keep: true/, 'right after «نفس شكل الصورة», which stays first');
  assert.match(media, /if \(size\.current\) \{ b\.classList\.add\('cur'\)/, 'the window shades the current size');
  assert.match(media, /المقاس الحالي/, 'and says so');
});

test('whatever the owner chooses for a text (size, colour, background, font, effect) is written with !important, so the page sheet cannot win, and is undone with the paint', () => {
  const paint = layer.slice(layer.indexOf('function tp(node, prop, value)'), layer.indexOf('function tp(node, prop, value)') + 1800);
  assert.match(layer, /function tp\(node, prop, value\) \{ node\.style\.setProperty\(prop, value, 'important'\); \}/, 'one writer, with !important');
  for (const prop of ['color', 'background-color', 'font-size', 'font-weight', 'text-align', 'font-family']) assert.ok(paint.includes("tp(visual, '" + prop + "'"), prop + ' goes through it (owner, 22 Nov: the size of «سحر الخليج بين يديك» did not change)');
  assert.match(paint, /var fx = entry\.kind === 'hero-text' \? visual : el;/, 'the effects reach the words of that title');
  assert.match(layer, /el\.__elanVis = \{ node: visual,/, 'the style of the inner text is remembered...');
  assert.match(layer, /if \(el\.__elanVis\) \{ var vis = el\.__elanVis;/, '...and given back when the paint is undone');
});

test('a card with its picture deleted is a white base, also when the picture is the card\'s own background (Masterpieces, brand cards)', () => {
  assert.match(block(css, '.card.art[data-no-media] {'), /background:\s*#fff\s*!important/);
  assert.match(css, /\.cb > \.card\.msel\[data-no-media\],\s*\.card\.brandc\[data-no-media\] \{\s*background-image:\s*none\s*!important/, 'owner, 23 Nov: the very old default picture came back after deleting one');
  assert.match(layer, /el\.setAttribute\('data-no-media', '1'\)/, 'the card is marked when its picture is deleted');
});

test('a picture that is still loading is never the one on screen: it is marked and hidden, so a browser that keeps the old picture of an <img> cannot show the card\'s first picture again (owner, 23 Nov)', () => {
  assert.match(css, /img\[data-elan-pending\] \{\s*visibility:\s*hidden\s*!important/, 'the rule that hides it');
  assert.match(layer, /img\.setAttribute\('data-elan-pending', '1'\)/, 'the layer marks the picture until it has loaded');
  assert.match(layer, /img\.removeAttribute\('data-elan-pending'\)/, 'and shows it when it has (and when the paint is undone)');
  assert.match(layer, /var hadPicture = img\.complete && img\.naturalWidth > 0;/, 'only when there is a loaded picture the browser could go on drawing');
  assert.doesNotMatch(layer, /img\.style\.setProperty\('visibility'/, 'not an inline style: fitMedia keeps a copy of the style attribute and puts it back on undo, which brought the hidden state back');
});

test('no gold line under a title or at the top of the footer, and a title the owner moves takes what is under it along (owner, 24 Nov)', () => {
  const s3 = read('style-3.css');
  assert.match(block(s3, 'h3:after{'), /background:\s*none/, 'the line under the titles is gone, and its box (the room it took) stays');
  assert.doesNotMatch(css, /footer \.fdiv \{\s*background:\s*linear-gradient/, 'no rule draws a gold line at the top of the footer');
  assert.match(css, /footer \.fdiv \{\s*background:\s*none\s*!important/, 'the footer divider draws nothing and keeps its place');
  assert.match(css, /#master > \.cb \{ margin-bottom: 0; \}/, 'the Masterpieces block adds no room of its own under its section, so the next section starts as far after it as after any other (the browser file section-titles measures it)');
  assert.match(layer, /entry\.kind === 'title' && ed\.dy\) el\.style\.marginBottom = titleRoomBelow\(el, ed\.dy\)/, 'the room under a title moves with it, so its arrow and cards follow');
  assert.match(layer, /function titleRoomBelow\(el, dy\)[\s\S]{0,900}Math\.max\(mb, mt\)/, 'and it counts margins that collapse, or lowering a title moves its arrow by less than the title (the browser file section-titles measures it)');
});

test('the room between two sections of the home page stays small and the same (owner, 25 Nov: «المسافات البينية كبيرة»), and the dimensions item of the right-click menu is never below the bottom of the menu', () => {
  assert.match(css, /#main > section:not\(#brands\) \{ padding-top: 28px; \}/, 'a section starts 28px under the one before it (it was 46px), brands excepted (the shelf of cards has its own place)');
  assert.match(css, /#main > section \.strip \{ padding-bottom: 12px; \}/, 'a strip of cards leaves 12px under itself (it was 22px)');
  assert.match(css, /#cats > \.cb:last-of-type \{[^}]*margin-bottom: 12px !important;/, 'and the last block of the categories leaves the same 12px');
  assert.match(read('edit-mode.js'), /var MENU_ORDER = \[[^\]]*'create_store', 'size_preset'\];/, '«أبعاد العناصر» comes right after the twelve items the owner ordered; it was the 19th of 21 and sat below the bottom of the menu on every window height (the browser file editor-menu-size opens the real menu)');
  assert.match(read('editor/elan-editor.html'), /#menu\{[^']*max-height:calc\(100vh - 16px\)!important[^']*\}#menu button\{margin:2px 0!important/, 'and the menu is compact and as tall as the window, so its items are seen');
});

test('an uploaded video plays by itself on a phone: muted, looping, inline', () => {
  assert.match(layer, /v\.muted = true; v\.loop = true; v\.autoplay = true; v\.setAttribute\('playsinline', ''\);/, 'the video the owner uploads to a card plays inline (phones otherwise open it full screen)');
  assert.match(layer, /v\.setAttribute\('muted', ''\); v\.setAttribute\('loop', ''\); v\.setAttribute\('autoplay', ''\); v\.setAttribute\('playsinline', ''\)/);
});

test('the design the owner saves from the editor keeps passing the schema (a saved design that the page refuses is a page without his edits)', () => {
  const ED = require('../design-schema.js');
  const result = ED.normalize(JSON.parse(read('design/home.json')), { strict: true });
  assert.ok(result.ok, 'design/home.json: ' + JSON.stringify(result.errors || []).slice(0, 400));
});
