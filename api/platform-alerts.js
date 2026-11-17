const { getContext, requireRoles } = require('./_auth');

/* Platform admin only: the messages of the admin panel (the notifications addressed to the platform) and what the alert centre polls.
     GET   /api/platform-alerts[?limit=30&offset=0&unread=1&type=order_initial]
           -> { ok, unread, firstNotices, total, notifications: [...], serverTime }
              `unread` is every unread message (not only this page), `firstNotices` is how many first notices exist (the panel
              notices a new one by this number growing), `total` is the size of the filtered list for paging.
     PATCH { id } | { ids: [uuid, ...up to 100] } | { all: true }     mark messages read (only ever the platform's own messages)
   Only the columns listed in COLUMNS leave the server (never the raw payload), so an order's customer data is not in a message:
   the first-notice page is where an order is read in full. */

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const COLUMNS = 'id,type,title,body,is_read,created_at,tracking_number,request_id,store_id';
const MAX_IDS = 100;

function reply(res, status, body) {
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('Content-Type', 'application/json');
  return res.status(status).json(body);
}

function first(value) { return Array.isArray(value) ? value[0] : value; }

function integerQuery(value, fallback, min, max) {
  const raw = first(value);
  if (raw === undefined || raw === null || raw === '') return fallback;
  const number = Number(raw);
  return Number.isSafeInteger(number) && number >= min && number <= max ? number : null;
}

function totalFrom(response) {
  const match = (response.headers.get('content-range') || '').match(/\/(\d+)$/);
  return match ? Number(match[1]) : null;
}

function messageView(row) {
  return {
    id: row.id,
    type: typeof row.type === 'string' ? row.type.slice(0, 60) : '',
    title: typeof row.title === 'string' ? row.title.slice(0, 200) : '',
    body: typeof row.body === 'string' ? row.body.slice(0, 1000) : '',
    isRead: !!row.is_read,
    createdAt: row.created_at,
    trackingNumber: typeof row.tracking_number === 'string' ? row.tracking_number.slice(0, 120) : null,
    requestId: UUID.test(String(row.request_id || '')) ? row.request_id : null,
    storeId: UUID.test(String(row.store_id || '')) ? row.store_id : null
  };
}

async function count(context, headers, table, filters) {
  const params = new URLSearchParams({ select: 'id', limit: '1', ...filters });
  const response = await fetch(`${context.supabaseUrl}/rest/v1/${table}?${params}`, { method: 'HEAD', headers: { ...headers, Prefer: 'count=exact', Range: '0-0' } });
  return response.ok ? totalFrom(response) : null;
}

module.exports = async function platformAlerts(req, res) {
  if (req.method !== 'GET' && req.method !== 'PATCH') return reply(res, 405, { ok: false, error: 'method_not_allowed' });
  try {
    const context = requireRoles(await getContext(req), ['platform_admin']);
    if (context.error) return reply(res, context.status, { ok: false, error: context.error });
    const headers = { apikey: context.serviceRoleKey, Authorization: `Bearer ${context.serviceRoleKey}`, 'Content-Type': 'application/json' };

    if (req.method === 'PATCH') {
      const body = req.body && typeof req.body === 'object' ? req.body : {};
      const params = new URLSearchParams({ recipient_role: 'eq.platform_admin' });
      if (body.all === true) params.set('is_read', 'eq.false');
      else if (typeof body.id === 'string') {
        if (!UUID.test(body.id)) return reply(res, 400, { ok: false, error: 'notification_id_required' });
        params.set('id', `eq.${body.id}`);
      } else if (Array.isArray(body.ids)) {
        const ids = body.ids.filter(value => typeof value === 'string');
        if (!ids.length || ids.length > MAX_IDS || ids.length !== body.ids.length || !ids.every(value => UUID.test(value))) return reply(res, 400, { ok: false, error: 'notification_id_required' });
        params.set('id', `in.(${ids.join(',')})`);
      } else return reply(res, 400, { ok: false, error: 'notification_id_required' });
      const response = await fetch(`${context.supabaseUrl}/rest/v1/notifications?${params}`, { method: 'PATCH', headers: { ...headers, Prefer: 'return=minimal' }, body: JSON.stringify({ is_read: true, read_at: new Date().toISOString() }) });
      if (!response.ok) return reply(res, 502, { ok: false, error: 'notification_update_failed' });
      return reply(res, 200, { ok: true });
    }

    const query = req.query || {};
    const limit = integerQuery(query.limit, 30, 1, 100);
    const offset = integerQuery(query.offset, 0, 0, 100000);
    if (limit === null || offset === null) return reply(res, 400, { ok: false, error: 'invalid_limit' });
    const filters = { recipient_role: 'eq.platform_admin' };
    if (first(query.unread) === '1') filters.is_read = 'eq.false';
    const type = first(query.type);
    if (type !== undefined && type !== '') {
      if (!/^[a-z][a-z0-9_]{0,59}$/.test(String(type))) return reply(res, 400, { ok: false, error: 'invalid_type' });
      filters.type = `eq.${type}`;
    }
    const listParams = new URLSearchParams({ select: COLUMNS, order: 'created_at.desc,id.desc', limit: String(limit), offset: String(offset), ...filters });
    const [listResponse, unread, firstNotices] = await Promise.all([
      fetch(`${context.supabaseUrl}/rest/v1/notifications?${listParams}`, { headers: { ...headers, Prefer: 'count=exact' } }),
      count(context, headers, 'notifications', { recipient_role: 'eq.platform_admin', is_read: 'eq.false' }),
      count(context, headers, 'platform_order_notices', {})
    ]);
    let rows = null;
    try { rows = await listResponse.json(); } catch (_) { rows = null; }
    if (!listResponse.ok || !Array.isArray(rows) || unread === null || firstNotices === null) return reply(res, 502, { ok: false, error: 'platform_alerts_unavailable' });
    const total = totalFrom(listResponse);
    return reply(res, 200, {
      ok: true,
      unread,
      firstNotices,
      total: total === null ? rows.length + offset : total,
      hasMore: total === null ? rows.length === limit : offset + rows.length < total,
      serverTime: new Date().toISOString(),
      notifications: rows.map(messageView)
    });
  } catch (_) {
    return reply(res, 502, { ok: false, error: 'platform_alerts_unavailable' });
  }
};
