const { getContext, requireRoles } = require('./_auth');
function reply(res, status, body) { res.status(status).setHeader('Content-Type', 'application/json').json(body); }
module.exports = async function notifications(req, res) {
  if (req.method !== 'GET' && req.method !== 'PATCH') return reply(res, 405, { ok: false, error: 'method_not_allowed' });
  try {
    const context = requireRoles(await getContext(req), ['customer', 'store_admin', 'platform_admin']);
    if (context.error) return reply(res, context.status, { ok: false, error: context.error });
    const headers = { apikey: context.serviceRoleKey, Authorization: `Bearer ${context.serviceRoleKey}`, 'Content-Type': 'application/json' };
    if (req.method === 'PATCH') {
      const id = req.body && req.body.id;
      if (!id) return reply(res, 400, { ok: false, error: 'notification_id_required' });
      const access = context.profile.role === 'platform_admin'
        ? `recipient_role=eq.platform_admin`
        : context.profile.role === 'store_admin'
          ? `or=(user_id.eq.${context.user.id},store_id.in.(${await storeIds(context)}))`
          : `user_id=eq.${context.user.id}`;
      const response = await fetch(`${context.supabaseUrl}/rest/v1/notifications?id=eq.${encodeURIComponent(id)}&${access}`, { method: 'PATCH', headers: { ...headers, Prefer: 'return=representation' }, body: JSON.stringify({ is_read: true, read_at: new Date().toISOString() }) });
      const data = await response.json();
      if (!response.ok) return reply(res, 502, { ok: false, error: 'notification_update_failed', details: data });
      return reply(res, 200, { ok: true, notification: data[0] || null });
    }
    const limit = Math.min(Math.max(Number((req.query || {}).limit) || 50, 1), 100);
    const params = new URLSearchParams({ select: 'id,user_id,recipient_role,store_id,checkout_session_id,request_id,tracking_number,type,title,body,payload,is_read,read_at,created_at', order: 'created_at.desc', limit: String(limit) });
    if ((req.query || {}).unread === '1') params.set('is_read', 'eq.false');
    if (context.profile.role === 'platform_admin') params.set('recipient_role', 'eq.platform_admin');
    else if (context.profile.role === 'store_admin') {
      const ids = await storeIds(context);
      params.set('or', `(user_id.eq.${context.user.id},store_id.in.(${ids.length ? ids.join(',') : '00000000-0000-0000-0000-000000000000'}))`);
    } else params.set('user_id', `eq.${context.user.id}`);
    const response = await fetch(`${context.supabaseUrl}/rest/v1/notifications?${params}`, { headers });
    const data = await response.json();
    if (!response.ok) return reply(res, 502, { ok: false, error: 'notification_read_failed', details: data });
    reply(res, 200, { ok: true, notifications: data });
  } catch (_) { reply(res, 502, { ok: false, error: 'notification_api_failed' }); }
};
async function storeIds(context) {
  const response = await fetch(`${context.supabaseUrl}/rest/v1/store_accounts?select=store_id&user_id=eq.${context.user.id}&limit=20`, { headers: { apikey: context.serviceRoleKey, Authorization: `Bearer ${context.serviceRoleKey}` } });
  const data = response.ok ? await response.json() : [];
  return data.map((row) => row.store_id);
}
