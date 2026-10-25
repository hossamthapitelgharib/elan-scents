/* The public storefront builds its HTML from catalog rows (brands, stores, products, offers, settings). A store can write its own offers,
   and an admin account can be compromised, so a value that reaches innerHTML unescaped is a stored XSS for every visitor.
   This test runs the real texts.js + app-core.js in a Node VM with a minimal fake DOM, answers every Supabase request with
   attacker-looking text in EVERY text column, walks the main views, and fails when any HTML the page writes still contains the
   payload as live markup. It needs no browser and no network. */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const root = path.resolve(__dirname, '..');
const read = (name) => fs.readFileSync(path.join(root, name), 'utf8');

const NUMERIC = /^(id|.*_id|price|original_price|.*_count|stock_quantity|size_ml|average_rating)$/;
const BOOLEAN = /^(is_.*|price_includes_.*)$/;
const PAYLOAD = (where) => '<img src=x onerror=__x(\'' + where + '\')>';
const ATTRIBUTE_BREAKOUT = (where) => 'https://x.test/a.png" onerror="__x(\'' + where + '\')';

function column(table, name, plain) {
  if (NUMERIC.test(name)) return name === 'average_rating' ? 4.5 : name === 'size_ml' ? 100 : /price/.test(name) ? 10 : 1;
  if (BOOLEAN.test(name)) return true;
  if (plain && plain[table + '.' + name] !== undefined) return plain[table + '.' + name];
  if (name === 'image_url') return ATTRIBUTE_BREAKOUT(table + '.' + name);
  return PAYLOAD(table + '.' + name);
}

/* A fake element that accepts anything. Every innerHTML / insertAdjacentHTML write is recorded. */
function makeDom(written) {
  const cache = new Map();
  function element(id) {
    if (cache.has(id)) return cache.get(id);
    const own = { innerHTML: '', dataset: {}, value: '', hidden: false, textContent: '' };
    const proxy = new Proxy(function () {}, {
      get(target, key) {
        if (key === Symbol.toPrimitive) return () => '';
        if (key === 'then') return undefined;
        if (key === 'length') return 0;
        if (key === 'insertAdjacentHTML') return (where, html) => { written.push({ id, html: String(html) }); };
        if (key === 'closest' || key === 'querySelector' || key === 'getElementById') return () => null;
        if (key === 'classList') return { add() {}, remove() {}, toggle() {}, contains() { return false; } };
        if (key in own) return own[key];
        return proxy;
      },
      set(target, key, value) {
        if (key === 'innerHTML') written.push({ id, html: String(value) });
        own[key] = value;
        return true;
      },
      apply() { return proxy; }
    });
    cache.set(id, proxy);
    return proxy;
  }
  const document = {
    getElementById: (id) => element('#' + id),
    querySelector: (sel) => element(sel),
    querySelectorAll: () => [],
    createElement: () => element('created'),
    addEventListener() {}, removeEventListener() {},
    body: element('body'), head: element('head'), documentElement: element('html'),
    cookie: '', readyState: 'complete', currentScript: null, referrer: '', title: ''
  };
  return document;
}

function catalogFor(url, plain) {
  const u = new URL(url);
  const table = (u.pathname.match(/\/rest\/v1\/([^/]+)/) || [])[1];
  if (table === 'site_settings') {
    return ['whatsapp_number', 'contact_email', 'order_request_endpoint', 'facebook_url', 'instagram_url', 'tiktok_url', 'footer_tagline', 'developer_credit']
      .map((key) => ({ key, value: PAYLOAD('site_settings.' + key) }));
  }
  const select = (u.searchParams.get('select') || 'id').split(',');
  return [1, 2].map(() => Object.fromEntries(select.map((name) => [name, column(table, name, plain)])));
}

async function openStorefront(plain) {
  const written = [];
  const fired = [];
  const document = makeDom(written);
  const storage = { getItem: () => null, setItem() {}, removeItem() {} };
  const SB = 'https://sb.invalid.test';
  const sandbox = {
    document, console: { log() {}, error() {}, warn() {} }, localStorage: storage, sessionStorage: storage,
    __x: (where) => fired.push(where),
    fetch: async (url) => {
      url = String(url);
      const body = url.endsWith('/api/config') ? { url: SB, key: 'anon' } : url.startsWith(SB + '/rest/v1/') ? catalogFor(url, plain) : [];
      return { ok: true, status: 200, headers: { get: () => null }, json: async () => body, text: async () => JSON.stringify(body) };
    },
    setTimeout: () => 0, setInterval: () => 0, clearTimeout() {}, clearInterval() {}, requestAnimationFrame: () => 0, cancelAnimationFrame() {},
    matchMedia: () => ({ matches: false, addEventListener() {}, addListener() {} }), scrollTo() {}, getComputedStyle: () => ({}),
    navigator: { userAgent: 'test', language: 'ar', languages: ['ar'] }, screen: { width: 400, height: 800 },
    location: { href: 'https://shop.test/', origin: 'https://shop.test', hash: '', search: '', pathname: '/', host: 'shop.test', hostname: 'shop.test' },
    history: { pushState() {}, replaceState() {} }, innerWidth: 400, innerHeight: 800,
    IntersectionObserver: class { observe() {} unobserve() {} disconnect() {} }, ResizeObserver: class { observe() {} disconnect() {} },
    MutationObserver: class { observe() {} disconnect() {} }, CustomEvent: class {}, Event: class {}, URL, URLSearchParams, Image: class {},
    addEventListener() {}, removeEventListener() {}, dispatchEvent() {}
  };
  sandbox.window = sandbox; sandbox.self = sandbox; sandbox.globalThis = sandbox; sandbox.parent = sandbox; sandbox.top = sandbox;
  vm.createContext(sandbox);
  vm.runInContext(read('texts.js'), sandbox, { filename: 'texts.js' });
  vm.runInContext(read('app-core.js'), sandbox, { filename: 'app-core.js' });
  for (let i = 0; i < 40; i++) await new Promise((resolve) => setImmediate(resolve)); // let loadData() finish
  // A click on data-go="brand|<escaped name>" reaches go() as the decoded text, so the tests do the same.
  vm.runInContext('var dec = function (s) { return String(s).replace(/&#39;/g, "\'").replace(/&quot;/g, \'"\').replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&amp;/g, "&"); };', sandbox);
  return { run: (code) => vm.runInContext(code, sandbox), written, fired };
}

function walkViews(page) {
  const steps = ['go("sec|brands")', 'go("sec|stores")', 'go("sec|all")', 'go("sec|offers")', 'go("sec|new")', 'go("sec|master")',
    'go("sec|cats")', 'go("sec|occ")', 'go("sec|notes")', 'go("col|cats|0")', 'go("col|occ|0")', 'go("col|notes|0")', 'go("prod|1")',
    'go("brand|" + dec(BR[0]))', 'go("store|" + dec(ST[0][0]))', 'render()', 'sheet("cart")', 'sheet("login")', 'sheet("signup")', 'sheet("fav")', 'sheet("orders")',
    'addToCart(1,1); sheet("cart")', 'openStoreOrder(ST[0][0])', 'results()', 'footer18(T())', 'quickSearchResults("a")'];
  for (const step of steps) { try { page.run(step); } catch (_) { /* a view that needs a real DOM is skipped; the others still count */ } }
}

const LIVE_PAYLOAD = /<img src=x onerror=__x|"\s*onerror="__x/;

test('catalog text with markup in every column never reaches the storefront HTML as live markup', async () => {
  const page = await openStorefront();
  assert.ok(page.written.length > 5, 'the storefront should have drawn something (' + page.written.length + ' writes)');
  walkViews(page);
  const live = page.written.filter((w) => LIVE_PAYLOAD.test(w.html));
  const columns = [...new Set(live.map((w) => (w.html.match(/__x\('([^']+)'/) || [])[1]))];
  assert.deepEqual(columns, [], 'these columns reach the page unescaped: ' + columns.join(', '));
  assert.deepEqual(page.fired, []);
});

test('the catalog really was drawn from the fake rows (the check above is not vacuous)', async () => {
  const page = await openStorefront();
  walkViews(page);
  const all = page.written.map((w) => w.html).join('\n');
  assert.match(all, /&lt;img src=x onerror=__x\(&#39;public_brands\.name&#39;\)&gt;/, 'brand names are shown, escaped');
  assert.match(all, /public_stores\.name/);
  assert.match(all, /cheapest_offers\.currency/);
});

test('names with & and an apostrophe are escaped once (no &amp;amp;) and still match their own filters', async () => {
  const plain = {
    'public_brands.name': "Maison & Co's", 'public_products.brand_name': "Maison & Co's", 'public_products.name': 'Oud & Musk',
    'public_stores.name': "Store's & More", 'cheapest_offers.store_name': "Store's & More", 'public_stores.short_description': 'Fine & rare',
    'public_products.short_description': 'a & b', 'public_products.official_description': 'c', 'public_products.composition': 'd',
    'product_sizes.size_label': '100ml', 'cheapest_offers.currency': 'EGP', 'site_settings.footer_tagline': 'x'
  };
  const page = await openStorefront(plain);
  page.run('go("brand|" + dec(BR[0]))');
  const html = page.written.map((w) => w.html).join('\n');
  assert.match(html, /Maison &amp; Co&#39;s/);
  assert.doesNotMatch(html, /&amp;amp;|&amp;#39;/);
  // the product of that brand is listed on the brand page: the filter compares escaped with escaped
  assert.ok(page.run('list().length') > 0, 'the brand page lists the brand\'s products');
  assert.equal(page.run('list().every(function (x) { return x.p.brand === BR[0]; })'), true);
});
