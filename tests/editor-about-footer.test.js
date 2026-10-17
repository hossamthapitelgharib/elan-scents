const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { designBrowser } = require('./browser-fixture');
const read = (f) => fs.readFileSync(path.join(__dirname, '..', f), 'utf8');

test('about, contact and every footer part are editable elements with stable ids', () => {
  const layer = read('design-layer.js');
  for (const id of ["'about:p'", "'footer'", "'footer:logo'", "'footer:cols'", "'footer:bar'", "'footer:credit'", "'footer:h'", "'footer:l'", "'footer:b'", "'contact:title'"]) {
    assert.ok(layer.includes('add(' + id), id + ' must be registered');
  }
  assert.match(layer, /e\.kind === 'title' \|\| e\.kind === 'text-area'/);
  const b = designBrowser();
  b.document.getElementById('abIn').innerHTML = '<p>النبذة <a href="#occ">المناسبات</a></p><p>فقرة ثانية</p>';
  b.document.getElementById('fcols').innerHTML = '<h5>عنوان</h5><a href="#about">عن إيلان</a>';
  b.document.getElementById('fbar').innerHTML = '<span>الحقوق</span><span>سياسة الخصوصية</span>';
  const entries = b.layer.elements();
  for (const id of ['about:p', 'about:p1', 'footer', 'footer:logo', 'footer:cols', 'footer:bar', 'footer:credit', 'footer:h', 'footer:l', 'footer:b', 'contact:title']) {
    assert.ok(entries.some((e) => e.id === id), id + ' must resolve to a real DOM element');
  }
  assert.equal(new Set(entries.map((e) => e.id)).size, entries.length);
  const paragraph = entries.find((e) => e.id === 'about:p').el;
  const link = paragraph.querySelector('a');
  b.layer.set({ version: 1, edits: { all: { 'about:p': { text: { ar: '<img src=x onerror=alert(1)>' } }, 'footer:l': { text: { ar: 'نبذة جديدة' } } } } });
  assert.equal(paragraph.textContent, '<img src=x onerror=alert(1)>');
  assert.equal(paragraph.querySelector('img'), null, 'text edits must never become markup');
  assert.equal(entries.find((e) => e.id === 'footer:l').el.getAttribute('href'), '#about');
  b.layer.set({ version: 1 });
  assert.equal(paragraph.querySelector('a'), link, 'undo/reset must restore the original link node and its behavior');
  assert.equal(link.getAttribute('href'), '#occ');
});

test('edit mode knows the new element kinds', () => {
  const mode = read('edit-mode.js');
  assert.match(mode, /'text-area': 'text', group: 'section', 'image-el': 'image'/);
});
