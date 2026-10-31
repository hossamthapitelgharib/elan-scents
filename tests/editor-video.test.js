const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { editBrowser, designBrowser, plain, read } = require('./browser-fixture');

const MP4 = '/assets/loop.mp4', WEBM = '/assets/loop.webm';

test('the menu says "image or video" where the original editor said it', async () => {
  const b = await editBrowser();
  const label = (id) => b.window.ElanEditTools.list().find((t) => t.id === id).label;
  assert.equal(label('create_banner'), 'إنشاء بانر صورة أو فيديو');
  assert.equal(label('media'), 'رفع صورة أو فيديو داخل العناصر أو الهيرو');
  assert.equal(label('media_delete'), 'حذف ميديا الكارت أو الهيرو إلى الأرشيف');
  assert.equal(label('create_image'), 'إنشاء صورة أو فيديو');
  const golden = JSON.parse(fs.readFileSync(path.join(__dirname, 'fixtures', 'elan-original-tools-golden.json'), 'utf8'));
  const original = golden.menu_by_element.card.map((x) => x.replace(/^\[(ok|x)\] /, ''));
  for (const l of ['إنشاء بانر صورة أو فيديو', 'رفع صورة أو فيديو داخل العناصر أو الهيرو', 'حذف ميديا الكارت أو الهيرو إلى الأرشيف']) assert.ok(original.includes(l), l + ' is the original wording');
});

test('a video goes on the hero\'s white base and undo gives the white base back', async () => {
  const b = await editBrowser();
  const video = b.document.getElementById('heroVideo'), hero = b.document.getElementById('hero');
  assert.equal(video.getAttribute('src'), null, 'the hero ships no video of its own');
  assert.equal(hero.getAttribute('data-media'), null);
  await b.mode.execute('element.setMedia', { elementId: 'hero', src: WEBM });
  assert.equal(b.mode.state().design.edits.all.hero.style.media, WEBM);
  assert.equal(video.getAttribute('src'), WEBM);
  assert.equal(hero.getAttribute('data-media'), 'video');
  assert.equal(video.getAttribute('poster'), null, 'no poster shows over the new video');
  assert.notEqual(video.style.display, 'none');
  await b.mode.execute('history.undo');
  assert.equal(video.getAttribute('src'), null);
  assert.equal(hero.getAttribute('data-media'), null);
});

test('a card takes a video in place of its picture; the picture comes back only by undo, and a second file needs the first deleted', async () => {
  const b = await editBrowser();
  b.document.getElementById('main').innerHTML = '<section id="cats"><div class="card" data-go="col|cats|0"><div class="artbg"><img class="pic" src="/assets/original.png"></div><h4>الفئة</h4></div></section>';
  const entry = b.layer.elements().find((e) => e.kind === 'card');
  const img = entry.el.querySelector('img');
  await assert.rejects(b.mode.execute('element.setMedia', { elementId: entry.id, src: MP4 }), /فيه صورة بالفعل/, 'the card\'s own picture is still there: delete it first');
  await b.mode.execute('tool.run', { id: 'media_delete', elementId: entry.id });
  await b.mode.execute('element.setMedia', { elementId: entry.id, src: MP4 });
  const video = entry.el.querySelector('video');
  assert.ok(video, 'the card shows a video now');
  assert.equal(video.getAttribute('src'), MP4);
  assert.equal(video.className, 'pic');
  assert.equal(img.style.display, 'none');
  assert.equal(['muted', 'loop', 'autoplay', 'playsinline'].every((a) => video.hasAttribute(a)), true, 'plays by itself, muted, looping, inline');
  await assert.rejects(b.mode.execute('element.setMedia', { elementId: entry.id, src: '/assets/new.webp' }), /فيه فيديو بالفعل/);
  await b.mode.execute('history.undo');
  assert.equal(entry.el.querySelector('video'), null);
  // back to the state after the delete: the card is its white base
  await b.mode.execute('element.setMedia', { elementId: entry.id, src: '/assets/new.webp' });
  assert.equal(entry.el.querySelector('video'), null);
  assert.equal(img.getAttribute('src'), '/assets/new.webp');
});

test('a banner takes a picture or a video (one at a time, only when it holds none) and the media tools follow what it holds', async () => {
  const b = await editBrowser();
  const { elementId } = await b.mode.execute('element.create', { kind: 'banner' });
  const block = () => plain(b.mode.state().design.blocks.find((x) => x.id === elementId));
  const tools = async () => { await b.mode.execute('element.select', { elementId }); return Object.fromEntries(b.window.ElanEditTools.menu(b.mode.state().selected).map((t) => [t.id, t.enabled])); };
  assert.equal((await tools()).media_delete, false, 'nothing to delete yet');
  await b.mode.execute('element.setMedia', { elementId, src: '/assets/a.webp' });
  assert.equal(block().image, '/assets/a.webp'); assert.equal(block().video, undefined);
  await assert.rejects(b.mode.execute('element.setMedia', { elementId, src: MP4 }), /فيه صورة بالفعل/, 'a second file is refused');
  assert.equal(block().image, '/assets/a.webp', 'and nothing changed');
  await b.mode.execute('tool.run', { id: 'media_delete', elementId });
  assert.equal(block().image, undefined);
  await b.mode.execute('element.setMedia', { elementId, src: MP4 });
  assert.equal(block().video, MP4); assert.equal(block().image, undefined);
  assert.equal((await tools()).media_delete, true);
  const node = b.layer.elements().find((e) => e.id === elementId).el;
  assert.equal(node.querySelector('video').className, 'elan-bgvideo');
  await b.mode.execute('tool.run', { id: 'media_delete', elementId });
  assert.equal(block().video, undefined, 'deleting the media removes the video and keeps the banner (it has a title)');
  assert.equal(b.layer.elements().find((e) => e.id === elementId).el.querySelector('video'), null);
  await assert.rejects(b.mode.execute('element.setMedia', { elementId, src: 'https://evil.example/a.mp4' }), /مش مسموح/);
});

test('creating a banner or an image from a video file puts it in the right field', async () => {
  const b = await editBrowser();
  const banner = (await b.mode.execute('tool.run', { id: 'create_banner', src: MP4 })).elementId;
  const image = (await b.mode.execute('tool.run', { id: 'create_image', src: WEBM })).elementId;
  const blocks = plain(b.mode.state().design.blocks);
  assert.equal(blocks.find((x) => x.id === banner).video, MP4);
  assert.equal(blocks.find((x) => x.id === image).src, WEBM);
  const pic = (await b.mode.execute('tool.run', { id: 'create_banner', src: '/assets/a.webp' })).elementId;
  assert.equal(plain(b.mode.state().design.blocks.find((x) => x.id === pic)).image, '/assets/a.webp');
});

test('an image block holding a video is a video element: no keyboard text edit, media can be removed, copying keeps the video', async () => {
  const b = await editBrowser();
  const id = (await b.mode.execute('tool.run', { id: 'create_image', src: WEBM })).elementId;
  await b.mode.execute('element.select', { elementId: id });
  const sel = b.mode.state().selected;
  assert.equal(sel.type, 'video'); assert.equal(sel.media, WEBM);
  const enabled = Object.fromEntries(b.window.ElanEditTools.menu(sel).map((t) => [t.id, t.enabled]));
  assert.equal(enabled.edit_text, false); assert.equal(enabled.media_delete, true); assert.equal(enabled.media, true); assert.equal(enabled.copy, true);
  const copy = (await b.mode.execute('element.duplicate', { elementId: id })).elementId;
  assert.equal(plain(b.mode.state().design.blocks.find((x) => x.id === copy)).src, WEBM);
  await b.mode.execute('tool.run', { id: 'media_delete', elementId: id });
  assert.equal(b.mode.state().archive.some((x) => x.id === id), true, 'a video block has nothing left without its video: it goes to the archive');
});

test('the storefront shows a banner video behind the text and an image block video as a moving picture', () => {
  const b = designBrowser();
  b.document.getElementById('main').innerHTML = '<section id="brands"><h3>براندات</h3></section>';
  b.layer.set({ version: 1, blocks: [{ id: 'x-ban', type: 'banner', title: { ar: 'عنوان' }, video: MP4 }, { id: 'x-vid', type: 'image', src: WEBM, alt: { ar: 'وصف' } }], order: ['brands', 'x-ban', 'x-vid'] });
  const main = b.document.getElementById('main');
  const banner = main.querySelector('.elan-banner'), vid = main.querySelector('.elan-image video');
  const bv = banner.querySelector('video');
  assert.equal(bv.getAttribute('src'), MP4); assert.equal(bv.className, 'elan-bgvideo');
  assert.equal(banner.children[0], bv, 'the video is the first layer, the title comes after it');
  assert.equal(vid.getAttribute('src'), WEBM);
  for (const v of [bv, vid]) assert.equal(['muted', 'loop', 'autoplay', 'playsinline'].every((a) => v.hasAttribute(a)), true);
  assert.equal(main.querySelector('.elan-image img'), null, 'no broken picture next to the video');
  const css = read('design-layer.js');
  assert.match(css, /\.elan-banner>\.elan-bgvideo\{position:absolute;inset:0;width:100%;height:100%;object-fit:cover;z-index:-1/);
  assert.match(css, /\.elan-banner\{position:relative;overflow:hidden;isolation:isolate/);
  assert.match(css, /\.elan-image img,\.elan-image video\{/);
});
