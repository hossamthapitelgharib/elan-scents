'use strict';
/* The cache-busting version of the storefront's scripts and stylesheets (?v=...), generated from the files themselves.

   Why: scripts and stylesheets are served "public, max-age=31536000, immutable" (vercel.json), so a browser keeps a file for a year under
   its URL. A changed file therefore needs a new URL, and that used to be a number typed into every page by hand
   (scripts/bump-asset-version.js). Every session that touched the storefront rewrote that number in ten files, so two sessions working at
   the same time conflicted on every rebase, and a forgotten bump left returning visitors on the old file.

   Now the source files carry one constant placeholder (?v=dev) that never changes, so it can never conflict, and the real version is the
   fingerprint of the immutable files' contents, put in when a page is served (railway/server.js) or built (scripts/build-cloudflare.js).
   A changed file changes the fingerprint, so a stale copy is impossible; an unchanged set of files keeps its version, so nothing is
   downloaded again for nothing.

   Only Node uses this file (the local server, the build, the tests). The Worker serves pages that were stamped at build time. */
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

const ROOT = typeof __dirname === 'string' ? path.resolve(__dirname, '..') : '/';
const IMMUTABLE = 'public, max-age=31536000, immutable';
/* What every source file carries. Stamping replaces it; a served page that still shows it was not stamped (the tests look for that). */
const PLACEHOLDER = 'dev';
/* A local script or stylesheet reference with its version: "/app-core.js?v=...". */
const REF = /(\/[A-Za-z0-9._\-\/]+\.(?:css|js))\?v=([A-Za-z0-9\-]+)/g;

/* The files vercel.json serves immutable (the one rule whose source is a plain list of root-relative names). */
function immutableFiles(root = ROOT) {
  const rules = JSON.parse(fs.readFileSync(path.join(root, 'vercel.json'), 'utf8')).headers || [];
  const rule = rules.find((r) => (r.headers || []).some((h) => h.key === 'Cache-Control' && h.value === IMMUTABLE) && /^\/\([\w.\/|-]+\)$/.test(r.source) && /\.(css|js)\b/.test(r.source));
  return rule ? rule.source.slice(2, -1).split('|').filter((f) => /\.(css|js)$/.test(f)).sort() : [];
}

function hashOf(file, root = ROOT) {
  let bytes;
  try { bytes = fs.readFileSync(path.join(root, file)); } catch (_) { bytes = 'missing'; } // a smaller tree (a test fixture) simply lacks some files
  return crypto.createHash('sha256').update(bytes).digest('hex');
}

/* One version for the whole set: the fingerprint of the immutable files (their names and contents). */
function computeVersion(root = ROOT) {
  const h = crypto.createHash('sha256');
  for (const f of immutableFiles(root)) h.update(f + '\0' + hashOf(f, root) + '\n');
  return h.digest('hex').slice(0, 12);
}

/* The same, kept in memory by the local server and re-checked only when a file's size or modification time moved. */
const memo = new Map();
function currentVersion(root = ROOT) {
  const files = immutableFiles(root);
  const signature = files.map((f) => { try { const s = fs.statSync(path.join(root, f)); return f + ':' + s.size + ':' + Math.floor(s.mtimeMs); } catch (_) { return f + ':missing'; } }).join('|');
  const hit = memo.get(root);
  if (hit && hit.signature === signature) return hit.version;
  const version = computeVersion(root);
  memo.set(root, { signature, version });
  return version;
}

/* Puts the version into every reference to a script or stylesheet of the shared set. A reference to anything else that carries its own
   version (the editor's own files) is left alone; so is every other kind of text. */
function stamp(text, version, root = ROOT) {
  const shared = new Set(immutableFiles(root));
  return String(text).replace(REF, (all, ref, old) => (shared.has(ref.slice(1)) || old === PLACEHOLDER ? `${ref}?v=${version}` : all));
}
function stampPage(text, root = ROOT) { return stamp(text, currentVersion(root), root); }

/* The pages (and the editor login page) that carry those references. */
function pageFiles(root = ROOT) {
  return [...fs.readdirSync(root).filter((f) => f.endsWith('.html') && f !== 'editor.html'), 'editor/login.html'].filter((f) => fs.existsSync(path.join(root, f)));
}

module.exports = { ROOT, IMMUTABLE, PLACEHOLDER, REF, immutableFiles, hashOf, computeVersion, currentVersion, stamp, stampPage, pageFiles };
