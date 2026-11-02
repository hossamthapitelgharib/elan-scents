// The registered-customers card on the platform dashboard follows new sign-ups by itself: the real platform-dashboard.js and portal.js
// run in a vm with a stub page, a routed fetch and a timer the test fires by hand.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const root = path.join(__dirname, '..');
const portalSource = fs.readFileSync(path.join(root, 'portal.js'), 'utf8');
const source = fs.readFileSync(path.join(root, 'platform-dashboard.js'), 'utf8');

const IDS = ['#loginForm', '#login', '#app', '#logout', '#refresh', '#message', '#stats', '#platformError', '#platformStoreError', '#platformStoreStats', '#platformAuditError', '#platformAuditList', '#platformAuditMore'];
const node = () => ({ hidden: false, disabled: false, value: '', textContent: '', innerHTML: '', addEventListener(type, callback) { (this.listeners ||= {})[type] = callback; } });
const json = (status, body) => ({ ok: status < 400, status, json: async () => body });
const flush = () => new Promise((resolve) => setImmediate(resolve));
const settle = async () => { for (let i = 0; i < 8; i++) await flush(); };
const n = (value) => value.toLocaleString('ar-EG');

function boot(customerAnswers) {
  const nodes = new Map(IDS.map((id) => [id, node()]));
  nodes.get('#app').hidden = true;
  const timers = [];
  const calls = [];
  const document = { hidden: false, querySelector: (s) => nodes.get(s) || null, getElementById: (id) => nodes.get(`#${id}`) || null, addEventListener() {}, body: { appendChild() {} } };
  const storage = new Map([['elan_auth_session', JSON.stringify({ access_token: 'admin-token' })]]);
  const routes = {
    '/api/platform-order-summary': () => json(200, { ok: true, counts: { orders: 70, completed: 18, open: 47, cancelled: 3, needsReview: 2 } }),
    '/api/platform-customer-summary': () => customerAnswers.shift() || customerAnswers.last,
    '/api/platform-stores': () => json(200, { ok: true, stores: [] }),
    '/api/platform-audit-log': () => json(200, { ok: true, entries: [], hasMore: false })
  };
  const context = vm.createContext({
    document,
    localStorage: { getItem: (k) => (storage.has(k) ? storage.get(k) : null), setItem: (k, v) => storage.set(k, String(v)), removeItem: (k) => storage.delete(k) },
    location: { reload() {} },
    fetch: async (url) => { const target = String(url).split('?')[0]; calls.push(target); if (!routes[target]) throw new Error(`unexpected request ${target}`); return routes[target](); },
    URLSearchParams, console, setTimeout, clearInterval,
    setInterval: (callback, ms) => { timers.push({ callback, ms }); return timers.length; }
  });
  context.window = context;
  context.window.addEventListener = () => {};
  vm.runInContext(portalSource, context, { filename: 'portal.js' });
  vm.runInContext(source, context, { filename: 'platform-dashboard.js' });
  return { nodes, calls, timers, document };
}
const registered = (page) => (page.nodes.get('#stats').innerHTML.match(new RegExp(`<small>عملاء مسجلون</small><b>([^<]*)</b>`)) || [])[1];
const tick = async (page) => { page.timers[0].callback(); await settle(); };
const counts = (registeredCount) => json(200, { ok: true, counts: { registered: registeredCount, visitors: 5 } });

test('the card starts at the loaded number and one timer re-reads it every 20 seconds', async () => {
  const answers = [counts(12), counts(13)]; answers.last = counts(13);
  const page = boot(answers);
  await settle();
  assert.equal(registered(page), n(12));
  assert.equal(page.timers.length, 1);
  assert.equal(page.timers[0].ms, 20000);
});

test('a tick reads only the customer count and the card grows, the order cards stay', async () => {
  const answers = [counts(12), counts(13)]; answers.last = counts(13);
  const page = boot(answers);
  await settle();
  const before = page.calls.length;
  await tick(page);
  assert.deepEqual(page.calls.slice(before), ['/api/platform-customer-summary'], 'nothing else is re-read');
  assert.equal(registered(page), n(13), 'the new sign-up is counted without a reload');
  assert.match(page.nodes.get('#stats').innerHTML, new RegExp(`<small>طلبات المتاجر</small><b>${n(70)}</b>`));
});

test('a hidden tab does not poll', async () => {
  const answers = [counts(12)]; answers.last = counts(99);
  const page = boot(answers);
  await settle();
  page.document.hidden = true;
  const before = page.calls.length;
  await tick(page);
  assert.equal(page.calls.length, before);
  assert.equal(registered(page), n(12));
});

test('a failed read keeps the numbers on screen and shows no error', async () => {
  const answers = [counts(12)]; answers.last = json(502, { ok: false, error: 'customer_summary_unavailable' });
  const page = boot(answers);
  await settle();
  await tick(page);
  assert.equal(registered(page), n(12));
  assert.equal(page.nodes.get('#platformError').hidden, true);
  answers.last = counts(14);
  await tick(page);
  assert.equal(registered(page), n(14), 'the next tick recovers');
});

test('a session that has ended goes back to the sign-in card', async () => {
  const answers = [counts(12)]; answers.last = json(401, { ok: false, error: 'invalid_session' });
  const page = boot(answers);
  await settle();
  await tick(page);
  assert.equal(page.nodes.get('#login').hidden, false);
  assert.equal(page.nodes.get('#app').hidden, true);
});

test('pressing refresh does not add a second timer, and a slow read is not overlapped', async () => {
  const answers = [counts(12)]; answers.last = counts(12);
  const page = boot(answers);
  await settle();
  page.nodes.get('#refresh').listeners.click();
  await settle();
  assert.equal(page.timers.length, 1, 'one timer for the page');
  const before = page.calls.length;
  page.timers[0].callback();
  page.timers[0].callback();
  await settle();
  assert.equal(page.calls.length - before, 1, 'two ticks at once make one request');
});
