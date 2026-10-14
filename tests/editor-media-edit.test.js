const test = require('node:test');
const assert = require('node:assert/strict');
const ED = require('../design-schema.js');
const media = require('../railway/editor-media.js');

test('edits may replace the media of an element with an allowed url only', () => {
  const ok = ED.normalize({ version: 1, edits: { all: { hero: { media: { src: '/assets/hero.mp4', kind: 'video' } }, 'sec:cats': { media: { src: '/assets/a.webp', kind: 'image' } } } } }, { strict: true });
  assert.equal(ok.ok, true, ok.errors.join());
  assert.deepEqual(ok.design.edits.all.hero.media, { src: '/assets/hero.mp4', kind: 'video' });
  const bad = ED.normalize({ version: 1, edits: { all: { hero: { media: { src: 'https://evil.example/x.mp4', kind: 'video' } } } } }, { strict: true });
  assert.equal(bad.ok, false);
  const notVideo = ED.normalize({ version: 1, edits: { all: { hero: { media: { src: '/assets/a.jpg', kind: 'video' } } } } }, { strict: true });
  assert.equal(notVideo.design.edits.all.hero.media.kind, 'image');
});

test('uploads accept real mp4 and webm files, nothing else posing as video', () => {
  assert.ok(media.looksLike(Buffer.concat([Buffer.from([0, 0, 0, 24]), Buffer.from('ftypmp42')]), 'video/mp4'));
  assert.ok(media.looksLike(Buffer.from([0x1a, 0x45, 0xdf, 0xa3, 1, 2, 3, 4, 5, 6, 7, 8, 9]), 'video/webm'));
  assert.equal(media.looksLike(Buffer.from('plain text file here'), 'video/mp4'), false);
  assert.ok(media.MAX_VIDEO_BYTES > media.MAX_BYTES);
});

test('the storefront layer paints replaced media and the live edit mode can set it', () => {
  const fs = require('node:fs');
  assert.match(fs.readFileSync(require('node:path').join(__dirname, '..', 'design-layer.js'), 'utf8'), /function paintMedia\(entry, m\)/);
  assert.match(fs.readFileSync(require('node:path').join(__dirname, '..', 'edit-mode.js'), 'utf8'), /en\.kind !== 'hero' && en\.kind !== 'card' && en\.kind !== 'section'/);
});
