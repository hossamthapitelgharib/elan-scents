/* The build copies the hero picture of the design from Supabase storage to this site (assets/hero/, named after its content, cached for
   good). Supabase stores the object with "Cache-Control: no-cache" on another host: every visit asked it about the picture before the
   hero could be drawn, and that wait was the white page before the hero. Everything here is checked without any network. */
const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const build = require('../scripts/build-cloudflare.js');

const root = path.join(__dirname, '..');
const index = fs.readFileSync(path.join(root, 'index.html'), 'utf8');
const SUPA = 'https://sbgdtuqfrnfeggkwqtrw.supabase.co/storage/v1/object/public/site-media/uploads/2026/hero.jpg';
const JPEG = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0, 0x10]), Buffer.from('JFIF\0'), Buffer.alloc(200, 7)]);
const PNG = Buffer.concat([Buffer.from([0x89]), Buffer.from('PNG\r\n\x1a\n'), Buffer.alloc(200, 3)]);
const WEBP = Buffer.concat([Buffer.from('RIFF'), Buffer.from([0, 1, 0, 0]), Buffer.from('WEBPVP8 '), Buffer.alloc(200, 5)]);
const nameOf = (bytes, ext) => '/assets/hero/' + crypto.createHash('sha256').update(bytes).digest('hex').slice(0, 20) + '.' + ext;

/* A folder holding just what the build needs, with the given design. */
function miniRoot(edits) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hero-copy-'));
  fs.mkdirSync(path.join(dir, 'design'));
  fs.mkdirSync(path.join(dir, 'editor'));
  fs.writeFileSync(path.join(dir, 'design', 'home.json'), JSON.stringify({ version: 1, edits }));
  fs.copyFileSync(path.join(root, 'vercel.json'), path.join(dir, 'vercel.json'));
  fs.copyFileSync(path.join(root, 'index.html'), path.join(dir, 'index.html'));
  for (const name of build.PRIVATE_EDITOR_FILES) fs.copyFileSync(path.join(root, 'editor', name), path.join(dir, 'editor', name));
  return dir;
}
const heroAll = (media) => ({ all: { hero: { style: { media } } } });
const reply = (bytes, init) => async () => Object.assign({ ok: true, status: 200, headers: { get: (k) => (k.toLowerCase() === 'content-length' ? String(bytes.length) : null) }, arrayBuffer: async () => bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.length) }, init);

test('sniffImage tells the real image types apart by their first bytes', () => {
  assert.equal(build.sniffImage(JPEG), 'jpg');
  assert.equal(build.sniffImage(PNG), 'png');
  assert.equal(build.sniffImage(WEBP), 'webp');
  assert.equal(build.sniffImage(Buffer.concat([Buffer.from('GIF89a'), Buffer.alloc(20)])), 'gif');
  assert.equal(build.sniffImage(Buffer.concat([Buffer.alloc(4), Buffer.from('ftypavif'), Buffer.alloc(20)])), 'avif');
  for (const bad of [Buffer.from('<html><body>Not found</body></html>'), Buffer.alloc(100), Buffer.from('{"error":"x"}....'), Buffer.alloc(3), null]) assert.equal(build.sniffImage(bad), '');
});

test('fetchHeroPictures copies a Supabase hero picture under a name made from its content, and says nothing it did not do', async () => {
  const dir = miniRoot(heroAll(SUPA));
  try {
    const calls = [], logs = [];
    const map = await build.fetchHeroPictures(dir, { log: (m) => logs.push(m), fetchImpl: async (url, opts) => { calls.push([url, opts]); return reply(JPEG)(); } });
    assert.deepEqual([...map.keys()], [SUPA]);
    const copy = map.get(SUPA);
    assert.equal(copy.path, nameOf(JPEG, 'jpg'));
    assert.ok(copy.bytes.equals(JPEG));
    assert.equal(calls.length, 1, 'one download even though three screen sizes name the picture');
    assert.equal(calls[0][1].redirect, 'error', 'a redirect to anywhere else is not followed');
    assert.ok(logs.length === 1 && /copied/.test(logs[0]) && logs[0].includes(copy.path));
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('fetchHeroPictures copies nothing that is not a Supabase picture, or that is not really that picture, and never throws', async () => {
  const dir = miniRoot(heroAll(SUPA));
  try {
    const cases = {
      'a page where the picture should be': reply(Buffer.from('<html><body>Not found</body></html>'.padEnd(60, ' '))),
      'a PNG under a .jpg address': reply(PNG),
      'an HTTP error': reply(JPEG, { ok: false, status: 404 }),
      'an empty body': reply(Buffer.alloc(0)),
      'a size announced as too big': async () => ({ ok: true, status: 200, headers: { get: () => String(7 * 1024 * 1024) }, arrayBuffer: async () => { throw new Error('should not be read'); } }),
      'a body that is too big': reply(Buffer.concat([JPEG, Buffer.alloc(6 * 1024 * 1024)]), { headers: { get: () => null } }),
      'a network failure': async () => { throw new Error('offline'); },
      'a timeout': async () => { throw Object.assign(new Error('The operation was aborted due to timeout'), { name: 'TimeoutError' }); }
    };
    for (const [label, fetchImpl] of Object.entries(cases)) {
      const logs = [];
      const map = await build.fetchHeroPictures(dir, { fetchImpl, log: (m) => logs.push(m) });
      assert.equal(map.size, 0, label);
      assert.ok(logs.length === 1 && /NOT copied/.test(logs[0]), label + ': it says so');
    }
    assert.equal((await build.fetchHeroPictures(dir, { fetchImpl: null })).size, 0, 'no fetch available');

    // Pictures that live on this site already, videos, no picture and unsafe addresses are never downloaded.
    for (const media of ['/assets/hero-poster.jpg', SUPA.replace('.jpg', '.mp4'), 'https://evil.example/x.jpg', '', 7]) {
      fs.writeFileSync(path.join(dir, 'design', 'home.json'), JSON.stringify({ edits: heroAll(media) }));
      let asked = 0;
      const map = await build.fetchHeroPictures(dir, { fetchImpl: async () => { asked += 1; return reply(JPEG)(); } });
      assert.equal(map.size + asked, 0, String(media));
    }
    assert.equal((await build.fetchHeroPictures(path.join(dir, 'nowhere'), { fetchImpl: async () => { throw new Error('asked'); } })).size, 0);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('the extension of the address must be the type of the file: a .jpeg or .JPG address with a JPEG is fine, a .webp address with a JPEG is not', async () => {
  const dir = miniRoot({});
  try {
    for (const [address, bytes, expected] of [[SUPA.replace('.jpg', '.jpeg'), JPEG, 'jpg'], [SUPA.replace('.jpg', '.JPG'), JPEG, 'jpg'], [SUPA.replace('.jpg', '.webp'), WEBP, 'webp'], [SUPA.replace('.jpg', '.png') + '?v=2', PNG, 'png'], [SUPA.replace('.jpg', '.webp'), JPEG, '']]) {
      fs.writeFileSync(path.join(dir, 'design', 'home.json'), JSON.stringify({ edits: heroAll(address) }));
      const map = await build.fetchHeroPictures(dir, { fetchImpl: reply(bytes) });
      assert.equal(map.size, expected ? 1 : 0, address);
      if (expected) assert.equal(map.get(address).path, nameOf(bytes, expected));
    }
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('the built folder uses the copy: the file itself, the page\'s first frame, the Link header, a rule that keeps it for good, and the design file untouched', async () => {
  const mobile = SUPA.replace('hero.jpg', 'm.webp');
  const dir = miniRoot({ all: { hero: { style: { media: SUPA } } }, mobile: { hero: { style: { media: mobile } } } });
  try {
    const mirror = new Map([[SUPA, { path: nameOf(JPEG, 'jpg'), bytes: JPEG }]]);       // only the desktop/tablet picture could be copied
    const out = path.join(dir, 'dist');
    build.build({ root: dir, outDir: out, generatedDir: path.join(dir, 'gen'), heroMirror: mirror });
    const copy = mirror.get(SUPA).path;
    assert.ok(fs.readFileSync(path.join(out, ...copy.split('/').filter(Boolean))).equals(JPEG), 'the copy is in the folder Cloudflare serves');

    const page = fs.readFileSync(path.join(out, 'index.html'), 'utf8');
    const css = page.match(/<!--hero-first--><style>([^<]*)<\/style>/)[1];
    assert.ok(css.includes('@media (max-width: 639px){:root{--hero-img:url("' + mobile + '")}}'), 'a picture that could not be copied keeps its own address');
    assert.ok(css.includes('@media (min-width: 640px) and (max-width: 1023px){:root{--hero-img:url("' + copy + '")}}'));
    assert.ok(css.includes('@media (min-width: 1024px){:root{--hero-img:url("' + copy + '")}}'));
    assert.ok(css.includes(':root{--hero-map:"' + SUPA + ' ' + copy + '"}'), 'hero-early.js is told which address the copy stands for');
    assert.ok(!css.includes('--hero-map:"' + mobile), 'a picture that was not copied is not in the map');
    assert.equal(build.withoutHeroFirstPaint(page), index, 'taking the block out gives back the source page');

    const headers = fs.readFileSync(path.join(out, '_headers'), 'utf8');
    const rules = headers.split('\n\n');
    const home = rules.find((r) => r.split('\n')[0] === '/index.html');
    assert.ok(home.includes('<' + copy + '>; rel=preload; as=image; fetchpriority=high; media="(min-width: 640px) and (max-width: 1023px)"'));
    assert.ok(home.includes('<' + mobile + '>; rel=preload'), 'and the one that stayed on Supabase keeps its link');
    assert.ok(!/Link:.*hero\.jpg/.test(home), 'the Supabase address of a copied picture is not preloaded any more');
    assert.match(rules.find((r) => r.split('\n')[0] === '/assets/hero/*'), /\n  Cache-Control: public, max-age=31536000, immutable\n?$/);
    // Cloudflare joins the values of every rule that matches a path, so nothing else may match the copies: only the catch-all (security headers) and this rule.
    const matching = headers.split('\n').filter((l) => l && !/^[\s#]/.test(l)).filter((pattern) => new RegExp('^' + pattern.replace(/[.+?^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*') + '$').test(copy));
    assert.deepEqual(matching, ['/*', '/assets/hero/*']);

    assert.equal(fs.readFileSync(path.join(out, 'design', 'home.json'), 'utf8'), fs.readFileSync(path.join(dir, 'design', 'home.json'), 'utf8'), 'the design file still names the Supabase address: the editor compares it with its commit');
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('without a copy (the default build, no network, a failed download) the build is what it was: the Supabase address everywhere, no extra rule, no map', () => {
  const dir = miniRoot(heroAll(SUPA));
  try {
    for (const heroMirror of [undefined, new Map(), 'junk']) {
      const out = path.join(dir, 'dist');
      build.build({ root: dir, outDir: out, generatedDir: path.join(dir, 'gen'), heroMirror });
      const page = fs.readFileSync(path.join(out, 'index.html'), 'utf8');
      assert.ok(page.includes(':root{--hero-img:url("' + SUPA + '")}'));
      assert.ok(!page.includes('--hero-map'));
      const headers = fs.readFileSync(path.join(out, '_headers'), 'utf8');
      assert.ok(!headers.includes('/assets/hero/'));
      assert.ok(headers.includes('<' + SUPA + '>; rel=preload'));
      assert.ok(!fs.existsSync(path.join(out, 'assets', 'hero')));
    }
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('the build command fetches the copy before building and keeps going when it cannot; HERO_MIRROR=0 turns it off', () => {
  const source = fs.readFileSync(path.join(root, 'scripts', 'build-cloudflare.js'), 'utf8');
  assert.match(source, /process\.env\.HERO_MIRROR !== '0'/);
  assert.ok(/try \{ heroMirror = await fetchHeroPictures\(ROOT/.test(source) && /\} catch \(e\) \{ console\.log\('cloudflare build: hero picture not copied/.test(source), 'a failed download never fails the deploy');
  assert.match(source, /build\(\{ heroMirror \}\)/);
});
