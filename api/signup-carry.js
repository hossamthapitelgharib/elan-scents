'use strict';

const { authenticateCustomer, callCustomerRpc } = require('../lib/customer-rpc');
const { createDistributedLimiter, clientIp, setRateLimitHeaders } = require('../lib/rate-limit');

/* The cart and hearts of the browser where an account was created, carried to the account (owner's decision, 9 Nov 2026).
   The confirmation link is often opened in another browser than the one the customer registered in, and a browser's lists live in that
   browser only. So right after sign-up, while the e-mail is still unconfirmed, the page of the registering browser sends its lists here
   (`stash`), and the browser that confirms the account takes them (`claim`):
     stash -> no token (the account cannot sign in before it is confirmed); the only key is the account's id, which only the browser that
              registered it ever receives. The database re-reads every line against the real catalog and accepts it only for an unconfirmed
              customer account younger than a day (public.stash_signup_carry), so a wrong, old or confirmed id stores nothing. The answer is
              the same whatever the database decided: nothing here tells a caller whether an id exists.
     claim -> the account's own token; the lists move into the account once, quantities merged by the larger value, never the sum
              (public.claim_signup_carry). The answer carries the counts only.
   Both database functions are callable by the server alone. See docs/handoff.ar.md. */

const stashLimiter = createDistributedLimiter({ name: 'signup-carry-stash', max: 10, windowMs: 60 * 1000 });
const claimLimiter = createDistributedLimiter({ name: 'signup-carry-claim', max: 30, windowMs: 60 * 1000 });

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const MAX_BYTES = 24000;
const MAX_CART_LINES = 100;
const MAX_FAVS = 200;

function reply(res, status, body) {
  res.setHeader('Cache-Control', 'no-store');
  return res.status(status).setHeader('Content-Type', 'application/json').json(body);
}

/* Only the three fields the database reads are kept; anything else a caller adds is dropped before it travels further. */
function cleanCart(input) {
  if (!Array.isArray(input)) return [];
  return input.slice(0, MAX_CART_LINES)
    .filter((row) => row && typeof row === 'object' && !Array.isArray(row))
    .map((row) => ({ sid: row.sid, storeProductId: row.storeProductId, q: row.q ?? row.quantity }));
}
function cleanFavs(input) {
  if (!Array.isArray(input)) return [];
  return input.slice(0, MAX_FAVS).filter((id) => typeof id === 'string' && UUID.test(id));
}

async function stash(req, res, body) {
  const userId = typeof body.userId === 'string' ? body.userId : '';
  if (!UUID.test(userId)) return reply(res, 400, { ok: false, error: 'invalid_request' });
  const limit = await stashLimiter(clientIp(req));
  if (!limit.allowed) { setRateLimitHeaders(res, limit, 10); return reply(res, 429, { ok: false, error: 'rate_limited' }); }
  const cart = cleanCart(body.cart);
  const favs = cleanFavs(body.favs);
  // Nothing to carry: answer like any other call, without touching the database.
  if (!cart.length && !favs.length) return reply(res, 200, { ok: true });
  const supabaseUrl = process.env.SUPABASE_URL || process.env.NEXT_PUBLIC_SUPABASE_URL;
  const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_SECRET_KEY;
  if (!supabaseUrl || !serviceRoleKey) return reply(res, 503, { ok: false, error: 'signup_carry_unavailable' });
  try {
    const result = await callCustomerRpc({ supabaseUrl, serviceRoleKey }, 'stash_signup_carry', { p_user_id: userId, p_cart: cart, p_favs: favs });
    if (!result.ok) return reply(res, 502, { ok: false, error: 'signup_carry_failed' });
  } catch (_) {
    return reply(res, 502, { ok: false, error: 'signup_carry_failed' });
  }
  return reply(res, 200, { ok: true });
}

async function claim(req, res) {
  const limit = await claimLimiter(clientIp(req));
  if (!limit.allowed) { setRateLimitHeaders(res, limit, 30); return reply(res, 429, { ok: false, error: 'rate_limited' }); }
  const context = await authenticateCustomer(req);
  if (context.error) return reply(res, context.status, { ok: false, error: context.error });
  try {
    const result = await callCustomerRpc(context, 'claim_signup_carry', { p_user_id: context.user.id });
    if (!result.ok) return reply(res, 502, { ok: false, error: 'signup_carry_failed' });
    const data = result.data && typeof result.data === 'object' ? result.data : {};
    return reply(res, 200, { ok: true, claimed: data.claimed === true, cart: Number(data.cart) || 0, favs: Number(data.favs) || 0 });
  } catch (_) {
    return reply(res, 502, { ok: false, error: 'signup_carry_failed' });
  }
}

module.exports = async function signupCarry(req, res) {
  if (req.method !== 'POST') return reply(res, 405, { ok: false, error: 'method_not_allowed' });
  if (Buffer.byteLength(JSON.stringify(req.body || {})) > MAX_BYTES) return reply(res, 413, { ok: false, error: 'payload_too_large' });
  if (String((req.headers && req.headers['sec-fetch-site']) || '') === 'cross-site') return reply(res, 403, { ok: false, error: 'cross_site_not_allowed' });
  const body = req.body && typeof req.body === 'object' ? req.body : {};
  if (body.action === 'stash') return stash(req, res, body);
  if (body.action === 'claim') return claim(req, res);
  return reply(res, 400, { ok: false, error: 'unknown_action' });
};
