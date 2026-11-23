'use strict';
/* Owner, 2026-11-21: the FRAME is the fixed thing and the picture (or video) adapts to it. A card or a banner keeps the size the page gives it (the same for every card of a kind), and the
   picture is resized, larger or smaller, to that width and height so it fills the whole frame: nothing is cut, no colour is made up behind it. A 9:16 picture in a 4:3 card fills the 4:3.
   Brand cards: the card is the picture alone, the name and the «awaiting the stores» sentence are written below it, and the sentence is only written while no store catalog is linked.
   Real Chromium, made-up pictures. */
const test = require('node:test');
const assert = require('node:assert/strict');
const H = require('./harness.js');

const pw = H.loadPlaywright();

let browser, server;
test.before(async () => { server = await H.startServer(); browser = await pw.chromium.launch({ args: ['--no-sandbox'] }); });
test.after(async () => { if (browser) await browser.close(); if (server) await server.stop(); });

async function visit(size) {
  const { context } = await H.openContext(browser, server, size);
  const errors = []; const page = await context.newPage(); H.watchErrors(page, errors);
  await page.goto(H.SITE + '/', { waitUntil: 'load' });
  await page.waitForSelector('#main section', { state: 'attached' });
  /* the saved design redraws the page once when it arrives: wait for that, so a picture swapped by a test is not thrown away by it */
  await page.waitForFunction(() => window.ElanDesignLayer && ElanDesignLayer.current() !== null, null, { timeout: 15000 }).catch(() => {});
  await page.waitForTimeout(400);
  /* a picture of any shape, drawn in the page (a data: address needs no network) */
  await page.evaluate(() => {
    window.__pic = (w, h) => { const k = document.createElement('canvas'); k.width = w; k.height = h; const x = k.getContext('2d'); x.fillStyle = '#3a5a8c'; x.fillRect(0, 0, w, h); x.strokeStyle = '#ffd400'; x.lineWidth = 6; x.strokeRect(3, 3, w - 6, h - 6); return k.toDataURL('image/png'); };
  });
  return { context, page, errors };
}
const settle = (page, ms) => page.waitForTimeout(ms || 300);
const box = (r) => ({ w: Math.round(r.width * 10) / 10, h: Math.round(r.height * 10) / 10 });

for (const size of [H.WIDTHS[0], H.WIDTHS[2]]) {
  test('brand cards at ' + size.width + 'px: every card has the same frame whatever its picture\'s shape, the picture fills it, the name and the sentence are under it', async () => {
    const { context, page, errors } = await visit(size);
    try {
      await page.evaluate(() => {
        window.BR = ['AMOUAGE', 'ARMAF', 'ARABIYAT PRESTIGE', 'LATTAFA']; window.PERFUMES = []; window.DATA_READY = true; render();
        const pics = [__pic(600, 200), __pic(300, 300), __pic(200, 300)];
        document.querySelectorAll('#brands .card').forEach((c, i) => { if (pics[i]) c.style.backgroundImage = 'url("' + pics[i] + '")'; });
      });
      await settle(page);
      const cards = await page.evaluate(() => Array.from(document.querySelectorAll('#brands .card')).map((c) => {
        const r = c.getBoundingClientRect(), cap = c.querySelector('.bcap').getBoundingClientRect(), h4 = c.querySelector('h4').getBoundingClientRect(), cs = getComputedStyle(c);
        return { w: r.width, h: r.height, bgSize: cs.backgroundSize, bgRepeat: cs.backgroundRepeat, capTop: cap.top - r.bottom, h4Top: h4.top - r.bottom, h4W: h4.width, bgColor: cs.backgroundColor, sentence: (c.querySelector('.st') || {}).textContent || '', shape: c.style.getPropertyValue('--cr') };
      }));
      assert.equal(cards.length, 4);
      cards.forEach((c, i) => {
        assert.ok(Math.abs(c.w - cards[0].w) < 1 && Math.abs(c.h - cards[0].h) < 1, 'every brand card has the same frame, whatever its picture: ' + JSON.stringify(cards.map(box)));
        assert.equal(c.shape, '', 'the frame does not take the picture\'s shape');
        assert.ok(c.capTop >= 0 && c.h4Top >= 0, 'the name sits below the card, not inside it: ' + JSON.stringify([c.capTop, c.h4Top]));
        assert.match(c.sentence, /بانتظار ربط كتالوج المتاجر/, 'while no store has linked its catalog, the sentence is written (under the card)');
        assert.ok(c.h4W <= 1.5, 'the brand name is not drawn for visitors (owner, 22 Nov 2026), it is still in the card: width ' + c.h4W);
        assert.equal(c.bgColor, 'rgb(255, 255, 255)', 'a brand card is a white card');
        if (i < 3) { assert.equal(c.bgSize, 'contain', 'a logo shows whole on its white card: never stretched (squeezed Armaf, Amouage, Maison Alhambra, Lattafa), never cut'); assert.equal(c.bgRepeat, 'no-repeat'); }
      });
      assert.deepEqual(errors, []);
    } finally { await context.close(); }
  });
}

test('the «awaiting the stores\' catalogs» sentence is not written once a store catalog is linked, nor while the data is still loading', async () => {
  const { context, page } = await visit(H.WIDTHS[0]);
  try {
    const sentences = () => page.evaluate(() => Array.from(document.querySelectorAll('#brands .card .st')).length);
    await page.evaluate(() => { window.BR = ['AMOUAGE', 'ARMAF']; window.PERFUMES = []; window.DATA_READY = false; render(); });
    assert.equal(await sentences(), 0, 'nothing is claimed before the data has arrived');
    await page.evaluate(() => { window.DATA_READY = true; render(); });
    assert.equal(await sentences(), 2, 'the data has arrived and no store has linked a catalog: the sentence is true');
    await page.evaluate(() => { window.PERFUMES = [{ id: 'size-1', name: 'Test', brand: 'AMOUAGE' }]; render(); });
    assert.equal(await sentences(), 0, 'a catalog is linked: the sentence is gone');
    const gap = await page.evaluate(() => { const c = document.querySelector('#brands .card'); return parseFloat(getComputedStyle(c).marginBottom); });
    assert.ok(gap >= 8 && gap < 30, 'the name is not drawn for visitors, so no room is kept under the card for it: ' + gap);
  } finally { await context.close(); }
});

test('an art card keeps its frame whatever the picture put in it: a tall and a wide picture both fill the same frame (object-fit fill, the picture box is the card box)', async () => {
  const { context, page } = await visit(H.WIDTHS[0]);
  try {
    const frames = () => page.evaluate(() => Array.from(document.querySelectorAll('#occ .card.art')).slice(0, 2).map((c) => { const r = c.getBoundingClientRect(); return { w: r.width, h: r.height }; }));
    const before = await frames();
    await page.evaluate(() => {
      const cards = document.querySelectorAll('#occ .card.art');
      const a = cards[0].querySelector('.artbg img'), b = cards[1].querySelector('.artbg img');
      a.removeAttribute('srcset'); a.src = __pic(400, 800); b.removeAttribute('srcset'); b.src = __pic(900, 300);   // 1:2 and 3:1
    });
    await page.waitForFunction(() => Array.from(document.querySelectorAll('#occ .card.art .artbg img')).slice(0, 2).every((i) => i.complete && i.naturalWidth > 0 && /^data:/.test(i.currentSrc || i.src)), null, { timeout: 10000 });
    await settle(page);
    const got = await page.evaluate(() => Array.from(document.querySelectorAll('#occ .card.art')).slice(0, 2).map((c) => {
      const r = c.getBoundingClientRect(), im = c.querySelector('.artbg img'), ir = im.getBoundingClientRect(), cs = getComputedStyle(im);
      return { w: r.width, h: r.height, imgW: ir.width, imgH: ir.height, fit: cs.objectFit, shape: c.style.getPropertyValue('--cr'), nat: im.naturalWidth + 'x' + im.naturalHeight };
    }));
    got.forEach((g, i) => {
      assert.equal(g.fit, 'fill', 'the picture is resized to the frame');
      assert.equal(g.shape, '', 'the frame does not take the picture\'s shape');
      assert.ok(Math.abs(g.w - before[i].w) < 1 && Math.abs(g.h - before[i].h) < 1, 'the frame is the one the page gave it: ' + JSON.stringify([before[i], box(g)]));
      assert.ok(Math.abs(g.imgW - g.w) <= 2 && Math.abs(g.imgH - g.h) <= 2, 'the picture fills the whole frame: ' + JSON.stringify(g));
    });
    assert.deepEqual([got[0].nat, got[1].nat], ['400x800', '900x300']);
  } finally { await context.close(); }
});

test('the categories cards keep the frame the page (or the owner\'s saved sizes) gives them whatever the picture, and the masterpieces picture is resized to fill its frame', async () => {
  const { context, page } = await visit(H.WIDTHS[0]);
  try {
    const frame = (sel) => page.evaluate((q) => { const c = document.querySelector(q); if (!c) return null; const r = c.getBoundingClientRect(); return { w: r.width, h: r.height }; }, sel);
    const catSel = '#cats .card.art';
    const before = await frame(catSel);
    if (before) {
      await page.evaluate((q) => { const im = document.querySelector(q + ' .artbg img'); im.removeAttribute('srcset'); im.src = __pic(300, 900); }, catSel);   // a 1:3 picture
      await page.waitForFunction((q) => { const i = document.querySelector(q + ' .artbg img'); return i && i.complete && /^data:/.test(i.currentSrc || i.src); }, catSel, { timeout: 10000 });
      await settle(page);
      const after = await page.evaluate((q) => { const c = document.querySelector(q), r = c.getBoundingClientRect(), im = c.querySelector('.artbg img'), ir = im.getBoundingClientRect(); return { w: r.width, h: r.height, imgW: ir.width, imgH: ir.height, fit: getComputedStyle(im).objectFit }; }, catSel);
      assert.ok(Math.abs(after.w - before.w) < 1 && Math.abs(after.h - before.h) < 1, 'the frame does not follow the picture: ' + JSON.stringify([before, box(after)]));
      assert.equal(after.fit, 'fill'); assert.ok(Math.abs(after.imgW - after.w) <= 2 && Math.abs(after.imgH - after.h) <= 2, 'the tall picture fills the whole frame: ' + JSON.stringify(after));
    }
    const master = await page.evaluate(() => { const ms = document.querySelector('.cb > .card.msel'); if (!ms) return null; const cs = getComputedStyle(ms); return { size: cs.backgroundSize, repeat: cs.backgroundRepeat }; });
    if (master) { assert.equal(master.size, '100% 100%'); assert.equal(master.repeat, 'no-repeat'); }
    assert.ok(before || master, 'at least one of the two kinds of card is on the page');
  } finally { await context.close(); }
});

test('product cards keep their own photo frame, and a banner keeps its own frame whatever its picture: the picture is resized to fill it', async () => {
  const { context, page } = await visit(H.WIDTHS[2]);
  try {
    await page.evaluate(() => {
      const pf = document.createElement('div'); pf.className = 'card pf'; pf.innerHTML = '<div class="pim"><img alt="" src="' + __pic(300, 300) + '"></div><div class="pbody"><h4>x</h4></div>';
      document.querySelector('#main').appendChild(pf);
      const b = document.createElement('div'); b.className = 'elan-block elan-banner'; b.style.backgroundImage = 'url("' + __pic(300, 120) + '")'; b.innerHTML = '<h3>t</h3><p>s</p>';
      document.querySelector('#main').insertBefore(b, document.querySelector('#occ'));
    });
    await settle(page);
    const read = () => page.evaluate(() => {
      const pf = document.querySelector('#main > .card.pf'), b = document.querySelector('#main > .elan-banner'), br = b.getBoundingClientRect(), cs = getComputedStyle(b);
      return { pfShape: pf.style.getPropertyValue('--cr'), pfFit: getComputedStyle(pf.querySelector('.pim img')).objectFit, w: br.width, h: br.height, bgs: cs.backgroundSize, rep: cs.backgroundRepeat, shape: b.style.getPropertyValue('--cr') };
    });
    const first = await read();
    assert.equal(first.pfShape, '', 'a product card is not touched'); assert.equal(first.pfFit, 'cover', 'and its photo keeps the way it is shown');
    assert.equal(first.bgs, '100% 100%'); assert.equal(first.rep, 'no-repeat'); assert.equal(first.shape, '');
    await page.evaluate(() => { document.querySelector('#main > .elan-banner').style.backgroundImage = 'url("' + __pic(100, 400) + '")'; });
    await settle(page);
    const second = await read();
    assert.ok(Math.abs(second.w - first.w) < 1 && Math.abs(second.h - first.h) < 1, 'the banner\'s frame does not change with its picture: ' + JSON.stringify([box({ width: first.w, height: first.h }), box({ width: second.w, height: second.h })]));
  } finally { await context.close(); }
});

test('a card the owner gave a size in the editor keeps the width AND the height he chose, and the picture is resized to fill it (never cut, no bars)', async () => {
  const { context, page } = await visit(H.WIDTHS[0]);
  try {
    await page.evaluate(() => {
      const card = document.querySelector('#occ .card.art');
      const entry = ElanDesignLayer.elements().find((e) => e.el === card);
      const edits = { all: {} }; edits.all[entry.id] = { w: 280, h: 280 };
      ElanDesignLayer.set({ version: 1, edits });   // redraws the page: the card is a new one
      const now = document.querySelector('#occ .card.art'), im = now.querySelector('.artbg img');
      im.removeAttribute('srcset'); im.src = __pic(400, 600);
      ElanDesignLayer.applyEdits();                 // paints the size again, now on the new picture
    });
    await page.waitForFunction(() => { const i = document.querySelector('#occ .card.art .artbg img'); return i && i.complete && /^data:/.test(i.currentSrc || i.src); }, null, { timeout: 10000 });
    await settle(page, 500);
    const got = await page.evaluate(() => {
      const card = document.querySelector('#occ .card.art'), r = card.getBoundingClientRect(), im = card.querySelector('.artbg img'), ir = im.getBoundingClientRect();
      return { w: r.width, h: r.height, fit: card.hasAttribute('data-elan-fit'), obj: getComputedStyle(im).objectFit, imgW: ir.width, imgH: ir.height, ratio: card.style.getPropertyValue('aspect-ratio') };
    });
    assert.equal(got.fit, true);
    assert.ok(Math.abs(got.w - 280) < 1 && Math.abs(got.h - 280) < 1, 'the size he chose: ' + got.w + 'x' + got.h);
    assert.equal(got.obj, 'fill'); assert.equal(got.ratio, '', 'the frame does not take the picture\'s shape');
    assert.ok(Math.abs(got.imgW - got.w) <= 2 && Math.abs(got.imgH - got.h) <= 2, 'the 2:3 picture fills the square frame: ' + JSON.stringify(got));
  } finally { await context.close(); }
});

test('while the page is being edited the brand names show under their cards as before (the editor marks the page <html class="elan-editing">)', async () => {
  const { context, page } = await visit(H.WIDTHS[0]);
  try {
    await page.evaluate(() => { window.BR = ['AMOUAGE', 'ARMAF']; window.PERFUMES = [{ id: 'size-1', name: 'Test', brand: 'AMOUAGE' }]; window.DATA_READY = true; render(); });
    const name = () => page.evaluate(() => { const c = document.querySelector('#brands .card'), h = c.querySelector('h4').getBoundingClientRect(), r = c.getBoundingClientRect(); return { w: h.width, below: h.top - r.bottom, gap: parseFloat(getComputedStyle(c).marginBottom), text: c.querySelector('h4').textContent }; });
    const visitor = await name();
    assert.ok(visitor.w <= 1.5 && visitor.text === 'AMOUAGE', 'a visitor sees no name, and the name is still there: ' + JSON.stringify(visitor));
    assert.ok(visitor.gap < 30, 'no room is kept under the card for a name that is not drawn: ' + visitor.gap);
    await page.evaluate(() => document.documentElement.classList.add('elan-editing'));
    const editor = await name();
    assert.ok(editor.w > 30 && editor.below >= 0, 'the editor shows the name under the card: ' + JSON.stringify(editor));
    assert.ok(editor.gap >= 40, 'and keeps the room for it: ' + editor.gap);
  } finally { await context.close(); }
});

for (const size of [H.WIDTHS[0], H.WIDTHS[2]]) {
  test('at ' + size.width + 'px each of the three category cards and the Masterpieces card is drawn at the size the saved design gives it (the owner sets them in the editor), the category cards carry no writing, and the Masterpieces arrow is under its title', async () => {
    const { context, page } = await visit(size);
    try {
      const got = await page.evaluate(() => {
        const rect = (e) => { const r = e.getBoundingClientRect(); return { w: Math.round(r.width), h: Math.round(r.height), top: r.top + scrollY }; };
        const cats = Array.from(document.querySelectorAll('#cats .card.art')), master = document.querySelector('#master .card.msel');
        /* the size the saved design file gives each of the four at this screen width (null when the owner left it free) */
        const device = innerWidth >= 1024 ? 'desktop' : 'mobile', edits = ((ElanDesignLayer.current() || {}).edits || {})[device] || {};
        const saved = (el) => { const hit = ElanDesignLayer.elements().find((x) => x.el === el), e = hit && edits[hit.id]; return e && e.w && e.h ? { w: e.w, h: e.h } : null; };
        const h3 = document.querySelector('#master > h3'), sub = document.querySelector('#master > .sub');
        return {
          cats: cats.map(rect), master: master ? rect(master) : null, savedCats: cats.map(saved), savedMaster: master ? saved(master) : null,
          ink: cats.map((c) => Array.from(c.querySelectorAll('h4, small, .st')).filter((t) => t.getBoundingClientRect().width > 2).length),
          fade: cats.map((c) => getComputedStyle(c, '::after').display),
          subInCard: !!document.querySelector('#master .cb > .sub'),
          subShown: !!sub && getComputedStyle(sub).display !== 'none', subTop: sub ? sub.getBoundingClientRect().top + scrollY : null, h3Top: h3 ? h3.getBoundingClientRect().top + scrollY : null, cardTop: master ? master.getBoundingClientRect().top + scrollY : null,
          order: sub && h3 && master ? [!!(h3.compareDocumentPosition(sub) & Node.DOCUMENT_POSITION_FOLLOWING), !!(sub.compareDocumentPosition(master) & Node.DOCUMENT_POSITION_FOLLOWING)] : null
        };
      });
      assert.equal(got.cats.length, 3); assert.ok(got.master, 'the Masterpieces card is on the page');
      /* Not «all four equal»: the owner changes these in the editor and saves (22 Nov: the three categories to a square, Masterpieces not yet) and a test must not turn his choice into a red main.
         What must hold is that the page draws every card at exactly the size the design file gives it. */
      [[got.cats[0], got.savedCats[0]], [got.cats[1], got.savedCats[1]], [got.cats[2], got.savedCats[2]], [got.master, got.savedMaster]].forEach(([drawn, want], i) => {
        if (want) assert.ok(Math.abs(drawn.w - want.w) <= 1 && Math.abs(drawn.h - want.h) <= 1, 'card ' + i + ' is drawn at ' + drawn.w + 'x' + drawn.h + ' but the saved design says ' + want.w + 'x' + want.h);
      });
      assert.deepEqual(got.ink, [0, 0, 0], 'no name, no line of words, no «استعرض المجموعة» is drawn on a category card');
      assert.deepEqual(got.fade, ['none', 'none', 'none'], 'and no dark fade over the picture');
      assert.equal(got.subInCard, false, 'the arrow is no longer under the Masterpieces card');
      assert.ok(got.subShown, 'the arrow is shown'); assert.deepEqual(got.order, [true, true], 'after the title and before the card');
      assert.ok(got.subTop < got.cardTop, 'above the card');
    } finally { await context.close(); }
  });
}

test('a banner with nothing in it yet (no words, no picture, no video) is not shown to visitors', async () => {
  const { context, page } = await visit(H.WIDTHS[0]);
  try {
    const got = await page.evaluate(() => {
      const d = ElanDesignLayer.current() || { version: 1 };
      const order = (d.order && d.order.length ? d.order : ['brands', 'offers', 'new', 'cats', 'master']).filter((x) => x !== 'x-empty1');
      order.splice(1, 0, 'x-empty1');
      ElanDesignLayer.set(Object.assign({}, d, { version: 1, blocks: (d.blocks || []).concat([{ id: 'x-empty1', type: 'banner', style: { align: 'center', size: 'md' } }]), order }));
      const b = document.querySelector('[data-elan-id="x-empty1"]');
      return b ? { cls: b.className, display: getComputedStyle(b).display } : null;
    });
    assert.ok(got, 'the empty banner is in the page');
    assert.match(got.cls, /elan-empty\b/); assert.equal(got.display, 'none');
  } finally { await context.close(); }
});

test('a card whose picture the owner deleted in the editor is a white base: not the old default picture again (Masterpieces draws its picture as its own background); a picture added later shows alone', async () => {
  /* Owner, 2026-11-23: deleting the picture of an element to upload another one showed the very old picture again, and it only went away once the new one was there. For a card that has
     an .artbg the existing rule hides it; Masterpieces has none (its default picture is a CSS background), so the card carries data-no-media and style.css draws the white base. */
  const { context, page } = await visit(H.WIDTHS[2]);
  try {
    const got = await page.evaluate(async () => {
      const L = ElanDesignLayer, original = JSON.parse(JSON.stringify(L.current() || { version: 1 }));
      /* a new design redraws the page, so the card is looked up again after each one */
      const card = () => document.querySelector('#master .card.msel'), id = L.elements().find((x) => x.el === card()).id;
      const bg = () => getComputedStyle(card()).backgroundImage;
      const design = (edit) => { const d = JSON.parse(JSON.stringify(original)); d.edits = d.edits || {}; d.edits.all = d.edits.all || {}; if (edit) d.edits.all[id] = edit; else delete d.edits.all[id]; L.set(d); L.applyEdits(); };
      design(null); const own = bg();
      design({ noMedia: true }); const deleted = { bg: bg(), flag: card().getAttribute('data-no-media') };
      design({ style: { media: '/assets/new-one.webp' } }); const added = { bg: bg(), flag: card().getAttribute('data-no-media') };
      design(null); const back = bg();
      return { own, deleted, added, back };
    });
    assert.notEqual(got.own, 'none', 'Masterpieces has a picture of its own to begin with');
    assert.equal(got.deleted.flag, '1', 'a card with its picture deleted is marked');
    assert.equal(got.deleted.bg, 'none', 'and draws its white base, not the old default picture');
    assert.match(got.added.bg, /new-one\.webp/, 'a picture added later is the only one drawn');
    assert.equal(got.added.flag, null, 'and the card is no longer marked');
    assert.equal(got.back, got.own, 'removing the edit brings the original back');
  } finally { await context.close(); }
});
