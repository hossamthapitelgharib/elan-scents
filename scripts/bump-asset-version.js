#!/usr/bin/env node
/* Sets ONE cache-busting version (?v=...) on every local .css/.js reference of the storefront, portals and editor.
   Usage: node scripts/bump-asset-version.js [version]   (default: next YYYYMMDD-NN)
   Run it whenever any frontend asset (html/js/css) changes, then commit. Media (mp4/jpg) keeps its own version. */
const fs = require('node:fs');
const path = require('node:path');

const root = path.resolve(__dirname, '..');
const REF = /(\/[A-Za-z0-9._\-\/]+\.(?:css|js))\?v=([A-Za-z0-9\-]+)/g;

function targets() {
  return [...fs.readdirSync(root).filter((f) => f.endsWith('.html')), 'app.js', 'style.css']
    .filter((f) => fs.existsSync(path.join(root, f)));
}

function currentVersions() {
  const found = new Set();
  for (const file of targets()) {
    const text = fs.readFileSync(path.join(root, file), 'utf8');
    for (const m of text.matchAll(REF)) found.add(m[2]);
  }
  return [...found].sort();
}

function nextVersion(now = new Date()) {
  const day = [now.getUTCFullYear(), String(now.getUTCMonth() + 1).padStart(2, '0'), String(now.getUTCDate()).padStart(2, '0')].join('');
  const sameDay = currentVersions().filter((v) => v.startsWith(day + '-')).map((v) => Number(v.split('-')[1]) || 0);
  return `${day}-${String(Math.max(0, ...sameDay) + 1).padStart(2, '0')}`;
}

function bump(version) {
  if (!/^[0-9]{8}-[0-9]{2,}$/.test(version)) throw new Error(`invalid version "${version}" (expected YYYYMMDD-NN)`);
  const changed = [];
  for (const file of targets()) {
    const full = path.join(root, file);
    const before = fs.readFileSync(full, 'utf8');
    const after = before.replace(REF, (_all, ref) => `${ref}?v=${version}`);
    if (after !== before) { fs.writeFileSync(full, after); changed.push(file); }
  }
  return changed;
}

module.exports = { targets, currentVersions, nextVersion, bump, REF };

if (require.main === module) {
  const version = process.argv[2] || nextVersion();
  const changed = bump(version);
  console.log(`asset version -> ${version} (${changed.length} files: ${changed.join(', ') || 'none'})`);
}
