const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const source = fs.readFileSync(path.join(__dirname, '..', 'editor', 'editor-guard.js'), 'utf8');

function load(statuses) {
  const body = { children: [], textContent: 'EDITOR PAGE', appendChild(el) { el.parentNode = body; body.children.push(el); }, removeChild(el) { body.children.splice(body.children.indexOf(el), 1); el.parentNode = null; } };
  const element = () => ({ style: {}, children: [], attrs: {}, setAttribute(k, v) { this.attrs[k] = v; }, appendChild(c) { this.children.push(c); }, addEventListener() {} });
  const listeners = {};
  let tick = null; let replaced = false;
  const sandbox = {
    document: { body, hidden: false, createElement: element, addEventListener(type, fn) { listeners['document:' + type] = fn; } },
    window: { open() {}, addEventListener(type, fn) { listeners['window:' + type] = fn; } },
    location: { replace() { replaced = true; } },
    setInterval(fn) { tick = fn; },
    fetch: async () => { if (!statuses.length) throw new Error('offline'); const status = statuses.shift(); return { status, ok: status < 300 }; }
  };
  sandbox.window.location = sandbox.location;
  vm.runInNewContext(source, sandbox);
  return { body, tick: () => tick(), focus: () => listeners['window:focus'](), replaced: () => replaced };
}

test('when the session ends the editor page is kept, with a warning, instead of being wiped', async () => {
  const g = load([200, 401, 200]);
  await g.tick();
  assert.equal(g.body.children.length, 0, 'a healthy session shows nothing');
  await g.tick();
  assert.equal(g.body.children.length, 1, 'an ended session shows the warning');
  assert.equal(g.body.textContent, 'EDITOR PAGE', 'the page content is untouched');
  assert.equal(g.replaced(), false, 'no redirect that would drop unsaved edits');
  await g.focus();
  assert.equal(g.body.children.length, 0, 'signing in again in another tab removes the warning');
});

test('being offline does not raise the warning', async () => {
  const g = load([]);
  await g.tick();
  assert.equal(g.body.children.length, 0);
});
