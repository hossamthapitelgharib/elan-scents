const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const build = require('../scripts/build-cloudflare.js');
const server = require('../railway/server.js');
const root = path.resolve(__dirname, '..');
const vercel = JSON.parse(fs.readFileSync(path.join(root, 'vercel.json'), 'utf8'));

function buildInto() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'elan-cf-'));
  const result = build.build({ outDir: path.join(dir, 'dist'), generatedDir: path.join(dir, 'gen') });
  return { dir, result, dist: path.join(dir, 'dist'), gen: path.join(dir, 'gen') };
}

function walk(dir, parts, out) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === '.git' || entry.name === 'node_modules' || entry.name === 'dist') continue;
    const next = parts.concat(entry.name);
    if (entry.isDirectory()) walk(path.join(dir, entry.name), next, out);
    else if (entry.isFile()) out.push(next.join('/'));
  }
  return out;
}

/* Cloudflare's documented _headers semantics: every rule whose pattern matches applies, a "*" splat matches everything,
   and a header that several rules set is joined with ", " (it is not replaced). */
function parseHeaders(text) {
  const rules = [];
  let current = null;
  for (const raw of text.split('\n')) {
    if (!raw.trim() || raw.trim().startsWith('#')) continue;
    if (!/^\s/.test(raw)) { current = { pattern: raw.trim(), headers: [] }; rules.push(current); continue; }
    const i = raw.indexOf(':');
    current.headers.push([raw.slice(0, i).trim(), raw.slice(i + 1).trim()]);
  }
  return rules;
}
function simulate(rules, urlPath) {
  const out = new Map();
  for (const rule of rules) {
    const re = new RegExp('^' + rule.pattern.replace(/[.+?^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*') + '$');
    if (!re.test(urlPath)) continue;
    for (const [k, v] of rule.headers) out.set(k.toLowerCase(), out.has(k.toLowerCase()) ? out.get(k.toLowerCase()) + ', ' + v : v);
  }
  return out;
}

test('the Cloudflare asset folder holds exactly the files railway/server.js serves, byte for byte', async () => {
  const { dir, result, dist } = buildInto();
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const base = 'http://127.0.0.1:' + server.address().port;
  try {
    const built = new Set(result.files);
    const repoFiles = walk(root, [], []);
    assert.ok(repoFiles.length > 100, 'the walk should see the whole repository');
    for (const rel of repoFiles) {
      const response = await fetch(base + '/' + rel.split('/').map(encodeURIComponent).join('/'));
      const served = response.status === 200;
      assert.equal(built.has(rel), served, rel + (served ? ' is public on Railway but missing from dist' : ' is private on Railway but would be public on Cloudflare'));
      if (served) assert.ok(Buffer.from(await response.arrayBuffer()).equals(fs.readFileSync(path.join(dist, ...rel.split('/')))), rel + ' differs from the served file');
      else await response.arrayBuffer();
    }
    for (const rel of built) assert.ok(repoFiles.includes(rel), rel + ' is not a repository file');
  } finally { server.close(); fs.rmSync(dir, { recursive: true, force: true }); }
});

test('nothing private reaches the asset folder', () => {
  const { dir, result } = buildInto();
  try {
    for (const rel of result.files) {
      assert.doesNotMatch(rel, /^(api|tests|supabase|railway|cloudflare|lib|scripts|reports|docs|node_modules|dist)\//, rel);
      assert.doesNotMatch(rel, /\.sql$/i, rel);
      assert.doesNotMatch(rel, /^(package\.json|package-lock\.json|vercel\.json|server\.js|wrangler\.[a-z]+|claude\.md|readme\.md)$/i, rel);
      assert.doesNotMatch(rel, /(^|\/)elan-(editor|scents)/i, rel);
    }
    for (const name of ['elan-editor.html', 'login.html', 'editor-login.js', 'editor-login.css', 'editor-guard.js', 'editor-media.js']) {
      assert.ok(!result.files.includes('editor/' + name), 'editor/' + name + ' must only be served by the Worker');
    }
    assert.ok(result.files.includes('editor/edit-model.js'), 'the storefront loads editor/edit-model.js directly');
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('every file of editor/ is either public, bundled into the Worker, or the README', () => {
  const { dir, result, gen } = buildInto();
  try {
    const bundled = require(path.join(gen, 'editor-files.js'));
    assert.deepEqual(Object.keys(bundled).sort(), build.PRIVATE_EDITOR_FILES.concat('elan-editor.hashes.json').sort());
    for (const name of fs.readdirSync(path.join(root, 'editor'))) {
      const isPublic = result.files.includes('editor/' + name);
      const isBundled = Object.prototype.hasOwnProperty.call(bundled, name) && name !== 'elan-editor.hashes.json';
      assert.ok(isPublic || isBundled || name === 'README.md', 'editor/' + name + ' is neither served nor bundled');
      assert.ok(!(isPublic && isBundled), 'editor/' + name + ' must not be both');
      if (isBundled) assert.equal(bundled[name], fs.readFileSync(path.join(root, 'editor', name), 'utf8'));
    }
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('_headers gives every file the same cache headers railway/server.js does, without overlapping rules', async () => {
  const { dir, result, dist } = buildInto();
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const base = 'http://127.0.0.1:' + server.address().port;
  try {
    const text = fs.readFileSync(path.join(dist, '_headers'), 'utf8');
    const rules = parseHeaders(text);
    assert.ok(rules.length <= 100, 'Cloudflare allows 100 header rules, found ' + rules.length);
    assert.equal(rules.filter((r) => r.pattern === '/*').length, 1);
    const baseline = simulate(rules, '/anything.js');
    assert.equal(baseline.get('x-content-type-options'), 'nosniff');
    assert.match(baseline.get('referrer-policy'), /strict-origin-when-cross-origin/);
    assert.match(baseline.get('strict-transport-security'), /max-age=\d+/);
    const compiled = vercel.headers.map((r) => new RegExp('^' + r.source + '$'));
    for (const rel of result.files.filter((f) => f !== '_headers')) {
      const urlPath = '/' + rel;
      const cf = simulate(rules, urlPath);
      const railway = await fetch(base + urlPath);
      await railway.arrayBuffer();
      const hasRule = compiled.some((re) => re.test(urlPath));
      if (hasRule) assert.equal(cf.get('cache-control'), railway.headers.get('cache-control'), urlPath + ' cache-control');
      else assert.equal(cf.get('cache-control'), undefined, urlPath + ' has no cache rule on Railway, so Cloudflare keeps its default (revalidate every time)');
      assert.equal(cf.get('x-content-type-options'), 'nosniff', urlPath);
    }
    // The storefront root is answered by the Worker from /index.html and keeps the root rule of vercel.json.
    assert.equal(simulate(rules, '/').get('cache-control'), 'no-store, max-age=0, must-revalidate');
    assert.equal(simulate(rules, '/assets/fonts/ibm-plex-sans-arabic-400.woff2').get('cache-control'), 'public, max-age=31536000, immutable');
  } finally { server.close(); fs.rmSync(dir, { recursive: true, force: true }); }
});

test('the header resolver keeps "later rule wins" and refuses unsafe input', () => {
  const config = { headers: [
    { source: '/assets/(.*)', headers: [{ key: 'Cache-Control', value: 'a' }] },
    { source: '/assets/fonts/(.*)', headers: [{ key: 'Cache-Control', value: 'b' }] },
    { source: '/assets/hero.mp4', headers: [{ key: 'Content-Type', value: 'video/mp4' }, { key: 'Cache-Control', value: 'c' }] }
  ] };
  const files = ['assets/x.png', 'assets/fonts/f.woff2', 'assets/fonts/g.woff2', 'assets/hero.mp4', 'index.html'];
  const rules = parseHeaders(build.buildHeadersFile(files, config));
  assert.equal(simulate(rules, '/assets/x.png').get('cache-control'), 'a');
  assert.equal(simulate(rules, '/assets/fonts/g.woff2').get('cache-control'), 'b');
  assert.equal(simulate(rules, '/assets/hero.mp4').get('cache-control'), 'c');
  assert.equal(simulate(rules, '/assets/hero.mp4').get('content-type'), undefined, 'Cloudflare picks Content-Type from the file');
  assert.equal(simulate(rules, '/index.html').get('cache-control'), undefined);
  assert.throws(() => build.buildHeadersFile(['bad name.png'], config), /not safe/);
  assert.throws(() => build.buildHeadersFile(['a.png'], { headers: [{ source: '/(.*)', headers: [{ key: 'X-Content-Type-Options', value: 'x' }] }] }), /baseline/);
  const many = Array.from({ length: 120 }, (_, i) => 'f' + i + '.js');
  assert.throws(() => build.buildHeadersFile(many, { headers: [{ source: '/(.*)\\.js', headers: [{ key: 'Cache-Control', value: 'x' }] }].concat(many.map((f, i) => ({ source: '/' + f.replace('.', '\\.'), headers: [{ key: 'Cache-Control', value: 'v' + i }] }))) }), /too many/);
});

test('every video file in the assets is routed through the Worker, where Range requests are answered', () => {
  // The whole-line comments are the only ones in wrangler.jsonc, so dropping them leaves plain JSON.
  const config = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'wrangler.jsonc'), 'utf8').split('\n').filter((l) => !l.trim().startsWith('//')).join('\n'));
  const first = new Set(config.assets.run_worker_first);
  const videos = build.listPublicFiles(path.join(__dirname, '..')).filter((rel) => /\.(mp4|webm)$/i.test(rel));
  assert.ok(videos.includes('assets/hero.mp4'));
  for (const rel of videos) assert.ok(first.has('/' + rel), rel + ' must be in run_worker_first (wrangler.jsonc), or Safari cannot play it');
});
