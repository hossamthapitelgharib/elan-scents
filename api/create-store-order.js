const crypto = require('node:crypto');

function reply(res, status, body) {
  res.status(status).setHeader('Content-Type', 'application/json').json(body);
}

function trackingNumber() {
  const now = new Date();
  const stamp = [now.getUTCFullYear(), String(now.getUTCMonth() + 1).padStart(2, '0'), String(now.getUTCDate()).padStart(2, '0')].join('');
  return `ELN-${stamp}-${crypto.randomBytes(4).toString('hex').toUpperCase()}`;
}

function validate(body) {
  if (!body.customer || !body.customer.name || !body.customer.phone || !body.customer.address) {
    return 'customer name, phone and address are required';
  }
  if (!Array.isArray(body.items) || body.items.length === 0) return 'items are required';
  if (body.items.some((item) => !item.storeId || !item.productSizeId || !item.name || !Number.isInteger(Number(item.quantity)) || Number(item.quantity) < 1)) {
    return 'each item must include storeId, productSizeId, name and a positive quantity';
  }
  return null;
}

async function createCheckoutSession(supabaseUrl, serviceRoleKey, payload, userAuthorization) {
  const response = await fetch(`${supabaseUrl}/rest/v1/rpc/create_checkout_session`, { method: 'POST', headers: { apikey: serviceRoleKey, Authorization: userAuthorization || `Bearer ${serviceRoleKey}`, 'Content-Type': 'application/json' }, body: JSON.stringify({ p_payload: payload }) });
  const raw = await response.text();
  let data; try { data = raw ? JSON.parse(raw) : null; } catch (_) { data = { raw }; }
  if (!response.ok) throw new Error(JSON.stringify(data));
  return Array.isArray(data) ? data[0] : data;
}

async function createStoreRequest(supabaseUrl, serviceRoleKey, payload, userAuthorization) {
  const response = await fetch(`${supabaseUrl}/rest/v1/rpc/create_store_order_request`, {
    method: 'POST',
    headers: {
      apikey: serviceRoleKey,
      Authorization: userAuthorization || `Bearer ${serviceRoleKey}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ p_payload: payload }),
  });
  const raw = await response.text();
  let data;
  try { data = raw ? JSON.parse(raw) : null; } catch (_) { data = { raw }; }
  if (!response.ok) throw new Error(JSON.stringify(data));
  return Array.isArray(data) ? data[0] : data;
}

module.exports = async function createStoreOrder(req, res) {
  if (req.method === 'OPTIONS') {
    res.status(204).setHeader('Access-Control-Allow-Origin', '*').setHeader('Access-Control-Allow-Headers', 'Content-Type').setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS').end();
    return;
  }
  if (req.method !== 'POST') {
    reply(res, 405, { ok: false, error: 'method_not_allowed' });
    return;
  }
  if (!req.headers.authorization || !req.headers.authorization.startsWith('Bearer ')) {
    reply(res, 401, { ok: false, error: 'login_required' });
    return;
  }

  const body = req.body && typeof req.body === 'object' ? req.body : {};
  const validationError = validate(body);
  if (validationError) {
    reply(res, 400, { ok: false, error: validationError });
    return;
  }

  const supabaseUrl = process.env.SUPABASE_URL || process.env.NEXT_PUBLIC_SUPABASE_URL;
  const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_SECRET_KEY;
  if (!supabaseUrl || !serviceRoleKey) {
    reply(res, 503, { ok: false, error: 'supabase_service_configuration_missing' });
    return;
  }

  const unifiedTrackingNumber = trackingNumber();
  const groups = new Map();
  body.items.forEach((item) => {
    const key = String(item.storeId);
    if (!groups.has(key)) groups.set(key, { storeId: item.storeId, storeName: item.storeName || '', items: [] });
    groups.get(key).items.push({
      id: item.id || item.productSizeId,
      productSizeId: item.productSizeId,
      storeProductId: item.storeProductId || '',
      name: item.name,
      brand: item.brand || '',
      size: item.size || '',
      quantity: Number(item.quantity),
      unitPrice: Number(item.unitPrice || 0),
      currency: 'EGP',
      total: Number(item.total || (Number(item.unitPrice || 0) * Number(item.quantity)).toFixed(2)),
    });
  });

  const stores = [];
  let checkoutSessionId = '';
  try {
    const checkoutSession = await createCheckoutSession(supabaseUrl, serviceRoleKey, { trackingNumber: unifiedTrackingNumber, customer: body.customer, currency: body.currency || 'EGP', subtotal: Number(body.items.reduce((sum, item) => sum + Number(item.total || (Number(item.unitPrice || 0) * Number(item.quantity))), 0).toFixed(2)) }, req.headers.authorization);
    checkoutSessionId = checkoutSession && checkoutSession.id || '';

    let index = 0;
    for (const group of groups.values()) {
      index += 1;
      const storeTrackingNumber = `${unifiedTrackingNumber}-S${String(index).padStart(2, '0')}`;
      const subtotal = Number(group.items.reduce((sum, item) => sum + item.total, 0).toFixed(2));
      const payload = {
        trackingNumber: storeTrackingNumber,
        checkoutTrackingNumber: unifiedTrackingNumber,
        checkoutSessionId,
        notificationType: 'initial_order',
        storeId: group.storeId,
        storeName: group.storeName,
        customer: body.customer,
        items: group.items,
        subtotal,
        currency: 'EGP',
        shipping: null,
        total: null,
        status: 'awaiting_store_confirmation',
        createdAt: new Date().toISOString(),
      };
      const created = await createStoreRequest(supabaseUrl, serviceRoleKey, payload, req.headers.authorization);
      stores.push({
        storeId: group.storeId,
        storeName: group.storeName,
        trackingNumber: storeTrackingNumber,
        subtotal,
        items: group.items,
        requestId: created && created.id,
        status: created && created.status,
      });
    }
  } catch (error) {
    reply(res, 502, { ok: false, error: 'store_request_creation_failed', trackingNumber: unifiedTrackingNumber, createdStores: stores, details: error.message });
    return;
  }

  reply(res, 201, {
    ok: true,
    trackingNumber: unifiedTrackingNumber,
    checkoutSessionId,
    status: 'awaiting_store_confirmation',
    customer: body.customer,
    stores,
  });
};
