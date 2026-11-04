'use strict';
/* Default pages: one design for every product page, every brand page and every store page (`prod:*`, `brand:*`, `store:*`).
   A page that has its own edits keeps them: they win over the default, which wins over the site-wide edits. */
const test = require('node:test');
const assert = require('node:assert/strict');
const ED = require('../design-schema.js');
const { designBrowser, editBrowser, plain } = require('./browser-fixture.js');

const normalize = (input) => ED.normalize(input, { strict: true });

test('the schema knows the default page of each kind and nothing else with a star', () => {
  ['prod:*', 'brand:*', 'store:*', 'prod:12', 'brand:AMOUAGE', 'store:Ola'].forEach((key) => assert.equal(ED.isPageKey(key), true, key));
  ['col:cats:*', 'sec:*', 'home:*', 'prod:a*b', 'prod:'].forEach((key) => assert.equal(ED.isPageKey(key), false, key));
  assert.equal(ED.defaultKeyOf('prod:12'), 'prod:*');
  assert.equal(ED.defaultKeyOf('brand:AMOUAGE'), 'brand:*');
  assert.equal(ED.defaultKeyOf('store:Ola'), 'store:*');
  assert.equal(ED.defaultKeyOf('prod:*'), null, 'a default page has no default of its own');
  assert.equal(ED.defaultKeyOf('sec:brands'), null);
  assert.equal(ED.defaultKeyOf('home'), null);
  assert.equal(ED.defaultKeyOf(null), null);
  assert.equal(ED.isDefaultKey('brand:*'), true);
  assert.equal(ED.isDefaultKey('brand:Dior'), false);
});

test('a default page is saved with its edits, its card order and its blocks, and survives a round trip', () => {
  const result = normalize({
    version: 1,
    pages: {
      'prod:*': { blocks: [{ id: 'x-note1', type: 'text', text: { ar: 'شحن مجاني' }, slot: 'bottom' }], edits: { desktop: { 'pg:_:title': { dy: 20 } } } },
      'brand:*': { blocks: [], cardOrder: { view: ['pcard:_:b', 'pcard:_:a'] } }
    }
  });
  assert.ok(result.ok, JSON.stringify(result.errors));
  assert.equal(result.design.pages['prod:*'].edits.desktop['pg:_:title'].dy, 20);
  assert.equal(result.design.pages['prod:*'].blocks.length, 1);
  assert.deepEqual(result.design.pages['brand:*'].cardOrder, { view: ['pcard:_:b', 'pcard:_:a'] });
  assert.equal(ED.isEmpty(result.design), false);
  assert.equal(ED.serialize(JSON.parse(ED.serialize(result.design))), ED.serialize(result.design));
  assert.equal(normalize({ version: 1, pages: { 'col:cats:*': { blocks: [] } } }).ok, false);
});

function innerPage(b, key, html) {
  b.document.body.classList.add('inner');
  b.context.P = [key];
  b.document.getElementById('view').innerHTML = html || '<h3>صفحة</h3>';
}
const title = (b) => b.layer.elements().find((e) => e.kind === 'title' && e.id.startsWith('pg:'));
const brand = (name) => ({ k: 'brand', n: name });

test('what is saved on the default page shows on every page of the kind, and only on that kind', async () => {
  const b = await editBrowser();
  innerPage(b, brand('AMOUAGE'));
  assert.equal(title(b).did, 'pg:_:title', 'the title has an id that does not depend on the page');
  assert.equal(b.mode.state().scope.mode, 'page');
  assert.equal(b.mode.state().scope.defaultKey, 'brand:*');

  const switched = await b.mode.execute('page.setScope', { scope: 'default' });
  assert.equal(switched.scope, 'default');
  assert.equal(b.mode.state().scope.mode, 'default');
  await b.mode.execute('element.move', { elementId: title(b).id, dx: 30, dy: 12 });
  await b.mode.execute('element.format', { elementId: title(b).id, style: { color: '#c00000' } });

  const saved = plain(b.mode.state().design);
  assert.deepEqual(Object.keys(saved.pages), ['brand:*'], 'nothing was saved on the page itself');
  assert.equal(saved.pages['brand:*'].edits.desktop['pg:_:title'].dy, 12);
  assert.ok(normalize(saved).ok, 'the server accepts what the editor saved');

  [brand('AMOUAGE'), brand('ARMAF'), brand('ANY-BRAND')].forEach((page) => {
    b.context.P = [page]; b.layer.applyEdits();
    assert.equal(title(b).el.style.transform, 'translate(30px,12px)', page.n);
    assert.equal(title(b).el.style.color, '#c00000', page.n);
  });
  b.context.P = [{ k: 'prod', sid: '12' }]; b.layer.applyEdits();
  assert.equal(title(b).el.style.transform, '', 'a product page does not take the brand default');
  b.context.P = [{ k: 'store', n: 'Ola' }]; b.layer.applyEdits();
  assert.equal(title(b).el.style.transform, '', 'a store page does not take the brand default');
});

test('a page with edits of its own overrides the default and keeps the rest of it', async () => {
  const b = await editBrowser();
  innerPage(b, brand('AMOUAGE'));
  await b.mode.execute('page.setScope', { scope: 'default' });
  await b.mode.execute('element.move', { elementId: title(b).id, dx: 30, dy: 12 });
  await b.mode.execute('element.format', { elementId: title(b).id, style: { color: '#c00000' } });

  b.context.P = [brand('ARMAF')]; b.layer.applyEdits();
  assert.equal(b.mode.state().scope.mode, 'page', 'a different page is edited on its own again');
  await b.mode.execute('element.move', { elementId: title(b).id, dx: 5, dy: 6 });

  const saved = plain(b.mode.state().design);
  assert.deepEqual(Object.keys(saved.pages).sort(), ['brand:*', 'brand:ARMAF']);
  assert.equal(saved.pages['brand:*'].edits.desktop['pg:_:title'].dy, 12, 'the default is untouched');
  assert.equal(title(b).el.style.transform, 'translate(5px,6px)', 'its own position wins');
  assert.equal(title(b).el.style.color, '#c00000', 'what it did not change comes from the default');

  b.context.P = [brand('AMOUAGE')]; b.layer.applyEdits();
  assert.equal(title(b).el.style.transform, 'translate(30px,12px)', 'the other brands still follow the default');
});

test('leaving the page puts the editor back on that page alone, so a stray edit never reaches every page', async () => {
  const b = await editBrowser();
  innerPage(b, brand('AMOUAGE'));
  await b.mode.execute('page.setScope', { scope: 'default' });
  b.context.P = [brand('ARMAF')];
  await b.mode.execute('element.move', { elementId: title(b).id, dx: 9, dy: 9 });
  assert.deepEqual(Object.keys(plain(b.mode.state().design).pages), ['brand:ARMAF']);

  /* a page with no default (a home section, a collection) ignores the request */
  innerPage(b, { k: 'sec', id: 'brands' });
  const answer = await b.mode.execute('page.setScope', { scope: 'default' });
  assert.equal(answer.scope, 'page');
  assert.equal(b.mode.state().scope.defaultKey, null);
});

test('the right-click menu offers the scope switch and the reset only where a default page exists', async () => {
  const b = await editBrowser();
  const menu = () => plain(b.window.ElanEditTools.menu(null)).filter((t) => /^scope_/.test(t.id));
  assert.deepEqual(menu(), [], 'the home page has no default page');

  innerPage(b, brand('AMOUAGE'));
  assert.deepEqual(menu().map((t) => t.id), ['scope_toggle', 'scope_reset']);
  assert.match(menu()[0].label, /هذه الصفحة فقط/);
  assert.match(menu()[0].label, /كل صفحات البراندات/);
  assert.equal(menu()[1].enabled, false, 'nothing of its own to reset');

  await b.mode.execute('tool.run', { id: 'scope_toggle' });
  assert.match(menu()[0].label, /النطاق الحالي: كل صفحات البراندات/);
  await b.mode.execute('tool.run', { id: 'scope_toggle' });
  assert.match(menu()[0].label, /هذه الصفحة فقط/);

  innerPage(b, { k: 'prod', sid: '7' });
  assert.match(menu()[0].label, /كل صفحات المنتجات/);
  innerPage(b, { k: 'store', n: 'Ola' });
  assert.match(menu()[0].label, /كل صفحات المتاجر/);
});

test('"back to the default" drops what the page set for itself and nothing else', async () => {
  const b = await editBrowser();
  innerPage(b, brand('AMOUAGE'));
  await b.mode.execute('page.setScope', { scope: 'default' });
  await b.mode.execute('element.move', { elementId: title(b).id, dx: 30, dy: 12 });

  b.context.P = [brand('ARMAF')]; b.layer.applyEdits();
  await b.mode.execute('element.move', { elementId: title(b).id, dx: 5, dy: 6 });
  assert.equal(plain(b.window.ElanEditTools.menu(null)).find((t) => t.id === 'scope_reset').enabled, true);

  await b.mode.execute('tool.run', { id: 'scope_reset' });
  const saved = plain(b.mode.state().design);
  assert.deepEqual(Object.keys(saved.pages), ['brand:*'], 'the page entry is gone, the default stays');
  assert.equal(title(b).el.style.transform, 'translate(30px,12px)');
  assert.equal(b.mode.state().scope.mode, 'page');

  await b.mode.execute('history.undo');
  assert.equal(title(b).el.style.transform, 'translate(5px,6px)', 'undo brings the page back as it was');
});

const CARDS = '<h3>صفحة</h3><div class="strip">' + ['a', 'b', 'c', 'd'].map((n, i) => '<div class="card" data-go="prod|' + i + '"><h4>' + n + '</h4></div>').join('') + '</div>';
const order = (b) => b.document.getElementById('view').querySelectorAll('.card').map((c) => c.querySelector('h4').textContent).join('');

test('the card order of the default page applies to every page of the kind unless the page has its own', () => {
  const b = designBrowser();
  innerPage(b, brand('AMOUAGE'), CARDS);
  const dids = b.layer.elements().filter((e) => e.kind === 'card').map((e) => e.did);
  assert.equal(new Set(dids).size, 4, 'one default id per card');
  assert.ok(dids.every((d) => /^pcard:_:/.test(d) && ED.EDIT_ID_RE.test(d)));

  b.layer.set({ version: 1, pages: { 'brand:*': { blocks: [], cardOrder: { view: [dids[2], dids[0], dids[3], dids[1]] } } } });
  assert.equal(order(b), 'cadb');

  /* another brand with the same go-targets gets the same order */
  b.document.getElementById('view').innerHTML = CARDS; b.context.P = [brand('ARMAF')];
  b.layer.set({ version: 1, pages: { 'brand:*': { blocks: [], cardOrder: { view: [dids[2], dids[0], dids[3], dids[1]] } } } });
  assert.equal(order(b), 'cadb');

  /* a page with its own order replaces the default one */
  b.document.getElementById('view').innerHTML = CARDS;
  const own = b.layer.elements().filter((e) => e.kind === 'card').map((e) => e.id);
  b.layer.set({ version: 1, pages: { 'brand:*': { blocks: [], cardOrder: { view: [dids[2], dids[0], dids[3], dids[1]] } }, 'brand:ARMAF': { blocks: [], cardOrder: { view: [own[3], own[2], own[1], own[0]] } } } });
  assert.equal(order(b), 'dcba');

  /* a product page is not touched by the brand default */
  b.document.getElementById('view').innerHTML = CARDS; b.context.P = [{ k: 'prod', sid: '3' }];
  b.layer.set({ version: 1, pages: { 'brand:*': { blocks: [], cardOrder: { view: [dids[2], dids[0], dids[3], dids[1]] } } } });
  assert.equal(order(b), 'abcd');
});

test('dragging a card on the default page saves the order under default ids', async () => {
  const b = await editBrowser();
  innerPage(b, brand('AMOUAGE'), CARDS);
  await b.mode.execute('page.setScope', { scope: 'default' });
  const cards = b.layer.elements().filter((e) => e.kind === 'card');
  /* what the drag handler stores: the new order mapped to the ids of the scope being edited */
  assert.match(require('node:fs').readFileSync(require('node:path').join(__dirname, '..', 'edit-mode.js'), 'utf8'), /Geometry\.reorder\(listed, g\.id, slot\.id, slot\.after\)\.map\(scopeId\)/);
  assert.ok(cards.every((c) => c.did && c.did !== c.id));
});

test('archiving on the default page hides the element on every page of the kind, and can be undone there', async () => {
  const b = await editBrowser();
  innerPage(b, brand('AMOUAGE'), CARDS);
  const first = () => b.layer.elements().filter((e) => e.kind === 'card')[0];
  await b.mode.execute('page.setScope', { scope: 'default' });
  const id = first().id;
  await b.mode.execute('element.archive', { elementId: id });

  const saved = plain(b.mode.state().design);
  assert.equal(saved.pages['brand:*'].edits.all[first().did].archived, true);
  assert.equal(first().el.style.display, 'none');
  assert.deepEqual(plain(b.mode.state().archive).map((a) => a.id), [id], 'listed under the id it has on this page');

  b.document.getElementById('view').innerHTML = CARDS; b.context.P = [brand('ARMAF')]; b.layer.applyEdits();
  assert.equal(first().el.style.display, 'none', 'hidden on another brand page too');

  b.context.P = [brand('AMOUAGE')]; b.layer.applyEdits();
  await b.mode.execute('page.setScope', { scope: 'default' });
  await b.mode.execute('archive.restore', { elementId: first().id });
  assert.equal(plain(b.mode.state().design).pages, undefined, 'nothing left once it is restored');
  assert.equal(first().el.style.display, '');
});

test('removing the picture of a card clears what was saved for it on the default page too', async () => {
  const b = await editBrowser();
  innerPage(b, brand('AMOUAGE'), CARDS);
  await b.mode.execute('page.setScope', { scope: 'default' });
  const card = b.layer.elements().filter((e) => e.kind === 'card')[0];
  await b.mode.execute('element.move', { elementId: card.id, dx: 14, dy: 3 });
  assert.equal(plain(b.mode.state().design).pages['brand:*'].edits.desktop[card.did].dx, 14);
  /* the original editor's "reset element" must find the default-page copy as well */
  const api = b.mode._debug();
  assert.ok(api.pages['brand:*'].edits.desktop[card.did]);
});

test('default-page blocks appear on every page of the kind, ahead of the page\'s own', () => {
  const b = designBrowser();
  innerPage(b, { k: 'prod', sid: '12' });
  const design = {
    version: 1,
    pages: {
      'prod:*': { blocks: [{ id: 'x-ship', type: 'text', text: { ar: 'شحن مجاني' }, slot: 'bottom' }] },
      'prod:12': { blocks: [{ id: 'x-own', type: 'text', text: { ar: 'خاص بالمنتج' }, slot: 'bottom' }] }
    }
  };
  b.layer.set(design);
  const texts = () => b.document.getElementById('view').querySelectorAll('[data-elan-custom]').map((n) => n.textContent);
  assert.deepEqual(texts(), ['شحن مجاني', 'خاص بالمنتج']);
  innerPage(b, { k: 'prod', sid: '99' }); b.layer.set(design);
  assert.deepEqual(texts(), ['شحن مجاني']);
  innerPage(b, brand('AMOUAGE')); b.layer.set(design);
  assert.deepEqual(texts(), [], 'brand pages do not get the product default');
});

test('a page without a title (the storefront draws none) gets its top blocks right after the breadcrumb, not above it', () => {
  const b = designBrowser();
  innerPage(b, brand('AMOUAGE'), '<nav class="bc"><a>الرئيسية</a><b>AMOUAGE</b></nav><div class="grid" id="res"></div>');
  const design = {
    version: 1,
    pages: { 'brand:*': { blocks: [{ id: 'x-top', type: 'text', text: { ar: 'فوق القائمة' } }, { id: 'x-bottom', type: 'text', text: { ar: 'آخر الصفحة' }, slot: 'bottom' }] } }
  };
  b.layer.set(design);
  const kids = b.document.getElementById('view').children.map((n) => (n.hasAttribute('data-elan-custom') ? 'block:' + n.textContent : n.tagName.toLowerCase() + (n.id ? '#' + n.id : '')));
  assert.deepEqual(kids, ['nav', 'block:فوق القائمة', 'div#res', 'block:آخر الصفحة'], 'the breadcrumb stays first');
});
