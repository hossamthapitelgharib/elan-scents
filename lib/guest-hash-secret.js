/* The key used to turn guest identifiers (browser key, IP, user agent...) into the irreversible hashes that are stored.
   It used to be the Supabase service-role key, which tied two unrelated things together: rotating the database key
   (which should be routine after any leak) silently changed every guest hash and cut every guest from their history,
   and anyone holding the database key could also re-derive guest hashes from raw identifiers.

   GUEST_HASH_SECRET (at least 16 characters) now takes over when it is set. When it is not set the old key is used,
   so nothing changes until the owner opts in. To keep all existing guest history, set GUEST_HASH_SECRET to the value
   the service-role key has today BEFORE rotating that key; a different value starts every guest from scratch. */
const MIN_LENGTH = 16;

function guestHashSecret(env = process.env) {
  const own = String(env.GUEST_HASH_SECRET || '').trim();
  if (own.length >= MIN_LENGTH) return own;
  return String(env.SUPABASE_SERVICE_ROLE_KEY || env.SUPABASE_SECRET_KEY || '');
}

module.exports = { guestHashSecret, MIN_LENGTH };
