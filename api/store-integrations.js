const { safeEqual } = require('../lib/secure');
function reply(res, status, body) {
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
  try { return raw ? JSON.parse(raw) : null; } catch (_) { return { raw }; }
}

module.exports = async function storeIntegrations(req, res) {
  if (!auth(req, res)) return;
  const { url, key } = supabase();
  if (!url || !key) { reply(res, 503, { ok: false, error: 'supabase_service_configuration_missing' }); return; }

  try {
    if (req.method === 'GET') {
      const [storesResponse, settingsResponse] = await Promise.all([
        fetch(`${url}/rest/v1/public_stores?select=id,name,short_description&order=name.asc`, { headers: { apikey: key, Authorization: `Bearer ${key}` } }),
        fetch(`${url}/rest/v1/site_settings?key=eq.store_integrations&select=value`, { headers: { apikey: key, Authorization: `Bearer ${key}` } }),
      ]);
      const stores = await readJson(storesResponse);
      const settings = await readJson(settingsResponse);
      if (!storesResponse.ok || !settingsResponse.ok) { reply(res, 502, { ok: false, error: 'store_settings_read_failed' }); return; }
      let integrations = {};
      try { integrations = JSON.parse(Array.isArray(settings) && settings[0] ? settings[0].value : '{}') || {}; } catch (_) {}
      const result = (Array.isArray(stores) ? stores : []).map((store) => {
        const saved = integrations[store.name] || {};
        return {
          id: store.id,
          name: store.name,
          shortDescription: store.short_description || '',
          enabled: saved.enabled !== false,
          baseUrl: saved.baseUrl || '',
          cartUrl: saved.cartUrl || '',
          apiBaseUrl: saved.apiBaseUrl || '',
          catalogEndpoint: saved.catalogEndpoint || '',
          webhookUrl: `${req.headers['x-forwarded-proto'] || 'https'}://${req.headers.host || ''}/api/store-order-status`,
          apiKey: '',
          webhookSecret: '',
          apiKeyMasked: mask(saved.apiKey),
          webhookSecretMasked: mask(saved.webhookSecret),
          hasApiKey: Boolean(saved.apiKey),
          hasWebhookSecret: Boolean(saved.webhookSecret),
          notes: saved.notes || '',
        };
      });
      reply(res, 200, { ok: true, stores: result });
      return;
    }

    if (req.method !== 'PUT') { reply(res, 405, { ok: false, error: 'method_not_allowed' }); return; }
    const body = req.body && typeof req.body === 'object' ? req.body : {};
    if (!Array.isArray(body.stores)) { reply(res, 400, { ok: false, error: 'stores_array_required' }); return; }

    const currentResponse = await fetch(`${url}/rest/v1/site_settings?key=eq.store_integrations&select=value`, { headers: { apikey: key, Authorization: `Bearer ${key}` } });
    const current = await readJson(currentResponse);
    let integrations = {};
    try { integrations = JSON.parse(Array.isArray(current) && current[0] ? current[0].value : '{}') || {}; } catch (_) {}
    body.stores.forEach((item) => {
      if (!item.name) return;
      const previous = integrations[item.name] || {};
      integrations[item.name] = {
        enabled: item.enabled !== false,
        baseUrl: String(item.baseUrl || '').trim(),
        cartUrl: String(item.cartUrl || '').trim(),
        apiBaseUrl: String(item.apiBaseUrl || '').trim(),
        catalogEndpoint: String(item.catalogEndpoint || '').trim(),
        apiKey: String(item.apiKey || '').trim() || previous.apiKey || '',
        webhookSecret: String(item.webhookSecret || '').trim() || previous.webhookSecret || '',
        notes: String(item.notes || '').trim(),
        updatedAt: new Date().toISOString(),
      };
    });
    const response = await fetch(`${url}/rest/v1/site_settings`, {
      method: 'POST',
      headers: { apikey: key, Authorization: `Bearer ${key}`, 'Content-Type': 'application/json', Prefer: 'resolution=merge-duplicates,return=minimal' },
      body: JSON.stringify({ key: 'store_integrations', value: JSON.stringify(integrations) }),
    });
    if (!response.ok) { reply(res, 502, { ok: false, error: 'store_settings_save_failed', details: await readJson(response) }); return; }
    reply(res, 200, { ok: true, saved: body.stores.map((x) => x.name).filter(Boolean) });
  } catch (_) {
    reply(res, 502, { ok: false, error: 'store_settings_request_failed' });
  }
};
