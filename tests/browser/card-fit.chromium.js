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
        return { w: r.width, h: r.height, bgSize: cs.backgroundSize, bgRepeat: cs.backgroundRepeat, capTop: cap.top - r.bottom, h4Top: h4.top - r.bottom, sentence: (c.querySelector('.st') || {}).textContent || '', shape: c.style.getPropertyValue('--cr') };
      }));
      assert.equal(cards.length, 4);
      cards.forEach((c, i) => {
        assert.ok(Math.abs(c.w - cards[0].w) < 1 && Math.abs(c.h - cards[0].h) < 1, 'every brand card has the same frame, whatever its picture: ' + JSON.stringify(cards.map(box)));
        assert.equal(c.shape, '', 'the frame does not take the picture\'s shape');
        assert.ok(c.capTop >= 0 && c.h4Top >= 0, 'the name sits below the card, not inside it: ' + JSON.stringify([c.capTop, c.h4Top]));
        assert.match(c.sentence, /بانتظار ربط كتالوج المتاجر/, 'while no store has linked its catalog, the sentence is written (under the card)');
        if (i < 3) { assert.equal(c.bgSize, '100% 100%', 'the picture is resized to the whole frame: no crop (cover), no bars (contain)'); assert.equal(c.bgRepeat, 'no-repeat'); }
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
    assert.ok(gap > 20 && gap < 60, 'the room kept under a card is the name\'s only: ' + gap);
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
