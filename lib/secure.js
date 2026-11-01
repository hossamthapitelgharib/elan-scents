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

// What a caller may learn from a failed database call. Our own functions reject bad input with RAISE EXCEPTION (SQLSTATE P0001) and
// write the message for people ("Order item does not belong to the specified request"), so that one message is passed on. Every other
// failure (a constraint, a missing column, a permission error, a timeout) names tables and columns, so the caller only gets the code.
function publicDatabaseError(result) {
  if (!result || typeof result !== 'object' || Array.isArray(result)) return undefined;
  const code = typeof result.code === 'string' ? result.code.slice(0, 8) : undefined;
  if (code === 'P0001' && typeof result.message === 'string') return { code, message: result.message.slice(0, 200) };
  return code ? { code } : undefined;
}

module.exports = { safeEqual, checkSecret, publicDatabaseError };
