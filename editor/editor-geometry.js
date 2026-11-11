(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.ElanEditorGeometry = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  var MIN_WIDTH = 40;
  var MIN_HEIGHT = 30;
  var MAX_SIZE = 4000;

  function move(rect, base, delta) {
    var baseDx = Number(base && base.dx) || 0;
    var baseDy = Number(base && base.dy) || 0;
    var dx = Math.round(baseDx + (Number(delta && delta.x) || 0));
    var dy = Math.round(baseDy + (Number(delta && delta.y) || 0));
    var left = Number(rect && rect.left) || 0;
    var top = Number(rect && rect.top) || 0;

    // The saved offsets are relative to the original element. Keep its top-left
    // corner on the page even when a drag starts near or crosses an edge.
    dx = Math.max(dx, Math.round(baseDx - left));
    dy = Math.max(dy, Math.round(baseDy - top));
    return { dx: dx, dy: dy };
  }

  function resize(width, height, deltaX, deltaY) {
    return {
      w: Math.max(MIN_WIDTH, Math.min(MAX_SIZE, Math.round((Number(width) || 0) + (Number(deltaX) || 0)))),
      h: Math.max(MIN_HEIGHT, Math.min(MAX_SIZE, Math.round((Number(height) || 0) + (Number(deltaY) || 0))))
    };
  }

  /* Common shapes (width:height) for an owner who thinks in shapes and not in pixels. They are examples, not a closed list: the editor shows them first,
     and an element can also be dragged to any other shape. A ratio has no size of its own, so choosing one needs a width (see sizeFromRatio). */
  var RATIOS = [
    { w: 1, h: 1, label: 'مربع (بوست إنستجرام)' }, { w: 4, h: 3, label: 'شاشة وعروض تقديمية' }, { w: 3, h: 4, label: 'طولي' },
    { w: 3, h: 2, label: 'صورة كاميرا' }, { w: 2, h: 3, label: 'صورة طولية' }, { w: 16, h: 9, label: 'عريض (فيديو ويوتيوب)' },
    { w: 9, h: 16, label: 'طولي (ستوري وريلز)' }, { w: 5, h: 4, label: 'شبه مربع' }, { w: 4, h: 5, label: 'بوست طولي (إنستجرام)' },
    { w: 21, h: 9, label: 'سينمائي' }, { w: 2, h: 1, label: 'بانر عريض' }, { w: 1, h: 2, label: 'شريط طولي' }, { w: 3, h: 1, label: 'شريط عريض (غلاف)' }
  ];

  /* The size a shape (rw:rh) has at a given width: the height follows, and when that would leave the limits the whole size is scaled to stay inside them with the
     same shape. No width given: null. */
  function sizeFromRatio(rw, rh, width) {
    var a = Math.round(Number(rw)), b = Math.round(Number(rh)), w = Number(width);
    if (!(a >= 1 && b >= 1 && w > 0)) return null;
    w = Math.max(MIN_WIDTH, Math.min(MAX_SIZE, w));
    var h = w * b / a;
    if (h < MIN_HEIGHT) { h = MIN_HEIGHT; w = h * a / b; }
    if (h > MAX_SIZE) { h = MAX_SIZE; w = h * a / b; }
    w = Math.round(w); h = Math.round(h);
    if (w < MIN_WIDTH || w > MAX_SIZE || h < MIN_HEIGHT || h > MAX_SIZE) return null;   // a shape too long to fit both limits
    return { w: w, h: h };
  }

  /* The name of the common shape a size has ("16:9"), or '' when it is none of them. A little room for the pixel rounding of a hand-made size. */
  function ratioName(width, height) {
    var w = Number(width), h = Number(height);
    if (!(w > 0 && h > 0)) return '';
    var tolerance = 0.01 + 0.5 / Math.min(w, h), found = '';
    RATIOS.forEach(function (r) { if (!found && Math.abs((w / h) / (r.w / r.h) - 1) <= tolerance) found = r.w + ':' + r.h; });
    return found;
  }

  /* The saved relative sizes an element steps through when it is dragged bigger or smaller: a share of the width it has room for (the page, or the box it sits in).
     No pixel numbers: «نص العرض» is half of the room whatever the screen. The element keeps its own shape (length to width) on every step. */
  var STEPS = [
    { pct: 10, name: '10% من العرض' }, { pct: 15, name: '15% من العرض' }, { pct: 20, name: '20% من العرض' }, { pct: 25, name: 'ربع العرض' },
    { pct: 33, name: 'تلت العرض' }, { pct: 40, name: '40% من العرض' }, { pct: 50, name: 'نص العرض' }, { pct: 60, name: '60% من العرض' },
    { pct: 67, name: 'تلتين العرض' }, { pct: 75, name: 'تلات أرباع العرض' }, { pct: 80, name: '80% من العرض' }, { pct: 90, name: '90% من العرض' }, { pct: 100, name: 'العرض كامل' }
  ];

  /* The steps for a room of this width, smallest first, each with the width it means in pixels; the ones narrower than an element may be are left out. */
  function widthSteps(room) {
    var r = Number(room) || 0, out = [];
    if (!(r > 0)) return out;
    STEPS.forEach(function (st) {
      var w = Math.round(r * st.pct / 100);
      if (w >= MIN_WIDTH && w <= MAX_SIZE && (!out.length || out[out.length - 1].w !== w)) out.push({ pct: st.pct, name: st.name, w: w });
    });
    return out;
  }

  /* Where a drag of the corner lands: `want` is the width the pointer asks for; the answer is the saved size nearest to it (never a free size), with the height the
     element's own shape (startW x startH) gives. Pulling on past a step moves on to the next one (or back to the one before), so every step can be reached. */
  function snapStep(startW, startH, room, want) {
    var steps = widthSteps(room), w0 = Number(startW) || 0, h0 = Number(startH) || 0, target = Number(want) || 0;
    if (!steps.length || !(w0 > 0 && h0 > 0)) return null;
    var best = steps[0];
    steps.forEach(function (st) { if (Math.abs(st.w - target) < Math.abs(best.w - target)) best = st; });
    var size = sizeFromRatio(w0, h0, best.w);
    if (!size) return null;
    return { w: size.w, h: size.h, pct: best.pct, name: best.name };
  }

  /* The size to really use: when it is wider than the room the element has (a phone, a narrow card), it is scaled down to that width
     keeping its shape, so a 728x90 banner stays an 8:1 strip on a 360px screen. Always inside the limits of a saved size. */
  function fitSize(size, room) {
    var w = Number(size && size.w) || 0, h = Number(size && size.h) || 0, avail = Number(room) || 0;
    if (!(w > 0 && h > 0)) return null;
    if (avail > 0 && w > avail) { h = h * avail / w; w = avail; }
    return {
      w: Math.max(MIN_WIDTH, Math.min(MAX_SIZE, Math.round(w))),
      h: Math.max(MIN_HEIGHT, Math.min(MAX_SIZE, Math.round(h)))
    };
  }

  /* Automatic displacement (the original editor's flow): a dragged card or section is dropped next to the sibling that is
     closest to the pointer, and every other sibling shifts to make room. `rects` are the siblings' boxes on screen
     ({id, left, top, width, height}); `point` is the pointer. The rule is the original `reflowAt` rule:
     nearest centre wins, and the dragged element goes AFTER it when the pointer is in the lower quarter of the target or,
     on the target's own row, on its far side. `axis: 'y'` is for full-width stacks (page sections): the middle line decides.
     `rtl` is the page direction: in a right-to-left row the next card in the flow sits on the LEFT. */
  function dropSlot(rects, point, opts) {
    var list = (rects || []).filter(function (r) { return r && r.width > 0 && r.height > 0; });
    if (!list.length || !point) return null;
    var px = Number(point.x) || 0, py = Number(point.y) || 0, best = Infinity, target = null;
    list.forEach(function (r) {
      var d = Math.hypot(px - (r.left + r.width / 2), py - (r.top + r.height / 2));
      if (d < best) { best = d; target = r; }
    });
    var cx = target.left + target.width / 2, after;
    if (opts && opts.axis === 'y') after = py > target.top + target.height / 2;
    else {
      var farSide = opts && opts.rtl ? px < cx : px > cx;
      after = py > target.top + target.height * 0.75 || (py >= target.top && farSide);
    }
    return { id: target.id, after: !!after };
  }

  /* The list `ids` with `id` moved right before (or after) `targetId`. Pure: never changes its input. */
  function reorder(ids, id, targetId, after) {
    var out = (ids || []).filter(function (x) { return x !== id; });
    var at = out.indexOf(targetId);
    if (at === -1 || (ids || []).indexOf(id) === -1) return (ids || []).slice();
    out.splice(at + (after ? 1 : 0), 0, id);
    return out;
  }

  /* Like `reorder`, for a list where some ids are glued to the id before them (the original editor's overlays follow the element
     under them): the element travels with the glued ids that follow it, and dropping it "after" a target goes after the target's
     own glued ids, so they never end up following the wrong element. A glued id is never moved on its own. */
  function reorderSticky(ids, id, targetId, after, sticky) {
    var glued = {}, groups = [], list = ids || [];
    (sticky || []).forEach(function (x) { glued[x] = true; });
    list.forEach(function (x) { if (glued[x] && groups.length) groups[groups.length - 1].push(x); else groups.push([x]); });
    var from = -1, i;
    for (i = 0; i < groups.length; i++) if (groups[i][0] === id) from = i;
    if (from === -1) return list.slice();
    var group = groups.splice(from, 1)[0], to = -1;
    for (i = 0; i < groups.length; i++) if (groups[i][0] === targetId) to = i;
    if (to === -1) return list.slice();
    groups.splice(to + (after ? 1 : 0), 0, group);
    return [].concat.apply([], groups);
  }

  return { move: move, resize: resize, RATIOS: RATIOS, sizeFromRatio: sizeFromRatio, ratioName: ratioName, STEPS: STEPS, widthSteps: widthSteps, snapStep: snapStep, fitSize: fitSize, dropSlot: dropSlot, reorder: reorder, reorderSticky: reorderSticky, MIN_WIDTH: MIN_WIDTH, MIN_HEIGHT: MIN_HEIGHT, MAX_SIZE: MAX_SIZE };
});
