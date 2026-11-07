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
  const user = Object.assign({ id: USER, email: 'buyer@example.invalid', email_confirmed_at: '2026-10-01T00:00:00Z', created_at: new Date(Date.now() - 60 * 60 * 1000).toISOString() }, world.user);
  const profile = Object.assign({ id: USER, role: 'customer', full_name: 'Test Buyer' }, world.profile);
  const claims = Object.assign({ welcome: true, registered: true }, world.claims);
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

test('the two mails carry the owner\'s wording, in Arabic, as text and as right-to-left HTML', () => {
  const welcome = templates.welcome();
  assert.match(welcome.text, /أهلًا ومرحبًا بك ونتمنى لك رحلة تسويقية ممتعة/);
  assert.match(welcome.html, /dir="rtl"/);
  assert.match(welcome.html, /أهلًا ومرحبًا بك ونتمنى لك رحلة تسويقية ممتعة/);
  assert.ok(welcome.subject);
  assert.equal(templates.goodbye, undefined, 'there is no goodbye mail any more');
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

test('only POST, only the two known events (no goodbye event), and only with a signed-in customer', async () => {
  assert.equal((await call('login', {}, { method: 'GET' })).res.statusCode, 405);
  assert.equal((await call('promo')).res.statusCode, 400);
  const goodbye = await call('logout');
  assert.equal(goodbye.res.statusCode, 400, 'signing out asks for nothing');
  assert.equal(goodbye.log.sent.length + goodbye.log.rpc.length, 0);
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
  const { log } = await call('registered');
  assert.ok(log.sent.length >= 1);
  assert.ok(log.sent.every((m) => m.pass === 'abcdefghijklmnop'), 'the spaces are not sent to the mail server');
  configure({ SMTP_PASSWORD: '   ' });
  const blank = await call('registered');
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

/* ---------- the welcome ---------- */

test('a new account is welcomed once, at the account\'s own address, from the shop mailbox', async () => {
  const { res, log } = await call('registered');
  assert.equal(res.statusCode, 202);
  assert.deepEqual(res.body, { ok: true, sent: true, queued: true });
  const welcome = log.sent.find((m) => m.to === 'buyer@example.invalid');
  assert.ok(welcome, 'the customer gets the welcome');
  assert.equal(welcome.from.address, 'shop@example.invalid');
  assert.equal(welcome.from.name, 'Élan Scents');
  assert.equal(welcome.host, 'smtp.gmail.com');
  assert.equal(welcome.port, 465);
  assert.match(welcome.text, /رحلة تسويقية ممتعة/);
  assert.deepEqual(log.rpc.map((r) => r.p_kind).sort(), ['registered', 'welcome']);
  assert.ok(log.rpc.every((r) => r.p_min_interval === '100 years'), 'both are once per account, for good');
});

test('the welcome is never repeated: a second report of the same account sends nothing', async () => {
  const { res, log } = await call('registered', { claims: { welcome: false, registered: false } });
  assert.equal(res.statusCode, 200);
  assert.deepEqual(res.body, { ok: true, sent: false, reason: 'already_sent' });
  assert.equal(log.sent.length, 0);
});

test('signing in again later sends nothing: an older account asks for nothing and touches nothing', async () => {
  const { res, log } = await call('login', { user: { created_at: '2025-01-01T00:00:00Z' } });
  assert.equal(res.statusCode, 200);
  assert.deepEqual(res.body, { ok: true, sent: false, reason: 'not_new_account' });
  assert.equal(log.sent.length + log.rpc.length, 0, 'no mail and no slot');
  const noDate = await call('login', { user: { created_at: '' } });
  assert.equal(noDate.res.body.reason, 'not_new_account');
});

test('the recipient is the token\'s own account: addresses in the request are ignored', async () => {
  const { log } = await call('registered', {}, { body: { event: 'registered', to: 'victim@example.invalid', email: 'victim@example.invalid', recipient: 'victim@example.invalid', user_id: 'e0000000-0000-4000-8000-0000000000e1' } });
  assert.deepEqual(log.sent.map((m) => m.to).sort(), ['buyer@example.invalid', 'platform@example.invalid']);
  assert.ok(log.rpc.every((r) => r.p_user_id === USER));
});

/* ---------- the platform notice ---------- */

test('a confirmed new account tells the platform mailbox once, with when it registered and when it confirmed', async () => {
  const { res, log } = await call('registered', { user: { created_at: '2026-11-03T11:02:45.747505+00:00', email_confirmed_at: '2026-11-03T11:03:11.652864+00:00' } });
  assert.equal(res.statusCode, 202);
  const notice = log.sent.find((m) => m.to === 'platform@example.invalid');
  assert.ok(notice, 'the platform mailbox is told');
  assert.equal(log.sent.filter((m) => m.to === 'platform@example.invalid').length, 1, 'once');
  assert.match(notice.text, /Test Buyer/);
  assert.match(notice.text, /buyer@example\.invalid/);
  assert.match(notice.text, /تاريخ ووقت التسجيل: .*3 نوفمبر 2026 في 1:02 م \(توقيت القاهرة\)/, 'the registration time, in Cairo time');
  assert.match(notice.text, /تاريخ ووقت تأكيد البريد: .*3 نوفمبر 2026 في 1:03 م \(توقيت القاهرة\)/, 'and the confirmation time');
  assert.match(notice.html, /1:02 م/);
  assert.equal(log.rpc.find((r) => r.p_kind === 'registered').p_min_interval, '100 years');

  const again = await call('registered', { claims: { registered: false, welcome: false } });
  assert.equal(again.log.sent.length, 0, 'a second report of the same account sends nothing');
  assert.equal(again.res.body.reason, 'already_sent');
});

test('the registration time is the last confirmation request: a customer who tried several times is not shown the time of his first attempt', async () => {
  const { log } = await call('registered', { user: { created_at: '2026-11-07T10:24:13.170558+00:00', confirmation_sent_at: '2026-11-07T15:10:12.166453+00:00', email_confirmed_at: '2026-11-07T15:10:43.377287+00:00' } });
  const notice = log.sent.find((m) => m.to === 'platform@example.invalid');
  assert.match(notice.text, /تاريخ ووقت التسجيل: .*7 نوفمبر 2026 في 5:10 م/, 'the attempt whose link he opened');
  assert.match(notice.text, /تاريخ ووقت تأكيد البريد: .*7 نوفمبر 2026 في 5:10 م/);
  assert.doesNotMatch(notice.text, /12:24/);
});

test('without a platform address the customer is still welcomed and the notice\'s slot stays free', async () => {
  configure({ PLATFORM_NOTIFY_EMAIL: '' });
  const { res, log } = await call('registered');
  assert.equal(res.statusCode, 202);
  assert.deepEqual(log.sent.map((m) => m.to), ['buyer@example.invalid']);
  assert.deepEqual(log.rpc.map((r) => r.p_kind), ['welcome'], 'the notice is not claimed, so it can still go out once the address is set');
});

test('the first sign-in of a young account does what the confirmation would have done (the link may have been opened elsewhere)', async () => {
  const { log } = await call('login');
  assert.deepEqual(log.sent.map((m) => m.to).sort(), ['buyer@example.invalid', 'platform@example.invalid']);
  assert.deepEqual(log.rpc.map((r) => r.p_kind).sort(), ['registered', 'welcome']);
});

test('what an account already received is not sent again, whichever way it is asked for', async () => {
  const welcomedOnly = await call('login', { claims: { welcome: false } });
  assert.deepEqual(welcomedOnly.log.sent.map((m) => m.to), ['platform@example.invalid']);
  const reportedOnly = await call('login', { claims: { registered: false } });
  assert.deepEqual(reportedOnly.log.sent.map((m) => m.to), ['buyer@example.invalid']);
});

test('a database hiccup on the second slot does not lose the mail whose slot was already taken', async () => {
  const { res, log } = await call('registered', { claimFailsFor: 'welcome' });
  assert.equal(res.statusCode, 202);
  assert.deepEqual(log.sent.map((m) => m.to), ['platform@example.invalid']);
});

/* ---------- failures ---------- */

test('a mail that could not be sent gives its slot back so the next attempt can try, and the answer never shows the reason', async () => {
  const { res, log } = await call('registered', { sendFails: true });
  assert.equal(res.statusCode, 202, 'the page is not told about a mail problem');
  assert.deepEqual(log.released.sort(), ['registered', 'welcome']);
  assert.ok(!JSON.stringify(res.body).includes('smtp'));
});

test('if the database memory is unavailable nothing is sent, and the answer is a plain error', async () => {
  const { res, log } = await call('registered', { claimFails: true });
  assert.equal(res.statusCode, 502);
  assert.deepEqual(res.body, { ok: false, error: 'customer_mail_failed' });
  assert.equal(log.sent.length, 0, 'no memory, no mail: it could repeat on every click');
});

test('the send runs after the answer when the platform allows it (waitUntil), and inside the request otherwise', async () => {
  let started = false, finished = false;
  global.fetch = async (url) => ({ ok: true, json: async () => (String(url).endsWith('/auth/v1/user') ? { id: USER, email: 'buyer@example.invalid', email_confirmed_at: 'x', created_at: new Date().toISOString() } : String(url).includes('/profiles') ? [{ id: USER, role: 'customer' }] : true) });
  smtp.sendMail = async () => { started = true; await new Promise((resolve) => setTimeout(resolve, 30)); finished = true; };
  const mk = () => ({ statusCode: 0, setHeader() { return this; }, status(code) { this.statusCode = code; return this; }, json() { return this; } });
  const headers = () => ({ authorization: 'Bearer t', 'x-real-ip': `203.0.113.${++ipCounter % 250}` });
  let kept;
  await handler({ method: 'POST', headers: headers(), body: { event: 'registered' }, waitUntil: (p) => { kept = p; } }, mk());
  assert.ok(kept, 'the work was handed to waitUntil');
  assert.equal(finished, false, 'the answer did not wait for the mail');
  await kept;
  assert.ok(started && finished);
  started = finished = false;
  await handler({ method: 'POST', headers: headers(), body: { event: 'registered' } }, mk());
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
