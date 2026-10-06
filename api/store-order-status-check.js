function reply(res, status, body) {
  res.status(status).setHeader('Content-Type', 'application/json').json(body);
}

module.exports = async function storeOrderStatusCheck(req, res) {
  if (req.method !== 'GET') {
    reply(res, 405, { ok: false, error: 'method_not_allowed' });
    return;
  }

  const trackingNumber = String((req.query && req.query.trackingNumber) || '').trim();
  if (!trackingNumber) {
    reply(res, 400, { ok: false, error: 'trackingNumber_required' });
    return;
  }

  const supabaseUrl = process.env.SUPABASE_URL || process.env.NEXT_PUBLIC_SUPABASE_URL;
  const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_SECRET_KEY;
  if (!supabaseUrl || !serviceRoleKey) {
    reply(res, 503, { ok: false, error: 'supabase_service_configuration_missing' });
    return;
  }

  try {
    const params = new URLSearchParams({
      tracking_number: `eq.${trackingNumber}`,
      select: 'tracking_number,status,store_id',
      limit: '1',
    });
    const response = await fetch(`${supabaseUrl}/rest/v1/store_order_requests?${params}`, {
      headers: { apikey: serviceRoleKey, Authorization: `Bearer ${serviceRoleKey}` },
    });
    const raw = await response.text();
    let data;
    try { data = raw ? JSON.parse(raw) : []; } catch (_) { data = []; }
    if (!response.ok) {
      reply(res, 502, { ok: false, error: 'supabase_status_lookup_failed' });
      return;
    }

    const row = Array.isArray(data) ? data[0] : data;
    const status = String((row && row.status) || '').toLowerCase();
    const completed = ['completed', 'success', 'succeeded', 'paid', 'confirmed'].includes(status);
    reply(res, 200, { ok: true, found: Boolean(row), trackingNumber, status: status || null, completed });
  } catch (_) {
    reply(res, 502, { ok: false, error: 'status_lookup_failed' });
  }
};
