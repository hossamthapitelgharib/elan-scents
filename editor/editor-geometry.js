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

  return { move: move, resize: resize, MIN_WIDTH: MIN_WIDTH, MIN_HEIGHT: MIN_HEIGHT, MAX_SIZE: MAX_SIZE };
});
