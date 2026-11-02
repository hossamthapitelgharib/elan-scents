'use strict';

const { createHmac } = require('node:crypto');

/* Shared rate-limit state. Redis remains supported; production can use the atomic
 * Supabase RPC when STATE_STORE_REQUIRED=1, without adding another paid service.
 * The Supabase backend stores only HMAC digests of endpoint/client/window keys. */
function config(env = process.env) {
  const url = String(env.STATE_STORE_URL || '').trim().replace(/\/$/, '');
  const token = String(env.STATE_STORE_TOKEN || '').trim();
  if (url && token) return { provider: 'upstash', url, token };

  if (String(env.STATE_STORE_REQUIRED || '') === '1') {
    const supabaseUrl = String(env.SUPABASE_URL || '').trim().replace(/\/$/, '');
    const serviceRoleKey = String(env.SUPABASE_SERVICE_ROLE_KEY || '').trim();
    if (supabaseUrl && serviceRoleKey) return { provider: 'supabase', url: supabaseUrl, token: serviceRoleKey };
  }
  return null;
}

async function command(commands, env = process.env) {
  const cfg = config(env);
  if (!cfg || cfg.provider !== 'upstash') throw new Error('state_store_not_configured');
  const response = await fetch(cfg.url + '/pipeline', {
    method: 'POST',
    headers: { Authorization: 'Bearer ' + cfg.token, 'Content-Type': 'application/json' },
    signal: AbortSignal.timeout(3000),
    body: JSON.stringify(commands)
  });
  if (!response.ok) throw new Error('state_store_http_' + response.status);
  const result = await response.json();
  if (!Array.isArray(result)) throw new Error('state_store_invalid_response');
  return result.map((item) => item && item.result);
}

async function incrementWindow(key, windowMs, env = process.env) {
  const cfg = config(env);
  if (!cfg) throw new Error('state_store_not_configured');
  if (!Number.isInteger(windowMs) || windowMs < 1000 || windowMs > 86400000) throw new Error('state_store_invalid_window');

  if (cfg.provider === 'supabase') {
    const bucket = Math.floor(Date.now() / windowMs);
    const digest = createHmac('sha256', cfg.token).update(String(key)).update('\0').update(String(bucket)).digest('hex');
    const response = await fetch(cfg.url + '/rest/v1/rpc/consume_edge_rate_limit', {
      method: 'POST',
      headers: {
        apikey: cfg.token,
        Authorization: 'Bearer ' + cfg.token,
        'Content-Type': 'application/json'
      },
      signal: AbortSignal.timeout(3000),
      body: JSON.stringify({ p_bucket_key: digest, p_window_ms: windowMs })
    });
    if (!response.ok) throw new Error('state_store_http_' + response.status);
    const raw = await response.json();
    const result = Array.isArray(raw) ? raw[0] : raw;
    const count = Number(result && result.count);
    const ttlMs = Number(result && result.ttlMs);
    if (!Number.isSafeInteger(count) || count < 1 || !Number.isFinite(ttlMs) || ttlMs < 1) {
      throw new Error('state_store_invalid_response');
    }
    return { count, ttlMs };
  }

  const [count, ttl] = await command([
    ['INCR', key],
    ['PTTL', key]
  ], env);
  const n = Number(count);
  if (!Number.isFinite(n)) throw new Error('state_store_invalid_count');
  if (n === 1 || Number(ttl) < 0) {
    await command([['PEXPIRE', key, String(windowMs)]], env);
  }
  const remainingTtl = n === 1 ? windowMs : Math.max(1, Number(ttl));
  return { count: n, ttlMs: remainingTtl };
}

module.exports = { config, command, incrementWindow };
