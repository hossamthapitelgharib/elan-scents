'use strict';

const { getContext, requireRoles } = require('./_auth');

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const COLUMNS = 'id,store_id,kind,mode,provider,label_ar,label_en,redirect_url,hosted_config,enabled,sort_order,created_at,updated_at';
const HTTPS_PAGE = /^https:\/\/[^\s/?#@]+(\/[^\s]*)?$/i;

function reply(res, status, body) {
  res.setHeader('Cache-Control', 'no-store');
  return res.status(status).setHeader('Content-Type', 'application/json').json(body);
}
function headers(context, extra) {
  return { apikey: context.serviceRoleKey, Authorization: `Bearer ${context.serviceRoleKey}`, ...(extra || {}) };
}
function text(value, max) {
  if (value == null) return null;
  const result = String(value).trim();
  return result ? result.slice(0, max + 1) : null;
}

/* The stores this account may manage: its own links for a store admin, any store for the platform admin. */
async function resolveStore(context, requested) {
  const isPlatform = context.profile.role === 'platform_admin';
  if (requested && !UUID.test(requested)) return { status: 400, error: 'invalid_store' };
  if (isPlatform) return requested ? { storeId: requested.toLowerCase() } : { status: 400, error: 'store_required' };
  const params = new URLSearchParams({ select: 'store_id', user_id: `eq.${context.user.id}`, limit: '50' });
  const response = await fetch(`${context.supabaseUrl}/rest/v1/store_accounts?${params}`, { headers: headers(context) });
  let rows;
  try { rows = await response.json(); } catch (_) { rows = null; }
  if (!response.ok || !Array.isArray(rows)) return { status: 502, error: 'store_access_check_failed' };
  const ids = rows.map(row => String(row.store_id || '').toLowerCase()).filter(id => UUID.test(id));
  if (requested) return ids.includes(requested.toLowerCase()) ? { storeId: requested.toLowerCase() } : { status: 403, error: 'store_access_denied' };
  if (ids.length === 1) return { storeId: ids[0] };
  return { status: 400, error: 'store_required' };
}

/* Shape and the card-data rule, before the database's own constraints (which stay the final word). A card is always paid on the
   merchant's or the provider's own page: Élan stores a page address and public labels, never a card number, a key or a secret. */
function parseMethod(body) {
  const kind = String(body.kind || '').toLowerCase();
  if (!['card', 'cod', 'other'].includes(kind)) return { error: 'invalid_kind' };
  const mode = String(body.mode || (kind === 'cod' ? 'none' : 'redirect')).toLowerCase();
  if (!['redirect', 'hosted', 'none'].includes(mode)) return { error: 'invalid_mode' };
  const labelAr = text(body.labelAr, 80);
  if (!labelAr || labelAr.length > 80) return { error: 'label_required' };
  const labelEn = text(body.labelEn, 80);
  if (labelEn && labelEn.length > 80) return { error: 'label_too_long' };
  const provider = text(body.provider, 60) || 'merchant';
  if (provider.length > 60) return { error: 'provider_too_long' };
  const redirectUrl = text(body.redirectUrl, 500);
  if (kind === 'cod') {
    if (mode !== 'none' || redirectUrl) return { error: 'cod_has_no_payment_page' };
  } else {
    if (mode === 'none') return { error: 'online_method_needs_page' };
    if (!redirectUrl || redirectUrl.length > 500 || !HTTPS_PAGE.test(redirectUrl)) return { error: 'invalid_payment_page' };
  }
  let hostedConfig = {};
  if (body.hostedConfig !== undefined && body.hostedConfig !== null) {
    const config = body.hostedConfig;
    if (!config || typeof config !== 'object' || Array.isArray(config) || Object.keys(config).length > 10) return { error: 'invalid_hosted_config' };
    for (const [key, value] of Object.entries(config)) {
      if (typeof value !== 'string' || value.length > 200 || key.length > 60) return { error: 'invalid_hosted_config' };
    }
    if (/(secret|private|password|passwd|card_?number|cvv|cvc|pan)/i.test(JSON.stringify(config))) return { error: 'hosted_config_must_be_public' };
    hostedConfig = config;
  }
  const sortOrder = Number.isInteger(body.sortOrder) && body.sortOrder >= 0 && body.sortOrder <= 1000 ? body.sortOrder : 0;
  return {
    row: { kind, mode, provider, label_ar: labelAr, label_en: labelEn, redirect_url: kind === 'cod' ? null : redirectUrl, hosted_config: hostedConfig,
           enabled: body.enabled === false ? false : true, sort_order: sortOrder }
  };
}

/* GET  /api/store-payment-methods[?storeId=]  — the store's payment methods (a store admin sees only its own store).
   POST /api/store-payment-methods {storeId?, id?, kind, mode?, provider?, labelAr, labelEn?, redirectUrl?, hostedConfig?, enabled?, sortOrder?}
        — add or change one. A method is never deleted (orders keep the snapshot they were approved with): turn it off with enabled:false.
   An order takes its payment options when the store approves it; a later change here never touches an order already approved. */
module.exports = async function storePaymentMethods(req, res) {
  if (req.method !== 'GET' && req.method !== 'POST') return reply(res, 405, { ok: false, error: 'method_not_allowed' });
  try {
    const context = requireRoles(await getContext(req), ['store_admin', 'platform_admin']);
    if (context.error) return reply(res, context.status, { ok: false, error: context.error });
    const query = req.query || {};
    const body = req.body && typeof req.body === 'object' ? req.body : {};
    const requested = String((req.method === 'GET' ? query.storeId : body.storeId) || '').trim();
    const store = await resolveStore(context, requested);
    if (store.error) return reply(res, store.status, { ok: false, error: store.error });

    if (req.method === 'GET') {
      const params = new URLSearchParams({ select: COLUMNS, store_id: `eq.${store.storeId}`, order: 'sort_order.asc,created_at.asc' });
      const response = await fetch(`${context.supabaseUrl}/rest/v1/store_payment_methods?${params}`, { headers: headers(context) });
      let rows;
      try { rows = await response.json(); } catch (_) { rows = null; }
      if (!response.ok || !Array.isArray(rows)) return reply(res, 502, { ok: false, error: 'supabase_read_failed' });
      return reply(res, 200, { ok: true, storeId: store.storeId, methods: rows });
    }

    const parsed = parseMethod(body);
    if (parsed.error) return reply(res, 400, { ok: false, error: parsed.error });
    const id = String(body.id || '');
    if (id && !UUID.test(id)) return reply(res, 400, { ok: false, error: 'invalid_method' });
    const row = { ...parsed.row, store_id: store.storeId };
    let response;
    if (id) {
      const params = new URLSearchParams({ id: `eq.${id}`, store_id: `eq.${store.storeId}`, select: COLUMNS });
      response = await fetch(`${context.supabaseUrl}/rest/v1/store_payment_methods?${params}`, { method: 'PATCH', headers: headers(context, { 'Content-Type': 'application/json', Prefer: 'return=representation' }), body: JSON.stringify(row) });
    } else {
      response = await fetch(`${context.supabaseUrl}/rest/v1/store_payment_methods?on_conflict=store_id,kind,provider&select=${COLUMNS}`, { method: 'POST', headers: headers(context, { 'Content-Type': 'application/json', Prefer: 'resolution=merge-duplicates,return=representation' }), body: JSON.stringify(row) });
    }
    let saved;
    try { saved = await response.json(); } catch (_) { saved = null; }
    if (!response.ok) {
      const message = `${saved && saved.message || ''}`;
      if (/store_payment_methods_(cod_has_no_page|online_has_page|hosted_is_public)|check constraint|violates/i.test(message)) return reply(res, 422, { ok: false, error: 'invalid_payment_method' });
      console.error('store-payment-methods: save failed', saved && saved.code, message.slice(0, 300));
      return reply(res, 502, { ok: false, error: 'payment_method_save_failed' });
    }
    if (!Array.isArray(saved) || !saved[0]) return reply(res, 404, { ok: false, error: 'method_not_found' });
    return reply(res, 200, { ok: true, method: saved[0] });
  } catch (_) {
    return reply(res, 502, { ok: false, error: 'payment_methods_failed' });
  }
};
