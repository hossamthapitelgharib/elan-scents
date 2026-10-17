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

test('requests that come from another website are refused', async () => {
  env(); let touched = false;
  global.fetch = async () => { touched = true; return reply({}); };
  const res = recorder();
  await handler({ method: 'POST', headers: { 'user-agent': 'Mozilla/5.0', 'sec-fetch-site': 'cross-site' }, body: { action: 'resolve', visitorKey: key() } }, res);
  assert.equal(res.out.status, 403); assert.equal(touched, false);
  const res2 = recorder();
  await activity({ method: 'POST', headers: { 'user-agent': 'Mozilla/5.0', 'sec-fetch-site': 'cross-site' }, body: { action: 'session', sessionAction: 'start', visitorKey: key(), sessionId: key() } }, res2);
  assert.equal(res2.out.status, 403); assert.equal(touched, false);
});

function headerRecorder() { const out = { headers: {} }; return { out, status(n) { out.status = n; return this; }, setHeader(k, v) { out.headers[k] = v; return this; }, json(b) { out.body = b; return this; } }; }

test('a first visit gets a long-lived server cookie holding its key', async () => {
  env(); global.fetch = async () => reply({ visitorId: 'v', status: 'guest', cart: [] });
  const k = key(), res = headerRecorder();
  await handler({ method: 'POST', headers: { 'user-agent': 'Mozilla/5.0', 'x-forwarded-proto': 'https' }, body: { action: 'resolve', visitorKey: k } }, res);
  assert.match(res.out.headers['Set-Cookie'], new RegExp(`^elan_gid=${k}; Max-Age=\\d+; Path=/; HttpOnly; SameSite=Lax; Secure`));
});

test('a browser that comes back with a different key is merged into the key the server already knows', async () => {
  env(); const known = key(), fresh = key(), calls = [];
  global.fetch = async (url, options = {}) => {
    const u = String(url); calls.push({ u, body: JSON.parse(options.body || '{}') });
    if (u.endsWith('/rpc/merge_guest_browser')) return reply({ merged: true, reason: 'merged' });
    return reply({ visitorId: 'v', status: 'guest', cart: [] });
  };
  const res = headerRecorder();
  await handler({ method: 'POST', headers: { 'user-agent': 'Mozilla/5.0', cookie: `elan_gid=${known}` }, body: { action: 'resolve', visitorKey: fresh } }, res);
  const merge = calls.find((c) => c.u.endsWith('/rpc/merge_guest_browser')).body;
  for (const k of ['p_from_fingerprint', 'p_to_fingerprint', 'p_from_analytics', 'p_to_analytics']) assert.match(merge[k], /^[a-f0-9]{64}$/);
  assert.notEqual(merge.p_from_fingerprint, merge.p_to_fingerprint);
  assert.equal(res.out.body.visitorKey, known);
  const resolveCall = calls.find((c) => c.u.endsWith('/rpc/resolve_guest_browser')).body;
  assert.equal(resolveCall.p_fingerprint_hash, merge.p_to_fingerprint);
  assert.equal(res.out.headers['Set-Cookie'], undefined);
});

test('if the merge is not available the browser keeps its own key, so nothing is lost', async () => {
  env(); const known = key(), fresh = key(), calls = [];
  global.fetch = async (url, options = {}) => {
    const u = String(url); calls.push({ u, body: JSON.parse(options.body || '{}') });
    if (u.endsWith('/rpc/merge_guest_browser')) return reply({ message: 'not found' }, 404);
    return reply({ visitorId: 'v', status: 'guest', cart: [] });
  };
  const res = headerRecorder();
  await handler({ method: 'POST', headers: { 'user-agent': 'Mozilla/5.0', cookie: `elan_gid=${known}` }, body: { action: 'resolve', visitorKey: fresh } }, res);
  assert.equal(res.out.status, 200); assert.equal(res.out.body.visitorKey, undefined);
  const merge = calls.find((c) => c.u.endsWith('/rpc/merge_guest_browser')).body;
  assert.equal(calls.find((c) => c.u.endsWith('/rpc/resolve_guest_browser')).body.p_fingerprint_hash, merge.p_from_fingerprint);
});

test('a new-guest request replaces the cookie and is never merged back into the previous person', async () => {
  env(); const old = key(), fresh = key(), calls = [];
  global.fetch = async (url, options = {}) => { calls.push(String(url)); return reply({ visitorId: 'v', status: 'guest', cart: [] }); };
  const res = headerRecorder();
  await handler({ method: 'POST', headers: { 'user-agent': 'Mozilla/5.0', cookie: `elan_gid=${old}`, 'x-forwarded-proto': 'https' }, body: { action: 'resolve', visitorKey: fresh, fresh: true } }, res);
  assert.match(res.out.headers['Set-Cookie'], new RegExp(`^elan_gid=${fresh};`));
  assert.equal(calls.some((u) => u.endsWith('/rpc/merge_guest_browser')), false);
});

const hex = (c, n = 64) => c.repeat(n);
const partsBody = { gpu: 'aaaaaaaa11', screen: 'bbbbbbbb22', canvas: 'cccccccc33', fonts: 'eeeeeeee55', tz: 'ffffffff66', hw: '1111111177', platform: '2222222288', lang: '3333333399' };
async function identifyRun(candidates, { storeOk = true, batchAvailable = true, headers = { 'user-agent': 'Mozilla/5.0 Chrome', 'accept-language': 'ar-EG', 'x-forwarded-for': '41.2.3.4' } } = {}) {
  env(); const calls = [];
  global.fetch = async (url, options = {}) => {
    const u = String(url), body = JSON.parse(options.body || '{}'); calls.push({ u, body });
    if (u.endsWith('/rpc/guest_signal_store')) return storeOk ? reply(true) : reply({}, 500);
    if (u.endsWith('/rpc/guest_signal_candidates')) return reply(candidates);
    if (u.endsWith('/rpc/guest_identity_link_many')) return batchAvailable ? reply((body.p_links || []).length) : reply({}, 404);
    if (u.endsWith('/rpc/guest_identity_link')) return reply(true);
    if (u.endsWith('/rpc/guest_final_id')) return reply(hex('9'));
    return reply({});
  };
  const res = headerRecorder();
  await handler({ method: 'POST', headers, body: { action: 'identify', visitorKey: key(), fp: hex('1', 32), parts: partsBody, behavior: { interactions: 5, activeSeconds: 30, pages: 3 } } }, res);
  return { res: res.out, calls };
}
const sameIp = async () => { const { createHmac } = require('node:crypto'); return createHmac('sha256', 'service-key').update('guest-ip:41.2.3.4').digest('hex'); };

test('identify stores hashed signals and links a very similar guest on the same network', async () => {
  const ipHash = await sameIp();
  const { res, calls } = await identifyRun([{ analyticsHash: hex('b'), fp: hex('1', 32), parts: partsBody, ipHash, ipPrefixHash: hex('0'), cartHash: null, lastSeenAt: new Date().toISOString(), popularity: 1, convertedUserIds: [] }]);
  assert.equal(res.status, 200); assert.equal(res.body.identified, true); assert.equal(res.body.linked, 1);
  assert.match(res.body.finalVisitorId, /^[a-f0-9]{32}$/);
  const store = calls.find((c) => c.u.endsWith('/rpc/guest_signal_store')).body;
  for (const k of ['p_ip_hash', 'p_ip_prefix_hash', 'p_ua_hash', 'p_lang_hash']) assert.match(store[k], /^[a-f0-9]{64}$/);
  assert.equal(JSON.stringify(store).includes('41.2.3.4'), false);
  assert.equal(JSON.stringify(store).includes('Chrome'), false);
});

test('identify batches several accepted links into one RPC instead of one request per candidate', async () => {
  const ipHash = await sameIp();
  const candidate = (digit) => ({ analyticsHash: hex(digit), fp: hex('1', 32), parts: partsBody, ipHash, ipPrefixHash: hex('0'), cartHash: null, lastSeenAt: new Date().toISOString(), popularity: 1, convertedUserIds: [] });
  const { res, calls } = await identifyRun([candidate('b'), candidate('c')]);
  const batchCalls = calls.filter((c) => c.u.endsWith('/rpc/guest_identity_link_many'));
  assert.equal(res.body.linked, 2);
  assert.equal(batchCalls.length, 1);
  assert.equal(batchCalls[0].body.p_links.length, 2);
  assert.equal(calls.some((c) => c.u.endsWith('/rpc/guest_identity_link')), false);
});

test('identify falls back to the existing per-link RPC until the batch migration is applied', async () => {
  const ipHash = await sameIp();
  const candidate = { analyticsHash: hex('b'), fp: hex('1', 32), parts: partsBody, ipHash, ipPrefixHash: hex('0'), cartHash: null, lastSeenAt: new Date().toISOString(), popularity: 1, convertedUserIds: [] };
  const { res, calls } = await identifyRun([candidate], { batchAvailable: false });
  assert.equal(res.body.linked, 1);
  assert.equal(calls.filter((c) => c.u.endsWith('/rpc/guest_identity_link_many')).length, 1);
  assert.equal(calls.filter((c) => c.u.endsWith('/rpc/guest_identity_link')).length, 1);
});

test('identify never links a guest that belongs to a different registered person', async () => {
  const ipHash = await sameIp();
  const { res, calls } = await identifyRun([{ analyticsHash: hex('b'), fp: hex('1', 32), parts: partsBody, ipHash, ipPrefixHash: hex('0'), cartHash: null, lastSeenAt: new Date().toISOString(), popularity: 1, convertedUserIds: ['u-1'] }]);
  assert.equal(res.body.linked, 0);
  assert.equal(calls.some((c) => c.u.endsWith('/rpc/guest_identity_link')), false);
});

test('identify never links on a common device or without network support', async () => {
  const ipHash = await sameIp();
  const common = await identifyRun([{ analyticsHash: hex('b'), fp: hex('1', 32), parts: partsBody, ipHash, ipPrefixHash: hex('0'), popularity: 9, convertedUserIds: [], lastSeenAt: new Date().toISOString() }]);
  assert.equal(common.res.body.linked, 0);
  const elsewhere = await identifyRun([{ analyticsHash: hex('b'), fp: hex('1', 32), parts: partsBody, ipHash: hex('d'), ipPrefixHash: hex('e'), popularity: 1, convertedUserIds: [], lastSeenAt: new Date().toISOString() }]);
  assert.equal(elsewhere.res.body.linked, 0);
});

test('identify does not hash the shared unknown-IP placeholder or link without a usable address', async () => {
  const { res, calls } = await identifyRun([{
    analyticsHash: hex('b'), fp: hex('1', 32), parts: partsBody,
    ipHash: await (async () => { const { createHmac } = require('node:crypto'); return createHmac('sha256', 'service-key').update('guest-ip:unknown').digest('hex'); })(),
    ipPrefixHash: null, cartHash: null, lastSeenAt: new Date().toISOString(), popularity: 1, convertedUserIds: []
  }], { headers: { 'user-agent': 'Mozilla/5.0 Chrome', 'accept-language': 'ar-EG' } });
  const store = calls.find((c) => c.u.endsWith('/rpc/guest_signal_store')).body;
  assert.equal(store.p_ip_hash, null);
  assert.equal(store.p_ip_prefix_hash, null);
  assert.equal(res.body.linked, 0);
  assert.equal(calls.some((c) => c.u.endsWith('/rpc/guest_identity_link')), false);
});

test('a failing database never breaks the shopper: identify just reports not identified', async () => {
  const { res } = await identifyRun([], { storeOk: false });
  assert.equal(res.status, 200); assert.equal(res.body.identified, false);
});
