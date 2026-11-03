const test = require('node:test');
const assert = require('node:assert/strict');
const { read } = require('./browser-fixture');

/* The storefront is pure white from the hero to the footer, so the editor must not put cream or off-white behind or over it:
   not around the page (the host body shows under and beside the frame), not as a tint on the selected element, and not in the
   panels and dialogs that open over it. (Found with a real browser: the selection box tinted whatever was selected with a 6% gold
   wash, and the host body was #eae7e1.) */
const CREAM = /background(?:-color)?\s*:\s*#(?:fffdf9|fffdf8|fffaf0|fffcf6|faf7f0|f1eee7|eae7e1|f6ecd3|fdfbf7|f8f2e6|f6efe2)\b/i;

/* The panels that open over the page (library, section, perfume card, brand/store cards, text format) follow the owner's original editor
   file in colour too, cream included (owner's request, 2026-11-02, which replaces the all-white panels of 2026-10-28):
   tests/browser/panels.chromium.js compares their colours with the original. What stays white is the chrome around and over the
   storefront: the page behind the frame, the selection box, the tools menu. The picker and the live edit mode keep no cream. */
test('the chrome around the storefront has no cream or off-white backgrounds', () => {
  for (const file of ['edit-mode.js']) {
    const css = read(file);
    assert.doesNotMatch(css, CREAM, file + ' still declares a cream or off-white background');
  }
  const host = read('editor/elan-editor.html');
  assert.match(host, /body\{[^}]*background:#fff[;}]/, 'the host body is white');
  assert.doesNotMatch(host, /#menu\{[^}]*background:#(?:fffdf9|fffdf8|fffaf0|faf7f0)/i, 'the tools menu stays white');
});

test('the panels use the original editor file\'s cream colours', () => {
  const host = read('editor/elan-editor.html'), create = read('editor/editor-live-create.js');
  assert.match(host, /button\{cursor:pointer;border:1px solid #c2a66a;border-radius:7px;padding:9px 13px;background:#fffaf0;/, 'buttons are #fffaf0 as in the original');
  assert.match(host, /#format\{background:#fffdf8;/);
  assert.match(host, /#format \.sample\{[^}]*background:#f1eee7\}/);
  for (const [name, text] of [['host', host], ['create', create]]) {
    assert.match(text, /\.sectionPanelClean\{width:760px;max-width:95vw;background:#fffdf8;/, name);
    assert.match(text, /\.sectionPanelClean fieldset\{[^}]*background:#faf7f0;/, name);
    assert.match(text, /\.sectionPanelClean\{width:min\(790px,94vw\)!important;[^}]*background:#fffdf9;/, name);
    assert.match(text, /\.sectionPanelClean input:disabled,\.sectionPanelClean select:disabled\{background:#f1eee7;/, name);
  }
});

test('the page around the live frame is white and the selection box does not tint the page', () => {
  const host = read('editor/elan-editor.html');
  assert.match(host, /body\{[^}]*background:#fff[;}]/, 'the host body (it shows under the frame) is white');
  assert.match(read('edit-mode.js'), /\.eo-box\{position:fixed;outline:2px solid #c8962a;background:transparent;display:none\}/, 'selected and hovered elements keep their own colour; only the outline marks them');
});
