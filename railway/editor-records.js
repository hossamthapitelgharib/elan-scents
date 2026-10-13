/* Élan Scents — real records created from the visual editor (brands and stores for now).
   Runs ONLY when the owner presses Save, after the admin session is checked. It matches an existing record by
   name (no duplicates) or creates it once, using the admin's own Supabase token so database policies still apply.
   No prices, stock or orders are ever touched here. */
const KINDS = {
  brand: { table: 'brands', slug: true, cols: ['name', 'slug', 'official_logo_url', 'description'], image: 'official_logo_url' },
  store: { table: 'stores', slug: true, cols: ['name', 'slug', 'logo_url', 'short_description'], image: 'logo_url' }
};
const NAME_RE = /^[^\u0000-\u001f<>]{2,80}$/u;

function norm(s) { return String(s || '').normalize('NFKC').toLowerCase().replace(/\s+/g, ' ').trim(); }
function slugOf(name) {
  const base = norm(name).replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 50);
  return base || ('x-' + Buffer.from(norm(name)).toString('hex').slice(0, 12));
}
/* Pictures may only come from this site's own folder or its media bucket. */
function imageOk(u, env) {
  if (u === undefined || u === null || u === '') return true;
  if (typeof u !== 'string' || u.length > 500) return false;
  if (/^\/assets\/[\w./-]+$/.test(u) && u.indexOf('..') === -1) return true;
  const base = String(env.SUPABASE_URL || '').replace(/\/+$/, '') + '/storage/v1/object/public/site-media/';
  return !!env.SUPABASE_URL && u.indexOf(base) === 0 && /^[\w./%-]+$/.test(u.slice(base.length));
}

async function rest(env, token, method, path, body) {
  const r = await fetch(String(env.SUPABASE_URL).replace(/\/+$/, '') + '/rest/v1/' + path, {
    method,
    headers: { apikey: env.SUPABASE_ANON_KEY, Authorization: 'Bearer ' + token, 'Content-Type': 'application/json', Prefer: 'return=representation' },
    body: body === undefined ? undefined : JSON.stringify(body)
  });
  let json = null; try { json = await r.json(); } catch (_) { /* empty */ }
  return { ok: r.ok, status: r.status, json };
}
const ilike = (v) => encodeURIComponent(String(v).replace(/[%*_\\]/g, '\\$&'));

async function findByName(env, token, kind, name) {
  const k = KINDS[kind];
  const r = await rest(env, token, 'GET', k.table + '?select=id,name,slug,' + k.image + '&name=ilike.' + ilike(name) + '&limit=5');
  if (!r.ok) return { error: 'database_unavailable' };
  const hit = (r.json || []).filter((x) => norm(x.name) === norm(name))[0];
  return { hit: hit || null };
}

async function search(env, token, body) {
  if (!KINDS[body.kind]) return { status: 400, body: { ok: false, error: 'invalid_request' } };
  const q = String(body.q || '').trim().slice(0, 80);
  if (q.length < 1) return { status: 200, body: { ok: true, matches: [] } };
  const k = KINDS[body.kind];
  const r = await rest(env, token, 'GET', k.table + '?select=id,name,' + k.image + '&name=ilike.*' + ilike(q) + '*&order=name.asc&limit=8');
  if (!r.ok) return { status: 502, body: { ok: false, error: 'database_unavailable' } };
  return { status: 200, body: { ok: true, matches: (r.json || []).map((x) => ({ id: x.id, name: x.name, image: x[k.image] || null })) } };
}

async function sync(env, token, body) {
  const drafts = Array.isArray(body.drafts) ? body.drafts : null;
  if (!drafts || !drafts.length || drafts.length > 20) return { status: 400, body: { ok: false, error: 'invalid_request' } };
  const results = [];
  for (const d of drafts) {
    const k = d && KINDS[d.kind];
    if (!k || typeof d.name !== 'string' || !NAME_RE.test(d.name.trim()) || !imageOk(d.image, env)) return { status: 400, body: { ok: false, error: 'invalid_draft', results } };
    const name = d.name.trim().replace(/\s+/g, ' ');
    const found = await findByName(env, token, d.kind, name);
    if (found.error) return { status: 502, body: { ok: false, error: found.error, results } };
    if (found.hit) { results.push({ kind: d.kind, name: found.hit.name, id: found.hit.id, status: 'matched' }); continue; }
    const row = { name };
    if (k.slug) {
      let slug = slugOf(name), n = 1;
      for (;;) {
        const t = await rest(env, token, 'GET', k.table + '?select=id&slug=eq.' + encodeURIComponent(slug) + '&limit=1');
        if (!t.ok) return { status: 502, body: { ok: false, error: 'database_unavailable', results } };
        if (!(t.json || []).length) break;
        slug = slugOf(name) + '-' + (++n);
      }
      row.slug = slug;
    }
    if (d.image) row[k.image] = d.image;
    const ins = await rest(env, token, 'POST', k.table, row);
    if (!ins.ok) return { status: ins.status === 401 || ins.status === 403 ? 403 : 502, body: { ok: false, error: ins.status === 401 || ins.status === 403 ? 'forbidden' : 'database_rejected', results } };
    const made = Array.isArray(ins.json) ? ins.json[0] : ins.json;
    results.push({ kind: d.kind, name, id: made && made.id, status: 'created' });
  }
  return { status: 200, body: { ok: true, results } };
}

async function handle(env, token, body) {
  if (!body || typeof body !== 'object') return { status: 400, body: { ok: false, error: 'invalid_request' } };
  if (!env.SUPABASE_URL || !env.SUPABASE_ANON_KEY) return { status: 503, body: { ok: false, error: 'supabase_service_configuration_missing' } };
  if (body.action === 'search') return search(env, token, body);
  if (body.action === 'sync') return sync(env, token, body);
  return { status: 400, body: { ok: false, error: 'invalid_request' } };
}

module.exports = { handle, norm, slugOf, imageOk, KINDS };
