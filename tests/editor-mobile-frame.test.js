/* Owner's 2026-10-30 request: on a laptop the editor must show the platform the way a PHONE presents it (full hero, the same section widths),
   not the laptop layout and not a phone-sized window. The page inside the frame is laid out at 390px wide, so edits go to the `mobile` bucket,
   and the frame is scaled up with a CSS transform so it fills the laptop screen. Runs the real fitLive() from the host page in a small VM. */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const html = fs.readFileSync(path.join(__dirname, '..', 'editor', 'elan-editor.html'), 'utf8');
const design = require('../design-schema.js');

const line = (start) => { const i = html.indexOf(start); assert.ok(i >= 0, start); return html.slice(i, html.indexOf('\n', i)); };

function stage({ innerWidth, innerHeight, top = 98 }) {
  const frame = { style: {} }, box = { style: {}, getBoundingClientRect: () => ({ top }) };
  const context = vm.createContext({ innerWidth, innerHeight, liveFrame: frame, liveStage: box });
  vm.runInContext(line('const MOBILE_LAYOUT_WIDTH=') + '\n' + line('function fitLive()'), context);
  vm.runInContext('fitLive()', context);
  return { frame, box, scale: () => vm.runInContext('liveScale', context) };
}

test('the frame is laid out at the phone width, so the page picks the mobile layout and edits go to the mobile bucket', () => {
  for (const [w, h] of [[1366, 768], [1400, 900], [1920, 1080], [820, 1100]]) {
    const s = stage({ innerWidth: w, innerHeight: h });
    assert.equal(s.frame.style.width, '390px', `${w}x${h}`);
    assert.equal(design.deviceOf(390), 'mobile');
  }
});

test('the frame is phone-tall (so the hero is laid out as on a phone) and scaled up to the height the window allows', () => {
  const s = stage({ innerWidth: 1400, innerHeight: 900 });
  const k = s.scale();
  assert.ok(k > 1 && k <= 1.6, 'enlarged, never past 1.6x: ' + k);
  assert.match(s.frame.style.transform, /^scale\(/);
  assert.equal(parseInt(s.frame.style.height, 10), Math.round(796 / k), 'layout height is the visible height divided by the scale');
  assert.ok(parseInt(s.frame.style.height, 10) >= 690, 'about a phone screen tall, so the hero is not cropped');
  assert.equal(s.box.style.width, Math.round(390 * k) + 'px', 'the stage is exactly the scaled width: centred, no side crop');
  assert.equal(s.box.style.height, Math.round(parseInt(s.frame.style.height, 10) * k) + 'px');
});

test('small laptop screens shrink the phone a little instead of cutting it off', () => {
  const s = stage({ innerWidth: 1366, innerHeight: 768 });
  assert.ok(s.scale() < 1 && s.scale() >= 0.8, 'between 0.8x and 1x: ' + s.scale());
  assert.ok(parseInt(s.box.style.height, 10) <= 768 - 98, 'the whole stage fits under the header');
});

test('a narrow window never lets the scaled phone overflow sideways', () => {
  const s = stage({ innerWidth: 360, innerHeight: 1200 });
  assert.ok(parseInt(s.box.style.width, 10) <= 360);
});

test('the preview-size buttons stay out and the host only has one frame, with the host menu following the scale', () => {
  assert.doesNotMatch(html, /deviceBox/);
  assert.doesNotMatch(html, /textContent='(لاب|تابلت|موبايل)'/);
  assert.equal(html.split("const liveFrame=document.createElement('iframe')").length - 1, 1, 'one frame declaration');
  const menu = line("menu.style.display='block';const mr=menu.getBoundingClientRect()");
  assert.match(menu, /r\.left\+info\.x\*liveScale/);
  assert.match(menu, /r\.top\+info\.y\*liveScale/);
});

test('the laptop scrollbar is hidden inside the frame, like the overlay scrollbar of a phone, so the layout width is the full 390px', () => {
  assert.match(html, /liveFrame\.contentDocument\.documentElement\.style\.scrollbarWidth='none'/);
});

test('the stage is measured again once it is on the page, after the frame loads and when the window changes', () => {
  const attach = line('liveArea.append(liveTools,liveStage)');
  assert.match(attach, /addEventListener\('resize',fitLive\)/);
  assert.match(attach, /livePanel\.after\(liveArea\);fitLive\(\)/, 'measured after it is attached');
  assert.match(attach, /liveFrame\.addEventListener\('load'/);
});
