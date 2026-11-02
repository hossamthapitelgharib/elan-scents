// Small fixed-window rate limiter for public endpoints.
// createLimiter remains synchronous for the single-process/Cloudflare path. Async handlers should use
// createDistributedLimiter when a shared backend is configured. Production can
// require the atomic Supabase RPC; local single-process development stays local.
const { config: stateStoreConfig, incrementWindow } = require('./state-store');
function createLimiter({ max, windowMs, now = Date.now, maxKeys = 10000 }) {
  const hits = new Map();
  return function check(key) {
    const t = now();
    let entry = hits.get(key);
    if (!entry || t >= entry.resetAt) {
      if (hits.size >= maxKeys) {
        for (const [k, v] of hits) if (t >= v.resetAt) hits.delete(k);
        if (hits.size >= maxKeys) hits.clear();
      }
      entry = { count: 0, resetAt: t + windowMs };
      hits.set(key, entry);
    }
    entry.count += 1;
    return {
      allowed: entry.count <= max,
      remaining: Math.max(0, max - entry.count),
      retryAfter: Math.max(1, Math.ceil((entry.resetAt - t) / 1000))
    };
  };
}

function createDistributedLimiter({ name, max, windowMs, maxKeys = 10000 }) {
  if (!name || !Number.isInteger(max) || !Number.isInteger(windowMs)) throw new Error('invalid_distributed_limiter');
  const local = createLimiter({ max, windowMs, maxKeys });
  return async function check(key) {
    if (!stateStoreConfig()) {
      if (process.env.STATE_STORE_REQUIRED === '1') return { allowed: false, remaining: 0, retryAfter: Math.max(1, Math.ceil(windowMs / 1000)), unavailable: true };
      return local(key);
    }
    const now = Date.now();
    const bucket = Math.floor(now / windowMs);
    const redisKey = `elan:ratelimit:${name}:${String(key).slice(0, 160)}:${bucket}`;
    try {
      const result = await incrementWindow(redisKey, windowMs);
      return { allowed: result.count <= max, remaining: Math.max(0, max - result.count), retryAfter: Math.max(1, Math.ceil(result.ttlMs / 1000)) };
    } catch (error) {
      if (process.env.STATE_STORE_REQUIRED === '1') return { allowed: false, remaining: 0, retryAfter: 1, unavailable: true };
      if (!createDistributedLimiter.warned) {
        createDistributedLimiter.warned = true;
        console.error('shared state unavailable; using process-local rate limits', error && error.message);
      }
      return local(key);
    }
  };
}

// Address of the caller. On Cloudflare the Worker (cloudflare/worker-core.js makeRequest) drops any X-Forwarded-For the caller
// sent and sets X-Real-IP from Cloudflare's own CF-Connecting-IP, which a caller cannot choose, so X-Real-IP is the value to
// trust. X-Forwarded-For (first address) and the socket address are only fallbacks for the local Node host (npm start).
function clientIp(req) {
  const headers = (req && req.headers) || {};
  const real = String(headers['x-real-ip'] || '').trim();
  const forwarded = String(headers['x-forwarded-for'] || '').split(',')[0].trim();
  const socket = (req && req.socket && req.socket.remoteAddress) || '';
  return (real || forwarded || socket || 'unknown').slice(0, 64);
}

function setRateLimitHeaders(res, result, max) {
  if (!res || !result) return;
  if (Number.isFinite(max)) res.setHeader('X-RateLimit-Limit', String(max));
  if (Number.isFinite(result.remaining)) res.setHeader('X-RateLimit-Remaining', String(result.remaining));
  if (Number.isFinite(result.retryAfter)) res.setHeader('Retry-After', String(result.retryAfter));
}

module.exports = { createLimiter, createDistributedLimiter, clientIp, setRateLimitHeaders };
