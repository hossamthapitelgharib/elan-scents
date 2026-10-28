const test = require('node:test');
const assert = require('node:assert/strict');
const { read } = require('./browser-fixture');

/* The storefront is pure white from the hero to the footer, so the editor must not put cream or off-white behind or over it:
   not around the page (the host body shows under and beside the frame), not as a tint on the selected element, and not in the
   panels and dialogs that open over it. (Found with a real browser: the selection box tinted whatever was selected with a 6% gold
   wash, and the host body was #eae7e1.) */
const CREAM = /background(?:-color)?\s*:\s*#(?:fffdf9|fffdf8|fffaf0|fffcf6|faf7f0|f1eee7|eae7e1|f6ecd3|fdfbf7|f8f2e6|f6efe2)\b/i;

test('the editor chrome has no cream or off-white backgrounds', () => {
  for (const file of ['editor/elan-editor.html', 'editor/editor-media.js', 'edit-mode.js', 'edit-panels.js', 'editor/editor-live-library.js']) {
    const css = read(file);
    assert.doesNotMatch(css, CREAM, file + ' still declares a cream or off-white background');
  }
});

test('the page around the live frame is white and the selection box does not tint the page', () => {
  const host = read('editor/elan-editor.html');
  assert.match(host, /body\{[^}]*background:#fff[;}]/, 'the host body (it shows under the frame) is white');
  assert.match(read('edit-mode.js'), /\.eo-box\{position:fixed;outline:2px solid #c8962a;background:transparent;display:none\}/, 'selected and hovered elements keep their own colour; only the outline marks them');
  assert.match(read('editor/editor-media.js'), /#elanMediaDlg\{[^}]*background:#fff[;}]/, 'the picker is white');
});
