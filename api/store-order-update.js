const { getContext, requireRoles } = require('./_auth');
const { canStoreTransition } = require('../lib/order-status');
function reply(res, status, body) { res.status(status).setHeader('Content-Type', 'application/json').json(body); }
const statuses = new Set(['store_confirmed','processing','shipped','delivered','store_rejected']);
module.exports = async function storeOrderUpdate(req, res) {
  if (req.method !== 'PATCH' && req.method !== 'POST') return reply(res, 405, { ok: false, error: 'method_not_allowed' });
  try {
    const context = requireRoles(await getContext(req), ['store_admin', 'platform_admin']);
    if (context.error) return reply(res, context.status, { ok: false, error: context.error });
    const body = req.body && typeof req.body === 'object' ? req.body : {};
    if (!body.requestId || !statuses.has(body.status)) return reply(res, 400, { ok: false, error: 'requestId and valid status are required' });
    const targetResponse = await fetch(`${context.supabaseUrl}/rest/v1/store_order_requests?select=id,store_id,tracking_number,status&id=eq.${encodeURIComponent(body.requestId)}&limit=1`, { headers: { apikey: context.serviceRoleKey, Authorization: `Bearer ${context.serviceRoleKey}` } });
    const target = await targetResponse.json();
    if (!targetResponse.ok || !Array.isArray(target)) return reply(res, 502, { ok: false, error: 'supabase_read_failed' });
    if (!target[0]) return reply(res, 404, { ok: false, error: 'order_not_found' });
    // platform_admin may set any store status from any state (support override for stuck orders); the role
    // is recorded in the notification payload below. Store accounts stay bound to the transition table.
    if (context.profile.role !== 'platform_admin') {
      const membershipParams = new URLSearchParams({ select: 'store_id', user_id: `eq.${context.user.id}`, store_id: `eq.${target[0].store_id}`, limit: '1' });
      const membershipResponse = await fetch(`${context.supabaseUrl}/rest/v1/store_accounts?${membershipParams}`, { headers: { apikey: context.serviceRoleKey, Authorization: `Bearer ${context.serviceRoleKey}` } });
      const memberships = await membershipResponse.json();
      if (!membershipResponse.ok || !Array.isArray(memberships)) return reply(res, 502, { ok: false, error: 'store_access_check_failed' });
      if (!memberships.some(row => row.store_id === target[0].store_id)) return reply(res, 403, { ok: false, error: 'store_access_denied' });
      if (!canStoreTransition(target[0].status, body.status)) return reply(res, 409, { ok: false, error: 'invalid_status_transition', from: target[0].status, to: body.status });
      if (body.shippingAmount != null || body.totalAmount != null) {
        if (['shipped','delivered','completed'].includes(target[0].status)) return reply(res, 409, { ok: false, error: 'financial_update_locked' });
      }
    }
    const patch = { status: body.status, updated_at: new Date().toISOString() };
    if (body.shippingAmount != null) patch.shipping_amount = Number(body.shippingAmount);
    if (body.totalAmount != null) patch.total_amount = Number(body.totalAmount);
    if (body.reason) patch.failure_reason = body.reason;
    // Compare-and-set: the transition was validated against the status read above, so the write only applies
    // while the order still has that status. Two concurrent updates can no longer both pass the check.
    const patchParams = new URLSearchParams({ id: `eq.${target[0].id}`, status: `eq.${target[0].status}`, select: 'id' });
    const response = await fetch(`${context.supabaseUrl}/rest/v1/store_order_requests?${patchParams}`, { method: 'PATCH', headers: { apikey: context.serviceRoleKey, Authorization: `Bearer ${context.serviceRoleKey}`, 'Content-Type': 'application/json', Prefer: 'return=representation' }, body: JSON.stringify(patch) });
    if (!response.ok) return reply(res, 502, { ok: false, error: 'supabase_update_failed' });
    const updated = await response.json().catch(() => null);
    if (!Array.isArray(updated) || updated.length === 0) return reply(res, 409, { ok: false, error: 'order_status_changed', from: target[0].status });
    // The status is already saved at this point, so a failed notification is reported, not turned into an error.
    let notificationQueued = false;
    try {
      const notification = await fetch(`${context.supabaseUrl}/rest/v1/store_order_notifications`, { method: 'POST', headers: { apikey: context.serviceRoleKey, Authorization: `Bearer ${context.serviceRoleKey}`, 'Content-Type': 'application/json' }, body: JSON.stringify({ request_id: target[0].id, tracking_number: target[0].tracking_number, event_type: 'store_update', store_status: body.status, match_status: 'pending', payload: { requestId: target[0].id, status: body.status, source: context.profile.role } }) });
      notificationQueued = notification.ok;
    } catch (_) { notificationQueued = false; }
    reply(res, 200, { ok: true, notificationQueued });
  } catch (_) { reply(res, 502, { ok: false, error: 'store_update_failed' }); }
};
