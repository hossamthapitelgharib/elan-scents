// The «eye» on password fields (owner, 8 Nov 2026): every password field the customer sees has a button that shows what he typed and hides it again;
// the field always starts hidden. The behaviour itself is exercised in a real browser (tests/browser/user-journeys.chromium.js, journeys 17 and 18);
// here: the script is safe under the page policy, small, and loaded by every page that has a password field.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.join(__dirname, '..');
const read = (f) => fs.readFileSync(path.join(root, f), 'utf8');
const SCRIPT = read('pw-eye.js');

test('pw-eye.js is a plain same-origin script: no eval, no network, no storage, no inline handlers, and it never reads or sends the password', () => {
  assert.doesNotMatch(SCRIPT, /\beval\s*\(|new Function|document\.write|fetch\(|XMLHttpRequest|localStorage|sessionStorage|\.value\b|onclick\s*=/);
  assert.match(SCRIPT, /type = show \? 'text' : 'password'/, 'it only flips the field type');
  assert.match(SCRIPT, /setAttribute\('aria-pressed', 'false'\)/, 'every field starts hidden');
  assert.match(SCRIPT, /MutationObserver/, 'forms built later (sheets, panels) get the eye too');
});

test('the eye has labels in both languages and is a button that cannot submit a form', () => {
  assert.match(SCRIPT, /ar: \['إظهار كلمة المرور', 'إخفاء كلمة المرور'\]/);
  assert.match(SCRIPT, /en: \['Show password', 'Hide password'\]/);
  assert.match(SCRIPT, /btn\.type = 'button'/);
});

test('every page with a password field, or a script that builds one, loads pw-eye.js under the shared version', () => {
  const pages = fs.readdirSync(root).filter((f) => f.endsWith('.html'));
  const needing = pages.filter((f) => { const h = read(f); return /type="password"/.test(h) || /src="\/(app|app-core|account|portal)\.js/.test(h); });
  /* The customers and stores pages now live inside platform-dashboard.html; their old addresses are bare redirects with no scripts. */
  assert.ok(needing.length >= 5, 'the storefront, the account page and the three panels: ' + needing.join(', '));
  const version = require('../lib/asset-version').PLACEHOLDER; // the sources carry the placeholder; the real version is put in when a page is served
  for (const f of needing) assert.match(read(f), new RegExp('<script src="/pw-eye\\.js\\?v=' + version + '" defer></script>'), f);
});

test('pw-eye.js is served like the other shared scripts (immutable under its ?v= URL) and is covered by the asset fingerprint', () => {
  assert.match(read('vercel.json'), /\|pw-eye\.js\|/);
  assert.ok(require('../lib/asset-version').immutableFiles().includes('pw-eye.js'), 'the fingerprint covers it');
});
