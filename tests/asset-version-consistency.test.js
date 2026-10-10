const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { targets, REF } = require('../scripts/bump-asset-version');

const root = path.resolve(__dirname, '..');

test('every page, app.js and style.css reference css/js assets with ONE shared cache-busting version', () => {
  const byVersion = new Map();
  for (const file of targets()) {
    const text = fs.readFileSync(path.join(root, file), 'utf8');
    for (const m of text.matchAll(REF)) {
      if (!byVersion.has(m[2])) byVersion.set(m[2], []);
      byVersion.get(m[2]).push(`${file}: ${m[1]}`);
    }
  }
  assert.ok(byVersion.size > 0, 'at least one versioned asset');
  assert.equal(byVersion.size, 1, `assets use different versions (run: node scripts/bump-asset-version.js):\n${JSON.stringify([...byVersion.entries()], null, 2)}`);
});

test('every local css/js asset linked from an HTML page carries a version', () => {
  for (const file of fs.readdirSync(root).filter((f) => f.endsWith('.html'))) {
    const html = fs.readFileSync(path.join(root, file), 'utf8');
    for (const m of html.matchAll(/(?:href|src)="(\/[^"?#]+\.(?:css|js))(\?[^"]*)?"/g)) {
      assert.match(m[2] || '', /^\?v=[0-9A-Za-z-]+$/, `${file} links ${m[1]} without ?v=`);
      assert.ok(fs.existsSync(path.join(root, m[1])), `${file} links a missing file ${m[1]}`);
    }
  }
});

test('bump script rewrites versions in place and rejects malformed input', () => {
  const { bump, nextVersion } = require('../scripts/bump-asset-version');
  assert.throws(() => bump('v2'), /invalid version/);
  assert.match(nextVersion(new Date('2030-01-02T00:00:00Z')), /^20300102-01$/);
});
