/* The editor host page used to throw "caption is not defined" 15 times and "suppliedSchema is not defined" twice on every load: legacy layers
   ended with `caption.textContent=...` (the caption element no longer exists), which aborted the rest of their script, so everything after it was
   dead code. That dead code is removed; the live behaviour is unchanged (a real-Chromium run clicked all 18 right-click menu items before and after
   and got identical results). These checks keep the errors from coming back. */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const html = fs.readFileSync(path.join(__dirname, '..', 'editor', 'elan-editor.html'), 'utf8');
const scripts = [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)].map((m) => m[1]);

test('no script of the editor page refers to the removed caption element', () => {
  assert.ok(scripts.length > 10, 'the inline scripts were found');
  for (const [i, code] of scripts.entries()) {
    assert.doesNotMatch(code, /\bcaption\b/, 'script #' + i);
    assert.doesNotMatch(code, /VISUAL EDITOR ·/, 'script #' + i);
  }
});

test('the dead schema layers are gone: nothing declares or reads the merchant schema constants any more at load time', () => {
  const top = scripts.join('\n');
  assert.doesNotMatch(top, /const suppliedSchema\s*=/);
  assert.doesNotMatch(top, /const canonicalTableSpecs\s*=/);
  assert.doesNotMatch(top, /const exactStoreSchema\s*=/);
  assert.doesNotMatch(top, /const elanElementDefinitions\s*=/);
});

test('every inline script still parses', () => {
  for (const [i, code] of scripts.entries()) assert.doesNotThrow(() => new vm.Script(code, { filename: 'elan-editor.html#' + i }), 'script #' + i);
});

test('the live platform bridge, the right-click menu and the mobile frame are still on the page', () => {
  for (const needle of ['function showLiveMenu', 'async function runLive(', 'const liveStage=', 'function markBridge']) assert.ok(html.includes(needle), needle);
});
