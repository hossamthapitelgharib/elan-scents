/* The "are you a person" check (Cloudflare Turnstile) in front of the account forms.
   turnstile.js runs here in a fake browser: no Cloudflare, no Supabase, no real keys; the site key is a made-up string.
   The forms that must carry the token (the storefront's login and sign-up sheet, the portal login of every dashboard and the account page,
   the account page's forgotten-password form, and the editor's login and forgotten-password boxes) are checked against it. */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const root = path.join(__dirname, '..');
const read = (name) => fs.readFileSync(path.join(root, name), 'utf8');
const SOURCE = read('turnstile.js');
const SCRIPT_URL = 'https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit';
const settle = async () => { for (let i = 0; i < 8; i += 1) await new Promise((resolve) => setImmediate(resolve)); };

/* A browser with a page, a /api/config, and Cloudflare's script that "loads" on the next tick. */
function harness(options) {
  const state = Object.assign({ key: 'site-key-for-tests', configFails: false, scriptFails: false, readyHangs: false }, options);
  const timers = [], rendered = [], removed = [], scripts = [], fetches = [], listeners = {};
  const clock = { now: 1700000000000 };
  const element = (tag) => ({
    tag, id: '', className: '', children: [], parentNode: null,
    appendChild(child) { child.parentNode = this; this.children.push(child); return child; },
    insertBefore(child, before) { child.parentNode = this; const index = this.children.indexOf(before); this.children.splice(index < 0 ? this.children.length : index, 0, child); return child; },
    removeChild(child) { this.children = this.children.filter((c) => c !== child); child.parentNode = null; return child; },
    querySelector(selector) { return selector === 'button[type="submit"]' ? this.submitButton || null : null; },
    closest(selector) { return this.watched && selector.split(',').map((s) => s.trim()).includes(this.watched) ? this : null; }
  });
  const api = {
    render(holder, opts) { const id = 'widget-' + (rendered.length + 1); rendered.push({ id, holder, opts }); return id; },
    remove(id) { removed.push(id); },
    ready(fn) { if (!state.readyHangs) fn(); }
  };
  const head = element('head');
  head.appendChild = (el) => {
    el.parentNode = head; head.children.push(el);
    if (el.tag === 'script') {
      scripts.push(el);
      setImmediate(() => { if (state.scriptFails) el.onerror(); else { sandbox.turnstile = api; el.onload(); } });
    }
    return el;
  };
  const sandbox = {
    document: { head, createElement: element, addEventListener(type, fn) { listeners[type] = fn; } },
    fetch: async (url) => {
      fetches.push(String(url));
      if (state.configFails) throw new TypeError('Failed to fetch');
      return { ok: true, json: async () => ({ url: 'https://project.example.invalid', key: 'anon', turnstile_site_key: state.key }) };
    },
    setTimeout(fn, ms) { timers.push({ fn, ms, live: true }); return timers.length; },
    clearTimeout(id) { if (timers[id - 1]) timers[id - 1].live = false; },
    Date: { now: () => clock.now }, WeakMap, Promise, Error, String, Object, JSON
  };
  sandbox.window = sandbox;
  vm.runInNewContext(SOURCE, sandbox, { filename: 'turnstile.js' });
  const form = (watched) => { const f = element('form'); f.watched = watched || null; f.submitButton = element('button'); f.appendChild(f.submitButton); return f; };
  return { ts: sandbox.ElanTurnstile, state, timers, rendered, removed, scripts, fetches, listeners, clock, form, element };
}

test('with no site key the check does not exist: token() answers "" at once and nothing from Cloudflare is loaded', async () => {
  const h = harness({ key: '' });
  assert.equal(await h.ts.token(h.form()), '');
  assert.equal(h.scripts.length, 0);
  assert.equal(h.rendered.length, 0);
  await h.ts.token(h.form());
  assert.equal(h.fetches.length, 1, 'a missing key is an answer, so /api/config is not asked again');
});

test('with a key: Cloudflare\'s script is loaded once, the widget is drawn quietly, its token is returned and then used up', async () => {
  const h = harness();
  const form = h.form();
  const first = h.ts.token(form);
  await settle();
  assert.equal(h.scripts.length, 1);
  assert.equal(h.scripts[0].src, SCRIPT_URL);
  assert.equal(h.rendered.length, 1);
  assert.equal(h.rendered[0].opts.sitekey, 'site-key-for-tests');
  assert.equal(h.rendered[0].opts.appearance, 'interaction-only', 'nothing is shown unless Cloudflare needs the visitor to tick the box');
  assert.equal(h.rendered[0].holder.parentNode, form, 'a box that does appear is inside the form');
  assert.ok(form.children.indexOf(h.rendered[0].holder) < form.children.indexOf(form.submitButton), 'a required challenge is placed before the submit button and is reachable on mobile');
  h.rendered[0].opts.callback('token-one');
  assert.equal(await first, 'token-one');
  assert.deepEqual(h.removed, ['widget-1'], 'the used widget is removed');
  assert.deepEqual(form.children, [form.submitButton], 'the used holder is removed while the submit button stays in place');

  const second = h.ts.token(form);
  await settle();
  assert.equal(h.rendered.length, 2, 'a token works once, so the next request solves again');
  assert.equal(h.scripts.length, 1, 'but the script is not loaded again');
  h.rendered[1].opts.callback('token-two');
  assert.equal(await second, 'token-two');
});

test('a loaded explicit-render script does not wait forever for turnstile.ready()', async () => {
  const h = harness({ readyHangs: true });
  const pending = h.ts.token(h.form());
  await settle();
  assert.equal(h.rendered.length, 1, 'render starts as soon as the loaded API exposes render()');
  h.rendered[0].opts.callback('ready-timeout-fixed');
  assert.equal(await pending, 'ready-timeout-fixed');
});

test('a check started early (the form was opened) is the one the button uses: one widget, one token', async () => {
  const h = harness();
  const form = h.form();
  h.ts.warm(form);
  h.ts.warm(form);
  await settle();
  assert.equal(h.rendered.length, 1, 'warming twice draws one widget');
  h.rendered[0].opts.callback('early-token');
  assert.equal(await h.ts.token(form), 'early-token');
  assert.equal(h.rendered.length, 1);
});

test('a token that waited more than four minutes is thrown away and a new check is run', async () => {
  const h = harness();
  const form = h.form();
  h.ts.warm(form);
  await settle();
  h.rendered[0].opts.callback('old-token');
  h.clock.now += 241000;
  const next = h.ts.token(form);
  await settle();
  assert.equal(h.rendered.length, 2);
  assert.deepEqual(h.removed, ['widget-1']);
  h.rendered[1].opts.callback('new-token');
  assert.equal(await next, 'new-token');
});

test('a check Cloudflare could not finish fails with a sentence for the visitor and cleans up', async () => {
  const h = harness();
  const form = h.form();
  const pending = h.ts.token(form);
  await settle();
  h.rendered[0].opts['error-callback']('300030');
  await assert.rejects(pending, (error) => error.code === 'captcha_failed' && /التحقق الأمني/.test(error.message));
  assert.deepEqual(h.removed, ['widget-1']);
  assert.deepEqual(form.children, [form.submitButton], 'the failed holder is removed while the submit button stays in place');
});

test('a visitor who never finishes the check gets a time-out after two minutes', async () => {
  const h = harness();
  const pending = h.ts.token(h.form());
  await settle();
  const timer = h.timers.find((t) => t.ms === 120000 && t.live);
  assert.ok(timer, 'a two-minute limit is running');
  timer.fn();
  await assert.rejects(pending, (error) => error.code === 'captcha_timeout' && /انتهت مهلة/.test(error.message));
});

test('Cloudflare\'s script being blocked (an ad blocker, no network) is reported, and the next try loads it again', async () => {
  const h = harness({ scriptFails: true });
  await assert.rejects(h.ts.token(h.form()), (error) => error.code === 'captcha_unavailable' && /مانع الإعلانات/.test(error.message));
  h.state.scriptFails = false;
  const again = h.ts.token(h.form());
  await settle();
  assert.equal(h.scripts.length, 2, 'the failed script tag was not kept');
  h.rendered[0].opts.callback('late-token');
  assert.equal(await again, 'late-token');
});

test('a failed /api/config is not remembered as "no key": the next request asks again and finds the key', async () => {
  const h = harness({ configFails: true });
  assert.equal(await h.ts.token(h.form()), '');
  h.state.configFails = false;
  const next = h.ts.token(h.form());
  await settle();
  assert.equal(h.rendered.length, 1);
  h.rendered[0].opts.callback('after-outage');
  assert.equal(await next, 'after-outage');
});

test('touching one of the account forms starts the check; touching anything else does not', async () => {
  const h = harness();
  const other = h.form(null);
  const input = (formElement) => ({ closest: (selector) => formElement.closest(selector) });
  h.listeners.focusin({ target: input(other) });
  await settle();
  assert.equal(h.rendered.length, 0);
  for (const watched of ['#loginForm', '#authForm', '#resetForm', 'form[data-auth-form]']) {
    const g = harness();
    g.listeners.focusin({ target: input(g.form(watched)) });
    await settle();
    assert.equal(g.rendered.length, 1, watched + ' starts the check');
  }
});

test('body() puts the token where Supabase Auth reads it, and leaves the request alone without one', () => {
  const h = harness();
  assert.deepEqual(JSON.parse(JSON.stringify(h.ts.body({ email: 'a@example.invalid' }, 'tok'))), { email: 'a@example.invalid', gotrue_meta_security: { captcha_token: 'tok' } });
  assert.deepEqual(JSON.parse(JSON.stringify(h.ts.body({ email: 'a@example.invalid' }, ''))), { email: 'a@example.invalid' });
});

test('turnstile.js loads one script from Cloudflare only, with no inline handler, and keeps no secret', () => {
  assert.deepEqual([...new Set(SOURCE.match(/https:\/\/[a-z0-9.-]+/g))], ['https://challenges.cloudflare.com']);
  assert.doesNotMatch(SOURCE, /\.innerHTML|\son[a-z]+=|eval\(|new Function/);
  assert.doesNotMatch(SOURCE, /0x4[A-Za-z0-9_-]{10,}/, 'no Turnstile key of any kind is written in the script: the site key arrives from /api/config');
});

/* ---------- the forms ---------- */

const stub = (calls) => ({
  token: async (box) => { calls.push(box); return 'stub-token'; },
  body: (object, tk) => { if (tk) object.gotrue_meta_security = { captcha_token: tk }; return object; },
  messages: {}
});
const refusal = () => { const e = new Error('لم يكتمل التحقق الأمني. حاول مرة أخرى.'); e.code = 'captcha_failed'; return e; };
const json = (status, body) => ({ ok: status >= 200 && status < 300, status, headers: { get: () => '' }, json: async () => body });

function loadPortal(turnstile, server) {
  const store = {}, calls = [];
  const context = vm.createContext({
    document: { hidden: false, querySelector: () => null, getElementById: () => null, querySelectorAll: () => [], addEventListener() {} },
    console, URLSearchParams, setTimeout: () => 0, setInterval: () => 0, clearInterval() {}, location: { reload() {} },
    localStorage: { getItem: (k) => (k in store ? store[k] : null), setItem: (k, v) => { store[k] = String(v); }, removeItem: (k) => { delete store[k]; } },
    fetch: async (url, init) => { calls.push({ url: String(url), init }); return server(String(url), init); }
  });
  context.window = context; context.addEventListener = () => {};
  if (turnstile) context.ElanTurnstile = turnstile;
  vm.runInContext(read('portal.js'), context, { filename: 'portal.js' });
  return { login: vm.runInContext('Portal.login', context), calls, store };
}
const okServer = async (url) => (url === '/api/config' ? json(200, { url: 'https://project.example.invalid', key: 'anon-key' }) : json(200, { access_token: 'a', refresh_token: 'r' }));
const signIn = (calls) => calls.find((c) => c.url.includes('/auth/v1/token'));

test('portal sign-in (every dashboard and the account page) sends the token for its own form to Supabase', async () => {
  const boxes = [];
  const p = loadPortal(stub(boxes), okServer);
  const form = { email: { value: ' person@example.invalid ' }, password: { value: 'a-test-password' } };
  await p.login(form);
  assert.equal(boxes[0], form, 'the check runs inside the form that was submitted');
  assert.deepEqual(JSON.parse(signIn(p.calls).init.body), { email: 'person@example.invalid', password: 'a-test-password', gotrue_meta_security: { captcha_token: 'stub-token' } });
});

test('portal sign-in is exactly as before when the page has no check (no key, or the script is missing)', async () => {
  const p = loadPortal(null, okServer);
  await p.login({ email: { value: 'person@example.invalid' }, password: { value: 'a-test-password' } });
  assert.deepEqual(JSON.parse(signIn(p.calls).init.body), { email: 'person@example.invalid', password: 'a-test-password' });
});

test('portal sign-in: a check that cannot finish says so in Arabic and sends no password at all', async () => {
  const p = loadPortal({ token: async () => { throw refusal(); }, body: (o) => o, messages: {} }, okServer);
  await assert.rejects(p.login({ email: { value: 'person@example.invalid' }, password: { value: 'a-test-password' } }), /التحقق الأمني/);
  assert.equal(signIn(p.calls), undefined, 'no sign-in request left the browser');
});

test('portal sign-in: Supabase refusing the token is explained, not shown as a wrong password', async () => {
  const p = loadPortal(stub([]), async (url) => (url === '/api/config' ? json(200, { url: 'https://project.example.invalid', key: 'k' }) : json(400, { error_code: 'captcha_failed', msg: 'captcha protection: request disallowed' })));
  await assert.rejects(p.login({ email: { value: 'a@example.invalid' }, password: { value: 'a-test-password' } }), (error) => /التحقق الأمني/.test(error.message) && !/غير صحيحة/.test(error.message));
});

/* The storefront sheet: app-core.js is one long file, so only the two functions that make the request are cut out and run. */
const CORE = read('app-core.js');
const AUTH_SOURCE = CORE.slice(CORE.indexOf('function authFailText('), CORE.indexOf('async function loadData('));

function storefront(turnstile, server) {
  const toasts = [], calls = [], saved = [];
  const context = vm.createContext({
    SB: { url: 'https://project.example.invalid', key: 'anon-key' }, AUTH: null, PENDING_STORE: '', CART_FIRST_SYNC_DONE: true,
    lang: 'ar', closeSheet() {}, toast: (text) => toasts.push(text), buildMenu() {}, syncCartFromCloud: async () => {}, openStoreOrder() {}, sheet() {},
    localStorage: { setItem: (k, v) => saved.push(k) },
    fetch: async (url, init) => { calls.push({ url: String(url), init }); return server(String(url), init); },
    Promise, JSON, String, RegExp
  });
  context.window = context;
  if (turnstile) context.ElanTurnstile = turnstile;
  vm.runInContext(AUTH_SOURCE, context, { filename: 'app-core.js (auth)' });
  const button = { disabled: false, textContent: 'إرسال' };
  const makeForm = (mode, extra) => ({ dataset: { authMode: mode }, elements: Object.assign({ email: { value: ' buyer@example.invalid ' }, password: { value: 'a-test-password' } }, extra), querySelector: () => button });
  return { submit: vm.runInContext('authSubmit', context), makeForm, toasts, calls, saved, button };
}
const authAnswer = (status, body) => async () => ({ json: async () => body, status });

test('the storefront sheet sends the token with a login and with a sign-up', async () => {
  for (const mode of ['login', 'signup']) {
    const boxes = [];
    const s = storefront(stub(boxes), authAnswer(200, { access_token: 'a', refresh_token: 'r' }));
    const form = s.makeForm(mode, mode === 'signup' ? { name: { value: 'Test Buyer' } } : {});
    s.submit(form);
    assert.equal(s.button.disabled, true);
    assert.equal(s.button.textContent, 'جارٍ التحقق الأمني...');
    await settle();
    assert.equal(boxes[0], form);
    const request = s.calls[0];
    assert.equal(request.url, 'https://project.example.invalid/auth/v1/' + (mode === 'login' ? 'token?grant_type=password' : 'signup'));
    const body = JSON.parse(request.init.body);
    assert.deepEqual(body.gotrue_meta_security, { captcha_token: 'stub-token' });
    assert.equal(body.email, 'buyer@example.invalid');
    if (mode === 'signup') assert.deepEqual(body.data, { full_name: 'Test Buyer' });
    assert.equal(s.button.disabled, false, 'the button is released after the answer');
    assert.equal(s.button.textContent, 'إرسال', 'the original button label is restored');
    assert.equal(form.dataset.busy, undefined);
  }
});

test('the storefront sheet works as before without a check, and a second press while the first is waiting does nothing', async () => {
  const s = storefront(null, authAnswer(200, { access_token: 'a' }));
  s.submit(s.makeForm('login', {}));
  await settle();
  assert.deepEqual(JSON.parse(s.calls[0].init.body), { email: 'buyer@example.invalid', password: 'a-test-password' });

  // Like the real helper, both presses would get the same waiting check (and so the same single-use token) were it not for the guard.
  let release; const waiting = new Promise((resolve) => { release = resolve; });
  const slow = { token: () => waiting, body: (o, t) => { o.gotrue_meta_security = { captcha_token: t }; return o; } };
  const t = storefront(slow, authAnswer(200, { access_token: 'a' }));
  const form = t.makeForm('login', {});
  t.submit(form);
  t.submit(form);
  assert.equal(t.button.disabled, true, 'the button is held while the check is running');
  assert.equal(t.button.textContent, 'جارٍ التحقق الأمني...', 'the visitor sees why it is temporarily disabled');
  release('only-token');
  await settle();
  assert.equal(t.calls.filter((c) => c.url.includes('/auth/v1/')).length, 1, 'one press, one sign-in request: a token works once');
  assert.equal(t.button.disabled, false);
  assert.equal(t.button.textContent, 'إرسال');
});

test('the storefront sheet explains a check that failed, and a token Supabase refused', async () => {
  const s = storefront({ token: async () => { throw refusal(); }, body: (o) => o }, authAnswer(200, {}));
  s.submit(s.makeForm('login', {}));
  await settle();
  assert.equal(s.calls.length, 0, 'nothing is sent without the check');
  assert.match(s.toasts.at(-1), /التحقق الأمني/);
  assert.equal(s.button.disabled, false);
  assert.equal(s.button.textContent, 'إرسال', 'a failed challenge leaves the form ready to retry');

  const refused = storefront(stub([]), authAnswer(400, { error_code: 'captcha_failed', msg: 'captcha protection: request disallowed (invalid-input-response)' }));
  refused.submit(refused.makeForm('signup', { name: { value: 'Test Buyer' } }));
  await settle();
  assert.match(refused.toasts.at(-1), /التحقق الأمني/);
  assert.equal(refused.saved.length, 0, 'no session was stored');
});

/* ---------- the editor ---------- */

const sessions = require('../railway/editor-session.js');

function withSupabase(handler, run) {
  const saved = { fetch: global.fetch, url: process.env.SUPABASE_URL, key: process.env.SUPABASE_ANON_KEY };
  process.env.SUPABASE_URL = 'https://project.example.invalid';
  process.env.SUPABASE_ANON_KEY = 'public-anon-key-for-tests';
  const seen = [];
  global.fetch = async (url, init) => { seen.push({ url: String(url), body: init && init.body ? JSON.parse(init.body) : null }); return handler(String(url), init); };
  const finish = () => { global.fetch = saved.fetch; for (const [k, v] of [['SUPABASE_URL', saved.url], ['SUPABASE_ANON_KEY', saved.key]]) { if (v === undefined) delete process.env[k]; else process.env[k] = v; } };
  return Promise.resolve(run(seen)).finally(finish);
}
const answer = (status, body) => ({ ok: status < 300, status, json: async () => body });

test('the editor login passes the token to Supabase Auth, and a refused token is not reported as a wrong password', async () => {
  await withSupabase(async () => answer(400, { error_code: 'captcha_failed', msg: 'captcha protection: request disallowed' }), async (seen) => {
    const r = await sessions.login('owner@example.invalid', 'a-test-password', '203.0.113.10', 'the-token');
    assert.deepEqual(r, { status: 400, error: 'captcha_failed' });
    assert.deepEqual(seen[0].body, { email: 'owner@example.invalid', password: 'a-test-password', gotrue_meta_security: { captcha_token: 'the-token' } });
  });
  await withSupabase(async () => answer(400, { error_code: 'invalid_credentials' }), async () => {
    const r = await sessions.login('owner@example.invalid', 'wrong-password', '203.0.113.11', 'the-token');
    assert.deepEqual(r, { status: 401, error: 'invalid_credentials' }, 'a wrong password is still a wrong password');
  });
});

test('the editor login sends no token field when there is none, and refuses a token that is not a short string', async () => {
  await withSupabase(async () => answer(400, { error_code: 'invalid_credentials' }), async (seen) => {
    await sessions.login('owner@example.invalid', 'wrong-password', '203.0.113.12');
    await sessions.login('owner@example.invalid', 'wrong-password', '203.0.113.12', '');
    assert.equal(seen.length, 2);
    for (const request of seen) assert.deepEqual(request.body, { email: 'owner@example.invalid', password: 'wrong-password' });
    for (const bad of [{ a: 1 }, 42, 'x'.repeat(5000)]) {
      assert.deepEqual(await sessions.login('owner@example.invalid', 'wrong-password', '203.0.113.13', bad), { status: 400, error: 'invalid_request' });
    }
    assert.equal(seen.length, 2, 'a malformed token never reaches Supabase');
  });
});

test('the forgotten-password request passes the token on, tells a refused token apart, and lets the owner retry at once', async () => {
  const redirect = 'https://shop.example.invalid/editor-reset';
  await withSupabase(async () => answer(400, { error_code: 'captcha_failed' }), async (seen) => {
    const r = await sessions.requestPasswordReset('Owner@Example.invalid', '203.0.113.20', redirect, 'the-token');
    assert.deepEqual(r, { status: 400, error: 'captcha_failed' });
    assert.deepEqual(seen[0].body, { email: 'owner@example.invalid', gotrue_meta_security: { captcha_token: 'the-token' } });
    // The same address again straight away: the one-minute memo was not kept for a request that never sent an email.
    const again = await sessions.requestPasswordReset('owner@example.invalid', '203.0.113.20', redirect, 'a-new-token');
    assert.equal(seen.length, 2, 'the retry reached Supabase');
    assert.deepEqual(again, { status: 400, error: 'captcha_failed' });
  });
  await withSupabase(async () => answer(200, {}), async (seen) => {
    assert.deepEqual(await sessions.requestPasswordReset('someone@example.invalid', '203.0.113.21', redirect), { status: 200 });
    assert.deepEqual(seen[0].body, { email: 'someone@example.invalid' });
    assert.deepEqual(await sessions.requestPasswordReset('other@example.invalid', '203.0.113.21', redirect, { no: 1 }), { status: 400, error: 'invalid_request' });
  });
});

test('the editor login page loads the check, has a place for it in both boxes, and its policy lets Cloudflare\'s script and frame in and nothing else new', () => {
  const html = read('editor/login.html');
  assert.match(html, /<script src="\/turnstile\.js\?v=[0-9A-Za-z-]+"><\/script>\s*<script src="\/editor-login\.js"><\/script>/, 'turnstile.js comes before the login script');
  assert.match(html, /id="loginCheck"/);
  assert.match(html, /id="forgotCheck"/);
  const host = read('railway/editor-host.js');
  const policy = host.match(/'Content-Security-Policy': "(default-src 'self'; script-src[^"]+)"/)[1];
  assert.match(policy, /script-src 'self' https:\/\/challenges\.cloudflare\.com;/);
  assert.match(policy, /frame-src https:\/\/challenges\.cloudflare\.com;/);
  assert.match(policy, /connect-src 'self';/, 'the login page still talks to this site only');
  assert.equal((policy.match(/https:\/\/[a-z.]+/g) || []).every((h) => h === 'https://challenges.cloudflare.com'), true);
  const client = read('editor/editor-login.js');
  assert.match(client, /captchaToken: token/);
  assert.equal((client.match(/captchaToken: token/g) || []).length, 2, 'login and forgotten password both send the token');
  assert.match(host, /sessions\.login\(body\.email, body\.password, ip\(req\), body\.captchaToken\)/);
  assert.match(host, /sessions\.requestPasswordReset\(body\.email, ip\(req\), redirectTo, body\.captchaToken\)/);
});

test('every page with a sign-in or sign-up form loads turnstile.js under the shared version', () => {
  const pages = ['index.html', 'account.html', 'dashboard.html', 'store-dashboard.html', 'platform-dashboard.html', 'stores-dashboard.html', 'customers-dashboard.html'];
  for (const page of pages) assert.match(read(page), /<script src="\/turnstile\.js\?v=[0-9A-Za-z-]+"><\/script>/, page);
  const manifest = JSON.parse(read('asset-manifest.json'));
  assert.ok(manifest.files['turnstile.js'], 'turnstile.js is an immutable, hashed asset like the other shared scripts');
});
