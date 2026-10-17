const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const root = path.join(__dirname, '..');
const bundlePath = path.join(root, 'vendor', 'thumbmark.js');
const versionPath = path.join(root, 'vendor', 'thumbmark.version.txt');
const skip = fs.existsSync(bundlePath) ? false : 'vendor/thumbmark.js is not vendored yet';

function loadBundle() {
  const context = { window: {} };
  vm.runInNewContext(fs.readFileSync(bundlePath, 'utf8'), context, { filename: 'thumbmark.js' });
  return context.ThumbmarkJS;
}

test('vendored ThumbmarkJS matches the pinned version and sha256 recorded next to it', { skip }, () => {
  const [version, hash] = fs.readFileSync(versionPath, 'utf8').trim().split(/\r?\n/);
  const bytes = fs.readFileSync(bundlePath);
  assert.match(version, /^\d+\.\d+\.\d+$/);
  assert.equal(crypto.createHash('sha256').update(bytes).digest('hex'), hash);
  assert.ok(bytes.toString('utf8').includes('"' + version + '"'));
});

test('vendored ThumbmarkJS loads and exposes the API that guest-identity.js uses', { skip }, () => {
  const lib = loadBundle();
  assert.equal(typeof lib.Thumbmark, 'function');
  assert.equal(typeof lib.getFingerprint, 'function');
  assert.equal(typeof lib.setOption, 'function');
  assert.equal(new lib.Thumbmark({ logging: false }).options.logging, false);
});

test('vendored ThumbmarkJS can only reach api.thumbmarkjs.com, through two fetch calls', { skip }, () => {
  const code = fs.readFileSync(bundlePath, 'utf8');
  assert.equal((code.match(/\bfetch\(/g) || []).length, 2);
  assert.doesNotMatch(code, /XMLHttpRequest|sendBeacon|WebSocket|EventSource/);
  const urls = [...new Set(code.match(/https?:\/\/[^"'`\s)]+/g) || [])];
  assert.deepEqual(urls, ['https://api.thumbmarkjs.com']);
});
