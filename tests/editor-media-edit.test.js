const test = require('node:test');
const assert = require('node:assert/strict');
const ED = require('../design-schema.js');
const media = require('../railway/editor-media.js');
const { editBrowser, plain, read } = require('./browser-fixture');

// The live editor handles pictures (up to 10 MB) and videos (MP4 or WebM, up to the bucket's 50 MB, uploaded straight to storage). Both live in the site-media bucket.
test('media edits use style.media with an allowed picture or video URL only', () => {
  const ok = ED.normalize({ version: 1, edits: { all: { hero: { style: { media: '/assets/hero-poster.jpg' } }, 'sec:cats': { style: { media: '/assets/a.webp' } }, card1: { style: { media: '/assets/hero.mp4' } }, card2: { style: { media: '/assets/loop.webm' } } } } }, { strict: true });
  assert.equal(ok.ok, true, ok.errors.join());
  assert.equal(ok.design.edits.all.hero.style.media, '/assets/hero-poster.jpg');
  assert.equal(ok.design.edits.all.card1.style.media, '/assets/hero.mp4');
  assert.equal(ED.serialize(JSON.parse(ED.serialize(ok.design))), ED.serialize(ok.design));
  const bucket = 'https://sbgdtuqfrnfeggkwqtrw.supabase.co/storage/v1/object/public/site-media/uploads/2026/a1b2.mp4';
  assert.equal(ED.normalize({ version: 1, edits: { all: { hero: { style: { media: bucket } } } } }, { strict: true }).ok, true, 'a video in our storage bucket');
  for (const src of ['https://evil.example/x.png', 'https://evil.example/x.mp4', '/assets/clip.mov', '/assets/clip.avi', '/assets/clip.mp4.html', '/assets/a.html', '/assets/../secret.png', '/assets/../secret.mp4', '/assets/%2e%2e/secret.png', '/assets/a%00.png', 'javascript:alert(1)', '/assets/a.png" onerror="x', '/assets/a.mp4" autoplay onerror="x']) {
    assert.equal(ED.normalize({ version: 1, edits: { all: { hero: { style: { media: src } } } } }, { strict: true }).ok, false, src);
  }
  assert.equal(ED.normalize({ version: 1, edits: { all: { hero: { media: { src: '/assets/a.png', kind: 'image' } } } } }, { strict: true }).ok, false, 'retired top-level media shape must not silently become a new contract');
});

test('banners and image blocks can hold a video; nothing else can', () => {
  const ok = (blocks) => ED.normalize({ version: 1, blocks }, { strict: true });
  const r = ok([{ id: 'x-a', type: 'banner', video: '/assets/hero.mp4' }, { id: 'x-b', type: 'banner', title: { ar: 'ع' }, image: '/assets/a.webp', video: '/assets/loop.webm' }, { id: 'x-c', type: 'image', src: '/assets/loop.webm' }]);
  assert.ok(r.ok, r.errors.join());
  assert.equal(r.design.blocks[0].video, '/assets/hero.mp4');
  assert.equal(r.design.blocks[1].image, '/assets/a.webp');
  assert.equal(r.design.blocks[2].src, '/assets/loop.webm');
  assert.equal(ok([{ id: 'x-d', type: 'banner', title: { ar: 'ع' }, video: 'https://evil.example/a.mp4' }]).ok, false, 'a video from another host');
  assert.equal(ok([{ id: 'x-e', type: 'banner', title: { ar: 'ع' }, video: '/assets/a.png' }]).ok, false, 'a picture is not a video');
  assert.equal(ok([{ id: 'x-f', type: 'banner', title: { ar: 'ع' }, image: '/assets/a.mp4' }]).ok, false, 'banner.image stays a picture; the video has its own field');
  assert.equal(ok([{ id: 'x-g', type: 'banner' }]).ok, false, 'still needs a title, a picture or a video');
});

test('uploads accept picture and video MIME with matching magic bytes only (videos are checked after a direct upload), and refuse the rest before any network access', async () => {
  const png = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(40, 1)]);
  const mp4 = Buffer.concat([Buffer.from([0, 0, 0, 24]), Buffer.from('ftypmp42'), Buffer.alloc(30, 2)]);
  const avifAsMp4 = Buffer.concat([Buffer.from([0, 0, 0, 24]), Buffer.from('ftypavif'), Buffer.alloc(30, 2)]);
  const webm = Buffer.concat([Buffer.from([0x1a, 0x45, 0xdf, 0xa3, 0x9f, 0x42, 0x82, 0x84]), Buffer.from('webm'), Buffer.alloc(30, 3)]);
  const mkv = Buffer.concat([Buffer.from([0x1a, 0x45, 0xdf, 0xa3, 0x9f, 0x42, 0x82, 0x88]), Buffer.from('matroska'), Buffer.alloc(30, 3)]);
  assert.equal(media.looksLike(png, 'image/png'), true);
  assert.equal(media.looksLike(png, 'image/jpeg'), false, 'a valid image cannot claim a different MIME');
  assert.equal(media.looksLike(Buffer.from('plain text file here'), 'image/png'), false);
  assert.equal(media.looksLike(mp4, 'video/mp4'), true);
  assert.equal(media.looksLike(webm, 'video/webm'), true);
  assert.equal(media.looksLike(mp4, 'video/webm'), false, 'an MP4 cannot claim to be WebM');
  assert.equal(media.looksLike(webm, 'video/mp4'), false);
  assert.equal(media.looksLike(mp4, 'image/avif'), false);
  assert.equal(media.looksLike(avifAsMp4, 'video/mp4'), false, 'an AVIF picture is not an MP4 video');
  assert.equal(media.looksLike(mkv, 'video/webm'), false, 'a Matroska file that is not WebM');
  assert.equal(media.looksLike(png, 'video/mp4'), false);
  assert.equal(media.looksLike(Buffer.from('<html><script>alert(1)</script></html>'), 'video/mp4'), false);
  assert.deepEqual(Object.keys(media.TYPES).sort(), ['image/avif', 'image/gif', 'image/jpeg', 'image/png', 'image/webp', 'video/mp4', 'video/webm']);
  assert.equal(media.MAX_BYTES, 10 * 1024 * 1024);
  assert.equal(media.MAX_VIDEO_BYTES, 50 * 1024 * 1024);
  assert.equal(media.limitFor('image/png'), media.MAX_BYTES);
  assert.equal(media.limitFor('video/mp4'), media.MAX_VIDEO_BYTES);
  const previous = { url: process.env.SUPABASE_URL, anon: process.env.SUPABASE_ANON_KEY, fetch: global.fetch };
  let calls = 0;
  process.env.SUPABASE_URL = 'https://sb.example.test'; process.env.SUPABASE_ANON_KEY = 'anon';
  global.fetch = async () => { calls++; throw new Error('rejected uploads must never reach storage'); };
  try {
    for (const [bytes, type] of [[mp4, 'text/html'], [png, 'image/svg+xml'], [mp4, 'image/png'], [mp4, 'video/webm'], [webm, 'video/mp4'], [png, 'video/mp4'], [avifAsMp4, 'video/mp4'], [mkv, 'video/webm'], [mp4, 'video/quicktime'], [mp4, 'application/octet-stream']]) {
      assert.equal((await media.upload({ token: 'admin' }, bytes, type, 'test')).status, 415, type);
    }
    assert.equal((await media.upload({ token: 'admin' }, Buffer.alloc(media.MAX_BYTES + 1, 1), 'image/png', 'big')).status, 413, 'a 10 MB+ picture');
    assert.equal((await media.upload({ token: 'admin' }, mp4, 'video/mp4', 'clip')).error, 'video_needs_direct_upload', 'videos never go through the server upload');
    assert.equal((await media.upload({ token: 'admin' }, webm, 'video/webm', 'clip')).status, 415);
    assert.equal(calls, 0);
    // an accepted picture goes to the site-media bucket and into the library
    const seen = [];
    global.fetch = async (url, init) => { seen.push([String(url), init && init.method, init && init.headers && init.headers['Content-Type'], init && init.body]); return { ok: true, status: 200 }; };
    const pic = await media.upload({ token: 'admin' }, png, 'image/png', '');
    assert.equal(pic.status, 200);
    assert.match(seen[0][0], /\/storage\/v1\/object\/site-media\/uploads\/\d{4}\/[0-9a-f]{20}\.png$/);
    assert.equal(JSON.parse(seen[1][3]).file_type, 'image');
  } finally {
    global.fetch = previous.fetch;
    if (previous.url === undefined) delete process.env.SUPABASE_URL; else process.env.SUPABASE_URL = previous.url;
    if (previous.anon === undefined) delete process.env.SUPABASE_ANON_KEY; else process.env.SUPABASE_ANON_KEY = previous.anon;
  }
});

test('the library lists pictures by default and videos on request', async () => {
  const previous = { url: process.env.SUPABASE_URL, anon: process.env.SUPABASE_ANON_KEY, fetch: global.fetch };
  process.env.SUPABASE_URL = 'https://sb.example.test'; process.env.SUPABASE_ANON_KEY = 'anon';
  const urls = [];
  global.fetch = async (url) => { urls.push(String(url)); return { ok: true, json: async () => [{ id: '1', file_url: 'https://sb.example.test/storage/v1/object/public/site-media/a.mp4', file_type: 'video', title: 'v', category: 'banners' }, { id: '2', file_url: '/assets/a.png', file_type: 'image' }] }; };
  try {
    const pictures = await media.list({ token: 'admin' }, 0);
    assert.match(urls[0], /file_type=eq\.image/);
    const videos = await media.list({ token: 'admin' }, 0, 'video');
    assert.match(urls[1], /file_type=eq\.video/);
    const all = await media.list({ token: 'admin' }, 24, 'all');
    assert.match(urls[2], /file_type=in\.\(image,video\)/); assert.match(urls[2], /offset=24/);
    assert.deepEqual(all.items.map((x) => x.kind), ['video', 'image']);
    assert.equal(pictures.status, 200); assert.equal(videos.status, 200);
  } finally {
    global.fetch = previous.fetch;
    if (previous.url === undefined) delete process.env.SUPABASE_URL; else process.env.SUPABASE_URL = previous.url;
    if (previous.anon === undefined) delete process.env.SUPABASE_ANON_KEY; else process.env.SUPABASE_ANON_KEY = previous.anon;
  }
});

test('style.media replaces the actual image, resets cleanly, and validates before mutating the live editor', async () => {
  assert.match(read('design-layer.js'), /if \(st\.media\) paintMedia\(entry, st\.media\)/);
  const b = await editBrowser();
  const main = b.document.getElementById('main');
  main.innerHTML = '<section id="cats"><div class="card" data-go="col|cats|0"><img src="/assets/original.png"><h4>الفئة</h4></div></section>';
  const entry = b.layer.elements().find((e) => e.kind === 'card');
  const img = entry.el.querySelector('img');
  await b.mode.execute('element.setMedia', { elementId: entry.id, src: '/assets/replacement.webp' });
  assert.equal(b.mode.state().design.edits.all[entry.id].style.media, '/assets/replacement.webp');
  assert.equal(img.getAttribute('src'), '/assets/replacement.webp', 'replacing a card image must not paint behind the unchanged image');
  const before = plain(b.mode.state().design);
  for (const src of ['https://evil.example/attack.png', 'https://evil.example/attack.mp4', '/assets/hero.mov', '/assets/hero.mp4.html']) {
    await assert.rejects(b.mode.execute('element.setMedia', { elementId: entry.id, src }), /مش مسموح/);
    assert.deepEqual(plain(b.mode.state().design), before, 'rejected input must not change the draft or undo history');
  }
  await b.mode.execute('history.undo');
  assert.equal(img.getAttribute('src'), '/assets/original.png');
  await b.mode.execute('history.redo');
  assert.equal(img.getAttribute('src'), '/assets/replacement.webp');
  await b.mode.execute('element.setMedia', { elementId: 'hero', src: '/assets/hero-poster.jpg' });
  const hero = b.document.getElementById('hero'), video = b.document.getElementById('heroVideo');
  assert.equal(video.style.display, 'none');
  assert.match(hero.style.backgroundImage, /hero-poster\.jpg/);
  assert.equal(hero.querySelectorAll('video').length, 1, 'image editing must not add video support');
  // style.css pins the hero background and its video's display with !important; a plain inline value loses to that, which once made a
  // hero picture save without ever showing (the old video kept playing). So the inline values must be !important too.
  const css = read('style.css');
  assert.match(css, /#hero\s*\{[^}]*background:[^;}]*!important/, 'the premise: the stylesheet pins the hero background');
  assert.match(css, /#heroVideo\s*\{[^}]*display:\s*block\s*!important/, 'the premise: the stylesheet pins the hero video as shown');
  assert.equal(video.style.getPropertyPriority('display'), 'important');
  for (const prop of ['background-image', 'background-size', 'background-position']) assert.equal(hero.style.getPropertyPriority(prop), 'important', prop);
  await b.mode.execute('history.undo');
  assert.equal(video.style.display, '');
  assert.equal(hero.style.backgroundImage, '');
  assert.equal(video.style.getPropertyPriority('display'), '', 'undo leaves no inline override behind');
});
