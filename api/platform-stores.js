const { getContext, requireRoles } = require('./_auth');

function reply(res, status, body) {
  res.setHeader('Cache-Control', 'no-store');
  res.status(status).setHeader('Content-Type', 'application/json').json(body);
}

async function readAllRows(base, headers, params, pageSize = 500) {
  const query = new URLSearchParams(params);
  query.set('limit', String(pageSize));
  const rows = [];
  let offset = 0;
  while (offset < 100000) {
    query.set('offset', String(offset));
    const response = await fetch(`${base}stores?${query.toString()}`, { headers });
    let page;
    try { page = await response.json(); } catch (_) { throw new Error('store_data_unavailable'); }
    if (!response.ok || !Array.isArray(page)) throw new Error('store_data_unavailable');
    rows.push(...page);
    if (page.length < pageSize) return rows;
    offset += page.length;
  }
  throw new Error('store_data_unavailable');
}

module.exports = async function platformStores(req, res) {
  if (req.method !== 'GET') return reply(res, 405, { ok: false, error: 'method_not_allowed' });
  try {
    const context = requireRoles(await getContext(req), ['platform_admin']);
    if (context.error) return reply(res, context.status, { ok: false, error: context.error });
    const headers = { apikey: context.serviceRoleKey, Authorization: `Bearer ${context.serviceRoleKey}` };
    const base = `${context.supabaseUrl}/rest/v1/`;
    const storeParams = new URLSearchParams({ select: 'id,name,slug,logo_url,image_url,short_description,website_url,status,commission_rate,priority_rank,created_at,updated_at', order: 'name.asc,id.asc' });
    const [stores, summaryResponse] = await Promise.all([
      readAllRows(base, headers, storeParams),
      fetch(`${base}rpc/platform_store_summary`, { method: 'POST', headers: { ...headers, 'Content-Type': 'application/json' }, body: '{}' })
    ]);
    if (!summaryResponse.ok) return reply(res, 502, { ok: false, error: 'store_data_unavailable' });
    const summaries = await summaryResponse.json();
    if (!Array.isArray(summaries)) return reply(res, 502, { ok: false, error: 'store_data_unavailable' });
    const summaryById = new Map(summaries.map(row => [row.store_id, row]));
    if (stores.some(store => !summaryById.has(store.id))) return reply(res, 502, { ok: false, error: 'store_summary_incomplete' });
    const result = stores.map(store => ({ ...store, summary: summaryById.get(store.id) }));
    return reply(res, 200, { ok: true, stores: result, count: result.length });
  } catch (_) {
    return reply(res, 502, { ok: false, error: 'store_data_unavailable' });
  }
};
