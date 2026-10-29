const { getContext, requireRoles } = require('./_auth');

/* Platform admin only: who may sign in to which store's dashboard.
     GET    /api/platform-store-accounts[?storeId=]   the linked accounts, with email and name
     POST   /api/platform-store-accounts              { storeId, email }   link a confirmed account to a store
     DELETE /api/platform-store-accounts              { accountId }        remove the link
   Everything goes through the service-role functions platform_store_accounts / platform_link_store_account /
   platform_unlink_store_account, which also keep the profile role in step and write the audit log. */

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/* What the database function says -> [HTTP status, error code the dashboard maps to Arabic]. */
const LINK_ERRORS = {
  'Invalid email': [400, 'invalid_email'],
  'Store not found': [404, 'store_not_found'],
  'User not found': [404, 'user_not_found'],
  'Email not confirmed': [409, 'email_not_confirmed'],
  'Platform admin cannot be a store account': [409, 'platform_admin_not_linkable'],
  'Customer has order history': [409, 'customer_has_order_history']
};
const UNLINK_ERRORS = { 'Account not found': [404, 'account_not_found'] };

function reply(res, status, body) {
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('Content-Type', 'application/json');
  return res.status(status).json(body);
}

async function callRpc(context, name, args) {
  const response = await fetch(`${context.supabaseUrl}/rest/v1/rpc/${name}`, {
    method: 'POST',
    headers: { apikey: context.serviceRoleKey, Authorization: `Bearer ${context.serviceRoleKey}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(args)
  });
  let data = null;
  try { data = await response.json(); } catch (_) { data = null; }
  return { ok: response.ok, status: response.status, data };
}

function accountView(row) {
  return {
    accountId: row.account_id,
    storeId: row.store_id,
    storeName: row.store_name,
    email: row.email || '',
    fullName: row.full_name || '',
    accountRole: row.account_role,
    profileRole: row.profile_role || '',
    createdAt: row.created_at
  };
}

module.exports = async function platformStoreAccounts(req, res) {
  if (!['GET', 'POST', 'DELETE'].includes(req.method)) return reply(res, 405, { ok: false, error: 'method_not_allowed' });
  try {
    const context = requireRoles(await getContext(req), ['platform_admin']);
    if (context.error) return reply(res, context.status, { ok: false, error: context.error });
    const query = req.query || {};
    const body = req.body && typeof req.body === 'object' && !Array.isArray(req.body) ? req.body : {};
    /* The temporary owner key has no user id: the audit row then has no actor. */
    const actor = typeof context.user?.id === 'string' && UUID.test(context.user.id) ? context.user.id : null;

    if (req.method === 'GET') {
      const storeId = query.storeId ? String(query.storeId) : null;
      if (storeId && !UUID.test(storeId)) return reply(res, 400, { ok: false, error: 'invalid_store_id' });
      const result = await callRpc(context, 'platform_store_accounts', { p_store_id: storeId });
      if (!result.ok || !Array.isArray(result.data)) return reply(res, 502, { ok: false, error: 'store_accounts_unavailable' });
      return reply(res, 200, { ok: true, accounts: result.data.map(accountView) });
    }

    if (req.method === 'POST') {
      const storeId = typeof body.storeId === 'string' ? body.storeId : '';
      const email = typeof body.email === 'string' ? body.email.trim() : '';
      if (!UUID.test(storeId)) return reply(res, 400, { ok: false, error: 'invalid_store_id' });
      if (!email || email.length > 320) return reply(res, 400, { ok: false, error: 'invalid_email' });
      const result = await callRpc(context, 'platform_link_store_account', { p_store_id: storeId, p_email: email, p_actor: actor });
      if (!result.ok) {
        const known = result.data && typeof result.data.message === 'string' ? LINK_ERRORS[result.data.message] : null;
        if (known) return reply(res, known[0], { ok: false, error: known[1] });
        return reply(res, 502, { ok: false, error: 'store_account_link_failed' });
      }
      const linked = result.data || {};
      return reply(res, linked.already_linked ? 200 : 201, { ok: true, accountId: linked.account_id, storeId: linked.store_id, alreadyLinked: Boolean(linked.already_linked) });
    }

    const accountId = String(body.accountId || query.accountId || '');
    if (!UUID.test(accountId)) return reply(res, 400, { ok: false, error: 'invalid_account_id' });
    const result = await callRpc(context, 'platform_unlink_store_account', { p_account_id: accountId, p_actor: actor });
    if (!result.ok) {
      const known = result.data && typeof result.data.message === 'string' ? UNLINK_ERRORS[result.data.message] : null;
      if (known) return reply(res, known[0], { ok: false, error: known[1] });
      return reply(res, 502, { ok: false, error: 'store_account_unlink_failed' });
    }
    return reply(res, 200, { ok: true, accountId, roleBackToCustomer: Boolean(result.data && result.data.role_back_to_customer) });
  } catch (_) {
    return reply(res, 502, { ok: false, error: 'store_accounts_request_failed' });
  }
};
