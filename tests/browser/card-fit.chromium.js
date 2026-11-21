'use strict';
/* Owner, 2026-11-19: a picture or a video fills its card (or banner) WHOLE: not cut, not stretched, no colour behind it. That only works when the frame has the picture's own shape,
   so the card keeps its width and its height follows the picture. Brand cards: the card is the picture alone, the name and the «awaiting the stores» sentence are written below it,
   and the sentence is only written while no store catalog is linked. Real Chromium, made-up pictures. */
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
  await page.waitForTimeout(900);
  /* a picture of any shape, drawn in the page (a data: address needs no network) */
  await page.evaluate(() => {
    window.__pic = (w, h) => { const k = document.createElement('canvas'); k.width = w; k.height = h; const x = k.getContext('2d'); x.fillStyle = '#3a5a8c'; x.fillRect(0, 0, w, h); x.strokeStyle = '#ffd400'; x.lineWidth = 6; x.strokeRect(3, 3, w - 6, h - 6); return k.toDataURL('image/png'); };
  });
  return { context, page, errors };
}
const settle = (page, ms) => page.waitForTimeout(ms || 700);

for (const size of [H.WIDTHS[0], H.WIDTHS[2]]) {
  test('brand cards at ' + size.width + 'px: the picture fills the card whole, the card takes the picture\'s shape (height kept in the strip), the name and the sentence are under it', async () => {
    const { context, page, errors } = await visit(size);
    try {
      await page.evaluate(() => {
        window.BR = ['AMOUAGE', 'ARMAF', 'ARABIYAT PRESTIGE', 'LATTAFA']; window.PERFUMES = []; window.DATA_READY = true; render();
        const pics = [__pic(600, 200), __pic(300, 300), __pic(200, 300)];
        document.querySelectorAll('#brands .card').forEach((c, i) => { if (pics[i]) c.style.backgroundImage = 'url("' + pics[i] + '")'; });
        ElanCardFit.scan();
      });
      await settle(page);
      const cards = await page.evaluate(() => Array.from(document.querySelectorAll('#brands .card')).map((c) => {
        const r = c.getBoundingClientRect(), cap = c.querySelector('.bcap').getBoundingClientRect(), h4 = c.querySelector('h4').getBoundingClientRect();
        return { w: r.width, h: r.height, cr: c.style.getPropertyValue('--cr').trim(), bgSize: getComputedStyle(c).backgroundSize, capTop: cap.top - r.bottom, h4Top: h4.top - r.bottom, sentence: (c.querySelector('.st') || {}).textContent || '', text: c.textContent.trim() };
      }));
      assert.equal(cards.length, 4);
      [[600, 200], [300, 300], [200, 300]].forEach(([w, h], i) => {
        const c = cards[i];
        assert.equal(c.cr, w + ' / ' + h, 'the card knows its picture\'s shape');
        assert.ok(Math.abs(c.h - 120) < 1, 'a brand card in the strip keeps its height: ' + c.h);
        assert.ok(Math.abs(c.w / c.h - w / h) < 0.02 * (w / h), 'the frame has the picture\'s shape: ' + c.w + 'x' + c.h + ' for ' + w + ':' + h);
        /* a picture the owner put on the card is painted with `cover`, which on a frame of the picture's own shape is the same as filling it: the check above is what proves nothing is cut */
        assert.ok(['100% 100%', 'cover'].includes(c.bgSize), 'the picture covers the whole frame, never `contain` (no bars): ' + c.bgSize);
      });
      cards.forEach((c) => {
        assert.ok(c.capTop >= 0 && c.h4Top >= 0, 'the name sits below the card, not inside it: ' + JSON.stringify([c.capTop, c.h4Top]));
        assert.match(c.sentence, /بانتظار ربط كتالوج المتاجر/, 'while no store has linked its catalog, the sentence is written (under the card)');
      });
      assert.equal(cards[3].cr, '', 'a card with no picture keeps the default frame');
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

test('an art card with a tall picture and one with a wide video-sized frame take the picture\'s shape: the picture fills the frame, object-fit fill, no crop', async () => {
  const { context, page } = await visit(H.WIDTHS[0]);
  try {
    await page.evaluate(() => {
      const cards = document.querySelectorAll('#occ .card.art');
      const a = cards[0].querySelector('.artbg img'), b = cards[1].querySelector('.artbg img');
      a.loading = b.loading = 'eager';   // a lazy picture far below the screen is not fetched, so it would never report its shape
      a.removeAttribute('srcset'); a.src = __pic(400, 800); b.removeAttribute('srcset'); b.src = __pic(900, 300);
    });
    await settle(page, 900);
    const got = await page.evaluate(() => Array.from(document.querySelectorAll('#occ .card.art')).slice(0, 2).map((c) => {
      const r = c.getBoundingClientRect(), im = c.querySelector('.artbg img'), ir = im.getBoundingClientRect(), cs = getComputedStyle(im);
      return { ratio: r.width / r.height, imgW: ir.width, imgH: ir.height, w: r.width, h: r.height, fit: cs.objectFit, cr: c.style.getPropertyValue('--cr').trim() };
    }));
    assert.equal(got[0].cr, '400 / 800'); assert.equal(got[1].cr, '900 / 300');
    assert.ok(Math.abs(got[0].ratio - 0.5) < 0.02, 'tall: ' + got[0].ratio); assert.ok(Math.abs(got[1].ratio - 3) < 0.06, 'wide: ' + got[1].ratio);
    got.forEach((g) => { assert.equal(g.fit, 'fill'); assert.ok(g.imgW >= g.w - 4 && g.imgH >= g.h - 4, 'the picture covers the whole frame: ' + JSON.stringify(g)); });
  } finally { await context.close(); }
});

test('product cards keep their own photo frame, and a banner with a picture takes the picture\'s shape too', async () => {
  const { context, page } = await visit(H.WIDTHS[2]);
  try {
    await page.evaluate(() => {
      const pf = document.createElement('div'); pf.className = 'card pf'; pf.innerHTML = '<div class="pim"><img alt="" src="' + __pic(300, 300) + '"></div><div class="pbody"><h4>x</h4></div>';
      document.querySelector('#main').appendChild(pf);
      const b = document.createElement('div'); b.className = 'elan-block elan-banner'; b.style.backgroundImage = 'url("' + __pic(300, 120) + '")'; b.innerHTML = '<h3>t</h3><p>s</p>';
      document.querySelector('#main').insertBefore(b, document.querySelector('#occ'));
    });
    await settle(page, 900);
    const got = await page.evaluate(() => {
      const pf = document.querySelector('#main > .card.pf'), b = document.querySelector('#main > .elan-banner'), br = b.getBoundingClientRect();
      return { pf: pf.style.getPropertyValue('--cr'), banner: br.width / br.height, bcr: b.style.getPropertyValue('--cr').trim(), bgs: getComputedStyle(b).backgroundSize };
    });
    assert.equal(got.pf, '', 'a product card is not touched');
    assert.equal(got.bcr, '300 / 120'); assert.ok(Math.abs(got.banner - 2.5) < 0.05, 'banner ratio ' + got.banner); assert.equal(got.bgs, '100% 100%');
  } finally { await context.close(); }
});

test('a card the owner gave a size in the editor keeps the width he chose and its height follows the picture (never cut, never stretched, no bars)', async () => {
  const { context, page } = await visit(H.WIDTHS[0]);
  try {
    await page.evaluate(() => {
      const card = document.querySelector('#occ .card.art');
      const entry = ElanDesignLayer.elements().find((e) => e.el === card);
      const edits = { all: {} }; edits.all[entry.id] = { w: 280, h: 280 };
      ElanDesignLayer.set({ version: 1, edits });   // redraws the page: the card is a new one
      const now = document.querySelector('#occ .card.art'), im = now.querySelector('.artbg img');
      im.loading = 'eager'; im.removeAttribute('srcset'); im.src = __pic(400, 600);
      ElanDesignLayer.applyEdits();                 // paints the size again, now on the new picture
    });
    await settle(page, 1000);
    const got = await page.evaluate(() => {
      const card = document.querySelector('#occ .card.art'), r = card.getBoundingClientRect(), im = card.querySelector('.artbg img');
      return { w: r.width, h: r.height, fit: card.hasAttribute('data-elan-fit'), obj: getComputedStyle(im).objectFit };
    });
    assert.equal(got.fit, true);
    assert.ok(Math.abs(got.w - 280) < 1, 'the width he chose: ' + got.w);
    assert.ok(Math.abs(got.w / got.h - 400 / 600) < 0.02, 'the height follows the picture: ' + got.w + 'x' + got.h);
    assert.equal(got.obj, 'fill');
  } finally { await context.close(); }
});

test('a picture that has been seen before gives its card the final shape at once, before the picture arrives (a returning visitor sees no jump)', async () => {
  const { context, page } = await visit(H.WIDTHS[0]);
  try {
    const got = await page.evaluate(() => {
      const url = 'https://pictures.example.test/remembered.png';
      CF_SIZES[url] = [400, 200];
      const card = document.createElement('div'); card.className = 'card art'; card.innerHTML = '<div class="artbg"><img alt="" src="' + url + '"></div><h4>x</h4>';
      document.querySelector('#occ .strip, #occ').appendChild(card);
      ElanCardFit.fit(card);
      const first = card.style.getPropertyValue('--cr').trim();
      const stored = JSON.parse(localStorage.getItem('elan_card_shapes_v1') || '{}');
      card.remove();
      return { first, storedDataUrl: Object.keys(stored).some((k) => /^data:/.test(k)) };
    });
    assert.equal(got.first, '400 / 200', 'the remembered shape is used straight away');
    assert.equal(got.storedDataUrl, false, 'nothing like a data address is kept');
  } finally { await context.close(); }
});
