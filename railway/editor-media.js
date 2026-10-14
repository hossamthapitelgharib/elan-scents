/* Élan Scents — media for the owner editor: list the library and upload an image.
   Runs with the admin's own Supabase session (kept on the server), so the database and storage rules decide what is allowed.
   No service key is used here. */
const crypto = require('crypto');

const BUCKET = 'site-media';
const MAX_BYTES = 10 * 1024 * 1024;
const TYPES = { 'image/jpeg': 'jpg', 'image/png': 'png', 'image/webp': 'webp', 'image/gif': 'gif', 'image/avif': 'avif' };

function cfg() { return { url: String(process.env.SUPABASE_URL || '').replace(/\/+$/, ''), anon: process.env.SUPABASE_ANON_KEY }; }
function headers(session, extra) { return Object.assign({ apikey: cfg().anon, Authorization: 'Bearer ' + session.token }, extra || {}); }

/* The bytes must really be the image type that was claimed. */
function looksLike(buf, type) {
  if (!buf || buf.length < 12) return false;
  if (type === 'image/jpeg') return buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff;
  if (type === 'image/png') return buf.slice(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]));
  if (type === 'image/gif') return buf.slice(0, 4).toString('latin1') === 'GIF8';
  if (type === 'image/webp') return buf.slice(0, 4).toString('latin1') === 'RIFF' && buf.slice(8, 12).toString('latin1') === 'WEBP';
  if (type === 'image/avif') return buf.slice(4, 12).toString('latin1') === 'ftypavif';
  return false;
}

async function list(session, offset) {
  const c = cfg();
  if (!c.url || !c.anon) return { status: 503, error: 'supabase_service_configuration_missing' };
  const off = Math.max(0, Math.min(10000, Number(offset) || 0));
  let r;
  try { r = await fetch(c.url + '/rest/v1/media_library?select=id,file_url,title,category&file_type=eq.image&order=created_at.desc&limit=24&offset=' + off, { headers: headers(session) }); }
  catch (_) { return { status: 502, error: 'library_unreachable' }; }
  if (!r.ok) return { status: r.status === 401 || r.status === 403 ? r.status : 502, error: 'library_failed' };
  const rows = await r.json().catch(() => []);
  return { status: 200, items: (Array.isArray(rows) ? rows : []).map((x) => ({ id: x.id, url: x.file_url, title: x.title || '', category: x.category || '' })) };
}

async function upload(session, buf, type, fileName) {
  const c = cfg();
  if (!c.url || !c.anon) return { status: 503, error: 'supabase_service_configuration_missing' };
  const ext = TYPES[type];
  if (!ext) return { status: 415, error: 'unsupported_type' };
  if (!buf || !buf.length) return { status: 400, error: 'empty_file' };
  if (buf.length > MAX_BYTES) return { status: 413, error: 'file_too_large' };
  if (!looksLike(buf, type)) return { status: 415, error: 'file_does_not_match_type' };
  const path = 'uploads/' + new Date().getUTCFullYear() + '/' + crypto.randomBytes(10).toString('hex') + '.' + ext;
  let up;
  try { up = await fetch(c.url + '/storage/v1/object/' + BUCKET + '/' + path, { method: 'POST', headers: headers(session, { 'Content-Type': type, 'x-upsert': 'false' }), body: buf }); }
  catch (_) { return { status: 502, error: 'storage_unreachable' }; }
  if (!up.ok) return { status: up.status === 401 || up.status === 403 ? up.status : 502, error: 'upload_failed' };
  const url = c.url + '/storage/v1/object/public/' + BUCKET + '/' + path;
  let row;
  try {
    row = await fetch(c.url + '/rest/v1/media_library', {
      method: 'POST', headers: headers(session, { 'Content-Type': 'application/json', Prefer: 'return=minimal' }),
      body: JSON.stringify({ file_url: url, file_type: 'image', source: 'device_upload', title: String(fileName || 'صورة').slice(0, 120), category: 'banners', storage_path: path, mime_type: type, size_bytes: buf.length, is_approved: true })
    });
  } catch (_) { return { status: 502, error: 'library_record_failed' }; }
  if (!row.ok) return { status: 502, error: 'library_record_failed' };
  return { status: 200, url };
}

module.exports = { list, upload, looksLike, MAX_BYTES, TYPES };
