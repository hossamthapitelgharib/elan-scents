/* Élan Scents — authenticated data provider for editor tools.
   Uses the attached admin session and Supabase service role only on the server. */
const crypto = require('crypto');
const { getContext, requireRoles } = require('../api/_auth');

function reply(res, status, body) {
  res.status(status).setHeader('Content-Type', 'application/json; charset=utf-8').setHeader('Cache-Control', 'no-store').json(body);
}

function bodyOf(req) {
  const b = req.body;
  return b && typeof b === 'object' && !Array.isArray(b) ? b : {};
}

function canonical(value) {
  if (Array.isArray(value)) return value.map(canonical);
  if (!value || typeof value !== 'object') return value;
  return Object.keys(value).sort().reduce((out, key) => { out[key] = canonical(value[key]); return out; }, {});
}

function same(a, b) { return JSON.stringify(canonical(a)) === JSON.stringify(canonical(b)); }

function libraryRevision(archive, savedElements) {
  const stable = {
    archive: archive.slice().sort((a, b) => String(a.id).localeCompare(String(b.id))),
    savedElements: savedElements.slice().sort((a, b) => String(a.id).localeCompare(String(b.id)))
  };
  return crypto.createHash('sha256').update(JSON.stringify(stable)).digest('hex');
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
  const search = String(filters && filters.search || '').trim().toLocaleLowerCase();
  const byId = new Map(products.filter((p) => !brand || p.brand_id === brand).map((p) => [String(p.id), p]));
  for (const s of sizes) {
    const p = byId.get(String(s.product_id));
    if (!p || (search && !String(p.name || '').toLocaleLowerCase().includes(search))) continue;
    if (size != null && s.size_ml !== size) continue;
    rows.push({ product_id: p.id, product_size_id: s.id, name: p.name, size_label: s.size_label || (s.size_ml ? String(s.size_ml) + ' ml' : null) });
  }
  return rows.slice(0, 2000);
}

async function library(ctx) {
  const [media, archive, saved] = await Promise.all([
    sb(ctx, 'media_library', '?select=id,file_url,file_type,title,category,source,alt_text,created_at&order=created_at.desc,id.asc&limit=1000'),
    sb(ctx, 'editor_archive', '?select=id,element_id,kind,name,payload,archived_reason,archived_at&order=archived_at.desc,id.asc&limit=1000'),
    sb(ctx, 'editor_saved_elements', '?select=id,name,kind,category,payload,created_at&order=created_at.desc,id.asc&limit=1000')
  ]);
  const result = {
    media: media.map((m) => ({ id: m.id, name: m.title || m.alt_text || m.id, src: m.file_url, type: m.file_type || 'image', category: m.category || 'general', source: m.source || null, created_at: m.created_at || null })),
    archive,
    savedElements: saved
  };
  // Media uploads are persisted independently; the revision guards archive and saved-element edits.
  result.revision = libraryRevision(result.archive, result.savedElements);
  return result;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
function objectPayload(value, fallback) {
  const payload = value && typeof value === 'object' && !Array.isArray(value) ? value : fallback;
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) throw Object.assign(new Error('invalid_library_payload'), { status: 400 });
  if (JSON.stringify(payload).length > 800000) throw Object.assign(new Error('library_too_large'), { status: 400 });
  return payload;
}
function bounded(value, fallback, max) { return String(value == null ? fallback : value).trim().slice(0, max); }

function normalizeSectionFilters(value) {
  if (value == null) return {};
  if (typeof value !== 'object' || Array.isArray(value)) throw Object.assign(new Error('invalid_section_filters'), { status: 400 });
  const allowed = new Set(['brand', 'store', 'cat', 'occ', 'note', 'flag', 'min', 'max', 'sort', 'limit']);
  const out = {};
  for (const [key, raw] of Object.entries(value)) {
    if (!allowed.has(key)) throw Object.assign(new Error('invalid_section_filter'), { status: 400 });
    if (key === 'min' || key === 'max') {
      if (raw === '' || raw == null) continue;
      const number = Number(raw);
      if (!Number.isFinite(number) || number < 0 || number > 10000000) throw Object.assign(new Error('invalid_section_filter'), { status: 400 });
      out[key] = number;
    } else if (key === 'limit') {
      const number = Number(raw);
      if (!Number.isInteger(number) || number < 1 || number > 24) throw Object.assign(new Error('invalid_section_filter'), { status: 400 });
      out[key] = number;
    } else if (key === 'sort') {
      if (!['relevance', 'price_asc', 'price_desc'].includes(raw)) throw Object.assign(new Error('invalid_section_filter'), { status: 400 });
      if (raw !== 'relevance') out[key] = raw;
    } else {
      const text = bounded(raw, '', 120);
      if (!text) throw Object.assign(new Error('invalid_section_filter'), { status: 400 });
      out[key] = text;
    }
  }
  return out;
}

function normalizeArchive(item) {
  if (!item || typeof item !== 'object' || Array.isArray(item)) throw Object.assign(new Error('invalid_archive_item'), { status: 400 });
  const id = UUID.test(String(item.id || '')) ? String(item.id) : null;
  const elementId = bounded(item.element_id || (!id && item.id) || '', '', 200);
  if (!elementId) throw Object.assign(new Error('archive_element_id_required'), { status: 400 });
  return {
    id,
    row: {
      element_id: elementId,
      kind: bounded(item.kind, 'element', 80) || 'element',
      name: item.name == null ? null : bounded(item.name, '', 300) || null,
      payload: objectPayload(item.payload, item)
    }
  };
}

function normalizeSaved(item) {
  if (!item || typeof item !== 'object' || Array.isArray(item)) throw Object.assign(new Error('invalid_saved_element'), { status: 400 });
  return {
    id: UUID.test(String(item.id || '')) ? String(item.id) : null,
    row: {
      name: bounded(item.name || item.id, 'عنصر', 300) || 'عنصر',
      kind: bounded(item.kind, 'element', 80) || 'element',
      category: item.category == null ? null : bounded(item.category, '', 100) || null,
      payload: objectPayload(item.payload, item)
    }
  };
}

async function mergeArchive(ctx, incoming, current) {
  for (const item of incoming) {
    const normalized = normalizeArchive(item);
    const { id, row } = normalized;
    let existing = id ? current.find((x) => x.id === id) : null;
    if (id && !existing) throw Object.assign(new Error('unknown_archive_id'), { status: 400 });
    if (!existing) existing = current.find((x) => x.element_id === row.element_id);
    const comparable = (x) => ({ element_id: x.element_id, kind: x.kind, name: x.name || null, payload: x.payload });
    if (existing) {
      if (!same(comparable(existing), row)) {
        await sb(ctx, 'editor_archive', '?id=eq.' + encodeURIComponent(existing.id), 'PATCH', row);
        Object.assign(existing, row);
      }
      continue;
    }
    const duplicate = current.find((x) => same(comparable(x), row));
    if (duplicate) continue;
    const inserted = await sb(ctx, 'editor_archive', '', 'POST', [row]);
    if (Array.isArray(inserted) && inserted[0]) current.push(inserted[0]);
  }
}

async function mergeSaved(ctx, incoming, current) {
  for (const item of incoming) {
    const normalized = normalizeSaved(item);
    const { id, row } = normalized;
    let existing = id ? current.find((x) => x.id === id) : null;
    if (id && !existing) throw Object.assign(new Error('unknown_saved_element_id'), { status: 400 });
    const comparable = (x) => ({ name: x.name, kind: x.kind, category: x.category || null, payload: x.payload });
    if (existing) {
      if (!same(comparable(existing), row)) {
        await sb(ctx, 'editor_saved_elements', '?id=eq.' + encodeURIComponent(existing.id), 'PATCH', row);
        Object.assign(existing, row);
      }
      continue;
    }
    if (current.some((x) => same(comparable(x), row))) continue;
    const inserted = await sb(ctx, 'editor_saved_elements', '', 'POST', [row]);
    if (Array.isArray(inserted) && inserted[0]) current.push(inserted[0]);
  }
}

async function saveLibrary(ctx, input) {
  const data = input && input.library;
  if (!data || typeof data !== 'object' || Array.isArray(data)) throw Object.assign(new Error('invalid_library'), { status: 400 });
  const expected = String(input.expectedRevision || data.expectedRevision || '');
  if (!/^[a-f0-9]{64}$/i.test(expected)) throw Object.assign(new Error('library_revision_required'), { status: 428 });
  const current = await library(ctx);
  if (expected !== current.revision) throw Object.assign(new Error('library_revision_conflict'), { status: 409 });
  const archive = Array.isArray(data.archive) ? data.archive.slice(0, 1000) : [];
  const saved = Array.isArray(data.savedElements) ? data.savedElements.slice(0, 1000) : [];
  if (JSON.stringify({ archive, saved }).length > 800000) throw Object.assign(new Error('library_too_large'), { status: 400 });
  // Merge by identity; absence from a client snapshot never means delete from shared storage.
  await mergeArchive(ctx, archive, current.archive);
  await mergeSaved(ctx, saved, current.savedElements);
  return { ok: true, revision: (await library(ctx)).revision };
}

async function createSection(ctx, input) {
  const section = input && input.section;
  const name = String(section && section.name || '').trim().slice(0, 200);
  if (!name) throw Object.assign(new Error('section_name_required'), { status: 400 });
  const requestedId = section && section.element_id;
  if (requestedId != null && (typeof requestedId !== 'string' || !/^x-[a-z0-9_-]{1,36}$/i.test(requestedId))) throw Object.assign(new Error('invalid_section_element_id'), { status: 400 });
  const elementId = requestedId || ('x-' + crypto.randomUUID().replace(/-/g, ''));
  const mode = section.selection_mode == null ? 'auto' : section.selection_mode;
  if (!['auto', 'manual'].includes(mode)) throw Object.assign(new Error('invalid_section_selection_mode'), { status: 400 });
  const purpose = bounded(section.purpose, '', 80);
  if (!['section', 'brand', 'store', 'perfume', 'occasion', 'note'].includes(purpose)) throw Object.assign(new Error('invalid_section_purpose'), { status: 400 });
  const filters = normalizeSectionFilters(section.filters);
  const productSizeIds = Array.isArray(section.product_size_ids) ? Array.from(new Set(section.product_size_ids)) : [];
  if (productSizeIds.length > 24 || productSizeIds.some((id) => typeof id !== 'string' || !UUID.test(id))) throw Object.assign(new Error('invalid_section_items'), { status: 400 });
  if (mode === 'manual' && !productSizeIds.length) throw Object.assign(new Error('manual_section_items_required'), { status: 400 });
  if (mode === 'auto' && productSizeIds.length) throw Object.assign(new Error('auto_section_cannot_have_manual_items'), { status: 400 });
  if (mode === 'manual') {
    const available = new Set((await perfumes(ctx, {})).map((row) => row.product_size_id));
    if (productSizeIds.some((id) => !available.has(id))) throw Object.assign(new Error('section_item_not_available'), { status: 400 });
  }
  const rows = await sb(ctx, 'editor_sections', '', 'POST', [{
    element_id: elementId,
    name,
    purpose,
    selection_mode: mode,
    filters,
    timer_mode: 'none',
    status: 'active'
  }]);
  const created = Array.isArray(rows) ? rows[0] : null;
  if (!created || !created.id) throw Object.assign(new Error('section_create_unconfirmed'), { status: 502 });
  if (productSizeIds.length) {
    try {
      const items = await sb(ctx, 'editor_section_items', '', 'POST', productSizeIds.map((productSizeId, sortOrder) => ({ section_id: created.id, product_size_id: productSizeId, sort_order: sortOrder })));
      if (!Array.isArray(items) || items.length !== productSizeIds.length) throw Object.assign(new Error('section_items_unconfirmed'), { status: 502 });
    } catch (error) {
      try { await sb(ctx, 'editor_sections', '?id=eq.' + encodeURIComponent(created.id), 'DELETE'); } catch (_) { /* rollback is best effort and scoped to the row just created */ }
      throw error;
    }
  }
  return { ok: true, ref: elementId, section: created, itemCount: productSizeIds.length };
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
    if (action === 'library.save' && req.method === 'POST') return reply(res, 200, await saveLibrary(ctx, input));
    if (action === 'section.create' && req.method === 'POST') return reply(res, 200, await createSection(ctx, input));
    return reply(res, 400, { ok: false, error: 'unknown_action' });
  } catch (e) {
    reply(res, e.status || 502, { ok: false, error: e.message === 'supabase_request_failed' ? 'data_provider_failed' : (e.message || 'editor_data_failed') });
  }
};
