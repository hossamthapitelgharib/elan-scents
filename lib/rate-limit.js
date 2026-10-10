// Small fixed-window rate limiter for public endpoints.
// Best effort by design: the counters live in the memory of one server instance, so on serverless hosts each warm
// instance counts separately. It stops a single client from hammering an endpoint; it is not a replacement for a
// shared (edge/firewall) limit if the site is ever attacked at scale.
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

// First address of X-Forwarded-For (set by Vercel/Railway proxies), then X-Real-IP, then the socket address.
function clientIp(req) {
  const headers = (req && req.headers) || {};
  const forwarded = String(headers['x-forwarded-for'] || '').split(',')[0].trim();
  const real = String(headers['x-real-ip'] || '').trim();
  const socket = (req && req.socket && req.socket.remoteAddress) || '';
  return (forwarded || real || socket || 'unknown').slice(0, 64);
}

module.exports = { createLimiter, clientIp };
