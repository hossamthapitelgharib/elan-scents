const crypto = require('node:crypto');

// Constant-time string comparison. Both sides are hashed first so the length of the secret is not leaked either.
function safeEqual(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string' || !a || !b) return false;
  const left = crypto.createHash('sha256').update(a).digest();
  const right = crypto.createHash('sha256').update(b).digest();
  return crypto.timingSafeEqual(left, right);
}

// Fail-closed shared-secret check used by webhooks.
// Returns null when the request is allowed, otherwise { status, error } to send back.
//  - no secret configured on the server  -> 503 (never fall back to "open")
//  - missing or wrong secret in the request -> 401
function checkSecret(req, envName, headerName) {
  const expected = process.env[envName];
  if (!expected) return { status: 503, error: `${envName.toLowerCase()}_not_configured` };
  const header = req && req.headers ? req.headers[headerName] : '';
  if (!safeEqual(String(Array.isArray(header) ? header[0] : header || ''), expected)) {
    return { status: 401, error: 'invalid_webhook_secret' };
  }
  return null;
}

module.exports = { safeEqual, checkSecret };
