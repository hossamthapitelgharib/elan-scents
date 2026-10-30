const { getContext, requireRoles } = require('./_auth');

/* Platform admin only: the platform audit log, newest first.
     GET /api/platform-audit-log[?limit=50&offset=0]
   Read through the service-role function platform_audit_entries (actor email, store name, the email of the account the
   action was about). Only the detail keys listed in DETAIL_KEYS leave the server, so a future action that stores
   something else in `details` does not reach the browser until it is listed here. */

const DETAIL_KEYS = { previous_role: 'previousRole', role_back_to_customer: 'roleBackToCustomer' };

function reply(res, status, body) {
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('Content-Type', 'application/json');
  return res.status(status).json(body);
}

function integerQuery(value, fallback, min, max) {
  if (value === undefined || value === null || value === '') return fallback;
  const number = Number(Array.isArray(value) ? value[0] : value);
  return Number.isSafeInteger(number) && number >= min && number <= max ? number : null;
}

function entryView(row) {
  const details = row && row.details && typeof row.details === 'object' && !Array.isArray(row.details) ? row.details : {};
  const detail = {};
  for (const [key, name] of Object.entries(DETAIL_KEYS)) {
    if (typeof details[key] === 'string' || typeof details[key] === 'boolean') detail[name] = details[key];
  }
  return {
    id: row.id,
    createdAt: row.created_at,
    action: row.action,
    targetType: row.target_type,
    targetId: row.target_id || null,
    actorEmail: row.actor_email || '',
    storeId: row.store_id || null,
    storeName: row.store_name || '',
    subjectEmail: row.subject_email || '',
    detail
  };
}

module.exports = async function platformAuditLog(req, res) {
  if (req.method !== 'GET') return reply(res, 405, { ok: false, error: 'method_not_allowed' });
  try {
    const context = requireRoles(await getContext(req), ['platform_admin']);
    if (context.error) return reply(res, context.status, { ok: false, error: context.error });
    const query = req.query || {};
    const limit = integerQuery(query.limit, 50, 1, 100);
    const offset = integerQuery(query.offset, 0, 0, 1000000);
    if (limit === null || offset === null) return reply(res, 400, { ok: false, error: 'invalid_page' });

    const response = await fetch(`${context.supabaseUrl}/rest/v1/rpc/platform_audit_entries`, {
      method: 'POST',
      headers: { apikey: context.serviceRoleKey, Authorization: `Bearer ${context.serviceRoleKey}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ p_limit: limit + 1, p_offset: offset })
    });
    let rows = null;
    try { rows = await response.json(); } catch (_) { rows = null; }
    if (!response.ok || !Array.isArray(rows)) return reply(res, 502, { ok: false, error: 'audit_log_unavailable' });
    return reply(res, 200, { ok: true, entries: rows.slice(0, limit).map(entryView), limit, offset, hasMore: rows.length > limit });
  } catch (_) {
    return reply(res, 502, { ok: false, error: 'audit_log_unavailable' });
  }
};
