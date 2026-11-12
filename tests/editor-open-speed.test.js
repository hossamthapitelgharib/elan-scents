'use strict';
/* Opening the editor used to be a chain of waits: ticket, then the storefront frame, then the tools one after another,
   then "are you allowed" and only after that "read the page". These tests pin the parts that now run side by side. */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const root = path.join(__dirname, '..');
const read = (f) => fs.readFileSync(path.join(root, f), 'utf8');
const PROTOCOL = 'elan-editor-bridge/v1';
const tick = () => new Promise((r) => setImmediate(r));

function installBridge(options) {
  const listeners = [];
  const sent = [];
  const parent = { postMessage: (m, origin) => sent.push({ m, origin }) };
  const win = { parent, addEventListener: (t, f) => listeners.push([t, f]), removeEventListener() {} };
  vm.runInNewContext(read('elan-host-bridge.js'), { window: win, URL, Error, Promise, Set, Array });
  win.ElanHostBridge.install(Object.assign({ allowedEditorOrigins: ['https://editor.example'], execute: async () => null }, options));
  const hello = (extra) => listeners[0][1]({ origin: 'https://editor.example', source: parent, data: Object.assign({ protocol: PROTOCOL, type: 'hello', session: 's1', ticket: 't' }, extra) });
  return { sent, hello };
}

test('the bridge asks for the page state while it is still checking the ticket, and says ready only after both', async () => {
  const order = [];
  let allow; let give;
  const gate = new Promise((r) => { allow = r; });
  const page = new Promise((r) => { give = r; });
  const b = installBridge({
    authorize: () => { order.push('authorize'); return gate; },
    getState: () => { order.push('getState'); return page; },
  });
  const done = b.hello();
  await tick();
  assert.deepEqual(order, ['authorize', 'getState'], 'the state read starts without waiting for the ticket answer');
  assert.equal(b.sent.length, 0, 'nothing is announced yet');
  give({ revision: 'r1' });
  await tick();
  assert.equal(b.sent.length, 0, 'the page is not handed over before the ticket is accepted');
  allow(true);
  await done;
  assert.equal(b.sent.length, 1);
  assert.equal(b.sent[0].m.type, 'ready');
  assert.deepEqual(JSON.parse(JSON.stringify(b.sent[0].m.page)), { revision: 'r1' });
});

test('a refused ticket never lets the page state out, and a failing read does not leak an unhandled rejection', async () => {
  const unhandled = [];
  const onUnhandled = (e) => unhandled.push(e);
  process.on('unhandledRejection', onUnhandled);
  try {
    const refused = installBridge({ authorize: async () => false, getState: async () => ({ revision: 'secret' }) });
    await refused.hello();
    assert.equal(refused.sent.length, 1);
    assert.equal(refused.sent[0].m.type, 'denied');
    assert.ok(!JSON.stringify(refused.sent[0].m).includes('secret'));

    const broken = installBridge({ authorize: async () => false, getState: async () => { throw new Error('state exploded'); } });
    await broken.hello();
    assert.equal(broken.sent[0].m.type, 'denied');

    const stateFails = installBridge({ authorize: async () => true, getState: async () => { throw new Error('no state'); } });
    await stateFails.hello();
    assert.equal(stateFails.sent[0].m.type, 'denied');

    const noRevision = installBridge({ authorize: async () => true, getState: async () => ({}) });
    await noRevision.hello();
    assert.equal(noRevision.sent[0].m.type, 'denied', 'a page without a published revision is still refused');
    await tick(); await tick();
  } finally { process.off('unhandledRejection', onUnhandled); }
  assert.deepEqual(unhandled, []);
});

test('a synchronous failure while reading the state is reported as denied, not thrown out of the handler', async () => {
  const b = installBridge({ authorize: async () => true, getState: () => { throw new Error('sync boom'); } });
  await b.hello();
  assert.equal(b.sent[0].m.type, 'denied');
});

function runBoot(search, framed) {
  const added = [];
  const doc = {
    currentScript: { src: 'https://x.example/edit-boot.js?v=77' },
    head: { appendChild: (s) => { added.push(s); } },
    createElement: () => ({}),
  };
  const win = {}; win.parent = framed ? {} : win;
  const logs = [];
  vm.runInNewContext(read('edit-boot.js'), { URLSearchParams, Promise, document: doc, location: { search }, window: win, console: { error: (m) => logs.push(m) } });
  return { added, logs };
}

test('the editing tools download together and still run in the same order as before', async () => {
  const { added, logs } = runBoot('?elan_editor=1', true);
  assert.deepEqual(added.map((s) => s.src), ['/elan-host-bridge.js?v=77', '/editor/editor-geometry.js?v=77', '/edit-mode.js?v=77']);
  assert.ok(added.every((s) => s.async === false), 'async=false keeps the run order while the downloads overlap');
  added.forEach((s) => s.onload());
  await tick();
  assert.deepEqual(logs, []);
});

test('a tool that fails to download is reported once, and customers load nothing at all', async () => {
  const { added, logs } = runBoot('?elan_editor=1', true);
  added[1].onerror(new Error('404'));
  await tick();
  assert.deepEqual(logs, ['edit mode failed to load']);
  assert.equal(runBoot('', true).added.length, 0, 'no editor flag, no tools');
  assert.equal(runBoot('?elan_editor=1', false).added.length, 0, 'not inside the editor frame, no tools');
});

test('the editor page asks for its ticket and opens the storefront frame at the same time', () => {
  const html = read('editor/elan-editor.html');
  const open = html.slice(html.indexOf('openLive.onclick=async'));
  assert.match(open, /const asked=newBridgeTicket\(\)/);
  const frameAt = open.indexOf('liveFrame.src=');
  assert.ok(frameAt > 0 && open.indexOf('const asked=newBridgeTicket()') < frameAt, 'the ticket request is sent before the frame starts loading, and the frame does not wait for it');
  assert.doesNotMatch(open.slice(0, frameAt), /await\s+newBridgeTicket/);
  const loaded = html.slice(html.indexOf('liveFrame.onload='));
  assert.match(loaded.slice(0, 600), /ticketPending/, 'hello is only sent once the ticket has arrived');
  assert.match(html, /function openedIn\(\)/, 'the real opening time is shown so a slow open can be reported with a number');
});
