#!/usr/bin/env node
/* The asset version (?v=...) is no longer typed by hand, so there is nothing to bump any more.

   The source files carry the constant placeholder ?v=dev. The real version is the fingerprint of the shared scripts and stylesheets,
   put into every page when it is served (railway/server.js) or built (scripts/build-cloudflare.js); see lib/asset-version.js. A changed
   file therefore always gets a new version by itself, and two sessions editing the storefront never conflict on a version number.

   This command stays so that an old habit (or an old instruction) does no harm: it puts the placeholder back wherever a literal number
   found its way into a page (for instance from an old branch), removes the retired asset-manifest.json, and says so.
   Usage: node scripts/bump-asset-version.js */
const fs = require('node:fs');
const path = require('node:path');
const assetVersion = require('../lib/asset-version');

const root = path.resolve(__dirname, '..');
const { REF, PLACEHOLDER } = assetVersion;

/* Every file that carries script or stylesheet references: the pages, the editor login page and the loader (app.js). */
function targets() {
  return [...assetVersion.pageFiles(root), 'app.js', 'style.css'].filter((f) => fs.existsSync(path.join(root, f)));
}

/* Puts the placeholder back on every reference of the shared set; returns the files that changed. */
function normalize() {
  const shared = new Set(assetVersion.immutableFiles(root));
  const changed = [];
  for (const file of targets()) {
    const full = path.join(root, file);
    const before = fs.readFileSync(full, 'utf8');
    const after = before.replace(REF, (all, ref) => (shared.has(ref.slice(1)) ? `${ref}?v=${PLACEHOLDER}` : all));
    if (after !== before) { fs.writeFileSync(full, after); changed.push(file); }
  }
  return changed;
}

module.exports = { targets, normalize, REF, PLACEHOLDER, immutableFiles: assetVersion.immutableFiles, hashOf: (f) => assetVersion.hashOf(f, root) };

if (require.main === module) {
  const changed = normalize();
  const manifest = path.join(root, 'asset-manifest.json');
  const removed = fs.existsSync(manifest);
  if (removed) fs.rmSync(manifest);
  console.log('The asset version is generated from the files when a page is served or built; there is nothing to bump.'
    + (changed.length ? ` Put the placeholder back in: ${changed.join(', ')}.` : '')
    + (removed ? ' Removed the retired asset-manifest.json.' : ''));
}
