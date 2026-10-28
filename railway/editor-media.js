/* Élan Scents — media for the owner editor: list the library and upload a picture or a video.
   Runs with the admin's own Supabase session (kept on the server), so the database and storage rules decide what is allowed.
   No service key is used here.
   A picture (small) goes through the server. A video goes straight from the browser to Supabase Storage: the server only signs the
   upload (signVideoUpload) and afterwards checks the stored file and records it in the library (finishVideoUpload), so the Worker never
   holds the video in memory and the only size limit is the storage bucket's own. */
const crypto = require('node:crypto');

const BUCKET = 'site-media';
const MAX_BYTES = 10 * 1024 * 1024;            // a picture
/* A video: MP4 (H.264) or WebM, the two types the storage bucket accepts. 50 MB is the bucket's own ceiling (storage.buckets.file_size_limit
   of site-media, which Supabase enforces itself). To allow bigger videos raise that limit in Supabase (it may need a plan that allows it),
   then this number; nothing in the Worker depends on it. */
const MAX_VIDEO_BYTES = 50 * 1024 * 1024;
const VIDEO_PATH = /^uploads\/\d{4}\/[0-9a-f]{20}\.(mp4|webm)$/;
const IMAGE_TYPES = { 'image/jpeg': 'jpg', 'image/png': 'png', 'image/webp': 'webp', 'image/gif': 'gif', 'image/avif': 'avif' };
const VIDEO_TYPES = { 'video/mp4': 'mp4', 'video/webm': 'webm' };
const TYPES = Object.assign({}, IMAGE_TYPES, VIDEO_TYPES);
const kindOf = (type) => (VIDEO_TYPES[type] ? 'video' : IMAGE_TYPES[type] ? 'image' : null);
const limitFor = (type) => (kindOf(type) === 'video' ? MAX_VIDEO_BYTES : MAX_BYTES);
/* MP4 files whose first box declares one of these brands are plain video (not an AVIF/HEIC picture or audio-only file). */
const MP4_BRANDS = ['isom', 'iso2', 'iso3', 'iso4', 'iso5', 'iso6', 'mp41', 'mp42', 'avc1', 'dash', 'msdh', 'msnv', 'M4V '];

function cfg() { return { url: String(process.env.SUPABASE_URL || '').replace(/\/+$/, ''), anon: process.env.SUPABASE_ANON_KEY }; }
function headers(session, extra) { return Object.assign({ apikey: cfg().anon, Authorization: 'Bearer ' + session.token }, extra || {}); }

/* The bytes must really be the type (picture or video) that was claimed. */
function looksLike(buf, type) {
  if (!buf || buf.length < 12) return false;
  if (type === 'image/jpeg') return buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff;
  if (type === 'image/png') return buf.slice(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]));
  if (type === 'image/gif') return buf.slice(0, 4).toString('latin1') === 'GIF8';
  if (type === 'image/webp') return buf.slice(0, 4).toString('latin1') === 'RIFF' && buf.slice(8, 12).toString('latin1') === 'WEBP';
  if (type === 'image/avif') return buf.slice(4, 12).toString('latin1') === 'ftypavif';
  if (type === 'video/mp4') return buf.slice(4, 8).toString('latin1') === 'ftyp' && MP4_BRANDS.indexOf(buf.slice(8, 12).toString('latin1')) !== -1;
  /* WebM is a Matroska (EBML) file whose header names the "webm" document type. */
  if (type === 'video/webm') return buf[0] === 0x1a && buf[1] === 0x45 && buf[2] === 0xdf && buf[3] === 0xa3 && buf.slice(0, 64).toString('latin1').indexOf('webm') !== -1;
  return false;
}

async function list(session, offset, kind) {
  const c = cfg();
  if (!c.url || !c.anon) return { status: 503, error: 'supabase_service_configuration_missing' };
  const off = Math.max(0, Math.min(10000, Number(offset) || 0));
  let r;
  const filter = kind === 'video' ? 'file_type=eq.video' : kind === 'all' ? 'file_type=in.(image,video)' : 'file_type=eq.image';
  try { r = await fetch(c.url + '/rest/v1/media_library?select=id,file_url,file_type,title,category&' + filter + '&order=created_at.desc&limit=24&offset=' + off, { headers: headers(session) }); }
  catch (_) { return { status: 502, error: 'library_unreachable' }; }
  if (!r.ok) return { status: r.status === 401 || r.status === 403 ? r.status : 502, error: 'library_failed' };
  const rows = await r.json().catch(() => []);
  return { status: 200, items: (Array.isArray(rows) ? rows : []).map((x) => ({ id: x.id, url: x.file_url, kind: x.file_type === 'video' ? 'video' : 'image', title: x.title || '', category: x.category || '' })) };
}

const newPath = (ext) => 'uploads/' + new Date().getUTCFullYear() + '/' + crypto.randomBytes(10).toString('hex') + '.' + ext;
const publicUrl = (c, path) => c.url + '/storage/v1/object/public/' + BUCKET + '/' + path;

/* Adds the stored file to the media library. Returns an error answer, or null when it was recorded. */
async function record(session, c, url, path, type, size, fileName) {
  let row;
  try {
    row = await fetch(c.url + '/rest/v1/media_library', {
      method: 'POST', headers: headers(session, { 'Content-Type': 'application/json', Prefer: 'return=minimal' }),
      body: JSON.stringify({ file_url: url, file_type: kindOf(type), source: 'device_upload', title: String(fileName || (kindOf(type) === 'video' ? 'فيديو' : 'صورة')).slice(0, 120), category: 'banners', storage_path: path, mime_type: type, size_bytes: size, is_approved: true })
    });
  } catch (_) { return { status: 502, error: 'library_record_failed' }; }
  return row.ok ? null : { status: 502, error: 'library_record_failed' };
}

/* A picture, sent through the server. (A video is too big for that: see signVideoUpload.) */
async function upload(session, buf, type, fileName) {
  const c = cfg();
  if (!c.url || !c.anon) return { status: 503, error: 'supabase_service_configuration_missing' };
  const ext = TYPES[type];
  if (!ext) return { status: 415, error: 'unsupported_type' };
  if (kindOf(type) === 'video') return { status: 415, error: 'video_needs_direct_upload' };
  if (!buf || !buf.length) return { status: 400, error: 'empty_file' };
  if (buf.length > MAX_BYTES) return { status: 413, error: 'file_too_large' };
  if (!looksLike(buf, type)) return { status: 415, error: 'file_does_not_match_type' };
  const path = newPath(ext);
  let up;
  try { up = await fetch(c.url + '/storage/v1/object/' + BUCKET + '/' + path, { method: 'POST', headers: headers(session, { 'Content-Type': type, 'x-upsert': 'false' }), body: buf }); }
  catch (_) { return { status: 502, error: 'storage_unreachable' }; }
  if (!up.ok) return { status: up.status === 401 || up.status === 403 ? up.status : 502, error: 'upload_failed' };
  const url = publicUrl(c, path);
  const failed = await record(session, c, url, path, type, buf.length, fileName);
  return failed || { status: 200, url };
}

/* Step 1 of a video upload: a one-time signed address for a file path the server picks. The browser uploads to it directly, so no video
   passes through the Worker. The signing runs as the admin's session, so only an admin can get one. */
async function signVideoUpload(session, type, size) {
  const c = cfg();
  if (!c.url || !c.anon) return { status: 503, error: 'supabase_service_configuration_missing' };
  if (kindOf(type) !== 'video') return { status: 415, error: 'unsupported_type' };
  const n = Number(size);
  if (!Number.isInteger(n) || n < 1) return { status: 400, error: 'empty_file' };
  if (n > MAX_VIDEO_BYTES) return { status: 413, error: 'file_too_large' };
  const path = newPath(TYPES[type]);
  let r;
  try { r = await fetch(c.url + '/storage/v1/object/upload/sign/' + BUCKET + '/' + path, { method: 'POST', headers: headers(session, { 'Content-Type': 'application/json' }), body: '{}' }); }
  catch (_) { return { status: 502, error: 'storage_unreachable' }; }
  if (!r.ok) return { status: r.status === 401 || r.status === 403 ? r.status : 502, error: 'upload_failed' };
  const j = await r.json().catch(() => ({}));
  let u;
  try { u = new URL(c.url + '/storage/v1' + String((j && j.url) || '')); } catch (_) { return { status: 502, error: 'upload_failed' }; }
  // the address must be our own storage, for exactly the path asked for: never hand the browser anything else
  if (u.origin !== new URL(c.url).origin || u.pathname !== '/storage/v1/object/upload/sign/' + BUCKET + '/' + path || !u.searchParams.get('token')) return { status: 502, error: 'upload_failed' };
  return { status: 200, path, uploadUrl: u.toString(), apikey: c.anon };
}

/* The first `n` bytes of a response, without reading the rest of a large file. */
async function firstBytes(res, n) {
  if (res.body && typeof res.body.getReader === 'function') {
    const reader = res.body.getReader(); const parts = []; let got = 0;
    try { while (got < n) { const { done, value } = await reader.read(); if (done) break; parts.push(Buffer.from(value)); got += value.length; } }
    finally { try { await reader.cancel(); } catch (_) { /* already closed */ } }
    return Buffer.concat(parts).subarray(0, n);
  }
  return Buffer.from(await res.arrayBuffer()).subarray(0, n);
}

/* Step 2: the browser says the upload is done. Check what is really stored (size and the file's first bytes, which the browser could lie
   about) before it goes into the library; a file that fails is removed from storage again. */
async function finishVideoUpload(session, path, type, fileName) {
  const c = cfg();
  if (!c.url || !c.anon) return { status: 503, error: 'supabase_service_configuration_missing' };
  if (kindOf(type) !== 'video') return { status: 415, error: 'unsupported_type' };
  if (typeof path !== 'string' || !VIDEO_PATH.test(path) || !path.endsWith('.' + TYPES[type])) return { status: 400, error: 'invalid_path' };
  const url = publicUrl(c, path);
  let g;
  try { g = await fetch(url, { headers: { Range: 'bytes=0-255' } }); } catch (_) { return { status: 502, error: 'storage_unreachable' }; }
  if (g.status === 404 || g.status === 400) return { status: 404, error: 'upload_not_found' };
  if (!g.ok) return { status: 502, error: 'storage_unreachable' };
  const range = /\/(\d+)$/.exec(String(g.headers.get('content-range') || ''));
  const size = Number(range ? range[1] : g.status === 200 ? g.headers.get('content-length') : NaN);
  const head = await firstBytes(g, 256);
  if (!Number.isInteger(size) || size < 1) return { status: 502, error: 'upload_unverifiable' };
  const discard = async () => { try { await fetch(c.url + '/storage/v1/object/' + BUCKET + '/' + path, { method: 'DELETE', headers: headers(session) }); } catch (_) { /* best effort */ } };
  if (size > MAX_VIDEO_BYTES) { await discard(); return { status: 413, error: 'file_too_large' }; }
  if (!looksLike(head, type)) { await discard(); return { status: 415, error: 'file_does_not_match_type' }; }
  const failed = await record(session, c, url, path, type, size, fileName);
  return failed || { status: 200, url };
}

module.exports = { list, upload, signVideoUpload, finishVideoUpload, looksLike, kindOf, limitFor, MAX_BYTES, MAX_VIDEO_BYTES, IMAGE_TYPES, VIDEO_TYPES, TYPES };
