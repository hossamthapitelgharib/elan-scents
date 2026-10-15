const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const handler = require(path.join(__dirname, '..', 'api', 'guest-cart'));
const activity = require(path.join(__dirname, '..', 'api', 'customer-activity'));

const userId = '45a6e52c-46c6-42e9-a730-9e5bec3dd201';
const savedFetch = global.fetch;
const savedEnv = { u: process.env.SUPABASE_URL, k: process.env.SUPABASE_SERVICE_ROLE_KEY };
test.after(() => { global.fetch = savedFetch; for (const [k, v] of [['SUPABASE_URL', savedEnv.u], ['SUPABASE_SERVICE_ROLE_KEY', savedEnv.k]]) v === undefined ? delete process.env[k] : process.env[k] = v; });
const reply = (data, status = 200) => new Response(JSON.stringify(data), { status, headers: { 'Content-Type': 'application/json' } });
const recorder = () => { const out = {}; return { out, status(n) { out.status = n; return this; }, setHeader() { return this; }, json(b) { out.body = b; return this; } }; };
let n = 0;
const key = () => `10000000-0000-4000-8000-${String(++n).padStart(12, '0')}`;
function env() { process.env.SUPABASE_URL = 'https://test.supabase.co'; process.env.SUPABASE_SERVICE_ROLE_KEY = 'service-key'; }

test('crawlers are not counted as visitors and never reach the database', async () => {
  env(); let touched = false;
  global.fetch = async () => { touched = true; return reply({}); };
  const res = recorder();
  await handler({ method: 'POST', headers: { 'user-agent': 'Mozilla/5.0 (compatible; Googlebot/2.1)', 'x-forwarded-for': '1.1.1.1' }, body: { action: 'resolve', visitorKey: key() } }, res);
  assert.equal(res.out.status, 200); assert.equal(res.out.body.bot, true); assert.equal(touched, false);
  const res2 = recorder();
  await activity({ method: 'POST', headers: { 'user-agent': 'Lighthouse' }, body: { action: 'session', sessionAction: 'start', visitorKey: key(), sessionId: key() } }, res2);
  assert.equal(res2.out.body.bot, true); assert.equal(touched, false);
});

test('many different shoppers behind one address are not blocked, one browser hammering is', async () => {
  env();
  global.fetch = async () => reply({ visitorId: 'v', status: 'guest', cart: [] });
  const ua = 'Mozilla/5.0 (iPhone) Safari';
  for (let i = 0; i < 80; i++) {
    const res = recorder();
    await handler({ method: 'POST', headers: { 'user-agent': ua, 'x-forwarded-for': '9.9.9.9' }, body: { action: 'resolve', visitorKey: key() } }, res);
    assert.equal(res.out.status, 200, `shopper ${i}`);
  }
  const one = key(); let blocked = 0;
  for (let i = 0; i < 40; i++) {
    const res = recorder();
    await handler({ method: 'POST', headers: { 'user-agent': ua, 'x-forwarded-for': '8.8.8.8' }, body: { action: 'resolve', visitorKey: one } }, res);
    if (res.out.status === 429) blocked++;
  }
  assert.ok(blocked > 0);
});

test('claim asks the database to drop the guest analytics and falls back to the old function until it is applied', async () => {
  env(); const rpcBodies = [];
  global.fetch = async (url, options = {}) => {
    const u = String(url);
    if (u.endsWith('/auth/v1/user')) return reply({ id: userId });
    rpcBodies.push(JSON.parse(options.body));
    return rpcBodies.length === 1 ? reply({ message: 'not found' }, 404) : reply({ claimed: true, cart: 1 });
  };
  const res = recorder();
  await handler({ method: 'POST', headers: { 'user-agent': 'Mozilla/5.0', authorization: 'Bearer t' }, body: { action: 'claim', visitorKey: key() } }, res);
  assert.equal(res.out.status, 200); assert.equal(res.out.body.claimed, true);
  assert.match(rpcBodies[0].p_analytics_hash, /^[a-f0-9]{64}$/);
  assert.equal('p_analytics_hash' in rpcBodies[1], false);
});
