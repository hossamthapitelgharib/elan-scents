'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { classifyAuthResult } = require('../scripts/live-turnstile-auth-probe');

const source = fs.readFileSync(path.join(__dirname, '..', 'scripts/live-turnstile-auth-probe.js'), 'utf8');

test('live Turnstile probe distinguishes a valid token from a rejected token', () => {
  assert.equal(classifyAuthResult(400, { error_code: 'invalid_credentials' }), 'token_accepted');
  assert.equal(classifyAuthResult(400, { error_code: 'captcha_failed' }), 'turnstile_rejected');
});

test('live Turnstile probe never signs up and targets a reserved nonexistent identity', () => {
  assert.match(source, /@example\.invalid/);
  assert.match(source, /auth\/v1\/token\?grant_type=password/);
  assert.doesNotMatch(source, /auth\/v1\/signup/);
  assert.doesNotMatch(source, /console\.(?:log|error)\(auth\.(?:token|key)/i);
});
