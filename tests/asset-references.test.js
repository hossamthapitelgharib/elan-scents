const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const root = path.resolve(__dirname, '..');

// Every page and stylesheet at the root, plus the scripts that build markup, must only point at /assets files that exist.
const sources = fs.readdirSync(root).filter((f) => /\.(html|css)$/.test(f)).concat(['app.js', 'app-core.js', 'portal.js', 'texts.js', 'design-layer.js']);
const reference = /(?:src|href)=["'](\/assets\/[^"'?#]+)|url\(\s*['"]?(\/assets\/[^'")?#]+)|['"](\/assets\/[^'"?#\s]+\.(?:png|jpe?g|webp|svg|mp4|woff2?|ttf|gif|ico))/g;

test('no page, stylesheet or script points at an /assets file that does not exist', () => {
  const missing = [];
  for (const file of sources) {
    const text = fs.readFileSync(path.join(root, file), 'utf8');
    for (const m of text.matchAll(reference)) {
      const ref = m[1] || m[2] || m[3];
      if (!fs.existsSync(path.join(root, ref))) missing.push(`${file} -> ${ref}`);
    }
  }
  assert.deepEqual(missing, [], 'every page load would send a request that returns 404');
});

test('the footer logo element stays for the editor (footer:logo) but is a placeholder that requests no file', () => {
  const html = fs.readFileSync(path.join(root, 'index.html'), 'utf8');
  assert.match(html, /class="footer-background" src="\/assets\/footer-background\.webp"/, 'the footer artwork is the one background image');
  assert.match(html, /<img class="footer-logo" src="data:image\/gif;base64,/, 'design-layer.js registers .footer-logo, so the element must exist');
  assert.doesNotMatch(html, /elan-scents-logo/);
});
