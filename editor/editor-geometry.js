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

  /* The standard sizes (in pixels) an element can be given instead of a random one: the IAB web-banner set, the usual social-media
     sizes, the common screen ratios and print paper at 96 ppi. Every entry is inside the limits the design file accepts (see design-schema.js);
     tests/editor-sizes.test.js checks that. The editor shows them grouped, the first choice always being "automatic" (no fixed size). */
  var SIZE_GROUPS = [
    { id: 'web', label: 'بانرات الويب (IAB)', sizes: [
      { w: 728, h: 90, label: 'ليدربورد' }, { w: 970, h: 250, label: 'بيلبورد' }, { w: 970, h: 90, label: 'ليدربورد كبير' }, { w: 468, h: 60, label: 'بانر كلاسيكي' },
      { w: 300, h: 250, label: 'مستطيل متوسط' }, { w: 336, h: 280, label: 'مستطيل كبير' }, { w: 300, h: 600, label: 'نصف صفحة' }, { w: 160, h: 600, label: 'ناطحة سحاب عريضة' },
      { w: 320, h: 50, label: 'بانر موبايل' }, { w: 320, h: 100, label: 'بانر موبايل كبير' }
    ] },
    { id: 'social', label: 'سوشيال ميديا', sizes: [
      { w: 1080, h: 1080, label: 'بوست مربع 1:1' }, { w: 1080, h: 1350, label: 'بوست طولي 4:5' }, { w: 1080, h: 1920, label: 'ستوري / ريلز 9:16' },
      { w: 1200, h: 630, label: 'مشاركة رابط (Open Graph)' }, { w: 1280, h: 720, label: 'صورة يوتيوب المصغّرة' }, { w: 820, h: 312, label: 'غلاف فيسبوك' },
      { w: 1500, h: 500, label: 'غلاف X' }, { w: 1584, h: 396, label: 'غلاف لينكدإن' }
    ] },
    { id: 'screen', label: 'شاشات ونسب شائعة', sizes: [
      { w: 1920, h: 1080, label: 'Full HD 16:9' }, { w: 1600, h: 900, label: '16:9' }, 
      { w: 1024, h: 768, label: '4:3' }, { w: 1200, h: 800, label: '3:2' }, { w: 1000, h: 1000, label: 'مربع 1:1' }
    ] },
    { id: 'print', label: 'ورق الطباعة (96 نقطة/بوصة)', sizes: [
      { w: 794, h: 1123, label: 'A4' }, { w: 559, h: 794, label: 'A5' }, { w: 1123, h: 794, label: 'A4 عرضي' }
    ] }
  ];

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

  return { move: move, resize: resize, SIZE_GROUPS: SIZE_GROUPS, fitSize: fitSize, dropSlot: dropSlot, reorder: reorder, reorderSticky: reorderSticky, MIN_WIDTH: MIN_WIDTH, MIN_HEIGHT: MIN_HEIGHT, MAX_SIZE: MAX_SIZE };
});
