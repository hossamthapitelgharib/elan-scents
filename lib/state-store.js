'use strict';

/* Optional shared state for multi-instance deployments.
 * Configure STATE_STORE_URL and STATE_STORE_TOKEN with an Upstash/Redis REST endpoint.
 * No credentials means the caller can use its documented process-local fallback.
 */
function config(env = process.env) {
  const url = String(env.STATE_STORE_URL || '').trim().replace(/\/$/, '');
  const token = String(env.STATE_STORE_TOKEN || '').trim();
  return url && token ? { url, token } : null;
}

async function command(commands, env = process.env) {
  const cfg = config(env);
  if (!cfg) throw new Error('state_store_not_configured');
  const response = await fetch(cfg.url + '/pipeline', {
    method: 'POST',
    headers: { Authorization: 'Bearer ' + cfg.token, 'Content-Type': 'application/json' },
    body: JSON.stringify(commands)
  });
  if (!response.ok) throw new Error('state_store_http_' + response.status);
  const result = await response.json();
  if (!Array.isArray(result)) throw new Error('state_store_invalid_response');
  return result.map((item) => item && item.result);
}

async function incrementWindow(key, windowMs, env = process.env) {
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
