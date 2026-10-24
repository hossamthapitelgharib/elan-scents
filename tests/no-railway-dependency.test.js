/* Railway is no longer the host: nothing the live site runs or serves may point at a Railway address.
   The owner editor, the framed storefront and the API all run on the Cloudflare Worker. A hard-coded *.up.railway.app address in
   served code would silently send the editor or the storefront to a service that no longer exists. Tests, docs, reports and the
   archive are not scanned (they may mention old addresses as test data or history). */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.resolve(__dirname, '..');
const SKIP_DIRS = new Set(['node_modules', '.git', 'dist', 'tests', '.archive', 'reports', 'supabase', 'cloudflare/generated']);
const CODE_EXT = new Set(['.js', '.mjs', '.cjs', '.html', '.css', '.json', '.jsonc', '.svg', '.xml', '.txt', '.webmanifest']);

function walk(dir, rel, out) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const next = rel ? rel + '/' + entry.name : entry.name;
    if (SKIP_DIRS.has(entry.name) || SKIP_DIRS.has(next) || entry.isSymbolicLink()) continue;
    if (entry.isDirectory()) walk(path.join(dir, entry.name), next, out);
    else if (entry.isFile() && CODE_EXT.has(path.extname(entry.name).toLowerCase())) out.push(next);
  }
  return out;
}

test('no served or running code contains a Railway address', () => {
  const offenders = [];
  for (const file of walk(root, '', [])) {
    const text = fs.readFileSync(path.join(root, file), 'utf8');
    const hit = text.match(/[a-z0-9.-]*\.up\.railway\.app|[a-z0-9.-]*\.railway\.internal/i);
    if (hit) offenders.push(file + ' -> ' + hit[0]);
  }
  assert.deepEqual(offenders, [], 'Railway addresses found in code:\n' + offenders.join('\n'));
});

test('the default site origin is the Cloudflare Worker address', () => {
  const { DEFAULT_SITE_ORIGIN } = require('../lib/site-origin.js');
  const wrangler = fs.readFileSync(path.join(root, 'wrangler.jsonc'), 'utf8');
  const name = (wrangler.match(/"name"\s*:\s*"([^"]+)"/) || [])[1];
  assert.ok(name, 'wrangler.jsonc has a Worker name');
  assert.ok(new URL(DEFAULT_SITE_ORIGIN).hostname.startsWith(name + '.'), 'default origin should start with the Worker name ' + name);
  assert.ok(DEFAULT_SITE_ORIGIN.endsWith('.workers.dev'));
});
