/* Scrolling must not make the page shake: the hero keeps its height while the browser's address bar slides away, the finger's path is not
   a "hover" that lights every card it crosses, and the scroll handler neither forces a layout nor restyles the whole page. */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const core = fs.readFileSync(path.join(__dirname, '..', 'app-core.js'), 'utf8');
const lineOf = (start) => { const i = core.indexOf(start); assert.ok(i >= 0, start); return core.slice(i, core.indexOf('\n', i)); };

const px = (v) => Math.round(parseFloat(v) * 1000) / 1000;
function viewport({ width = 393, height = 660, scale = 1 } = {}) {
  const props = {}, vv = { height, scale };
  const win = { innerWidth: width, innerHeight: height, visualViewport: vv };
  const ctx = { window: win, document: { documentElement: { style: { setProperty: (k, v) => { props[k] = v; } } } } };
  vm.runInNewContext(lineOf('var vuW=0,vuH=0;') + ';this.setViewportUnit=setViewportUnit', ctx);
  return { props, call: () => ctx.setViewportUnit(), win, vv };
}

test('--app-vh follows a real change of the screen but not the address bar sliding away while scrolling', () => {
  const v = viewport({ height: 660 });
  v.call();
  assert.equal(px(v.props['--app-vh']), 6.6);
  v.vv.height = 716; v.win.innerHeight = 716; v.call();
  assert.equal(px(v.props['--app-vh']), 6.6, 'address bar gone (+56px): the hero keeps its height, nothing below it moves');
  v.vv.height = 740; v.call();
  assert.equal(px(v.props['--app-vh']), 6.6, 'bars fully gone (+80px)');
  v.vv.height = 330; v.call();
  assert.equal(px(v.props['--app-vh']), 3.3, 'a keyboard (-330px) is a real change');
  v.vv.height = 660; v.call();
  assert.equal(px(v.props['--app-vh']), 6.6);
  v.win.innerWidth = 852; v.vv.height = 393; v.call();
  assert.equal(px(v.props['--app-vh']), 3.93, 'turning the phone changes the width: always updated');
});

test('pinching to zoom does not resize the hero', () => {
  const v = viewport({ height: 660 });
  v.call();
  v.vv.scale = 2.5; v.vv.height = 264; v.call();
  assert.equal(px(v.props['--app-vh']), 6.6);
});

test('the card proximity glow is for a mouse only, and runs once per frame', () => {
  const src = lineOf('var proxAt=null,proxBusy=0;');
  assert.doesNotMatch(core, /addEventListener\('touchmove',prox/);
  assert.match(core, /addEventListener\('mousemove',prox\);/);
  const frames = [], toggles = [];
  const card = (left, top) => ({ getBoundingClientRect: () => ({ left, right: left + 100, top, bottom: top + 100 }), classList: { toggle: (c, on) => toggles.push([left, on]) } });
  const ctx = { requestAnimationFrame: (fn) => { frames.push(fn); return frames.length; }, document: { querySelectorAll: () => [card(0, 0), card(500, 500)] }, Math };
  vm.runInNewContext(src + ';this.prox=prox', ctx);
  ctx.prox({ clientX: 50, clientY: 50 }); ctx.prox({ clientX: 52, clientY: 52 }); ctx.prox({ clientX: 540, clientY: 540 });
  assert.equal(frames.length, 1, 'ten mouse moves in a frame cost one pass');
  frames[0]();
  assert.deepEqual(toggles, [[0, false], [500, true]], 'the last position wins: the second card is near');
  ctx.prox({ clientX: 1, clientY: 1 });
  assert.equal(frames.length, 2, 'the next frame can run again');
});

test('the scroll handler restyles only the strip and the header, once per change, and the compact header has a margin against flicker', () => {
  const handler = lineOf("addEventListener('scroll',function(){");
  assert.doesNotMatch(handler, /documentElement\.style\.setProperty\('--p'/, '--p is no longer set on the root, which restyled every element on every scroll event');
  assert.match(handler, /getElementById\('bar'\),document\.querySelector\('header'\)/);
  assert.match(handler, /if\(p!==pLast\)/);
  assert.match(handler, /y>innerHeight\*\(on\?\.5:\.6\)/);

  // run it: scrolling past the compact threshold and back
  const bodyClasses = new Set(), set = [];
  const el = () => ({ style: { setProperty: (k, v) => set.push([k, v]) } });
  const listeners = {};
  const ctx = {
    scrollY: 0, innerHeight: 800, addEventListener: (t, f) => { listeners[t] = f; },
    document: { body: { classList: { contains: (c) => bodyClasses.has(c), toggle: (c, on) => { if (on) bodyClasses.add(c); else bodyClasses.delete(c); } } }, getElementById: () => el(), querySelector: () => el() },
  };
  vm.runInNewContext('var ly=0,hdC={ok:0,hb:0,mid:0},pLast=-1,pEls=null;function hdTone(){}function hdRefresh(){}\n' + handler, ctx);
  const at = (y) => { ctx.scrollY = y; listeners.scroll(); return bodyClasses.has('sc'); };
  assert.equal(at(400), false);
  assert.equal(at(481), true, 'passes 60% of the screen: compact');
  assert.equal(at(430), true, 'the address bar moving the threshold a little does not flip it back');
  assert.equal(at(399), false, 'clearly back above: expanded again');
  const before = set.length;
  at(500); at(900); at(1200);
  assert.equal(set.filter(([k, v]) => k === '--p' && v === 1).length, 2, '--p reaches 1 once for the strip and once for the header, then no more writes while scrolling on');
  assert.ok(set.length >= before);
});
