const { getContext, requireRoles } = require('./_auth');
const { SHIPPING_STATUS_OPTIONS, canShippingTransition } = require('../lib/shipping-status');

function reply(res, status, body) {
  res.status(status).setHeader('Content-Type', 'application/json').json(body);
}

function headers(key) {
  return { apikey: key, Authorization: `Bearer ${key}` };
}

function text(value, max) {
  if (value == null) return null;
  const result = String(value).trim();
  return result ? result.slice(0, max) : null;
}

function isoOrNull(value) {
  if (value == null || value === '') return null;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? undefined : date.toISOString();
}

module.exports = async function storeShipmentUpdate(req, res) {
  if (req.method !== 'PATCH' && req.method !== 'POST') return reply(res, 405, { ok: false, error: 'method_not_allowed' });
  try {
    const context = requireRoles(await getContext(req), ['store_admin', 'platform_admin']);
    if (context.error) return reply(res, context.status, { ok: false, error: context.error });
    const body = req.body && typeof req.body === 'object' ? req.body : {};
    const requestId = text(body.requestId, 80);
    const status = text(body.shippingStatus, 40);
    if (!requestId || !SHIPPING_STATUS_OPTIONS.includes(status)) return reply(res, 400, { ok: false, error: 'requestId and valid shippingStatus are required' });

    const base = headers(context.serviceRoleKey);
    const requestParams = new URLSearchParams({ select: 'id,store_id,tracking_number,status', id: `eq.${requestId}`, limit: '1' });
    const requestResponse = await fetch(`${context.supabaseUrl}/rest/v1/store_order_requests?${requestParams}`, { headers: base });
    const requests = await requestResponse.json();
    if (requestResponse.status === 400) return reply(res, 400, { ok: false, error: 'invalid_request_id' });
    if (!requestResponse.ok || !Array.isArray(requests)) return reply(res, 502, { ok: false, error: 'supabase_read_failed' });
    const request = requests[0];
    if (!request) return reply(res, 404, { ok: false, error: 'order_not_found' });

    if (context.profile.role !== 'platform_admin') {
      const membershipParams = new URLSearchParams({ select: 'store_id', user_id: `eq.${context.user.id}`, store_id: `eq.${request.store_id}`, limit: '1' });
      const accountResponse = await fetch(`${context.supabaseUrl}/rest/v1/store_accounts?${membershipParams}`, { headers: base });
      const accounts = await accountResponse.json();
      if (!accountResponse.ok || !Array.isArray(accounts)) return reply(res, 502, { ok: false, error: 'store_access_check_failed' });
      if (!accounts.some(row => row.store_id === request.store_id)) return reply(res, 403, { ok: false, error: 'store_access_denied' });
    }
    if (['store_rejected', 'store_cancelled', 'restored'].includes(request.status)) return reply(res, 409, { ok: false, error: 'order_not_shippable', status: request.status });

    const currentParams = new URLSearchParams({ select: 'id,shipping_status,updated_at,delivered_at', request_id: `eq.${requestId}`, limit: '1' });
    const currentResponse = await fetch(`${context.supabaseUrl}/rest/v1/store_shipments?${currentParams}`, { headers: base });
    let currentRows = null;
    try { currentRows = currentResponse.ok ? await currentResponse.json() : null; } catch (_) { currentRows = null; }
    if (!Array.isArray(currentRows)) return reply(res, 502, { ok: false, error: 'shipment_read_failed' });
    const current = currentRows[0];
    if (current && !canShippingTransition(current.shipping_status, status)) return reply(res, 409, { ok: false, error: 'invalid_shipping_transition', from: current.shipping_status, to: status });

    const estimated = isoOrNull(body.estimatedDeliveryAt);
    if (estimated === undefined) return reply(res, 400, { ok: false, error: 'estimatedDeliveryAt is invalid' });
    const patch = {
      request_id: request.id,
      store_id: request.store_id,
      carrier_name: text(body.carrierName, 120),
      tracking_code: text(body.trackingCode, 160),
      shipping_status: status,
      status_note: text(body.statusNote, 500),
      estimated_delivery_at: estimated,
      delivered_at: status === 'delivered' ? (current && current.delivered_at) || new Date().toISOString() : null,
      updated_at: new Date().toISOString()
    };

    let saveUrl;
    let saveMethod;
    let prefer;
    const saveParams = new URLSearchParams({ select: '*' });
    if (current) {
      // Compare both the transition state and row version. The updated_at filter also
      // serializes concurrent edits that repeat the same status but change other fields.
      saveParams.set('request_id', `eq.${request.id}`);
      saveParams.set('shipping_status', `eq.${current.shipping_status}`);
      saveParams.set('updated_at', current.updated_at == null ? 'is.null' : `eq.${current.updated_at}`);
      saveUrl = `${context.supabaseUrl}/rest/v1/store_shipments?${saveParams}`;
      saveMethod = 'PATCH';
      prefer = 'return=representation';
    } else {
      // A racing first insert must not merge over the winner's row.
      saveParams.set('on_conflict', 'request_id');
      saveUrl = `${context.supabaseUrl}/rest/v1/store_shipments?${saveParams}`;
      saveMethod = 'POST';
      prefer = 'resolution=ignore-duplicates,return=representation';
    }
    const saveResponse = await fetch(saveUrl, {
      method: saveMethod,
      headers: { ...base, 'Content-Type': 'application/json', Prefer: prefer },
      body: JSON.stringify(patch)
    });
    const saved = await saveResponse.json();
    if (!saveResponse.ok) {
      if (/Payment is required before shipping/i.test(`${saved && saved.message || ''}`)) return reply(res, 409, { ok: false, error: 'payment_required' });
      console.error('store-shipment-update: save failed', saved && saved.code, saved && saved.message);
      return reply(res, 502, { ok: false, error: 'shipment_save_failed' });
    }
    if (!Array.isArray(saved) || saved.length !== 1) {
      return reply(res, 409, { ok: false, error: 'shipment_status_changed', from: current && current.shipping_status || null });
    }

    const notification = { request_id: request.id, tracking_number: request.tracking_number, event_type: 'store_update', store_status: status, match_status: 'pending', payload: { type: 'shipping_update', ...patch, source: context.profile.role } };
    let notificationQueued = false;
    try {
      const queued = await fetch(`${context.supabaseUrl}/rest/v1/store_order_notifications`, { method: 'POST', headers: { ...base, 'Content-Type': 'application/json' }, body: JSON.stringify(notification) });
      notificationQueued = queued.ok;
    } catch (_) { notificationQueued = false; }
    reply(res, 200, { ok: true, shipment: saved[0], notificationQueued });
  } catch (_) {
    reply(res, 502, { ok: false, error: 'shipment_update_failed' });
  }
};
