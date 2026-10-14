const { safeEqual } = require('../lib/secure');

const MAX_STORES = 1000;
const FIELD_LIMITS = {
  baseUrl: 2048,
  cartUrl: 2048,
  apiBaseUrl: 2048,
  catalogEndpoint: 2048,
  apiKey: 4096,
  webhookSecret: 4096,
  notes: 10000,
};

function reply(res, status, body) {
  res.setHeader('Cache-Control', 'no-store');
  res.status(status).setHeader('Content-Type', 'application/json').json(body);
}

function auth(req, res) {
  const expected = process.env.DASHBOARD_TOKEN;
  if (!expected) { reply(res, 503, { ok: false, error: 'dashboard_token_not_configured' }); return false; }
  if (!safeEqual(String(req.headers['x-dashboard-token'] || ''), expected)) { reply(res, 401, { ok: false, error: 'unauthorized' }); return false; }
  return true;
}

function supabase() {
  return {
    url: process.env.SUPABASE_URL || process.env.NEXT_PUBLIC_SUPABASE_URL,
    key: process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_SECRET_KEY,
  };
}

function mask(value) {
  const text = String(value || '');
  if (!text) return '';
  if (text.length <= 8) return '••••••••';
  return `${text.slice(0, 4)}••••${text.slice(-4)}`;
}

async function readJson(response) {
  const raw = await response.text();
  try { return raw ? JSON.parse(raw) : null; } catch (_) { return null; }
}

function headers(key) {
  return { apikey: key, Authorization: `Bearer ${key}` };
}

async function getRows(url, key) {
  const response = await fetch(url, { headers: headers(key) });
  const data = await readJson(response);
  if (!response.ok || !Array.isArray(data)) throw new Error('store_settings_read_failed');
  return data;
}

async function getLegacySettings(base, key) {
  const params = new URLSearchParams({ key: 'eq.store_integrations', select: 'value', limit: '1' });
  const rows = await getRows(`${base}site_settings?${params}`, key);
  try {
    const parsed = rows[0] && typeof rows[0].value === 'string' ? JSON.parse(rows[0].value) : {};
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {};
  } catch (_) { return {}; }
}

function byStoreIds(base, key, ids) {
  if (!ids.length) return Promise.resolve([]);
  const params = new URLSearchParams({
    select: 'store_id,enabled,base_url,cart_url,api_base_url,catalog_endpoint,api_key,webhook_secret,notes',
    store_id: `in.(${ids.join(',')})`,
    limit: String(MAX_STORES),
  });
  return getRows(`${base}store_integrations?${params}`, key);
}

function tooLong(item) {
  return Object.entries(FIELD_LIMITS).some(([field, max]) => String(item[field] == null ? '' : item[field]).length > max);
}

function clean(value) {
  return String(value == null ? '' : value).trim();
}

module.exports = async function storeIntegrations(req, res) {
  if (!auth(req, res)) return;
  const { url, key } = supabase();
  if (!url || !key) { reply(res, 503, { ok: false, error: 'supabase_service_configuration_missing' }); return; }
  const base = `${url}/rest/v1/`;

  try {
    if (req.method === 'GET') {
      const storeParams = new URLSearchParams({ select: 'id,name,short_description', order: 'name.asc,id.asc', limit: String(MAX_STORES) });
      const stores = await getRows(`${base}public_stores?${storeParams}`, key);
      const [integrations, legacy] = await Promise.all([
        byStoreIds(base, key, stores.map(store => store.id).filter(Boolean)),
        getLegacySettings(base, key),
      ]);
      const savedById = new Map(integrations.map(row => [row.store_id, row]));
      const result = stores.map(store => {
        const row = savedById.get(store.id);
        const saved = row || legacy[store.name] || {};
        const apiKey = row ? row.api_key : saved.api_key || saved.apiKey;
        const webhookSecret = row ? row.webhook_secret : saved.webhook_secret || saved.webhookSecret;
        return {
          id: store.id,
          name: store.name,
          shortDescription: store.short_description || '',
          enabled: saved.enabled !== false,
          baseUrl: row ? row.base_url : saved.base_url || saved.baseUrl || '',
          cartUrl: row ? row.cart_url : saved.cart_url || saved.cartUrl || '',
          apiBaseUrl: row ? row.api_base_url : saved.api_base_url || saved.apiBaseUrl || '',
          catalogEndpoint: row ? row.catalog_endpoint : saved.catalog_endpoint || saved.catalogEndpoint || '',
          webhookUrl: `${req.headers['x-forwarded-proto'] || 'https'}://${req.headers.host || ''}/api/store-order-status`,
          apiKey: '',
          webhookSecret: '',
          apiKeyMasked: mask(apiKey),
          webhookSecretMasked: mask(webhookSecret),
          hasApiKey: Boolean(apiKey),
          hasWebhookSecret: Boolean(webhookSecret),
          notes: row ? row.notes : saved.notes || '',
        };
      });
      reply(res, 200, { ok: true, stores: result });
      return;
    }

    if (req.method !== 'PUT') { reply(res, 405, { ok: false, error: 'method_not_allowed' }); return; }
    const body = req.body && typeof req.body === 'object' ? req.body : {};
    if (!Array.isArray(body.stores) || body.stores.length > MAX_STORES) {
      reply(res, 400, { ok: false, error: 'stores_array_required' });
      return;
    }
    if (!body.stores.length) { reply(res, 200, { ok: true, saved: [] }); return; }
    if (body.stores.some(item => !item || typeof item !== 'object' || !clean(item.name)) || body.stores.some(tooLong)) {
      reply(res, 400, { ok: false, error: 'invalid_store_settings' });
      return;
    }
    const names = body.stores.map(item => clean(item.name));
    if (new Set(names).size !== names.length) { reply(res, 400, { ok: false, error: 'duplicate_store_settings' }); return; }

    const storeParams = new URLSearchParams({ select: 'id,name', name: `in.(${names.map(name => `"${name.replace(/"/g, '\\"')}"`).join(',')})`, limit: String(MAX_STORES) });
    const stores = await getRows(`${base}stores?${storeParams}`, key);
    const storesByName = new Map();
    for (const store of stores) {
      if (storesByName.has(store.name)) { reply(res, 400, { ok: false, error: 'ambiguous_store_name' }); return; }
      storesByName.set(store.name, store);
    }
    if (names.some(name => !storesByName.has(name))) { reply(res, 400, { ok: false, error: 'unknown_store' }); return; }

    const ids = names.map(name => storesByName.get(name).id);
    const [existingRows, legacy] = await Promise.all([
      byStoreIds(base, key, ids),
      getLegacySettings(base, key),
    ]);
    const existingById = new Map(existingRows.map(row => [row.store_id, row]));
    const upserts = body.stores.map(item => {
      const name = clean(item.name), store = storesByName.get(name);
      const existing = existingById.get(store.id);
      const old = existing || legacy[name] || {};
      const previousApiKey = existing ? existing.api_key : old.api_key || old.apiKey;
      const previousWebhookSecret = existing ? existing.webhook_secret : old.webhook_secret || old.webhookSecret;
      return {
        store_id: store.id,
        enabled: item.enabled !== false,
        base_url: clean(item.baseUrl),
        cart_url: clean(item.cartUrl),
        api_base_url: clean(item.apiBaseUrl),
        catalog_endpoint: clean(item.catalogEndpoint),
        api_key: clean(item.apiKey) || previousApiKey || '',
        webhook_secret: clean(item.webhookSecret) || previousWebhookSecret || '',
        notes: clean(item.notes),
        updated_at: new Date().toISOString(),
      };
    });
    const save = await fetch(`${base}store_integrations?on_conflict=store_id`, {
      method: 'POST',
      headers: { ...headers(key), 'Content-Type': 'application/json', Prefer: 'resolution=merge-duplicates,return=minimal' },
      body: JSON.stringify(upserts),
    });
    if (!save.ok) { reply(res, 502, { ok: false, error: 'store_settings_save_failed' }); return; }
    reply(res, 200, { ok: true, saved: names });
  } catch (_) {
    reply(res, 502, { ok: false, error: 'store_settings_request_failed' });
  }
};
