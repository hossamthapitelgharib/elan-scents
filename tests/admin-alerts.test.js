const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

/* The alert centre of the admin panel (admin-alerts.js) in a vm with a stub page, a fake sound device and made-up messages only. */
const root = path.join(__dirname, '..');
const read = file => fs.readFileSync(path.join(root, file), 'utf8');
const IDS = ['#bellCount', '#messagesUnreadCount', '#soundToggle', '#soundLabel', '#soundTest', '#desktopToggle', '#alertHealth', '#alertStrip', '#alertStripList', '#app'];

function makeNode() {
  return { hidden: false, disabled: false, textContent: '', innerHTML: '', dataset: {}, attributes: {}, listeners: {}, addEventListener(type, callback) { this.listeners[type] = callback; }, setAttribute(name, value) { this.attributes[name] = String(value); } };
}
const msg = (n, extra = {}) => ({ id: `m${n}`, type: 'order_payment_recorded', title: `تنبيه ${n}`, body: `نص ${n}`, isRead: false, createdAt: '2026-11-15T10:00:00Z', trackingNumber: `ELN-TEST-000${n}`, requestId: null, storeId: null, ...extra });

function boot({ sound = false, hidden = false, permission = 'default', storage = {}, brokenStorage = false } = {}) {
  const nodes = new Map(IDS.map(id => [id, makeNode()]));
  nodes.get('#app').hidden = false;
  const countNodes = [makeNode()];
  const store = { ...storage };
  if (sound) store.elan_admin_sound = '1';
  const document = {
    hidden,
    querySelector: selector => nodes.get(selector) || null,
    querySelectorAll: selector => (selector === '[data-count-for="messages"]' ? countNodes : []),
    addEventListener() {}, removeEventListener() {}
  };
  const notifications = [];
  class FakeNotification { constructor(title, options) { this.title = title; this.options = options; notifications.push(this); } close() {} static requestPermission() { return Promise.resolve(FakeNotification.permission); } }
  FakeNotification.permission = permission;
  const played = [];
  const device = {
    state: 'running', currentTime: 0, destination: {}, resumed: 0,
    resume() { this.resumed++; this.state = 'running'; return Promise.resolve(); },
    createOscillator() { const o = { frequency: { setValueAtTime: frequency => played.push(frequency) }, connect() {}, start() {}, stop() {} }; return o; },
    createGain() { return { gain: { setValueAtTime() {}, exponentialRampToValueAtTime() {} }, connect() {} }; }
  };
  const calls = [];
  const context = vm.createContext({
    document, console, setTimeout: () => 0, clearTimeout() {}, Notification: FakeNotification,
    localStorage: brokenStorage
      ? { getItem() { throw new Error('blocked'); }, setItem() { throw new Error('blocked'); } }
      : { getItem: key => (key in store ? store[key] : null), setItem: (key, value) => { store[key] = String(value); } },
    Portal: { session: () => ({ access_token: 't' }), auth: () => ({ Authorization: 'Bearer t' }), errorText: error => String(error && error.message) },
    location: { hash: '' },
    fetch: async (url, options = {}) => {
      calls.push({ url: String(url), method: options.method || 'GET', body: options.body ? JSON.parse(options.body) : null });
      const route = context.__route ? context.__route(String(url), options) : null;
      return route || { ok: true, status: 200, json: async () => ({ ok: true, notifications: [], unread: 0, firstNotices: 0 }) };
    }
  });
  context.window = context;
  context.window.AudioContext = function () { return device; };
  context.window.focus = () => {};
  vm.runInContext(read('admin-common.js'), context, { filename: 'admin-common.js' });
  vm.runInContext(`${read('admin-alerts.js')}\nglobalThis.AdminAlerts = AdminAlerts;`, context, { filename: 'admin-alerts.js' });
  const alerts = context.AdminAlerts;
  alerts.bind();
  return { alerts, nodes, countNodes, store, played, device, notifications, calls, context, FakeNotification };
}
/* The page is open and its first read happened: this is the baseline every later message is compared with. */
/* What a poll does with an answer: read it, then draw. */
function prime(page, messages = [], extra = {}) {
  page.alerts._ingest({ notifications: messages, unread: messages.filter(m => !m.isRead).length, firstNotices: 0, serverTime: '2026-11-15T10:00:00Z', ...extra });
  page.alerts.render();
}
function arrive(page, messages, extra = {}) {
  page.alerts._ingest({ notifications: messages, unread: messages.filter(m => !m.isRead).length, firstNotices: 0, serverTime: '2026-11-15T10:05:00Z', ...extra });
  page.alerts.render();
}

test('the first read only remembers what is there: no card and no sound for yesterday\'s messages', () => {
  const page = boot({ sound: true });
  page.alerts._setAudio(page.device);
  prime(page, [msg(1), msg(2), msg(3)]);
  assert.equal(page.alerts._strip().length, 0);
  assert.deepEqual(page.played, []);
  assert.equal(page.nodes.get('#alertStrip').hidden, true);
  assert.equal(page.nodes.get('#bellCount').textContent, '٣');
});

test('a message that arrives later becomes a card and, with sound on, a two-note chime', () => {
  const page = boot({ sound: true });
  page.alerts._setAudio(page.device);
  prime(page, [msg(1)]);
  arrive(page, [msg(2), msg(1)]);
  const strip = page.alerts._strip();
  assert.equal(strip.length, 1);
  assert.equal(strip[0].id, 'm2');
  assert.equal(strip[0].href, '#first-notices');
  assert.deepEqual(page.played, [660, 880], 'two rising notes for news');
  assert.equal(page.nodes.get('#alertStrip').hidden, false);
  assert.match(page.nodes.get('#alertStripList').innerHTML, /data-alert-open="m2"/);
  // the same message on the next poll is not announced again
  page.played.length = 0;
  arrive(page, [msg(2), msg(1)]);
  assert.deepEqual(page.played, []);
  assert.equal(page.alerts._strip().length, 1);
});

test('something that needs a decision (a cancellation request) plays three notes', () => {
  const page = boot({ sound: true });
  page.alerts._setAudio(page.device);
  prime(page, []);
  arrive(page, [msg(5, { type: 'customer_cancel_requested' })]);
  assert.deepEqual(page.played, [880, 660, 880]);
  assert.equal(page.alerts._strip()[0].href, '#messages');
});

test('the order-sending messages from stage 1: a failed attempt is shown but silent, a cancellation is heard, and each has its own name', () => {
  const page = boot({ sound: true });
  page.alerts._setAudio(page.device);
  prime(page, []);
  // up to six failed attempts per order, ten seconds apart: they must never turn into six chimes
  arrive(page, [msg(8, { type: 'order_delivery_attempt_failed' })]);
  arrive(page, [msg(9, { type: 'order_delivery_attempt_failed' }), msg(8, { type: 'order_delivery_attempt_failed' })]);
  assert.deepEqual(page.played, []);
  assert.equal(page.alerts._strip().length, 2, 'they still appear in the strip');
  arrive(page, [msg(10, { type: 'order_cancelled' }), msg(9, { type: 'order_delivery_attempt_failed' })]);
  assert.deepEqual(page.played, [880, 660, 880], 'the cancellation that follows is the one that is heard');
  page.played.length = 0;
  arrive(page, [msg(11, { type: 'order_cancel_delivery_failed' }), msg(10, { type: 'order_cancelled' })]);
  assert.deepEqual(page.played, [880, 660, 880]);
  const labels = Object.fromEntries(page.alerts.kinds().map(kind => [kind.type, kind.label]));
  for (const type of ['order_delivery_attempt_failed', 'order_cancelled', 'order_cancel_delivery_failed']) assert.ok(labels[type] && labels[type] !== 'رسالة', `${type} has its own label`);
  assert.equal(page.alerts.kindOf('order_cancelled').href, '#messages');
});

test('a new customer is shown but not heard, and an unknown kind of message is heard', () => {
  const page = boot({ sound: true });
  page.alerts._setAudio(page.device);
  prime(page, []);
  arrive(page, [msg(6, { type: 'customer_registered' })]);
  assert.equal(page.alerts._strip().length, 1);
  assert.deepEqual(page.played, []);
  arrive(page, [msg(7, { type: 'something_new_we_do_not_know' }), msg(6, { type: 'customer_registered' })]);
  assert.deepEqual(page.played, [660, 880], 'a new alert never passes in silence');
});

test('with sound off there is a card but no chime; with the browser still locked the chime does not throw', () => {
  const off = boot({ sound: false });
  off.alerts._setAudio(off.device);
  prime(off, []);
  arrive(off, [msg(1)]);
  assert.equal(off.alerts._strip().length, 1);
  assert.deepEqual(off.played, []);

  const locked = boot({ sound: true });
  locked.device.state = 'suspended';
  locked.alerts._setAudio(locked.device);
  prime(locked, []);
  assert.doesNotThrow(() => arrive(locked, [msg(1)]));
  assert.deepEqual(locked.played, []);
  assert.equal(locked.alerts._strip().length, 1, 'the card still shows');
});

test('the sound button says what is happening: off, waiting for a tap, or on', async () => {
  const off = boot({ sound: false });
  assert.equal(off.nodes.get('#soundToggle').dataset.state, 'off');
  assert.equal(off.nodes.get('#soundLabel').textContent, 'الصوت مغلق');
  assert.equal(off.nodes.get('#soundToggle').attributes['aria-pressed'], 'false');

  const waiting = boot({ sound: true });   // sound was on before the reload: the browser needs one tap
  assert.equal(waiting.nodes.get('#soundToggle').dataset.state, 'locked');
  assert.equal(waiting.nodes.get('#soundLabel').textContent, 'اضغط لتفعيل الصوت');

  const click = boot({ sound: false });
  await click.alerts.setSound(true);
  assert.equal(click.nodes.get('#soundToggle').dataset.state, 'on');
  assert.equal(click.nodes.get('#soundLabel').textContent, 'الصوت يعمل');
  assert.equal(click.store.elan_admin_sound, '1');
  assert.deepEqual(click.played, [660, 880], 'turning it on plays the chime once so the admin hears what to expect');
  await click.alerts.setSound(false);
  assert.equal(click.store.elan_admin_sound, '0');
  assert.equal(click.nodes.get('#soundToggle').dataset.state, 'off');
});

test('a message read elsewhere leaves the card; a card the admin hid does not come back', () => {
  const page = boot({ sound: false });
  prime(page, []);
  arrive(page, [msg(2), msg(3)]);
  assert.equal(page.alerts._strip().length, 2);
  arrive(page, [msg(2, { isRead: true }), msg(3)]);
  assert.deepEqual([...page.alerts._strip().map(item => item.id)], ['m3']);
  // hide m3 through the button on the card
  page.nodes.get('#alertStripList').listeners.click({ target: { closest: selector => (selector === '[data-alert-hide]' ? { dataset: { alertHide: 'm3' } } : null) } });
  assert.equal(page.alerts._strip().length, 0);
  assert.equal(page.nodes.get('#alertStrip').hidden, true);
  arrive(page, [msg(3)]);
  assert.equal(page.alerts._strip().length, 0, 'still hidden on the next poll');
});

test('a first notice with no message of its own still gets one card; one that came with its message does not get two', () => {
  const lone = boot({ sound: false });
  prime(lone, [], { firstNotices: 2 });
  arrive(lone, [], { firstNotices: 3 });
  const items = lone.alerts._strip();
  assert.equal(items.length, 1);
  assert.equal(items[0].synthetic, true);
  assert.equal(items[0].href, '#first-notices');
  assert.doesNotMatch(lone.nodes.get('#alertStripList').innerHTML, /data-alert-read/, 'a card with no message behind it has no «تمت القراءة»');

  const paired = boot({ sound: false });
  prime(paired, [], { firstNotices: 2 });
  arrive(paired, [msg(1)], { firstNotices: 3 });
  assert.equal(paired.alerts._strip().length, 1);
  assert.equal(paired.alerts._strip()[0].synthetic, false);
});

test('opening the first-notices page counts what is listed as seen and drops that card', () => {
  const page = boot({ sound: false });
  prime(page, [], { firstNotices: 1 });
  arrive(page, [], { firstNotices: 3 });
  assert.equal(page.alerts._strip().length, 1);
  page.alerts.noticesSeen(3);
  assert.equal(page.alerts._strip().length, 0);
  assert.equal(page.store.elan_admin_notices_seen, '3');
  assert.equal(vm.runInContext("AdminAttention.list().find(entry => entry.key === 'notices')", page.context), undefined, 'nothing left to open, so it leaves the overview list');
});

test('the numbers on the bell, the menu and the tab, and the cap at 99', () => {
  const page = boot({ sound: false });
  prime(page, [], { unread: 120 });
  assert.equal(page.nodes.get('#bellCount').textContent, '٩٩+');
  assert.equal(page.countNodes[0].textContent, '٩٩+');
  assert.equal(page.nodes.get('#messagesUnreadCount').hidden, false);
  prime(page, [], { unread: 0 });
  assert.equal(page.nodes.get('#bellCount').hidden, true);
  assert.equal(page.countNodes[0].hidden, true);
  assert.equal(page.alerts.state().unread, 0);
});

test('a card shows at most four and says how many more wait in the messages page; every text on it is escaped', () => {
  const page = boot({ sound: false });
  prime(page, []);
  const many = [1, 2, 3, 4, 5, 6].map(n => msg(n, { title: n === 1 ? '<img src=x onerror=alert(1)>' : `تنبيه ${n}`, body: n === 1 ? '"><script>alert(2)</script>' : 'x' }));
  arrive(page, many);
  const html = page.nodes.get('#alertStripList').innerHTML;
  assert.equal((html.match(/class="alert-item/g) || []).length, 4);
  assert.match(html, /alert-more/);
  assert.match(html, /و٢ تنبيهات أخرى|و٢ تنبيه/);
  assert.doesNotMatch(html, /<img|<script/i);
  assert.match(html, /&lt;img/);
});

test('browser notifications appear only when the admin allowed them and the tab is hidden', async () => {
  const hiddenTab = boot({ sound: false, hidden: true, permission: 'granted', storage: { elan_admin_desktop: '1' } });
  prime(hiddenTab, []);
  arrive(hiddenTab, [msg(1)]);
  assert.equal(hiddenTab.notifications.length, 1);
  assert.equal(hiddenTab.notifications[0].title, 'تنبيه 1');
  assert.equal(hiddenTab.notifications[0].options.dir, 'rtl');

  const visibleTab = boot({ sound: false, hidden: false, permission: 'granted', storage: { elan_admin_desktop: '1' } });
  prime(visibleTab, []);
  arrive(visibleTab, [msg(1)]);
  assert.equal(visibleTab.notifications.length, 0, 'the card at the top is enough while the tab is open');

  const notAllowed = boot({ sound: false, hidden: true, permission: 'default' });
  prime(notAllowed, []);
  arrive(notAllowed, [msg(1)]);
  assert.equal(notAllowed.notifications.length, 0);

  const ask = boot({ sound: false, permission: 'denied' });
  assert.equal(await ask.alerts.setDesktop(true), false);
  assert.equal(ask.store.elan_admin_desktop, '0');
  assert.equal(ask.nodes.get('#desktopToggle').disabled, true, 'a permission the browser blocked cannot be asked for again');
});

test('marking read sends only ids or all, as a PATCH with the admin token, and removes the card', async () => {
  const page = boot({ sound: false });
  prime(page, []);
  arrive(page, [msg(2)]);
  page.context.__route = (url, options) => ({ ok: true, status: 200, json: async () => ({ ok: true, notifications: [msg(2, { isRead: true })], unread: 0, firstNotices: 0, serverTime: 'x' }) });
  await page.alerts.markRead({ id: 'm2' });
  const patch = page.calls.find(call => call.method === 'PATCH');
  assert.equal(patch.url, '/api/platform-alerts');
  assert.deepEqual(patch.body, { id: 'm2' });
  assert.equal(page.alerts._strip().length, 0);
  assert.equal(page.alerts.state().unread, 0);
  await page.alerts.markRead({ all: true });
  assert.deepEqual(page.calls.filter(call => call.method === 'PATCH')[1].body, { all: true });
});

test('a session that ended or an account that is not a platform admin stops the polling and tells the shell', async () => {
  for (const status of [401, 403]) {
    const page = boot({ sound: false });
    page.context.__route = () => ({ ok: false, status, json: async () => ({ error: status === 401 ? 'unauthorized' : 'forbidden' }) });
    let heard = null;
    page.alerts.onAuthProblem(error => { heard = error; });
    await page.alerts.pollOnce();
    assert.equal(heard && heard.status, status);
    // the first read (probe) refuses with the same status, which is how the shell decides to show the sign-in card
    await assert.rejects(() => page.alerts.probe(), error => error.status === status);
  }
  const flaky = boot({ sound: false });
  flaky.context.__route = () => ({ ok: false, status: 502, json: async () => ({ error: 'platform_alerts_unavailable' }) });
  let called = false;
  flaky.alerts.onAuthProblem(() => { called = true; });
  for (let i = 0; i < 3; i++) await flaky.alerts.pollOnce();
  assert.equal(called, false, 'a server error is not a sign-out');
  assert.equal(flaky.nodes.get('#alertHealth').hidden, false, 'after three failures in a row the panel says it cannot reach the server');
});

test('blocked browser storage never breaks the panel', () => {
  const page = boot({ brokenStorage: true });
  assert.doesNotThrow(() => { prime(page, []); arrive(page, [msg(1)]); page.alerts.noticesSeen(1); });
  assert.equal(page.alerts._strip().length, 1, 'the card still shows');
  assert.equal(page.nodes.get('#soundToggle').dataset.state, 'off');
});

test('the script keeps its names to itself: one global, no inline handler, no audio file, no network but the alerts API', () => {
  const source = read('admin-alerts.js');
  assert.match(source, /^const AdminAlerts = \(\(\) => \{/m);
  assert.doesNotMatch(source, /\bon(click|submit|load)=/);
  assert.doesNotMatch(source, /\.mp3|\.wav|\.ogg|new Audio\(/, 'the chime is made with Web Audio, there is no file to load');
  assert.deepEqual([...new Set(source.match(/\/api\/[a-z-]+/g))], ['/api/platform-alerts']);
  assert.match(source, /try \{ localStorage\./, 'storage reads and writes are guarded');
});
