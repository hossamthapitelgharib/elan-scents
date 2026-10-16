const { getContext, requireRoles } = require('./_auth');
const PERIODS = new Set(['all', 'today', 'week', 'month', 'year']);

function reply(res, status, body) {
  res.setHeader('Cache-Control', 'no-store');
  return res.status(status).setHeader('Content-Type', 'application/json').json(body);
}
function queryValue(query, key, fallback) {
  const value = query && query[key];
  return value === undefined || value === null || value === '' ? fallback : String(Array.isArray(value) ? value[0] : value);
}
function pageNumber(value, fallback, minimum, maximum) {
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed >= minimum && parsed <= maximum ? parsed : fallback;
}
function nonnegative(value) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? Math.max(0, parsed) : 0;
}

module.exports = async function customerBestSellers(req, res) {
  if (req.method !== 'GET') return reply(res, 405, { ok: false, error: 'method_not_allowed' });
  try {
    const context = requireRoles(await getContext(req, { strictProfile: true }), ['platform_admin']);
    if (context.error) return reply(res, context.status, { ok: false, error: context.error });

    const query = req.query || {};
    const period = queryValue(query, 'period', 'all');
    const limit = pageNumber(queryValue(query, 'limit', '50'), null, 1, 100);
    const offset = pageNumber(queryValue(query, 'offset', '0'), null, 0, 100000);
    if (!PERIODS.has(period)) return reply(res, 400, { ok: false, error: 'invalid_period' });
    if (limit === null || offset === null) return reply(res, 400, { ok: false, error: 'invalid_page' });

    const response = await fetch(`${context.supabaseUrl}/rest/v1/rpc/platform_registered_customer_best_sellers`, {
      method: 'POST',
      headers: { apikey: context.serviceRoleKey, Authorization: `Bearer ${context.serviceRoleKey}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ p_period: period, p_limit: limit, p_offset: offset })
    });
    if (!response.ok) return reply(res, 502, { ok: false, error: 'best_sellers_unavailable' });
    const result = await response.json();
    if (!result || !Array.isArray(result.records) || !result.audit || typeof result.audit !== 'object') {
      return reply(res, 502, { ok: false, error: 'best_sellers_unavailable' });
    }

    return reply(res, 200, {
      ok: true,
      period,
      fromDate: result.fromDate || null,
      toDate: result.toDate || null,
      limit,
      offset,
      total: nonnegative(result.total),
      hasMore: result.hasMore === true,
      records: result.records.map(row => ({
        rank: nonnegative(row && row.rank),
        product: row && row.product && typeof row.product === 'object' ? {
          id: String(row.product.id || ''),
          name: String(row.product.name || 'عطر غير معروف'),
          brand_name: row.product.brand_name == null ? null : String(row.product.brand_name),
          slug: row.product.slug == null ? null : String(row.product.slug)
        } : null,
        unitsSold: nonnegative(row && row.unitsSold),
        purchases: nonnegative(row && row.purchases),
        storeCount: nonnegative(row && row.storeCount),
        sizeBreakdown: Array.isArray(row && row.sizeBreakdown) ? row.sizeBreakdown.map(size => ({
          size: String(size && size.size || 'غير محدد'),
          units: nonnegative(size && size.units)
        })) : []
      })),
      audit: {
        registeredUnits: nonnegative(result.audit.registeredUnits),
        eligiblePurchases: nonnegative(result.audit.eligiblePurchases),
        eligibleUnits: nonnegative(result.audit.eligibleUnits),
        rankedUnits: nonnegative(result.audit.rankedUnits),
        unlinkedEligibleUnits: nonnegative(result.audit.unlinkedEligibleUnits),
        unlinkedEligibleLines: nonnegative(result.audit.unlinkedEligibleLines),
        excludedCancelledUnits: nonnegative(result.audit.excludedCancelledUnits),
        excludedInProgressUnits: nonnegative(result.audit.excludedInProgressUnits),
        excludedReviewOrMismatchUnits: nonnegative(result.audit.excludedReviewOrMismatchUnits),
        excludedOtherUnits: nonnegative(result.audit.excludedOtherUnits),
        ownerConflictUnits: nonnegative(result.audit.ownerConflictUnits),
        unregisteredUnitsExcluded: nonnegative(result.audit.unregisteredUnitsExcluded),
        returnsAndRefundsTracked: result.audit.returnsAndRefundsTracked === true
      }
    });
  } catch (_) {
    return reply(res, 502, { ok: false, error: 'best_sellers_unavailable' });
  }
};
