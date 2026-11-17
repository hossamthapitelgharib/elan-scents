const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

/* The admin panel is one document (platform-dashboard.html) with pages inside it. These tests read the real html and scripts: the page list, the way scripts
   share one global scope, the sign-in gate, and the old addresses that now redirect. The click-through is in tests/browser/admin-shell.chromium.js. */
const root = path.join(__dirname, '..');
const read = file => fs.readFileSync(path.join(root, file), 'utf8');
const html = read('platform-dashboard.html');
const shellSource = read('admin-shell.js');
const ROUTES = ['overview', 'first-notices', 'messages', 'customers', 'stores', 'settlements', 'rankings', 'audit'];

const scriptsOf = page => [...page.matchAll(/<script src="\/([a-z0-9.-]+\.js)\?v=([0-9A-Za-z-]+)"([^>]*)><\/script>/g)].map(match => ({ file: match[1], version: match[2], attrs: match[3] }));
const adminScripts = () => scriptsOf(html).map(script => script.file).filter(file => !['auth-session.js', 'portal.js', 'turnstile.js', 'pw-eye.js'].includes(file));

test('every page of the panel has a menu link, a section and a title, and nothing else is linked as a page', () => {
  const shellRoutes = [...shellSource.matchAll(/^    '?([a-z-]+)'?: \{ title: '([^']+)', module: '([a-z]+)' \},?$/gm)].map(match => ({ key: match[1], title: match[2], module: match[3] }));
  assert.deepEqual(shellRoutes.map(route => route.key), ROUTES);
  const links = [...html.matchAll(/<a class="nav-link"[^>]*data-page="([a-z-]+)"/g)].map(match => match[1]);
  assert.deepEqual([...links].sort(), [...ROUTES].sort(), 'one menu link per page');
  for (const route of shellRoutes) {
    assert.match(html, new RegExp(`<section class="page" id="page-${route.key}" data-page="${route.key}" hidden`), `section for ${route.key}`);
    assert.match(html, new RegExp(`data-page="${route.key}"[^>]*>[\\s\\S]*?<span>${route.title}</span>`), `the menu names ${route.key} as «${route.title}»`);
  }
  const sections = [...html.matchAll(/<section class="page" id="page-([a-z-]+)"/g)].map(match => match[1]);
  assert.deepEqual(sections, ROUTES);
  assert.match(html, /<a class="nav-link" href="\/dashboard\.html">/, 'the orders board stays one click away as its own page');
});

test('the modules the pages load through are registered by scripts the panel loads, and only once each', () => {
  const modules = [...new Set([...shellSource.matchAll(/module: '([a-z]+)'/g)].map(match => match[1]))].sort();
  const registered = [];
  const withoutComments = source => source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
  for (const file of adminScripts()) for (const match of withoutComments(read(file)).matchAll(/AdminPages\.register\('([a-z]+)'/g)) registered.push(match[1]);
  assert.deepEqual([...registered].sort(), modules);
  assert.equal(new Set(registered).size, registered.length, 'no module registered twice');
});

test('scripts load in an order where each one finds what it needs, and every file is there with the same ?v= as the rest', () => {
  const list = scriptsOf(html);
  const order = list.map(script => script.file);
  const at = file => order.indexOf(file);
  for (const file of ['admin-common.js', 'platform-dashboard.js', 'customers-dashboard.js', 'stores-dashboard.js', 'admin-alerts.js', 'admin-notices.js', 'admin-messages.js', 'admin-shell.js']) assert.ok(at(file) > -1, file);
  assert.ok(at('portal.js') < at('admin-common.js'));
  assert.ok(at('admin-common.js') < at('platform-dashboard.js'), 'the shared helpers come first');
  for (const page of ['platform-dashboard.js', 'customers-dashboard.js', 'stores-dashboard.js']) assert.ok(at(page) < at('admin-alerts.js'), `${page} registers its page before the alert centre starts`);
  assert.ok(at('admin-alerts.js') < at('admin-notices.js') && at('admin-alerts.js') < at('admin-messages.js'), 'the pages that listen to the alert centre load after it');
  assert.equal(order[order.length - 1], 'admin-shell.js', 'the shell starts last, when everything it opens is registered');
  const versions = new Set(list.map(script => script.version));
  assert.equal(versions.size, 1);
  const manifest = JSON.parse(read('asset-manifest.json'));
  assert.equal([...versions][0], manifest.version);
  for (const script of list) assert.ok(fs.existsSync(path.join(root, script.file)), script.file);
  assert.match(html, new RegExp(`<link rel="stylesheet" href="/portal\\.css\\?v=${manifest.version}">\\s*<link rel="stylesheet" href="/admin\\.css\\?v=${manifest.version}">`), 'admin.css loads after portal.css');
});

test('the shared scripts and the new stylesheet are served immutable and tracked by the manifest', () => {
  const vercel = read('vercel.json');
  const manifest = JSON.parse(read('asset-manifest.json'));
  for (const file of ['admin.css', 'admin-common.js', 'admin-alerts.js', 'admin-notices.js', 'admin-messages.js', 'admin-shell.js']) {
    assert.match(vercel, new RegExp(`\\|${file.replace('.', '\\.')}[|)]`), `${file} is in the immutable rule`);
    assert.ok(manifest.files[file], `${file} is in asset-manifest.json`);
  }
});

test('the scripts share one global scope without clashing: no top-level name is declared twice, and every id a script asks for exists', () => {
  const declared = new Map();
  const clashes = [];
  for (const file of adminScripts()) {
    const source = read(file);
    for (const match of source.matchAll(/^(?:const|let|var|class|async function|function)\s+([A-Za-z_$][\w$]*)/gm)) {
      const name = match[1];
      if (declared.has(name) && declared.get(name) !== file) clashes.push(`${name} in ${declared.get(name)} and ${file}`);
      declared.set(name, file);
    }
  }
  assert.deepEqual(clashes, []);
  const ids = new Set([...html.matchAll(/\sid="([^"]+)"/g)].map(match => match[1]));
  const all = [...html.matchAll(/\sid="([^"]+)"/g)].map(match => match[1]);
  assert.equal(all.length, ids.size, 'no id appears twice in the document');
  // ids the stores script writes into the store-detail card it builds when a store is opened
  const created = new Set(['storeAccountsError', 'storeTermsError', 'storeAccountsBody']);
  const missing = [];
  for (const file of adminScripts()) {
    const source = read(file);
    for (const match of source.matchAll(/(?:\$|querySelector)\('#([A-Za-z][\w-]*)'\)|getElementById\('([A-Za-z][\w-]*)'\)/g)) {
      const id = match[1] || match[2];
      if (!ids.has(id) && !created.has(id)) missing.push(`${file}: #${id}`);
    }
  }
  assert.deepEqual([...new Set(missing)], []);
});

test('the page has no inline script or handler, and the shell owns the five ids it shares with the page scripts', () => {
  assert.doesNotMatch(html, /<script(?![^>]*\bsrc=)/i);
  assert.doesNotMatch(html, /\son[a-z]+=/i);
  assert.match(html, /<body class="admin" data-own-alerts>/, 'the portal\'s own notification bell stays off: the alert centre replaces it');
  for (const id of ['login', 'loginForm', 'app', 'logout', 'refresh', 'message', 'boot', 'adminNav', 'adminMain', 'pageTitle', 'menuToggle', 'navBackdrop', 'soundToggle', 'bellLink', 'alertStrip', 'alertStripList']) {
    assert.equal((html.match(new RegExp(`\\sid="${id}"`, 'g')) || []).length, 1, id);
  }
  for (const file of ['platform-dashboard.js', 'customers-dashboard.js', 'stores-dashboard.js', 'admin-notices.js', 'admin-messages.js']) {
    const source = read(file);
    assert.doesNotMatch(source, /\$\('#loginForm'\)\.addEventListener|\$\('#refresh'\)\.addEventListener|querySelector\('#loginForm'\)\.addEventListener/, `${file} leaves sign-in and «تحديث» to the shell`);
    assert.doesNotMatch(source, /\son(click|submit|change)=/, file);
  }
});

test('the sound, bell and page-title controls are reachable by keyboard and readers', () => {
  assert.match(html, /<button id="soundToggle"[^>]*aria-pressed="false"/);
  assert.match(html, /<a id="bellLink"[^>]*aria-label="[^"]+"/);
  assert.match(html, /<button id="menuToggle"[^>]*aria-controls="adminSide"[^>]*aria-expanded="false"/);
  assert.match(html, /<h1 id="pageTitle"[^>]*tabindex="-1"/);
  assert.match(html, /class="skip-link" href="#adminMain"/);
  assert.match(html, /id="alertStrip"[^>]*role="region"|id="alertStrip"[^>]*aria-live/);
  assert.match(html, /class="ic ic-on"/);
  assert.match(html, /class="ic ic-off"/);
});

test('the old addresses of the customers and stores pages only send the visitor to the new place', () => {
  for (const [file, page] of [['customers-dashboard.html', 'customers'], ['stores-dashboard.html', 'stores']]) {
    const old = read(file);
    assert.match(old, new RegExp(`<meta http-equiv="refresh" content="0;url=/platform-dashboard\\.html#${page}">`), file);
    assert.match(old, new RegExp(`<a href="/platform-dashboard\\.html#${page}">`), `${file}: a visible link too, in case the redirect is blocked`);
    assert.doesNotMatch(old, /<script/i, file);
    assert.match(old, /name="robots" content="noindex"/);
  }
  assert.match(read('vercel.json'), /customers-dashboard\\\.html\|stores-dashboard\\\.html|stores-dashboard\\\.html\|customers-dashboard\\\.html|customers-dashboard\.html/, 'they stay out of the long-lived cache so the redirect can be changed');
});

test('«ينتظرك الآن» only links where there is something to open', () => {
  const targets = new Set();
  for (const file of ['platform-dashboard.js', 'admin-alerts.js']) for (const match of read(file).matchAll(/href: '([^']+)'/g)) targets.add(match[1]);
  assert.ok(targets.size >= 3);
  for (const target of targets) {
    if (target.startsWith('#')) assert.ok(ROUTES.includes(target.slice(1)), `${target} is a page of the panel`);
    else assert.ok(fs.existsSync(path.join(root, target.replace(/^\//, ''))), `${target} exists`);
  }
});

/* ---- the sign-in gate, with the real shell script in a vm ---- */
function bootShell({ session = true, status = 200 } = {}) {
  const nodes = new Map();
  const get = selector => { if (!nodes.has(selector)) nodes.set(selector, { hidden: false, disabled: false, textContent: '', dataset: {}, attributes: {}, listeners: {}, classList: { toggle() {}, contains: () => false }, addEventListener(type, callback) { this.listeners[type] = callback; }, setAttribute() {}, removeAttribute() {}, focus() {}, querySelector: () => null }); return nodes.get(selector); };
  const store = session ? { elan_auth_session: JSON.stringify({ access_token: 't' }) } : {};
  const document = { hidden: false, title: '', body: { classList: { toggle() {}, contains: () => false } }, querySelector: get, querySelectorAll: () => [], addEventListener() {}, removeEventListener() {} };
  const context = vm.createContext({
    document, console, setTimeout: () => 0, clearTimeout() {},
    localStorage: { getItem: key => (key in store ? store[key] : null), setItem: (key, value) => { store[key] = String(value); }, removeItem: key => { delete store[key]; } },
    Portal: {
      session: () => (store.elan_auth_session ? JSON.parse(store.elan_auth_session) : null), auth: () => ({}), login: async () => {},
      errorText: error => ({ unauthorized: 'انتهت الجلسة.', forbidden: 'هذا الحساب ليس مديرًا للمنصة.' }[error && error.message] || 'تعذر الفتح.')
    },
    location: { hash: '' }, history: { replaceState() {} },
    fetch: async () => ({ ok: status === 200, status, json: async () => (status === 200 ? { ok: true, notifications: [], unread: 0, firstNotices: 0 } : { error: status === 401 ? 'unauthorized' : 'forbidden' }) })
  });
  context.window = context;
  context.addEventListener = () => {};
  context.scrollTo = () => {};
  for (const file of ['admin-common.js', 'admin-alerts.js', 'admin-shell.js']) vm.runInContext(read(file), context, { filename: file });
  return { context, get, store };
}
const settle = async () => { for (let i = 0; i < 10; i++) await new Promise(resolve => setImmediate(resolve)); };

test('an address that is not a page opens the overview, and an address with a query or slash still finds its page', () => {
  const { context } = bootShell({ session: false });
  const pageFromHash = vm.runInContext('AdminShell.pageFromHash', context);
  for (const key of ROUTES) assert.equal(pageFromHash(`#${key}`), key);
  assert.equal(pageFromHash(''), 'overview');
  assert.equal(pageFromHash('#'), 'overview');
  assert.equal(pageFromHash('#nope'), 'overview');
  assert.equal(pageFromHash('#orders'), 'overview', 'the old orders address does not leave a blank panel');
  assert.equal(pageFromHash('#messages?type=order_initial'), 'messages');
  assert.equal(pageFromHash('#stores/abc'), 'stores');
  assert.equal(pageFromHash('#constructor'), 'overview', 'names from the object prototype are not pages');
  assert.equal(pageFromHash('#__proto__'), 'overview');
});

test('no saved session shows the sign-in card and asks nothing from the server', async () => {
  const page = bootShell({ session: false });
  await settle();
  assert.equal(page.get('#login').hidden, false);
  assert.equal(page.get('#app').hidden, true);
  assert.equal(page.get('#boot').hidden, true);
});

test('the server decides who may enter: an ended session is cleared, a customer account is told why, a platform admin gets the panel', async () => {
  const ended = bootShell({ status: 401 });
  await settle();
  assert.equal(ended.get('#login').hidden, false);
  assert.equal(ended.get('#app').hidden, true);
  assert.equal(ended.store.elan_auth_session, undefined, 'the dead session is removed');
  assert.match(ended.get('#message').textContent, /انتهت الجلسة/);

  const wrongRole = bootShell({ status: 403 });
  await settle();
  assert.equal(wrongRole.get('#login').hidden, false);
  assert.equal(wrongRole.get('#app').hidden, true);
  assert.ok(wrongRole.store.elan_auth_session, 'a wrong-role session is kept; signing in again replaces it');
  assert.match(wrongRole.get('#message').textContent, /ليس مديرًا للمنصة/);

  const admin = bootShell({ status: 200 });
  await settle();
  assert.equal(admin.get('#login').hidden, true);
  assert.equal(admin.get('#app').hidden, false);
  assert.equal(admin.get('#logout').hidden, false);
  assert.equal(admin.get('#boot').hidden, true);
});
