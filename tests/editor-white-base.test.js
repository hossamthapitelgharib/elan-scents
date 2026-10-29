const test = require('node:test');
const assert = require('node:assert/strict');
const ED = require('../design-schema.js');
const { browser, editBrowser, designBrowser, plain, read } = require('./browser-fixture');

/* Owner's rule (2026-10-28): the hero is a plain white slot that keeps the room for the picture or video and is the base the page
   falls back to. Media sits on top of it. Deleting the media (the media tool or the archive tool) returns the white base. A picture
   or a video is refused on anything that still shows one (hero, banner, section, category / occasion / notes card), so replaced
   files never pile up on the platform. */
const MP4 = '/assets/loop.mp4';
const PIC = '/assets/a.webp';
const BUSY = /بالفعل/;

test('the page ships a white hero slot: no video file, no poster, no dark base, and dark text until something sits on it', () => {
  const html = read('index.html'), css = read('style.css');
  const hero = html.slice(html.indexOf('<div id="hero">'), html.indexOf('<main id="main">'));
  assert.match(hero, /<video id="heroVideo"[^>]*><\/video>/, 'the video element stays so a video can be put on the hero');
  assert.doesNotMatch(hero, /<source|poster=|hero\.mp4|hero-poster/, 'nothing is shipped on the hero');
  assert.doesNotMatch(css, /background:\s*#1a1208/, 'no dark base behind the hero (it is white)');
  for (const m of css.matchAll(/#hero\s*\{[^}]*\}/g)) if (/background\s*:/.test(m[0])) assert.match(m[0], /background:\s*#fff\s*!important/, 'every #hero rule that sets a background sets white');
  assert.match(css, /#hero #heroVideo:not\(\[src\]\)[^{]*\{\s*display:\s*none\s*!important/, 'a video element with no file is not drawn');
  assert.match(css, /#hero:not\(\[data-media\]\) \.hero-overlay/, 'the dark overlay belongs to a hero with media only');
  assert.match(css, /#hero:not\(\[data-media\]\) \.magic h2[^{]*\{[^}]*color:\s*#1a1208\s*!important/, 'dark text on the white slot');
});

test('the storefront shows the hero white until a picture or a video is on it, and deleting returns the white', () => {
  const b = designBrowser();
  const hero = b.document.getElementById('hero'), video = b.document.getElementById('heroVideo');
  b.layer.set({ version: 1 });
  assert.equal(hero.getAttribute('data-media'), null);
  assert.equal(video.getAttribute('src'), null);
  b.layer.set({ version: 1, edits: { all: { hero: { style: { media: PIC } } } } });
  assert.equal(hero.getAttribute('data-media'), 'image');
  assert.match(hero.style.backgroundImage, /a\.webp/);
  b.layer.set({ version: 1, edits: { all: { hero: { style: { media: MP4 } } } } });
  assert.equal(hero.getAttribute('data-media'), 'video');
  assert.equal(video.getAttribute('src'), MP4);
  b.layer.set({ version: 1 });   // the media was deleted
  assert.equal(hero.getAttribute('data-media'), null, 'back to the white base');
  assert.equal(video.getAttribute('src'), null);
  assert.equal(hero.style.backgroundImage, '');
});

test('an older design that archived the hero keeps the white slot instead of removing it', () => {
  const b = designBrowser(), hero = b.document.getElementById('hero');
  b.layer.set({ version: 1, edits: { all: { hero: { archived: true, style: { media: PIC } } } } });
  assert.notEqual(hero.style.display, 'none', 'the hero keeps its room');
  assert.equal(hero.getAttribute('data-media'), null, 'but what was on it is gone');
});

test('hero: one picture or video at a time; either delete tool returns the white base; undo brings it back', async () => {
  const b = await editBrowser();
  const hero = b.document.getElementById('hero'), video = b.document.getElementById('heroVideo');
  const sel = async () => { await b.mode.execute('element.select', { elementId: 'hero' }); return b.mode.state().selected; };
  const enabled = async () => Object.fromEntries(b.window.ElanEditTools.menu(await sel()).map((t) => [t.id, t.enabled]));
  assert.equal((await sel()).hasMedia, false);
  assert.equal((await enabled()).media_delete, false, 'nothing to delete on the white base');
  await b.mode.execute('element.setMedia', { elementId: 'hero', src: PIC });
  assert.equal((await sel()).hasMedia, true);
  assert.equal((await enabled()).media_delete, true);
  const before = plain(b.mode.state().design);
  for (const src of [PIC, MP4]) {
    await assert.rejects(b.mode.execute('element.setMedia', { elementId: 'hero', src }), BUSY);
    await assert.rejects(b.mode.execute('tool.run', { id: 'media', elementId: 'hero' }), BUSY, 'refused before asking for a file');
  }
  assert.deepEqual(plain(b.mode.state().design), before, 'a refused upload changes nothing');
  // tool 1: delete the media
  await b.mode.execute('tool.run', { id: 'media_delete', elementId: 'hero' });
  assert.equal(b.mode.state().design.edits, undefined, 'the saved design holds no hero media any more');
  assert.equal(hero.getAttribute('data-media'), null); assert.equal(hero.style.backgroundImage, '');
  assert.equal((await sel()).hasMedia, false);
  assert.equal(b.mode.state().archive.some((x) => x.id === 'hero'), false, 'the hero is not archived: its slot stays');
  // and a new one can be put on it
  await b.mode.execute('element.setMedia', { elementId: 'hero', src: MP4 });
  assert.equal(hero.getAttribute('data-media'), 'video'); assert.equal(video.getAttribute('src'), MP4);
  // tool 2: delete the element to the archive: for the hero that deletes what is on it, and the slot stays white
  await b.mode.execute('tool.run', { id: 'archive', elementId: 'hero' });
  assert.equal(hero.getAttribute('data-media'), null); assert.equal(video.getAttribute('src'), null);
  assert.notEqual(hero.style.display, 'none');
  assert.equal(b.mode.state().archive.some((x) => x.id === 'hero'), false);
  assert.equal(b.mode.state().design.edits, undefined);
  // on the white base the archive tool has nothing to delete and changes nothing
  const white = plain(b.mode.state().design);
  await b.mode.execute('tool.run', { id: 'archive', elementId: 'hero' });
  assert.deepEqual(plain(b.mode.state().design), white);
  await b.mode.execute('history.undo');
  assert.equal(hero.getAttribute('data-media'), 'video', 'undo of the delete puts the video back');
});

test('card: its own picture counts, delete leaves a white card, and a new file is accepted only after that', async () => {
  const b = await editBrowser();
  b.document.getElementById('main').innerHTML = '<section id="occ"><div class="card art" data-go="col|occ|0"><div class="artbg"><img src="/assets/cards/occasion-day.webp"></div><h4>صباحي</h4></div></section>';
  const entry = () => b.layer.elements().find((e) => e.kind === 'card');
  const card = entry().el, art = card.querySelector('.artbg'), id = entry().id;
  const info = async () => { await b.mode.execute('element.select', { elementId: id }); return b.mode.state().selected; };
  assert.equal((await info()).hasMedia, true, 'the shipped picture is the card\'s media');
  await assert.rejects(b.mode.execute('element.setMedia', { elementId: id, src: PIC }), BUSY);
  assert.equal(b.mode.state().design.edits, undefined, 'nothing was saved');
  await b.mode.execute('tool.run', { id: 'media_delete', elementId: id });
  assert.equal(b.mode.state().design.edits.all[id].noMedia, true);
  assert.equal(art.style.display, 'none'); assert.equal(art.style.getPropertyPriority('display'), 'important');
  assert.equal(card.getAttribute('data-no-media'), '1');
  assert.equal((await info()).hasMedia, false);
  assert.equal(ED.normalize(plain(b.mode.state().design), { strict: true }).ok, true, 'what the editor saves is accepted by the server schema');
  await b.mode.execute('element.setMedia', { elementId: id, src: PIC });
  const saved = b.mode.state().design.edits.all[id];
  assert.equal(saved.style.media, PIC); assert.equal(saved.noMedia, undefined, 'the delete mark goes when a file is added');
  assert.equal(card.getAttribute('data-no-media'), null); assert.notEqual(art.style.display, 'none');
  assert.equal(card.querySelector('img').getAttribute('src'), PIC);
  await assert.rejects(b.mode.execute('element.setMedia', { elementId: id, src: MP4 }), BUSY);
  // deleting a file that was added puts the card on its white base too (not back on the shipped picture)
  await b.mode.execute('tool.run', { id: 'media_delete', elementId: id });
  assert.equal(b.mode.state().design.edits.all[id].noMedia, true); assert.equal(b.mode.state().design.edits.all[id].style, undefined);
  assert.equal(card.getAttribute('data-no-media'), '1');
  // the archive tool (delete the element) is separate and still archives a card
  await b.mode.execute('tool.run', { id: 'archive', elementId: id });
  assert.equal(b.mode.state().archive.some((x) => x.id === id), true);
});

test('card whose artwork is a drawing: the new picture or video replaces the drawing, not hides behind it', async () => {
  const b = await editBrowser();
  b.document.getElementById('main').innerHTML = '<section id="notes"><div class="card art" data-go="col|notes|0"><div class="artbg"><svg></svg></div><h4>عود</h4></div></section>';
  const card = b.layer.elements().find((e) => e.kind === 'card'), id = card.id, art = card.el.querySelector('.artbg');
  await b.mode.execute('tool.run', { id: 'media_delete', elementId: id });
  await b.mode.execute('element.setMedia', { elementId: id, src: PIC });
  assert.equal(art.style.display, 'none', 'the drawing is hidden so the picture is seen');
  assert.match(card.el.style.backgroundImage, /a\.webp/);
  assert.equal(card.el.getAttribute('data-no-media'), null);
  await b.mode.execute('history.undo');
  assert.equal(card.el.getAttribute('data-no-media'), '1'); assert.equal(card.el.style.backgroundImage, '');
});

test('the storefront paints a deleted card as a white card and clears it again on the next paint', () => {
  const b = designBrowser();
  b.document.getElementById('main').innerHTML = '<section id="occ"><div class="card art" data-go="col|occ|0"><div class="artbg"><img src="/assets/x.webp"></div><h4>ليلي</h4></div></section>';
  const card = b.layer.elements().find((e) => e.kind === 'card'), art = card.el.querySelector('.artbg');
  b.layer.set({ version: 1, edits: { all: { [card.id]: { noMedia: true } } } });
  assert.equal(card.el.getAttribute('data-no-media'), '1'); assert.equal(art.style.display, 'none');
  b.layer.set({ version: 1, edits: { all: { [card.id]: { noMedia: true, style: { media: PIC } } } } });
  assert.equal(card.el.getAttribute('data-no-media'), null, 'a file on the card wins over the delete mark');
  assert.equal(art.style.display, '');
  b.layer.set({ version: 1 });
  assert.equal(card.el.getAttribute('data-no-media'), null); assert.equal(art.style.display, '');
  const css = read('style.css');
  assert.match(css, /\.card\.art\[data-no-media\]\s*\{[^}]*background:\s*#fff\s*!important/);
  assert.match(css, /\.card\.art\[data-no-media\]:after\s*\{[^}]*display:\s*none\s*!important/);
  assert.match(css, /\.card\.art\[data-no-media\] h4[^{]*\{[^}]*color:\s*#1a1208\s*!important/);
});

test('section background, banner and image block follow the same rule', async () => {
  const b = await editBrowser();
  b.document.getElementById('main').innerHTML = '<section id="cats"><h3>الفئات</h3></section>';
  // a section has no picture of its own: one can be added, then it has to be deleted before another
  await b.mode.execute('element.setMedia', { elementId: 'sec:cats', src: PIC });
  await assert.rejects(b.mode.execute('element.setMedia', { elementId: 'sec:cats', src: MP4 }), BUSY);
  await b.mode.execute('tool.run', { id: 'media_delete', elementId: 'sec:cats' });
  await b.mode.execute('element.setMedia', { elementId: 'sec:cats', src: MP4 });
  assert.equal(b.mode.state().design.edits.all['sec:cats'].style.media, MP4);
  // a banner without media takes one; with media it refuses
  const banner = (await b.mode.execute('element.create', { kind: 'banner' })).elementId;
  await b.mode.execute('element.setMedia', { elementId: banner, src: PIC });
  await assert.rejects(b.mode.execute('element.setMedia', { elementId: banner, src: MP4 }), BUSY);
  // an image block is its picture: it takes no other one, and deleting it archives it
  const image = (await b.mode.execute('tool.run', { id: 'create_image', src: PIC })).elementId;
  await assert.rejects(b.mode.execute('element.setMedia', { elementId: image, src: MP4 }), BUSY);
  await b.mode.execute('tool.run', { id: 'media_delete', elementId: image });
  assert.equal(b.mode.state().archive.some((x) => x.id === image), true);
});

test('the refusal says what to do, and it is the same wording for a picture and a video', async () => {
  const b = await editBrowser();
  await b.mode.execute('element.setMedia', { elementId: 'hero', src: PIC });
  await assert.rejects(b.mode.execute('element.setMedia', { elementId: 'hero', src: MP4 }), /فيه صورة بالفعل.*حذف ميديا.*حذف العنصر إلى الأرشيف.*تتراكم/);
  await b.mode.execute('tool.run', { id: 'media_delete', elementId: 'hero' });
  await b.mode.execute('element.setMedia', { elementId: 'hero', src: MP4 });
  await assert.rejects(b.mode.execute('element.setMedia', { elementId: 'hero', src: PIC }), /فيه فيديو بالفعل/);
});

test('schema: noMedia is a true/false mark on an edit, nothing else', () => {
  const norm = (e) => ED.normalize({ version: 1, edits: { all: { 'card:a1': e } } }, { strict: true });
  assert.equal(norm({ noMedia: true }).ok, true);
  assert.equal(norm({ noMedia: true }).design.edits.all['card:a1'].noMedia, true);
  assert.equal(norm({ noMedia: false, archived: true }).design.edits.all['card:a1'].noMedia, undefined, 'false is the same as absent');
  for (const bad of ['yes', 1, null, {}, []]) assert.equal(norm({ noMedia: bad }).ok, false, JSON.stringify(bad));
});

test('the editor window refuses before it opens the picker when the element still has media', async () => {
  const b = browser(), runs = [];
  b.context.runLive = (action, payload) => { runs.push([action, plain(payload)]); };
  let fetched = 0; b.context.fetch = async () => { fetched++; return { ok: false }; };
  b.run(read('editor/editor-media.js'));
  await b.window.elanLiveMedia({ id: 'hero', hasMedia: true, media: PIC }, { id: 'media' });
  const dlg = b.document.querySelector('#elanMediaDlg');
  assert.ok(dlg, 'a notice is shown');
  assert.match(dlg.textContent, /فيه ميديا بالفعل/); assert.match(dlg.textContent, /احذفي الميديا الحالية الأول/);
  assert.equal(fetched, 0, 'the library was not opened and nothing was uploaded');
  const [del, cancel] = dlg.querySelectorAll('button');
  assert.equal(del.textContent, 'حذف الميديا الحالية'); assert.equal(cancel.textContent, 'إلغاء');
  del.click();
  assert.deepEqual(runs, [['tool.run', { id: 'media_delete', elementId: 'hero' }]], 'one click clears the way (the editor\'s undo still brings it back)');
  assert.equal(b.document.querySelector('#elanMediaDlg'), null);
});

test('the media tool is enabled everywhere it was; only deleting depends on there being media', async () => {
  const b = await editBrowser();
  await b.mode.execute('element.select', { elementId: 'hero' });
  const tools = Object.fromEntries(b.window.ElanEditTools.menu(b.mode.state().selected).map((t) => [t.id, t.enabled]));
  assert.equal(tools.media, true, 'enabled: clicking it explains the refusal instead of greying out without a reason');
  assert.equal(tools.media_delete, false);
});
