#!/usr/bin/env node
/* Sets ONE cache-busting version (?v=...) on every local .css/.js reference of the storefront and portals.
   Usage: node scripts/bump-asset-version.js [version]   (default: next YYYYMMDD-NN)
   Run it whenever any frontend asset (html/js/css) changes, then commit. Media (mp4/jpg) keeps its own version.
   It also rewrites asset-manifest.json: the version and a content hash of every script/stylesheet that vercel.json serves with
   "public, max-age=31536000, immutable". Browsers keep those files for a year under their ?v= URL, so a file changed WITHOUT a new
   version would stay stale for returning visitors; tests/asset-immutable.test.js fails when a hash no longer matches. */
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

const root = path.resolve(__dirname, '..');
const REF = /(\/[A-Za-z0-9._\-\/]+\.(?:css|js))\?v=([A-Za-z0-9\-]+)/g;

function targets() {
  return [...fs.readdirSync(root).filter((f) => f.endsWith('.html') && f !== 'editor.html'), 'app.js', 'style.css']
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

const MANIFEST = path.join(root, 'asset-manifest.json');
const IMMUTABLE = 'public, max-age=31536000, immutable';

/* The files vercel.json serves as immutable under a versioned URL (the one rule whose source is a plain list of root-relative names). */
function immutableFiles() {
  const rules = JSON.parse(fs.readFileSync(path.join(root, 'vercel.json'), 'utf8')).headers || [];
  const rule = rules.find((r) => (r.headers || []).some((h) => h.key === 'Cache-Control' && h.value === IMMUTABLE) && /^\/\([\w.\/|-]+\)$/.test(r.source) && /\.(css|js)\b/.test(r.source));
  return rule ? rule.source.slice(2, -1).split('|').filter((f) => /\.(css|js)$/.test(f)) : [];
}

function hashOf(file) { return crypto.createHash('sha256').update(fs.readFileSync(path.join(root, file))).digest('hex').slice(0, 16); }

function manifestFor(version) {
  const files = {};
  for (const f of immutableFiles().sort()) files[f] = hashOf(f);
  return { version, files };
}

function writeManifest(version) {
  fs.writeFileSync(MANIFEST, JSON.stringify(manifestFor(version), null, 2) + '\n');
}

module.exports = { targets, currentVersions, nextVersion, bump, REF, MANIFEST, IMMUTABLE, immutableFiles, hashOf, manifestFor, writeManifest };

if (require.main === module) {
  const version = process.argv[2] || nextVersion();
  const changed = bump(version);
  writeManifest(version);
  console.log(`asset version -> ${version} (${changed.length} files: ${changed.join(', ') || 'none'}); asset-manifest.json updated`);
}
