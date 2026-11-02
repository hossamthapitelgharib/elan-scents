const test = require('node:test');
const assert = require('node:assert/strict');
const { config } = require('../lib/state-store');
const { createDistributedLimiter } = require('../lib/rate-limit');

test('shared state is opt-in and has no credentials by default', () => {
  const oldUrl = process.env.STATE_STORE_URL;
  const oldToken = process.env.STATE_STORE_TOKEN;
  delete process.env.STATE_STORE_URL;
  delete process.env.STATE_STORE_TOKEN;
  try {
    assert.equal(config(), null);
  } finally {
    if (oldUrl === undefined) delete process.env.STATE_STORE_URL; else process.env.STATE_STORE_URL = oldUrl;
    if (oldToken === undefined) delete process.env.STATE_STORE_TOKEN; else process.env.STATE_STORE_TOKEN = oldToken;
  }
});

test('distributed limiter preserves local behavior when shared state is not configured', async () => {
  const oldUrl = process.env.STATE_STORE_URL;
  const oldToken = process.env.STATE_STORE_TOKEN;
  delete process.env.STATE_STORE_URL;
  delete process.env.STATE_STORE_TOKEN;
  try {
    const check = createDistributedLimiter({ name: 'test', max: 2, windowMs: 60000 });
    assert.equal((await check('a')).allowed, true);
    assert.equal((await check('a')).allowed, true);
    assert.equal((await check('a')).allowed, false);
  } finally {
    if (oldUrl === undefined) delete process.env.STATE_STORE_URL; else process.env.STATE_STORE_URL = oldUrl;
    if (oldToken === undefined) delete process.env.STATE_STORE_TOKEN; else process.env.STATE_STORE_TOKEN = oldToken;
  }
});
