// Small fixed-window rate limiter for public endpoints.
// Best effort by design: counters live in this Railway process. This stops a single client from
// hammering an endpoint; it is not a replacement for a shared firewall limit during a large attack.
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

// Client address behind Railway. Railway documents X-Real-IP as the header that identifies the client's remote IP and the
// edge sets it itself, so it is the only value a caller cannot choose. X-Forwarded-For is only a fallback (first address,
// the usual convention) for hosts that do not send X-Real-IP, then the socket address.
function clientIp(req) {
  const headers = (req && req.headers) || {};
  const real = String(headers['x-real-ip'] || '').trim();
  const forwarded = String(headers['x-forwarded-for'] || '').split(',')[0].trim();
  const socket = (req && req.socket && req.socket.remoteAddress) || '';
  return (real || forwarded || socket || 'unknown').slice(0, 64);
}

module.exports = { createLimiter, clientIp };
