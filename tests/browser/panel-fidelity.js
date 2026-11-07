'use strict';
/* What "the same as the original editor" means for a panel, in numbers: every element that is really drawn
   (not display:none, not zero-sized) is listed in document order with its tag, class, own text, its box relative
   to the panel (x, y, width, height) and the typography, colours, spacing, border and layout properties that decide how it looks
   (the owner asked for the original's colours too, 2026-11-02). The same function runs on the original editor file (scripts/capture-original-panels.js writes
   tests/fixtures/elan-original-panels-golden.json) and on the live editor (tests/browser/panels.chromium.js). */

/* Data both sides are given, so the lists in the panels are the same. */
const OPTIONS = {
  brands: [{ id: 'b1', name: 'براند أ' }], stores: [{ id: 's1', name: 'متجر أ' }], categories: [{ id: 'c1', name: 'فئة أ' }],
  occasions: [{ id: 'o1', name: 'مناسبة أ' }], notes: [{ id: 'n1', name: 'عود' }], sizes: [{ size_ml: 100, name: '100 مل' }]
};
/* The pictures and videos the media dialog lists (the original reads them from its provider, the live editor from /api/editor-media). */
const MEDIA = [{ title: 'صورة أولى', kind: 'image', url: 'https://elan.test/a.jpg' }, { title: 'فيديو ثان', kind: 'video', url: 'https://elan.test/b.mp4' }];
const PERFUMES = [
  { product_id: 'p1', product_size_id: 'ps1', name: 'عطر أول', size_label: '100 مل' },
  { product_id: 'p2', product_size_id: 'ps2', name: 'عطر ثان', size_label: '50 مل' }
];

const PROPS = ['fontSize', 'fontWeight', 'color', 'backgroundColor', 'borderTopColor', 'borderBottomColor', 'borderLeftColor', 'boxShadow', 'opacity', 'paddingTop', 'paddingRight', 'paddingBottom', 'paddingLeft', 'marginTop', 'marginBottom', 'borderTopWidth', 'borderBottomWidth', 'borderTopLeftRadius', 'display', 'textAlign', 'gap'];

/* Runs inside the page (Playwright passes one argument: { selector, props }). */
function describePanel(arg) {
  const selector = arg.selector, props = arg.props;
  const root = document.querySelector(selector);
  if (!root) return null;
  const base = root.getBoundingClientRect();
  const out = [];
  const walk = (el) => {
    const cs = getComputedStyle(el), r = el.getBoundingClientRect();
    if (cs.display === 'none' || cs.visibility === 'hidden' || r.width <= 0 || r.height <= 0) return;
    const own = Array.from(el.childNodes).filter((n) => n.nodeType === 3).map((n) => n.textContent.trim()).join(' ').slice(0, 40);
    const style = {}; props.forEach((p) => { style[p] = cs[p]; });
    out.push({ tag: el.tagName.toLowerCase(), cls: typeof el.className === 'string' ? el.className : '', text: own, x: Math.round(r.left - base.left), y: Math.round(r.top - base.top), w: Math.round(r.width), h: Math.round(r.height), style });
    Array.from(el.children).forEach(walk);
  };
  walk(root);
  return out;
}

/* The letters' own width depends on the Arabic font a machine has (the original was captured here, CI runs on another image), so the left
   edge and width of elements that shrink to their text may differ by a few pixels between machines: x and w get 4px, y and h 2px.
   compare(live, golden, tolerance, drop, looseText): `drop(entry)` lists original elements that were deleted on purpose (the AI button);
   `drop` may also answer 'tail' for the original's closing rows (the panel then loses their height); `looseText` lists texts that depend on the element being edited (the sample line), which are compared by box only.
   Wording the live library says differently on purpose (its title and its connection line) is compared by box only, and a
   short hint under the upload button may take a different number of lines: whatever follows it is moved by the difference. */
function compare(live, golden, tolerance, drop, looseText) {
  const tol = typeof tolerance === 'number' ? { x: tolerance, y: tolerance, w: tolerance, h: tolerance } : tolerance;
  const problems = [];
  /* drop(entry) may answer 'stack' for an element in a vertical stack: what follows it then moves up by the room it took */
  const kept = []; let cut = 0, tail = null;
  for (let g = 0; g < golden.length; g++) {
    const e = golden[g], d = drop && drop(e);
    if (d) {
      if (d === 'stack') { const next = golden.slice(g + 1).find((x) => !(drop && drop(x))); if (next && next.y > e.y) cut += next.y - e.y; }
      if (d === 'tail') tail = e;
      continue;
    }
    kept.push(Object.assign({}, e, { y: e.y - cut }));
  }
  if (cut && kept.length) kept[0].h -= cut;
  /* 'tail' marks the original's closing rows (removed on purpose): the panel is shorter by what they took, margins included */
  if (tail && kept.length > 1) {
    const edge = (e) => e.y + e.h + (parseFloat(e.style.marginBottom) || 0), last = kept[kept.length - 1];
    kept[0].h -= Math.max(0, edge(tail) - edge(last));
  }
  const orig = kept;
  const hint = (list) => list.findIndex((e) => e.tag === 'small');
  const li = hint(live), gi = hint(orig);
  const dy = li >= 0 && gi >= 0 ? live[li].h - orig[gi].h : 0;
  if (live.length !== orig.length) problems.push('drawn elements: ' + live.length + ' live, ' + orig.length + ' in the original');
  for (let i = 0; i < Math.min(live.length, orig.length); i++) {
    const a = live[i], b = orig[i], after = gi >= 0 && i > gi;
    const name = '#' + i + ' <' + b.tag + (b.cls ? '.' + b.cls.replace(/ /g, '.') : '') + '> "' + b.text + '"';
    if (a.tag !== b.tag) { problems.push(name + ': tag ' + a.tag); continue; }
    if (a.cls !== b.cls) problems.push(name + ': class "' + a.cls + '"');
    const ownWords = a.tag === 'h3' && /\u0645\u0643\u062a\u0628\u0629/.test(b.text) || a.tag === 'p' && /\u0627\u0644\u0631\u0628\u0637 \u0627\u0644\u0645\u0631\u0643\u0632\u064a/.test(b.text) || a.tag === 'small' || (looseText || []).includes(b.text);
    if (!ownWords && a.text !== b.text) problems.push(name + ': text "' + a.text + '"');
    const want = { x: b.x, y: b.y + (after ? dy : 0), w: b.w, h: b.h + (i === 0 ? dy : 0) };
    if (a.tag === 'small') { want.h = a.h; }
    ['x', 'y', 'w', 'h'].forEach((k) => { if (Math.abs(a[k] - want[k]) > tol[k]) problems.push(name + ': ' + k + ' ' + a[k] + ' (original ' + want[k] + ')'); });
    Object.keys(b.style).forEach((k) => { if (i === 0 && /^margin/.test(k)) return;   // a dialog's auto margins only centre it, whatever its height
      if (a.style[k] !== b.style[k]) problems.push(name + ': ' + k + ' ' + a.style[k] + ' (original ' + b.style[k] + ')'); });
  }
  return problems;
}

/* For a panel filled with real data (the live site's lists, not the test's): which looks of the original are missing?
   Every distinct look (tag, class, colours, type size and weight, border colour and radius) the original draws must be drawn
   somewhere in the live panel too, and the panel itself must be as wide. Texts, counts and positions are data and are not compared. */
function looks(list) {
  const set = new Map();
  list.forEach((e) => {
    const st = e.style, key = [e.tag, e.cls, st.backgroundColor, st.color, st.fontSize, st.fontWeight, st.borderTopColor, st.borderTopLeftRadius].join('|');
    if (!set.has(key)) set.set(key, e.tag + (e.cls ? '.' + e.cls.replace(/ /g, '.') : '') + ' "' + e.text + '" bg ' + st.backgroundColor + ' color ' + st.color + ' ' + st.fontSize + ' border ' + st.borderTopColor + ' r' + st.borderTopLeftRadius);
  });
  return set;
}
function missingLooks(live, golden, drop) {
  const have = looks(live), want = looks(golden.filter((e) => !(drop && drop(e))));
  const missing = [];
  want.forEach((label, key) => { if (!have.has(key)) missing.push(label); });
  const wide = live[0] && golden[0] && Math.abs(live[0].w - golden[0].w) > 4 ? ['panel width ' + live[0].w + ' (original ' + golden[0].w + ')'] : [];
  return wide.concat(missing);
}

module.exports = { OPTIONS, MEDIA, PERFUMES, looks, missingLooks, PROPS, describePanel, compare };
