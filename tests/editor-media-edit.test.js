const test = require('node:test');
const assert = require('node:assert/strict');
const ED = require('../design-schema.js');
const media = require('../railway/editor-media.js');
const { editBrowser, plain, read } = require('./browser-fixture');

// The live editor currently supports images only. Local experimental canvas videos are not a server upload contract.
test('image edits use style.media with an allowed image URL only', () => {
  const ok = ED.normalize({ version: 1, edits: { all: { hero: { style: { media: '/assets/hero-poster.jpg' } }, 'sec:cats': { style: { media: '/assets/a.webp' } } } } }, { strict: true });
  assert.equal(ok.ok, true, ok.errors.join());
  assert.equal(ok.design.edits.all.hero.style.media, '/assets/hero-poster.jpg');
  assert.equal(ED.serialize(JSON.parse(ED.serialize(ok.design))), ED.serialize(ok.design));
  for (const src of ['https://evil.example/x.png', '/assets/hero.mp4', '/assets/movie.webm', '/assets/a.html', '/assets/../secret.png', '/assets/%2e%2e/secret.png', '/assets/a%00.png', 'javascript:alert(1)', '/assets/a.png" onerror="x']) {
    assert.equal(ED.normalize({ version: 1, edits: { all: { hero: { style: { media: src } } } } }, { strict: true }).ok, false, src);
  }
  assert.equal(ED.normalize({ version: 1, edits: { all: { hero: { media: { src: '/assets/a.png', kind: 'image' } } } } }, { strict: true }).ok, false, 'retired top-level media shape must not silently become a new contract');
});

test('uploads accept image MIME and magic bytes only and refuse MP4/WebM before any network access', async () => {
  const png = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(40, 1)]);
  const mp4 = Buffer.concat([Buffer.from([0, 0, 0, 24]), Buffer.from('ftypmp42')]);
  const webm = Buffer.from([0x1a, 0x45, 0xdf, 0xa3, 1, 2, 3, 4, 5, 6, 7, 8, 9]);
  assert.equal(media.looksLike(png, 'image/png'), true);
  assert.equal(media.looksLike(png, 'image/jpeg'), false, 'a valid image cannot claim a different MIME');
  assert.equal(media.looksLike(Buffer.from('plain text file here'), 'image/png'), false);
  assert.equal(media.looksLike(mp4, 'video/mp4'), false);
  assert.equal(media.looksLike(webm, 'video/webm'), false);
  assert.equal(media.looksLike(mp4, 'image/avif'), false);
  assert.deepEqual(Object.keys(media.TYPES).sort(), ['image/avif', 'image/gif', 'image/jpeg', 'image/png', 'image/webp']);
  assert.equal(media.MAX_BYTES, 10 * 1024 * 1024);
  const previous = { url: process.env.SUPABASE_URL, anon: process.env.SUPABASE_ANON_KEY, fetch: global.fetch };
  let calls = 0;
  process.env.SUPABASE_URL = 'https://sb.example.test'; process.env.SUPABASE_ANON_KEY = 'anon';
  global.fetch = async () => { calls++; throw new Error('rejected uploads must never reach storage'); };
  try {
    for (const [bytes, type] of [[mp4, 'video/mp4'], [webm, 'video/webm'], [png, 'text/html'], [png, 'image/svg+xml'], [mp4, 'image/png']]) {
      assert.equal((await media.upload({ token: 'admin' }, bytes, type, 'test')).status, 415, type);
    }
    assert.equal(calls, 0);
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
  for (const src of ['https://evil.example/attack.png', '/assets/hero.mp4', '/assets/hero.webm']) {
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
  await b.mode.execute('history.undo');
  assert.equal(video.style.display, '');
  assert.equal(hero.style.backgroundImage, '');
});
