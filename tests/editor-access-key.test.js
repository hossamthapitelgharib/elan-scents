const test = require('node:test');
const assert = require('node:assert/strict');
const sessions = require('../railway/editor-session.js');
const { getContext, requireRoles } = require('../api/_auth.js');

function withEnv(vars, fn) {
  const old = {};
  Object.keys(vars).forEach((k) => { old[k] = process.env[k]; if (vars[k] === undefined) delete process.env[k]; else process.env[k] = vars[k]; });
  return Promise.resolve(fn()).finally(() => Object.keys(old).forEach((k) => { if (old[k] === undefined) delete process.env[k]; else process.env[k] = old[k]; }));
}
const FAKE = { SUPABASE_URL: 'https://example.invalid', SUPABASE_SERVICE_ROLE_KEY: 'test-service-key', EDITOR_ACCESS_KEY: 'a-long-test-phrase-123', EDITOR_AUTH_BYPASS: '1' };

test('access-key login is off unless the owner turns it on with a long enough phrase', async () => {
  await withEnv({ ...FAKE, EDITOR_AUTH_BYPASS: undefined }, () => assert.equal(sessions.keyLogin('a-long-test-phrase-123', 'ip1').error, 'not_enabled'));
  await withEnv({ ...FAKE, EDITOR_ACCESS_KEY: 'short' }, () => assert.equal(sessions.keyLogin('short', 'ip2').error, 'not_enabled'));
});

test('only the right phrase opens a session, wrong tries are limited', async () => {
  await withEnv(FAKE, async () => {
    assert.equal(sessions.keyLogin('wrong', 'ip3').error, 'invalid_key');
    const ok = sessions.keyLogin('a-long-test-phrase-123', 'ip4');
    assert.equal(ok.status, 200);
    const s = await sessions.get(ok.id);
    assert.equal(s.bypass, true);
    for (let i = 0; i < 12; i++) sessions.keyLogin('nope', 'ip5');
    assert.equal(sessions.keyLogin('a-long-test-phrase-123', 'ip5').error, 'too_many_attempts');
  });
});

test('the admin shortcut is a server-side flag, never a header the client can send', async () => {
  await withEnv(FAKE, async () => {
    const forged = await getContext({ headers: { authorization: '', 'x-editor-key-admin': 'true' } });
    assert.equal(forged.error, 'unauthorized');
    const ctx = requireRoles(await getContext({ headers: {}, __editorKeyAdmin: true }), ['platform_admin']);
    assert.equal(ctx.error, undefined);
    assert.equal(ctx.profile.role, 'platform_admin');
  });
});
