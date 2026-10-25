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

  return { move: move, resize: resize, dropSlot: dropSlot, reorder: reorder, MIN_WIDTH: MIN_WIDTH, MIN_HEIGHT: MIN_HEIGHT, MAX_SIZE: MAX_SIZE };
});
