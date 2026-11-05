// The service e-mails (api/customer-mail.js, lib/mail-templates.js): who gets what, never twice, never to an address the caller picked.
// The server, the database functions and the mail server are all faked; nothing real is contacted and no address is real.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const KEYS = ['SUPABASE_URL', 'SUPABASE_SERVICE_ROLE_KEY', 'SMTP_USER', 'SMTP_PASSWORD', 'SMTP_HOST', 'SMTP_PORT', 'MAIL_FROM_NAME', 'PLATFORM_NOTIFY_EMAIL'];
const savedEnv = Object.fromEntries(KEYS.map((key) => [key, process.env[key]]));
const originalFetch = global.fetch;
process.env.SUPABASE_URL = 'https://mail-test.example.invalid';
process.env.SUPABASE_SERVICE_ROLE_KEY = 'unit-test-server-secret';
const handler = require('../api/customer-mail');
const smtp = require('../lib/smtp');
const templates = require('../lib/mail-templates');
const originalSend = smtp.sendMail;

const USER = 'd0000000-0000-4000-8000-0000000000c1';
let ipCounter = 0;

function configure(extra = {}) {
  for (const key of KEYS.slice(2)) delete process.env[key];
  Object.assign(process.env, { SMTP_USER: 'shop@example.invalid', SMTP_PASSWORD: 'app-password-for-tests', PLATFORM_NOTIFY_EMAIL: 'platform@example.invalid' }, extra);
}

/* world: { user, profile, claims: { kind: boolean | (kind) => boolean }, sendFails } */
async function call(event, world = {}, { token = 'user-token', body, method = 'POST', waitUntil = true, ip } = {}) {
  const log = { rpc: [], sent: [], released: [], fetches: [], waiting: [] };
  const user = Object.assign({ id: USER, email: 'buyer@example.invalid', email_confirmed_at: '2026-10-01T00:00:00Z', created_at: '2026-01-01T00:00:00Z' }, world.user);
  const profile = Object.assign({ id: USER, role: 'customer', full_name: 'Test Buyer' }, world.profile);
  const claims = Object.assign({ login: true, logout: true, registered: true }, world.claims);
  global.fetch = async (url, options = {}) => {
    url = String(url);
    log.fetches.push(url);
    const json = (value, ok = true) => ({ ok, json: async () => value });
    if (url.endsWith('/auth/v1/user')) return token ? json(user) : json({}, false);
    if (url.includes('/rest/v1/profiles')) return json([profile]);
    if (url.endsWith('/rpc/claim_customer_mail')) {
      const args = JSON.parse(options.body);
      log.rpc.push(args);
      if (world.claimFails || world.claimFailsFor === args.p_kind) return json({}, false);
      return json(claims[args.p_kind] !== false);
    }
    if (url.endsWith('/rpc/release_customer_mail')) { log.released.push(JSON.parse(options.body).p_kind); return json(null); }
    throw new Error('unexpected request ' + url);
  };
  smtp.sendMail = async (options) => {
    log.sent.push(options);
    if (world.sendFails) throw new smtp.SmtpError('smtp_auth');
  };
  const res = {
    statusCode: 200, headers: {}, body: null,
    setHeader(name, value) { this.headers[name] = value; return this; },
    status(code) { this.statusCode = code; return this; },
    json(value) { this.body = value; return this; }
  };
  const req = { method, headers: Object.assign({ 'x-real-ip': ip || `198.51.100.${++ipCounter % 250}` }, token ? { authorization: 'Bearer ' + token } : {}), body: body === undefined ? { event } : body };
  if (waitUntil) req.waitUntil = (promise) => log.waiting.push(promise);
  await handler(req, res);
  await Promise.all(log.waiting);
  return { res, log };
}

test.after(() => {
  global.fetch = originalFetch;
  smtp.sendMail = originalSend;
  for (const [key, value] of Object.entries(savedEnv)) { if (value === undefined) delete process.env[key]; else process.env[key] = value; }
});
test.beforeEach(() => configure());

/* ---------- the wording ---------- */

test('the three mails carry the owner\'s wording, in Arabic, as text and as right-to-left HTML', () => {
  const welcome = templates.welcome();
  assert.match(welcome.text, /أهلًا ومرحبًا بك ونتمنى لك رحلة تسويقية ممتعة/);
  assert.match(welcome.html, /dir="rtl"/);
  assert.match(welcome.html, /أهلًا ومرحبًا بك ونتمنى لك رحلة تسويقية ممتعة/);
  const goodbye = templates.goodbye();
  assert.match(goodbye.text, /كنا سعداء بوجودك معنا، وفي انتظارك دائمًا/);
  assert.match(goodbye.html, /كنا سعداء بوجودك معنا، وفي انتظارك دائمًا/);
  assert.ok(welcome.subject && goodbye.subject);
  const notice = templates.registeredNotice({ name: 'Test Buyer', email: 'buyer@example.invalid' });
  assert.match(notice.text, /Test Buyer/);
  assert.match(notice.text, /buyer@example\.invalid/);
  assert.match(notice.subject, /Test Buyer/);
});

test('a name or address that carries markup is escaped in the platform notice and can not add header lines', () => {
  const notice = templates.registeredNotice({ name: '<img src=x onerror=alert(1)>"\'&', email: 'a@b.invalid' });
  assert.ok(!notice.html.includes('<img'), 'no live tag from the name');
  assert.match(notice.html, /&lt;img src=x onerror=alert\(1\)&gt;&quot;&#39;&amp;/);
  const long = templates.registeredNotice({ name: 'م'.repeat(500), email: 'a@b.invalid' });
  assert.ok(long.subject.length < 120, 'the subject stays short');
});

test('times are shown in Cairo time, follow Egypt\'s summer time, and a missing time is a dash', () => {
  assert.match(templates.cairoTime('2026-11-03T11:03:11Z'), /1:03 م \(توقيت القاهرة\)/, 'winter: UTC+2');
  assert.match(templates.cairoTime('2026-07-03T11:03:11Z'), /2:03 م \(توقيت القاهرة\)/, 'summer: UTC+3');
  assert.equal(templates.cairoTime(null), '—');
  assert.equal(templates.cairoTime('not a date'), '—');
});

/* ---------- who can ask, and for what ---------- */

test('only POST, only the three known events, and only with a signed-in customer', async () => {
  assert.equal((await call('login', {}, { method: 'GET' })).res.statusCode, 405);
  assert.equal((await call('promo')).res.statusCode, 400);
  assert.equal((await call('login', {}, { body: { event: ['login'] } })).res.statusCode, 400);
  assert.equal((await call('login', {}, { body: {} })).res.statusCode, 400);
  const anonymous = await call('login', {}, { token: '' });
  assert.equal(anonymous.res.statusCode, 401);
  assert.equal(anonymous.log.sent.length, 0);
  assert.equal(anonymous.log.rpc.length, 0, 'no slot is taken for an unknown caller');
});

test('without the mailbox settings the endpoint does nothing and touches nothing', async () => {
  for (const missing of ['SMTP_USER', 'SMTP_PASSWORD']) {
    configure();
    delete process.env[missing];
    const { res, log } = await call('login');
    assert.equal(res.statusCode, 200);
    assert.deepEqual(res.body, { ok: true, sent: false, reason: 'mail_not_configured' });
    assert.equal(log.fetches.length, 0, 'not even the account is looked up');
    assert.equal(log.sent.length, 0);
  }
});

test('an app password pasted in Google\'s four groups works, and a blank one counts as not set', async () => {
  configure({ SMTP_PASSWORD: ' abcd efgh\tijkl mnop \n' });
  const { log } = await call('login');
  assert.equal(log.sent.length, 1);
  assert.equal(log.sent[0].pass, 'abcdefghijklmnop', 'the spaces are not sent to the mail server');
  configure({ SMTP_PASSWORD: '   ' });
  const blank = await call('login');
  assert.equal(blank.res.body.reason, 'mail_not_configured');
  assert.equal(blank.log.sent.length, 0);
});

test('staff and platform accounts, and unconfirmed addresses, get nothing', async () => {
  for (const role of ['platform_admin', 'store_admin']) {
    const { res, log } = await call('login', { profile: { role } });
    assert.equal(res.body.reason, 'not_customer');
    assert.equal(log.sent.length + log.rpc.length, 0);
  }
  const unconfirmed = await call('login', { user: { email_confirmed_at: null, confirmed_at: null } });
  assert.equal(unconfirmed.res.body.reason, 'email_not_confirmed');
  assert.equal(unconfirmed.log.sent.length + unconfirmed.log.rpc.length, 0);
  const noAddress = await call('login', { user: { email: '' } });
  assert.equal(noAddress.res.body.reason, 'no_email');
});

/* ---------- welcome and goodbye ---------- */

test('signing in sends the welcome to the account\'s own address, once per 30 minutes', async () => {
  const { res, log } = await call('login');
  assert.equal(res.statusCode, 202);
  assert.deepEqual(res.body, { ok: true, sent: true, queued: true });
  assert.equal(log.sent.length, 1);
  const mail = log.sent[0];
  assert.equal(mail.to, 'buyer@example.invalid');
  assert.equal(mail.from.address, 'shop@example.invalid');
  assert.equal(mail.from.name, 'Élan Scents');
  assert.equal(mail.host, 'smtp.gmail.com');
  assert.equal(mail.port, 465);
  assert.match(mail.text, /رحلة تسويقية ممتعة/);
  assert.deepEqual(log.rpc, [{ p_user_id: USER, p_kind: 'login', p_min_interval: '30 minutes' }]);
});

test('signing out sends the goodbye', async () => {
  const { log } = await call('logout');
  assert.equal(log.sent.length, 1);
  assert.equal(log.sent[0].to, 'buyer@example.invalid');
  assert.match(log.sent[0].text, /كنا سعداء بوجودك معنا/);
  assert.deepEqual(log.rpc, [{ p_user_id: USER, p_kind: 'logout', p_min_interval: '30 minutes' }]);
});

test('a second request inside the interval sends nothing', async () => {
  const { res, log } = await call('login', { claims: { login: false } });
  assert.equal(res.statusCode, 200);
  assert.deepEqual(res.body, { ok: true, sent: false, reason: 'already_sent' });
  assert.equal(log.sent.length, 0);
});

test('the recipient is the token\'s own account: addresses in the request are ignored', async () => {
  const { log } = await call('login', {}, { body: { event: 'login', to: 'victim@example.invalid', email: 'victim@example.invalid', recipient: 'victim@example.invalid', user_id: 'e0000000-0000-4000-8000-000000000000' } });
  assert.equal(log.sent.length, 1);
  assert.equal(log.sent[0].to, 'buyer@example.invalid');
  assert.equal(log.rpc[0].p_user_id, USER);
});

/* ---------- the platform notice ---------- */

test('a confirmed new account tells the platform mailbox once, with when it registered and when it confirmed', async () => {
  const { res, log } = await call('registered', { user: { created_at: '2026-11-03T11:02:45.747505+00:00', email_confirmed_at: '2026-11-03T11:03:11.652864+00:00' } });
  assert.equal(res.statusCode, 202);
  assert.equal(log.sent.length, 1);
  assert.equal(log.sent[0].to, 'platform@example.invalid');
  assert.match(log.sent[0].text, /Test Buyer/);
  assert.match(log.sent[0].text, /buyer@example\.invalid/);
  assert.match(log.sent[0].text, /تاريخ ووقت التسجيل: .*3 نوفمبر 2026 في 1:02 م \(توقيت القاهرة\)/, 'the registration time, in Cairo time');
  assert.match(log.sent[0].text, /تاريخ ووقت تأكيد البريد: .*3 نوفمبر 2026 في 1:03 م \(توقيت القاهرة\)/, 'and the confirmation time');
  assert.match(log.sent[0].html, /1:02 م/);
  assert.deepEqual(log.rpc.map((r) => r.p_kind), ['registered'], 'only its own slot: the customer\'s next sign-in is still welcomed');
  assert.equal(log.rpc[0].p_min_interval, '100 years');

  const again = await call('registered', { claims: { registered: false } });
  assert.equal(again.log.sent.length, 0, 'a second report of the same account sends nothing');
  assert.equal(again.res.body.reason, 'already_sent');
});

test('without a platform address the notice waits and nothing is claimed', async () => {
  configure({ PLATFORM_NOTIFY_EMAIL: '' });
  const { res, log } = await call('registered');
  assert.equal(res.body.reason, 'platform_email_not_set');
  assert.equal(log.rpc.length + log.sent.length, 0, 'the slot stays free for when the address is set');
});

test('the first sign-in of a young account also reports it (the confirmation link may have been opened elsewhere), and still welcomes', async () => {
  const young = new Date(Date.now() - 60 * 60 * 1000).toISOString();
  const { log } = await call('login', { user: { created_at: young } });
  assert.deepEqual(log.sent.map((m) => m.to).sort(), ['buyer@example.invalid', 'platform@example.invalid']);
  assert.deepEqual(log.rpc.map((r) => r.p_kind), ['registered', 'login']);
});

test('a database hiccup on the welcome slot does not lose a platform notice that was already claimed', async () => {
  const young = new Date(Date.now() - 60 * 60 * 1000).toISOString();
  const { res, log } = await call('login', { user: { created_at: young }, claimFailsFor: 'login' });
  assert.equal(res.statusCode, 202);
  assert.deepEqual(log.sent.map((m) => m.to), ['platform@example.invalid']);
});

test('a young account that was already reported is welcomed like anyone else; an old one is never reported', async () => {
  const young = new Date(Date.now() - 60 * 60 * 1000).toISOString();
  const reported = await call('login', { user: { created_at: young }, claims: { registered: false } });
  assert.equal(reported.log.sent.length, 1);
  assert.equal(reported.log.sent[0].to, 'buyer@example.invalid');
  assert.deepEqual(reported.log.rpc.map((r) => r.p_kind), ['registered', 'login']);

  const old = await call('login', { user: { created_at: '2025-01-01T00:00:00Z' } });
  assert.deepEqual(old.log.rpc.map((r) => r.p_kind), ['login'], 'an old account never asks for the registered slot');
  assert.equal(old.log.sent[0].to, 'buyer@example.invalid');
});

/* ---------- failures ---------- */

test('a mail that could not be sent gives its slot back so the next attempt can try, and the answer never shows the reason', async () => {
  const { res, log } = await call('login', { sendFails: true });
  assert.equal(res.statusCode, 202, 'the page is not told about a mail problem');
  assert.deepEqual(log.released, ['login']);
  assert.ok(!JSON.stringify(res.body).includes('smtp'));
  const notice = await call('registered', { sendFails: true });
  assert.deepEqual(notice.log.released, ['registered']);
});

test('if the database memory is unavailable nothing is sent, and the answer is a plain error', async () => {
  const { res, log } = await call('login', { claimFails: true });
  assert.equal(res.statusCode, 502);
  assert.deepEqual(res.body, { ok: false, error: 'customer_mail_failed' });
  assert.equal(log.sent.length, 0, 'no memory, no mail: it could repeat on every click');
});

test('the send runs after the answer when the platform allows it (waitUntil), and inside the request otherwise', async () => {
  let started = false, finished = false;
  global.fetch = async (url) => ({ ok: true, json: async () => (String(url).endsWith('/auth/v1/user') ? { id: USER, email: 'buyer@example.invalid', email_confirmed_at: 'x', created_at: '2025-01-01T00:00:00Z' } : String(url).includes('/profiles') ? [{ id: USER, role: 'customer' }] : true) });
  smtp.sendMail = async () => { started = true; await new Promise((resolve) => setTimeout(resolve, 30)); finished = true; };
  const mk = () => ({ statusCode: 0, setHeader() { return this; }, status(code) { this.statusCode = code; return this; }, json() { return this; } });
  const headers = () => ({ authorization: 'Bearer t', 'x-real-ip': `203.0.113.${++ipCounter % 250}` });
  let kept;
  await handler({ method: 'POST', headers: headers(), body: { event: 'login' }, waitUntil: (p) => { kept = p; } }, mk());
  assert.ok(kept, 'the work was handed to waitUntil');
  assert.equal(finished, false, 'the answer did not wait for the mail');
  await kept;
  assert.ok(started && finished);
  started = finished = false;
  await handler({ method: 'POST', headers: headers(), body: { event: 'login' } }, mk());
  assert.ok(finished, 'without waitUntil (npm start) the request waits for the mail');
});

test('a caller that asks too often is slowed down', async () => {
  configure();
  delete process.env.SMTP_PASSWORD;   // cheap path: the limit is checked before anything else
  let last;
  for (let i = 0; i < 62; i++) last = await call('login', {}, { ip: '192.0.2.77' });
  assert.equal(last.res.statusCode, 429);
  assert.ok(last.res.headers['Retry-After']);
});

/* ---------- wiring ---------- */

test('the endpoint is registered for the Worker, the Worker hands requests a waitUntil, and the page never sends an address', () => {
  const root = path.join(__dirname, '..');
  const registry = fs.readFileSync(path.join(root, 'cloudflare', 'api-registry.js'), 'utf8');
  assert.match(registry, /'customer-mail': \(\) => require\('\.\.\/api\/customer-mail\.js'\)/);
  const core = fs.readFileSync(path.join(root, 'cloudflare', 'worker-core.js'), 'utf8');
  assert.match(core, /req\.waitUntil = \(promise\) => ctx\.waitUntil\(promise\)/);
  const app = fs.readFileSync(path.join(root, 'app-core.js'), 'utf8');
  const fn = app.slice(app.indexOf('function mailEvent('), app.indexOf('\nfunction ', app.indexOf('function mailEvent(') + 10));
  assert.match(fn, /JSON\.stringify\(\{event:kind\}\)/, 'the body is the event name and nothing else');
});

test('the SMTP password and the app password never appear in the repository files that ship', () => {
  const root = path.join(__dirname, '..');
  for (const file of ['api/customer-mail.js', 'lib/mail-templates.js', 'lib/smtp.js', 'app-core.js']) {
    const text = fs.readFileSync(path.join(root, file), 'utf8');
    assert.ok(!/SMTP_PASSWORD\s*[:=]\s*['"][^'"]+['"]/.test(text), file + ' holds no password literal');
    assert.ok(!/console\.(log|error)\([^)]*pass/i.test(text), file + ' never logs a password');
  }
});
