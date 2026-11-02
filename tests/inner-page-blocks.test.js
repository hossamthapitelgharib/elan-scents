/* An inner page (a section, a category, a perfume: body.inner) shows only #view between the header and the footer. Every block of the
   home page has to be hidden there. The title "سحر الخليج بين يديك" and the brands / stores / perfumes counters moved out of the hero
   into their own block (#intro) under it, and the rule that hides the home blocks on an inner page was not told, so they stayed above
   the filters of every inner page. */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const read = (file) => fs.readFileSync(path.join(__dirname, '..', file), 'utf8');
const index = read('index.html');
const base = read('style-3.css');

/* The blocks the page keeps on every page, home or inner: the drawing sheet, header, menu, panels, the inner page itself, the footer. */
const SHARED = new Set(['bar', 'quickSearch', 'menu', 'mov', 'sheet', 'view', 'wa', 'toast']);

function topLevelBlocks(html) {
  const body = html.slice(html.indexOf('<body'));
  const out = [];
  let depth = 0;
  for (const m of body.matchAll(/<(\/?)([a-zA-Z][a-zA-Z0-9]*)([^>]*?)(\/?)>/g)) {
    const [, close, tag, attrs, selfClose] = m;
    const name = tag.toLowerCase();
    if (['br', 'img', 'input', 'meta', 'link', 'hr', 'source', 'path', 'circle', 'rect', 'line', 'polyline', 'stop', 'use', 'script', 'style'].includes(name)) continue;
    if (close) { depth -= 1; continue; }
    if (depth === 1) out.push({ tag: name, id: (/\bid="([^"]+)"/.exec(attrs) || [])[1] || '', cls: (/\bclass="([^"]+)"/.exec(attrs) || [])[1] || '' });
    if (!selfClose) depth += 1;
  }
  return out;
}

test('every block of the home page is hidden on an inner page, except the ones every page keeps', () => {
  const hidden = (base.match(/(?:^|\n)((?:body\.inner [^,{]+,?)+)\{display:none\}/) || [])[1] || '';
  assert.ok(hidden, 'the rule that hides the home blocks on an inner page exists');
  const blocks = topLevelBlocks(index);
  assert.ok(blocks.some((b) => b.id === 'hero') && blocks.some((b) => b.id === 'intro') && blocks.some((b) => b.id === 'main'), 'the page structure was read');
  for (const b of blocks) {
    if (b.tag === 'svg' || b.tag === 'header' || b.tag === 'footer' || SHARED.has(b.id)) continue;
    const names = [b.id && '#' + b.id, b.cls && '.' + b.cls.split(/\s+/)[0], b.tag].filter(Boolean);
    assert.ok(names.some((n) => new RegExp('body\\.inner ' + n.replace(/[.#]/g, '\\$&') + '(?![\\w-])').test(hidden)), 'the home block ' + names[0] + ' stays visible on an inner page: add body.inner ' + names[0] + ' to the hide rule in style-3.css');
  }
});

test('the title and the counters are hidden on an inner page, and shown on the home page', () => {
  assert.match(base, /body\.inner #intro[,{]/);
  assert.doesNotMatch(base + read('style.css'), /body\.inner #intro[^{]*\{[^}]*display:\s*(?:block|flex|grid)/, 'nothing shows it again');
});
