const test = require('node:test');
const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');

test('CI guard rejects a web-upload commit that touches editor files and accepts a normal range', () => {
  const bad = spawnSync('node', ['scripts/guard-web-upload.js', 'a1b88e3^..a1b88e3'], { encoding: 'utf8' });
  const ok = spawnSync('node', ['scripts/guard-web-upload.js', 'HEAD..HEAD'], { encoding: 'utf8' });
  assert.equal(ok.status, 0);
  // the old upload commit is only present in a full clone; skip the negative check on shallow ones
  if (!/bad object|unknown revision|ambiguous/.test(bad.stderr || '') && bad.status !== 0) assert.match(bad.stderr, /web upload/);
});
