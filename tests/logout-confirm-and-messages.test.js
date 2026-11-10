// The on-screen messages and the sign-out question:
//  - the storefront asks «OK / Cancel» before signing out (the menu entry only asks), and says goodbye on the next page;
//  - the welcome appears the moment the session exists, before the slower account syncs;
//  - the account page (and the other panels) say welcome / goodbye too, in a toast that is actually styled;
//  - on the storefront the welcome and the goodbye are the same card as the first-time «account confirmed» one (owner, 8 Nov 2026).
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const root = path.join(__dirname, '..');
const read = (file) => fs.readFileSync(path.join(root, file), 'utf8');
const core = read('app-core.js');
const oneLine = (start) => { const i = core.indexOf(start); assert.ok(i >= 0, start + ' exists'); return core.slice(i, core.indexOf('\n', i)); };

test('the menu entry opens a question, and only «OK» signs out; «Cancel» and the × just close it', () => {
  const fn = oneLine('function confirmLogout');
  assert.match(fn, /data-logout-now/, 'the OK button');
  assert.match(fn, /data-close-sheet>'\+esc\(l\.n\)/, 'the Cancel button closes the sheet and nothing else');
  assert.match(fn, /role="alertdialog"/);
  assert.doesNotMatch(fn, /ElanAuth|signOut|location\.reload/, 'asking does not sign out');
  assert.match(core, /var ln=e\.target\.closest\('\[data-logout-now\]'\);if\(ln\)\{e\.preventDefault\(\);logoutNow\(\)/);
  assert.match(core, /var lo=e\.target\.closest\('\[data-logout\]'\);if\(lo\)\{e\.preventDefault\(\);document\.getElementById\('menu'\)\.classList\.remove\('open'\);confirmLogout\(\)/);
});

test('the question is written in both languages and the text is escaped before it reaches the page', () => {
  const texts = read('texts.js');
  assert.match(texts, /lo:\{t:'تسجيل الخروج',q:'هل تريد تسجيل الخروج من حسابك؟',y:'موافق',n:'إلغاء'\}/);
  assert.match(texts, /lo:\{t:'Sign out',q:'Do you want to sign out of your account\?',y:'OK',n:'Cancel'\}/);
  const fn = oneLine('function confirmLogout');
  for (const key of ['l.t', 'l.q', 'l.y', 'l.n']) assert.ok(fn.includes('esc(' + key + ')'), key + ' goes through esc()');
});

test('confirmLogout builds the sheet with OK and Cancel, and does nothing while signing out or in the editor preview', () => {
  const html = { value: '' };
  const sheet = { hidden: true, dataset: {} };
  const classes = new Set();
  const context = vm.createContext({
    lang: 'ar', LOGGING_OUT: false, window: {}, esc: (v) => String(v), T: () => ({ lo: { t: 'تسجيل الخروج', q: 'هل تريد تسجيل الخروج من حسابك؟', y: 'موافق', n: 'إلغاء' } }),
    document: { getElementById: (id) => id === 'sheet' ? sheet : id === 'sheetB' ? { set innerHTML(v) { html.value = v; } } : null, body: { classList: { add: (c) => classes.add(c) } } },
    logoutNow: () => { throw new Error('asking must not sign out'); }
  });
  vm.runInContext(oneLine('function confirmLogout'), context);
  vm.runInContext('confirmLogout()', context);
  assert.equal(sheet.hidden, false);
  assert.equal(sheet.dataset.kind, 'logout');
  assert.ok(classes.has('sheet-open'));
  assert.match(html.value, /<button class="btn" type="button" data-logout-now>موافق<\/button>/);
  assert.match(html.value, /<div class="auth-actions"><button class="btn" type="button" data-logout-now>موافق<\/button><button class="btn ghost" type="button" data-close-sheet>إلغاء<\/button><\/div>/, 'the two answers sit in one row with a gap between them');
  assert.match(html.value, /هل تريد تسجيل الخروج من حسابك؟/);
  // while a sign-out is already running, or in the editor preview, the question is not asked
  sheet.hidden = true; html.value = '';
  context.LOGGING_OUT = true; vm.runInContext('confirmLogout()', context);
  assert.equal(sheet.hidden, true);
  context.LOGGING_OUT = false; context.window.ELAN_EDITOR_PREVIEW = true; vm.runInContext('confirmLogout()', context);
  assert.equal(sheet.hidden, true);
});

test('the welcome card comes before the slower account syncs, so a slow network never hides it', () => {
  const i = core.indexOf("buildMenu();mailEvent(mode=='signup'?'registered':'login',d.access_token);");
  assert.ok(i > 0);
  const tail = core.slice(i, core.indexOf('}).catch(', i));
  const order = ['else welcomeNotice()', 'await carryClaim', 'await GuestIdentity.claim', 'await syncCartFromCloud', 'await syncFavsFromCloud', 'openStoreOrder(st)'].map((marker) => {
    const at = tail.indexOf(marker); assert.ok(at >= 0, marker + ' is in the sign-in path'); return at;
  });
  assert.deepEqual(order, [...order].sort((a, b) => a - b), 'welcome card, then the carried lists, the guest claim and the syncs, then the store order form');
  assert.doesNotMatch(tail, /toast\(welcomeBackText/, 'the old toast is gone');
});

test('signing in without waiting: the welcome card shows while the syncs are still pending', async () => {
  // run the real success path with syncs that never finish
  const notices = [];
  const start = core.indexOf("AUTH=d;try{localStorage.setItem('elan_auth_session'");
  const path = core.slice(start, core.indexOf('}).catch(', start));
  const context = vm.createContext({
    AUTH: null, mode: 'login', d: { access_token: 'tok' }, PENDING_STORE: '', CART_FIRST_SYNC_DONE: false, lang: 'ar', localStorage: { setItem() {} },
    buildMenu() {}, adoptAccountLists() {}, mailEvent() {}, toast() { throw new Error('no toast'); }, welcomeNotice: () => notices.push('welcome'),
    sheetNotice: (kind) => notices.push(kind), signupDoneTitle: () => 'done', signupDoneText: () => 'signup',
    window: { GuestIdentity: { claim: () => new Promise(() => {}) } }, GuestIdentity: { claim: () => new Promise(() => {}) },
    carryClaim: () => new Promise(() => {}), syncCartFromCloud: () => new Promise(() => {}), syncFavsFromCloud: () => new Promise(() => {}), openStoreOrder() { throw new Error('no store chosen'); }
  });
  vm.runInContext('(async function(){' + path + '})()', context);
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(notices, ['welcome'], 'the welcome is on screen although the syncs never finished');
});

test('the account page and every panel: welcome after signing in on the account page, goodbye after any sign-out', () => {
  const portal = read('portal.js'), account = read('account.js');
  assert.match(portal, /Portal\.welcomeText = 'أهلًا ومرحبًا بك ونتمنى لك رحلة تسويقية ممتعة'/, 'the owner\'s wording');
  assert.match(account, /await Portal\.login\(event\.target\); Portal\.toast\(Portal\.welcomeText\); await loadAccount\(\)/);
  assert.match(portal, /sessionStorage\.setItem\('elan_flash', 'logout'\)/, 'sign-out leaves the note for the next page');
  assert.match(portal, /if \(flash === 'logout'\) Portal\.toast\('تم تسجيل الخروج بنجاح'\)/);
  assert.match(portal, /DOMContentLoaded', \(\) => \{ Portal\.showFlash\(\); Portal\.startNotifications\(\); \}/);
});

test('the panels\' toast is really styled (it used to be a bare div at the end of the page, so nobody saw it)', () => {
  for (const file of ['portal.css', 'dashboard.css']) {
    const css = read(file);
    assert.match(css, /#portalToast\{position:fixed;[^}]*bottom:24px/, file);
    assert.match(css, /\.portal-toast\{background:#1a1610;/, file);
    assert.match(css, /\.portal-toast\.warning\{/, file);
  }
  // every page that loads portal.js loads one of the two stylesheets
  for (const page of fs.readdirSync(root).filter((f) => f.endsWith('.html'))) {
    const html = read(page);
    if (!/src="\/portal\.js/.test(html)) continue;
    assert.match(html, /href="\/(portal|dashboard)\.css/, page + ' styles the toast');
  }
});
