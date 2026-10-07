const { getContext, requireRoles } = require('./_auth');
function reply(res, status, body) { res.status(status).setHeader('Content-Type', 'application/json').json(body); }
const statuses = new Set(['store_confirmed','processing','shipped','delivered','store_rejected']);
module.exports = async function storeOrderUpdate(req, res) {
  if (req.method !== 'PATCH' && req.method !== 'POST') return reply(res, 405, { ok: false, error: 'method_not_allowed' });
  try {
    const context = requireRoles(await getContext(req), ['store_admin', 'platform_admin']);
    if (context.error) return reply(res, context.status, { ok: false, error: context.error });
    const body = req.body && typeof req.body === 'object' ? req.body : {};
    if (!body.requestId || !statuses.has(body.status)) return reply(res, 400, { ok: false, error: 'requestId and valid status are required' });
    if (context.profile.role !== 'platform_admin') {
      const accounts = await fetch(`${context.supabaseUrl}/rest/v1/store_accounts?select=store_id&user_id=eq.${context.user.id}&limit=20`, { headers: { apikey: context.serviceRoleKey, Authorization: `Bearer ${context.serviceRoleKey}` } }).then((r) => r.json());
      const allowed = (accounts || []).map((row) => row.store_id);
      const target = await fetch(`${context.supabaseUrl}/rest/v1/store_order_requests?select=id,store_id,tracking_number&id=eq.${body.requestId}&limit=1`, { headers: { apikey: context.serviceRoleKey, Authorization: `Bearer ${context.serviceRoleKey}` } }).then((r) => r.json());
      if (!target[0] || !allowed.includes(target[0].store_id)) return reply(res, 403, { ok: false, error: 'store_access_denied' });
    }
    const patch = { status: body.status, updated_at: new Date().toISOString() };
    if (body.shippingAmount != null) patch.shipping_amount = Number(body.shippingAmount);
    if (body.totalAmount != null) patch.total_amount = Number(body.totalAmount);
    if (body.reason) patch.failure_reason = body.reason;
    const response = await fetch(`${context.supabaseUrl}/rest/v1/store_order_requests?id=eq.${encodeURIComponent(body.requestId)}`, { method: 'PATCH', headers: { apikey: context.serviceRoleKey, Authorization: `Bearer ${context.serviceRoleKey}`, 'Content-Type': 'application/json', Prefer: 'return=representation' }, body: JSON.stringify(patch) });
    const updated = await response.json();
    if (!response.ok) return reply(res, 502, { ok: false, error: 'supabase_update_failed', details: updated });
    const request = updated[0];
    await fetch(`${context.supabaseUrl}/rest/v1/store_order_notifications`, { method: 'POST', headers: { apikey: context.serviceRoleKey, Authorization: `Bearer ${context.serviceRoleKey}`, 'Content-Type': 'application/json' }, body: JSON.stringify({ request_id: request.id, tracking_number: request.tracking_number, event_type: 'store_update', store_status: body.status, match_status: 'pending', payload: body }) });
    reply(res, 200, { ok: true, order: request });
  } catch (_) { reply(res, 502, { ok: false, error: 'store_update_failed' }); }
};
