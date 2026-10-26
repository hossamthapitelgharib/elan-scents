const test = require('node:test');
const assert = require('node:assert/strict');
const sessions = require('../railway/editor-session.js');
const { getContext, requireRoles } = require('../api/_auth.js');

function withEnv(vars, fn) {
  const old = {};
  Object.keys(vars).forEach((k) => { old[k] = process.env[k]; if (vars[k] === undefined) delete process.env[k]; else process.env[k] = vars[k]; });
  return Promise.resolve(fn()).finally(() => Object.keys(old).forEach((k) => { if (old[k] === undefined) delete process.env[k]; else process.env[k] = old[k]; }));
}
const inHours = (h) => new Date(Date.now() + h * 3600 * 1000).toISOString();
const FAKE = { SUPABASE_URL: 'https://example.invalid', SUPABASE_SERVICE_ROLE_KEY: 'test-service-key', EDITOR_ACCESS_KEY: 'a-long-test-phrase-123', EDITOR_AUTH_BYPASS: '1', EDITOR_ACCESS_KEY_UNTIL: inHours(2) };

test('access-key login is off unless the owner turns it on with a long enough phrase', async () => {
  await withEnv({ ...FAKE, EDITOR_AUTH_BYPASS: undefined }, () => assert.equal(sessions.keyLogin('a-long-test-phrase-123', 'ip1').error, 'not_enabled'));
  await withEnv({ ...FAKE, EDITOR_ACCESS_KEY: 'short' }, () => assert.equal(sessions.keyLogin('short', 'ip2').error, 'not_enabled'));
});

test('access-key login is temporary by construction: it needs an end moment at most 24 hours ahead and stops there', async () => {
  const phrase = 'a-long-test-phrase-123';
  // no end moment, an unreadable one, one in the past and one far in the future: all of them leave the login off
  for (const until of [undefined, '', 'tomorrow-ish', inHours(-1), inHours(24.5), '2099-01-01T00:00:00Z', 'Infinity']) {
    await withEnv({ ...FAKE, EDITOR_ACCESS_KEY_UNTIL: until }, () => {
      assert.equal(sessions.accessKeyEnabled(), false, String(until));
      assert.equal(sessions.keyLogin(phrase, 'ipu-' + String(until)).error, 'not_enabled', String(until));
    });
  }
  await withEnv({ ...FAKE, EDITOR_ACCESS_KEY_UNTIL: inHours(23) }, () => assert.equal(sessions.accessKeyEnabled(), true));

  // a session opened with the key ends at the moment the owner set, even though normal sessions last hours
  const until = new Date(Date.now() + 30 * 60 * 1000);
  let now = Date.now();
  sessions.__setClock(() => now);
  try {
    await withEnv({ ...FAKE, EDITOR_ACCESS_KEY_UNTIL: until.toISOString() }, async () => {
      const ok = sessions.keyLogin(phrase, 'ip-expiry');
      assert.equal(ok.status, 200);
      assert.ok(await sessions.get(ok.id), 'open before the end moment');
      now = until.getTime() - 1000;
      assert.ok(await sessions.get(ok.id), 'still open a second before it');
      now = until.getTime() + 1000;
      assert.equal(await sessions.get(ok.id), null, 'closed after it');
      assert.equal(sessions.accessKeyEnabled(), false, 'and the login itself is off again');
    });
  } finally { sessions.__setClock(null); }
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
