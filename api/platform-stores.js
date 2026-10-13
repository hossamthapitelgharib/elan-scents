const { getContext, requireRoles } = require('./_auth');

function reply(res, status, body) {
  res.setHeader('Cache-Control', 'no-store');
  res.status(status).setHeader('Content-Type', 'application/json').json(body);
}

module.exports = async function platformStores(req, res) {
  if (req.method !== 'GET') return reply(res, 405, { ok: false, error: 'method_not_allowed' });
  try {
    const context = requireRoles(await getContext(req), ['platform_admin']);
    if (context.error) return reply(res, context.status, { ok: false, error: context.error });
    const headers = { apikey: context.serviceRoleKey, Authorization: `Bearer ${context.serviceRoleKey}` };
    const base = `${context.supabaseUrl}/rest/v1/`;
    const [storesResponse, summaryResponse] = await Promise.all([
      fetch(`${base}stores?select=id,name,slug,logo_url,image_url,short_description,website_url,status,commission_rate,priority_rank,created_at,updated_at&order=name.asc&limit=500`, { headers }),
      fetch(`${base}rpc/platform_store_summary`, { method: 'POST', headers: { ...headers, 'Content-Type': 'application/json' }, body: '{}' })
    ]);
    if (!storesResponse.ok || !summaryResponse.ok) return reply(res, 502, { ok: false, error: 'store_data_unavailable' });
    const [stores, summaries] = await Promise.all([storesResponse.json(), summaryResponse.json()]);
    if (!Array.isArray(stores) || !Array.isArray(summaries)) return reply(res, 502, { ok: false, error: 'store_data_unavailable' });
    const summaryById = new Map(summaries.map(row => [row.store_id, row]));
    const result = stores.map(store => ({ ...store, summary: summaryById.get(store.id) || null }));
    return reply(res, 200, { ok: true, stores: result, count: result.length });
  } catch (_) {
    return reply(res, 502, { ok: false, error: 'store_data_unavailable' });
  }
};
