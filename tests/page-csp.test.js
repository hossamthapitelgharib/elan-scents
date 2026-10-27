/* Content-Security-Policy of the public pages (storefront and the account / dashboard pages).
   The policy is a header rule in vercel.json, the single source that railway/server.js and the Cloudflare _headers file are both built
   from. It only works because no page carries inline code: these tests keep it that way, and keep the policy itself tight and in step
   with the Supabase address the Worker is configured with. */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const http = require('node:http');
const path = require('node:path');
const vm = require('node:vm');

const root = path.resolve(__dirname, '..');
const read = (name) => fs.readFileSync(path.join(root, name), 'utf8');
const vercel = JSON.parse(read('vercel.json'));
const server = require('../railway/server.js');

const PAGES = fs.readdirSync(root).filter((f) => f.endsWith('.html')).sort();

function policyOf(headers) {
  const out = new Map();
  for (const part of String(headers).split(';')) {
    const tokens = part.trim().split(/\s+/).filter(Boolean);
    if (tokens.length) out.set(tokens[0], tokens.slice(1));
  }
  return out;
}

function pageRuleValue(pathname) {
  const values = [];
  for (const rule of vercel.headers) {
    if (!new RegExp('^' + rule.source + '$').test(pathname)) continue;
    for (const h of rule.headers) if (h.key === 'Content-Security-Policy') values.push(h.value);
  }
  return values;
}

async function withServer(run) {
  const s = http.createServer(server.listeners('request')[0]);
  await new Promise((resolve) => s.listen(0, '127.0.0.1', resolve));
  try { await run('http://127.0.0.1:' + s.address().port); } finally { s.close(); }
}

test('the page policy forbids inline scripts, eval, plugins and foreign framing, and uses no wildcard for scripts', () => {
  const values = pageRuleValue('/index.html');
  assert.equal(values.length, 1, 'exactly one Content-Security-Policy rule applies to a page');
  const p = policyOf(values[0]);
  assert.deepEqual(p.get('default-src'), ["'self'"]);
  assert.deepEqual(p.get('script-src'), ["'self'"], 'scripts come from this site only (no unsafe-inline, unsafe-eval or https:)');
  assert.deepEqual(p.get('script-src-attr'), ["'none'"], 'inline event handler attributes are blocked');
  assert.deepEqual(p.get('object-src'), ["'none'"]);
  assert.deepEqual(p.get('base-uri'), ["'self'"]);
  assert.deepEqual(p.get('form-action'), ["'self'"]);
  assert.deepEqual(p.get('frame-ancestors'), ["'self'"], 'the owner editor frames the storefront from the same origin; nobody else may');
  for (const [name, sources] of p) {
    if (name === 'img-src') continue;
    assert.equal(sources.includes('*'), false, name + ' must not allow everything');
    assert.equal(sources.includes('https:'), false, name + ' must not allow every https host');
  }
});

test('connect-src names this site and the Supabase project the Worker is configured with, nothing else', () => {
  const wrangler = read('wrangler.jsonc');
  const supabase = new URL(wrangler.match(/"SUPABASE_URL"\s*:\s*"([^"]+)"/)[1]).origin;
  const p = policyOf(pageRuleValue('/index.html')[0]);
  assert.deepEqual(p.get('connect-src'), ["'self'", supabase],
    'when the Supabase project changes, change the origin in the vercel.json policy too, or every page loses its catalog');
  // the only other hosts: the web-font service the editor can switch a design to (design-layer.js loadFont)
  assert.deepEqual(p.get('style-src'), ["'self'", "'unsafe-inline'", 'https://fonts.googleapis.com']);
  assert.deepEqual(p.get('font-src'), ["'self'", 'https://fonts.gstatic.com']);
  // videos the owner puts on the page (editor: banner, card, hero, image block) are files in the site-media bucket of that same project
  assert.deepEqual(p.get('media-src'), ["'self'", supabase],
    'without the Supabase origin here every uploaded video is blocked by the browser');
});

test('every public page, and the root address, is served with the policy by the local host', async () => {
  assert.ok(PAGES.includes('index.html') && PAGES.length >= 7, 'found the pages: ' + PAGES.join(', '));
  const expected = pageRuleValue('/index.html')[0];
  await withServer(async (base) => {
    for (const address of ['/'].concat(PAGES.map((f) => '/' + f))) {
      const response = await fetch(base + address);
      assert.equal(response.status, 200, address);
      assert.equal(response.headers.get('content-security-policy'), expected, address);
    }
    // not on data or scripts: the policy is for documents
    assert.equal((await fetch(base + '/app.js')).headers.get('content-security-policy'), null);
    assert.equal((await fetch(base + '/api/config')).headers.get('content-security-policy'), null);
  });
});

test('the Cloudflare _headers file carries the same policy for the root and for every page', () => {
  const { buildHeadersFile, listPublicFiles } = require('../scripts/build-cloudflare.js');
  const file = buildHeadersFile(listPublicFiles(root), vercel);
  const blocks = file.split(/\n\n/);
  const expected = pageRuleValue('/index.html')[0];
  for (const address of ['/'].concat(PAGES.map((f) => '/' + f))) {
    const block = blocks.find((b) => b.split('\n')[0] === address);
    assert.ok(block, address + ' has a rule in _headers');
    assert.ok(block.includes('  Content-Security-Policy: ' + expected), address + ' carries the policy');
  }
  assert.equal(blocks.filter((b) => /Content-Security-Policy/.test(b) && /^\/(app\.js|api)/.test(b)).length, 0);
});

test('no page has inline script, an inline event handler attribute or a javascript: address', () => {
  for (const page of PAGES) {
    const html = read(page);
    const inline = [...html.matchAll(/<script\b([^>]*)>/gi)].filter((m) => !/\bsrc\s*=/.test(m[1]));
    assert.deepEqual(inline.map((m) => m[0]), [], page + ' has an inline <script>');
    assert.deepEqual([...html.matchAll(/\son[a-z]{3,}\s*=/gi)].map((m) => m[0].trim()), [], page + ' has an inline event handler attribute');
    assert.doesNotMatch(html, /javascript:/i, page);
  }
});

test('no script builds markup with an inline handler attribute, a javascript: address, eval or new Function', () => {
  const files = fs.readdirSync(root).filter((f) => f.endsWith('.js'));
  const bad = [];
  for (const file of files) {
    const lines = read(file).split('\n');
    lines.forEach((line, i) => {
      // `<a onclick="..."`, `' onclick=\"..."`, ` onsubmit='...'` inside a string, but not `el.onclick = fn`
      if (/[\s"'`]on[a-z]{3,}\s*=\s*[\\"'`]/.test(line)) bad.push(file + ':' + (i + 1) + ' inline handler');
      if (/javascript:/i.test(line) && !/^\s*(\/\/|\*|\/\*)/.test(line) && !/replace\(|test\(|match\(|indexOf\(|startsWith\(|\/javascript/.test(line)) bad.push(file + ':' + (i + 1) + ' javascript: address');
      if (/(^|[^.\w])eval\s*\(|new\s+Function\s*\(/.test(line)) bad.push(file + ':' + (i + 1) + ' eval / new Function');
    });
  }
  assert.deepEqual(bad, []);
});

test('the hero video script is an external file, loaded by the storefront with a cache-busting version and cached like the other scripts', () => {
  const index = read('index.html');
  assert.match(index, /<script src="\/hero-video\.js\?v=[0-9A-Za-z-]+"><\/script>/);
  assert.ok(fs.existsSync(path.join(root, 'hero-video.js')));
  const cacheRule = vercel.headers.find((r) => /hero-video\.js/.test(r.source));
  assert.ok(cacheRule, 'hero-video.js is in a vercel.json cache rule');
  assert.ok(cacheRule.headers.some((h) => h.key === 'Cache-Control'));
});

/* The three handlers that used to be attributes in the markup now live in app-core.js as delegated listeners. */
function loadStorefrontListeners() {
  const listeners = {};
  const opened = [];
  const removed = [];
  const element = () => new Proxy(function () {}, {
    get(target, key) {
      if (key === Symbol.toPrimitive) return () => '';
      if (key === 'then') return undefined;
      if (key === 'length') return 0;
      if (key === 'classList') return { add() {}, remove() {}, toggle() {}, contains() { return false; } };
      return element();
    },
    set() { return true; },
    apply() { return element(); }
  });
  const document = {
    getElementById: () => element(), querySelector: () => element(), querySelectorAll: () => [], createElement: () => element(),
    addEventListener(type, fn) { (listeners[type] = listeners[type] || []).push(fn); }, removeEventListener() {},
    body: { classList: { add() {}, toggle() {}, contains() { return false; }, remove(name) { removed.push(name); } } },
    head: element(), documentElement: element(), cookie: '', readyState: 'complete', currentScript: null, referrer: '', title: ''
  };
  const storage = { getItem: () => null, setItem() {}, removeItem() {} };
  const sandbox = {
    document, console: { log() {}, error() {}, warn() {} }, localStorage: storage, sessionStorage: storage,
    fetch: async () => ({ ok: false, status: 500, headers: { get: () => null }, json: async () => ({}), text: async () => '' }),
    setTimeout: () => 0, setInterval: () => 0, clearTimeout() {}, clearInterval() {}, requestAnimationFrame: () => 0,
    matchMedia: () => ({ matches: false, addEventListener() {}, addListener() {} }), scrollTo() {}, getComputedStyle: () => ({}),
    navigator: { userAgent: 'test', language: 'ar', languages: ['ar'] }, screen: { width: 400, height: 800 },
    location: { href: 'https://shop.test/', origin: 'https://shop.test', hash: '', search: '', pathname: '/', host: 'shop.test', hostname: 'shop.test' },
    history: { pushState() {}, replaceState() {} }, innerWidth: 400, innerHeight: 800,
    IntersectionObserver: class { observe() {} disconnect() {} }, ResizeObserver: class { observe() {} disconnect() {} },
    MutationObserver: class { observe() {} disconnect() {} }, CustomEvent: class {}, Event: class {}, URL, URLSearchParams, Image: class {},
    addEventListener() {}, removeEventListener() {}, dispatchEvent() {}, open: (url) => { opened.push(url); }
  };
  sandbox.window = sandbox; sandbox.self = sandbox; sandbox.globalThis = sandbox; sandbox.parent = sandbox; sandbox.top = sandbox;
  vm.createContext(sandbox);
  vm.runInContext(read('texts.js'), sandbox, { filename: 'texts.js' });
  vm.runInContext(read('app-core.js'), sandbox, { filename: 'app-core.js' });
  return { listeners, opened, removed, run: (code) => vm.runInContext(code, sandbox) };
}

const clickOn = (matches) => {
  const prevented = [];
  const target = { closest: (selector) => (matches[selector] ? {} : null) };
  return { event: { target, preventDefault: () => prevented.push(true) }, prevented };
};

test('the WhatsApp link opens wa.me with the digits of the saved number and leaves the page alone otherwise', () => {
  const page = loadStorefrontListeners();
  assert.ok(page.listeners.click && page.listeners.click.length > 0, 'a delegated click listener is registered');
  const fire = (matches) => { const c = clickOn(matches); page.listeners.click.forEach((fn) => { try { fn(c.event); } catch (_) { /* other listeners need a real DOM */ } }); return c; };

  page.run("CFG.waNumber = ''");
  let c = fire({ '#wa': true });
  assert.deepEqual(page.opened, [], 'no number saved: the link goes to the contact section as before');
  assert.deepEqual(c.prevented, []);

  page.run("CFG.waNumber = '+20 100 123-4567'");
  c = fire({ '#wa': true });
  assert.deepEqual(page.opened, ['https://wa.me/201001234567'], 'only digits are put in the address');
  assert.equal(c.prevented.length, 1);

  page.run('CFG.waNumber = \'1"><script>\'');
  fire({ '#wa': true });
  assert.equal(page.opened[1], 'https://wa.me/1', 'a number with markup cannot change the address');
});

test('a footer link closes the inner page view, and the contact form is sent through sendMsg', () => {
  const page = loadStorefrontListeners();
  const click = clickOn({ '#fcols a': true });
  page.listeners.click.forEach((fn) => { try { fn(click.event); } catch (_) { /* other listeners need a real DOM */ } });
  assert.deepEqual(page.removed, ['inner']);

  // the contact form is wired by an attribute-free selector; the real sendMsg is swapped for a counter so no form is needed
  assert.ok(page.listeners.submit && page.listeners.submit.length > 0, 'a delegated submit listener is registered');
  page.run('globalThis.__calls = 0; sendMsg = function () { globalThis.__calls++; };');
  page.listeners.submit.forEach((fn) => fn({ target: { closest: () => null, matches: (selector) => selector === 'form[data-contact-form]' } }));
  assert.equal(page.run('globalThis.__calls'), 1);
  page.listeners.submit.forEach((fn) => fn({ target: { closest: () => null, matches: () => false } }));
  assert.equal(page.run('globalThis.__calls'), 1, 'other forms are not routed to sendMsg');
  assert.match(read('index.html'), /<form data-contact-form>/);
});
