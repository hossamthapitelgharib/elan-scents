const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const root = path.join(__dirname, '..');
const sessions = require('../railway/editor-session.js');

const response = (status, body) => ({ ok: status >= 200 && status < 300, status, json: async () => body });

test('editor login reports role-check failures separately from wrong passwords', async () => {
  const previousEnv = Object.fromEntries(['SUPABASE_URL', 'SUPABASE_ANON_KEY', 'SUPABASE_SERVICE_ROLE_KEY'].map((k) => [k, process.env[k]]));
  const previousFetch = global.fetch;
  process.env.SUPABASE_URL = 'https://supabase.example.test';
  process.env.SUPABASE_ANON_KEY = 'anon';
  process.env.SUPABASE_SERVICE_ROLE_KEY = 'service';

  try {
    global.fetch = async (url, options = {}) => {
      url = String(url);
      if (url.includes('/auth/v1/token?grant_type=password')) {
        const credentials = JSON.parse(options.body);
        return credentials.password === 'correct'
          ? response(200, { access_token: 'valid-token', refresh_token: 'refresh-token', expires_in: 3600 })
          : response(400, { error: 'invalid_grant' });
      }
      if (url.endsWith('/auth/v1/user')) return response(200, { id: 'user-1', email: 'owner@example.test' });
      if (url.includes('/rest/v1/profiles')) return response(503, { error: 'database_unavailable' });
      throw new Error('Unexpected authentication request: ' + url);
    };

    const badPassword = await sessions.login('owner@example.test', 'wrong', 'test-bad-password');
    assert.deepEqual(badPassword, { status: 401, error: 'invalid_credentials' });
    const failedRoleCheck = await sessions.login('owner@example.test', 'correct', 'test-role-check-failure');
    assert.deepEqual(failedRoleCheck, { status: 502, error: 'role_check_failed' });

    global.fetch = async (url, options = {}) => {
      url = String(url);
      if (url.includes('/auth/v1/token?grant_type=password')) return response(200, { access_token: 'valid-token', refresh_token: 'refresh-token', expires_in: 3600 });
      if (url.endsWith('/auth/v1/user')) return response(200, { id: 'user-2', email: 'customer@example.test' });
      if (url.includes('/rest/v1/profiles')) return response(200, [{ id: 'user-2', role: 'customer' }]);
      throw new Error('Unexpected authentication request: ' + url);
    };
    const forbidden = await sessions.login('customer@example.test', 'correct', 'test-forbidden-role');
    assert.deepEqual(forbidden, { status: 403, error: 'forbidden' });
  } finally {
    global.fetch = previousFetch;
    for (const [key, value] of Object.entries(previousEnv)) {
      if (value === undefined) delete process.env[key]; else process.env[key] = value;
    }
  }

  const client = fs.readFileSync(path.join(root, 'editor/editor-login.js'), 'utf8');
  assert.match(client, /role_check_failed/);
});
