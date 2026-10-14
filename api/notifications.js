const { getContext, requireRoles } = require('./_auth');
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const STORE_ACCOUNT_PAGE = 500;
const MAX_OFFSET = 1000000;
function reply(res, status, body) { res.setHeader('Cache-Control', 'no-store'); res.status(status).setHeader('Content-Type', 'application/json').json(body); }
function visibleNotification(row) {
  return { id: row.id, title: row.title, body: row.body, is_read: !!row.is_read, created_at: row.created_at };
}
function storeScope(userId, ids) {
  const safeIds = ids.length ? ids.join(',') : '00000000-0000-0000-0000-000000000000';
  return `(user_id.eq.${userId},store_id.in.(${safeIds}))`;
}
module.exports = async function notifications(req, res) {
  if (req.method !== 'GET' && req.method !== 'PATCH') return reply(res, 405, { ok: false, error: 'method_not_allowed' });
  try {
    const context = requireRoles(await getContext(req), ['customer', 'store_admin', 'platform_admin']);
    if (context.error) return reply(res, context.status, { ok: false, error: context.error });
    const headers = { apikey: context.serviceRoleKey, Authorization: `Bearer ${context.serviceRoleKey}`, 'Content-Type': 'application/json' };
    if (req.method === 'PATCH') {
      const id = req.body && req.body.id;
      if (!UUID.test(String(id || ''))) return reply(res, 400, { ok: false, error: 'notification_id_required' });
      const params = new URLSearchParams({ id: `eq.${id}` });
      if (context.profile.role === 'platform_admin') params.set('recipient_role', 'eq.platform_admin');
      else if (context.profile.role === 'store_admin') params.set('or', storeScope(context.user.id, await storeIds(context)));
      else params.set('user_id', `eq.${context.user.id}`);
      const response = await fetch(`${context.supabaseUrl}/rest/v1/notifications?${params}`, { method: 'PATCH', headers: { ...headers, Prefer: 'return=minimal' }, body: JSON.stringify({ is_read: true, read_at: new Date().toISOString() }) });
      if (!response.ok) return reply(res, 502, { ok: false, error: 'notification_update_failed' });
      return reply(res, 200, { ok: true });
    }
    const limit = Math.min(Math.max(Number((req.query || {}).limit) || 50, 1), 100);
    const params = new URLSearchParams({ select: 'id,title,body,is_read,created_at', order: 'created_at.desc', limit: String(limit) });
    if ((req.query || {}).unread === '1') params.set('is_read', 'eq.false');
    if (context.profile.role === 'platform_admin') params.set('recipient_role', 'eq.platform_admin');
    else if (context.profile.role === 'store_admin') {
      const ids = await storeIds(context);
      params.set('or', storeScope(context.user.id, ids));
    } else params.set('user_id', `eq.${context.user.id}`);
    const response = await fetch(`${context.supabaseUrl}/rest/v1/notifications?${params}`, { headers });
    const data = await response.json();
    if (!response.ok || !Array.isArray(data)) return reply(res, 502, { ok: false, error: 'notification_read_failed' });
    reply(res, 200, { ok: true, notifications: data.map(visibleNotification) });
  } catch (_) { reply(res, 502, { ok: false, error: 'notification_api_failed' }); }
};
async function storeIds(context) {
  const ids = new Set();
  const headers = { apikey: context.serviceRoleKey, Authorization: `Bearer ${context.serviceRoleKey}` };
  for (let offset = 0; offset <= MAX_OFFSET; offset += STORE_ACCOUNT_PAGE) {
    const params = new URLSearchParams({ select: 'store_id', user_id: `eq.${context.user.id}`, order: 'created_at.asc,id.asc', limit: String(STORE_ACCOUNT_PAGE), offset: String(offset) });
    const response = await fetch(`${context.supabaseUrl}/rest/v1/store_accounts?${params}`, { headers });
    let rows;
    try { rows = await response.json(); } catch (_) { throw new Error('store_memberships_unavailable'); }
    if (!response.ok || !Array.isArray(rows)) throw new Error('store_memberships_unavailable');
    for (const row of rows) if (UUID.test(String(row.store_id || ''))) ids.add(row.store_id);
    if (rows.length < STORE_ACCOUNT_PAGE) return [...ids];
  }
  throw new Error('store_memberships_unavailable');
}
