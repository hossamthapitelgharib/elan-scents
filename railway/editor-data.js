/* Élan Scents — authenticated data provider for editor tools.
   Uses the already-attached admin session and Supabase service role only on the server. */
const crypto = require('crypto');
const { getContext, requireRoles } = require('../api/_auth');

function reply(res, status, body) {
  res.status(status).setHeader('Content-Type', 'application/json; charset=utf-8').setHeader('Cache-Control', 'no-store').json(body);
}

function bodyOf(req) {
  const b = req.body;
  return b && typeof b === 'object' && !Array.isArray(b) ? b : {};
}

async function sb(ctx, table, query, method = 'GET', payload) {
  const url = ctx.supabaseUrl + '/rest/v1/' + table + (query || '');
  const r = await fetch(url, {
    method,
    headers: {
      apikey: ctx.serviceRoleKey,
      Authorization: 'Bearer ' + ctx.serviceRoleKey,
      Accept: 'application/json',
      ...(payload === undefined ? {} : { 'Content-Type': 'application/json', Prefer: 'return=representation' })
    },
    body: payload === undefined ? undefined : JSON.stringify(payload)
  });
  let data = null;
  try { data = await r.json(); } catch (_) { /* empty */ }
  if (!r.ok) throw Object.assign(new Error('supabase_request_failed'), { status: 502, detail: data });
  return data;
}

async function options(ctx) {
  const [brands, stores, categories, occasions, notes] = await Promise.all([
    sb(ctx, 'brands', '?select=id,name&is_active=eq.true&order=name.asc&limit=500'),
    sb(ctx, 'stores', '?select=id,name&status=eq.active&order=name.asc&limit=500'),
    sb(ctx, 'categories', '?select=id,name&order=name.asc&limit=500'),
    sb(ctx, 'occasions', '?select=id,name&order=name.asc&limit=500'),
    sb(ctx, 'aromatic_notes', '?select=id,name&order=name.asc&limit=500')
  ]);
  const sizes = await sb(ctx, 'product_sizes', '?select=size_ml&size_ml=not.is.null&order=size_ml.asc&limit=500');
  return { brands, stores, categories, occasions, notes, sizes: sizes.filter((x) => x.size_ml != null) };
}

async function perfumes(ctx, filters) {
  const products = await sb(ctx, 'products', '?select=id,name,brand_id,status,is_active&status=eq.published&is_active=eq.true&order=name.asc&limit=1000');
  const sizes = await sb(ctx, 'product_sizes', '?select=id,product_id,size_ml,size_label&order=size_ml.asc&limit=2000');
  const rows = [];
  const brand = filters && filters.brand_id ? String(filters.brand_id) : null;
  const size = filters && filters.size_ml != null ? Number(filters.size_ml) : null;
  const productIds = new Set(products.filter((p) => !brand || p.brand_id === brand).map((p) => p.id));
  for (const s of sizes) {
    if (!productIds.has(s.product_id)) continue;
    if (size != null && s.size_ml !== size) continue;
    const p = products.find((x) => x.id === s.product_id);
    if (p) rows.push({ product_id: p.id, product_size_id: s.id, name: p.name, size_label: s.size_label || (s.size_ml ? String(s.size_ml) + ' ml' : null) });
  }
  return rows.slice(0, 2000);
}

async function library(ctx) {
  const [media, archive, saved] = await Promise.all([
    sb(ctx, 'media_library', '?select=id,file_url,file_type,title,category,source,alt_text,created_at&order=created_at.desc&limit=1000'),
    sb(ctx, 'editor_archive', '?select=id,element_id,kind,name,payload,archived_reason,archived_at&order=archived_at.desc&limit=1000'),
    sb(ctx, 'editor_saved_elements', '?select=id,name,kind,category,payload,created_at&order=created_at.desc&limit=1000')
  ]);
  return {
    media: media.map((m) => ({ id: m.id, name: m.title || m.alt_text || m.id, src: m.file_url, type: m.file_type || 'image', category: m.category || 'general', source: m.source || null })),
    archive,
    savedElements: saved
  };
}

async function saveLibrary(ctx, data) {
  if (!data || typeof data !== 'object') throw Object.assign(new Error('invalid_library'), { status: 400 });
  const archive = Array.isArray(data.archive) ? data.archive.slice(0, 1000) : [];
  const saved = Array.isArray(data.savedElements) ? data.savedElements.slice(0, 1000) : [];
  if (JSON.stringify({ archive, saved }).length > 800000) throw Object.assign(new Error('library_too_large'), { status: 400 });
  await sb(ctx, 'editor_archive', '?id=not.is.null', 'DELETE');
  await sb(ctx, 'editor_saved_elements', '?id=not.is.null', 'DELETE');
  if (archive.length) await sb(ctx, 'editor_archive', '', 'POST', archive.map((x) => ({ element_id: String(x.element_id || x.id || '').slice(0, 200), kind: String(x.kind || 'element').slice(0, 80), name: x.name ? String(x.name).slice(0, 300) : null, payload: x.payload && typeof x.payload === 'object' ? x.payload : x })));
  if (saved.length) await sb(ctx, 'editor_saved_elements', '', 'POST', saved.map((x) => ({ name: String(x.name || x.id || 'عنصر').slice(0, 300), kind: String(x.kind || 'element').slice(0, 80), category: x.category ? String(x.category).slice(0, 100) : null, payload: x.payload && typeof x.payload === 'object' ? x.payload : x })));
  return { ok: true };
}

async function createSection(ctx, input) {
  const section = input && input.section;
  const name = String(section && section.name || '').trim().slice(0, 200);
  if (!name) throw Object.assign(new Error('section_name_required'), { status: 400 });
  const elementId = 'x-' + crypto.randomUUID().replace(/-/g, '');
  const mode = section.selection_mode === 'auto' ? 'auto' : 'manual';
  const rows = await sb(ctx, 'editor_sections', '', 'POST', [{
    element_id: elementId,
    name,
    purpose: String(section.purpose || '').slice(0, 500) || null,
    selection_mode: mode,
    filters: section.filters && typeof section.filters === 'object' ? section.filters : {},
    timer_mode: 'none',
    status: 'active'
  }]);
  return { ok: true, ref: elementId, section: Array.isArray(rows) ? rows[0] : null };
}

module.exports = async function editorData(req, res) {
  if (req.method !== 'GET' && req.method !== 'POST') return reply(res, 405, { ok: false, error: 'method_not_allowed' });
  try {
    const ctx = requireRoles(await getContext(req), ['platform_admin']);
    if (ctx.error) return reply(res, ctx.status, { ok: false, error: ctx.error });
    const input = req.method === 'POST' ? bodyOf(req) : (req.query || {});
    const action = input.action || 'library';
    if (action === 'options') return reply(res, 200, { ok: true, options: await options(ctx) });
    if (action === 'perfumes') return reply(res, 200, { ok: true, rows: await perfumes(ctx, input.filters || {}) });
    if (action === 'library' && req.method === 'GET') return reply(res, 200, { ok: true, library: await library(ctx) });
    if (action === 'library.save' && req.method === 'POST') return reply(res, 200, await saveLibrary(ctx, input.library));
    if (action === 'section.create' && req.method === 'POST') return reply(res, 200, await createSection(ctx, input));
    return reply(res, 400, { ok: false, error: 'unknown_action' });
  } catch (e) {
    reply(res, e.status || 502, { ok: false, error: e.message === 'supabase_request_failed' ? 'data_provider_failed' : (e.message || 'editor_data_failed') });
  }
};
