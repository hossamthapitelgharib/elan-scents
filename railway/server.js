/* Élan Scents — Railway host.
   Serves the same static files and the same /api/* handlers that Vercel serves,
   and reads headers/rewrites from vercel.json so both hosts stay identical.
   No dependencies. Start: node railway/server.js */
const http = require('http');
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const PORT = Number(process.env.PORT) || 3000;
const MAX_BODY = 1000000;
const CONFIG = (() => { try { return JSON.parse(fs.readFileSync(path.join(ROOT, 'vercel.json'), 'utf8')); } catch (e) { return {}; } })();

const MIME = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8', '.svg': 'image/svg+xml', '.png': 'image/png', '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg', '.webp': 'image/webp', '.gif': 'image/gif', '.ico': 'image/x-icon', '.mp4': 'video/mp4',
  '.webm': 'video/webm', '.woff2': 'font/woff2', '.woff': 'font/woff', '.ttf': 'font/ttf', '.txt': 'text/plain; charset=utf-8',
  '.md': 'text/markdown; charset=utf-8'
};

// Never serve server-side or repo-internal files.
const BLOCKED_TOP = new Set(['api', 'lib', 'reports', 'tests', 'supabase', 'railway', 'node_modules', 'src', '.github', '.git']);
const BLOCKED_FILES = new Set(['package.json', 'package-lock.json', 'vercel.json', 'claude.md', 'readme.md']);

function compile(rules, key) {
  return (rules || []).map((r) => {
    let re = null;
    try { re = new RegExp('^' + r.source + '$'); } catch (e) { re = null; }
    return re ? { re, rule: r } : null;
  }).filter(Boolean);
}
const HEADER_RULES = compile(CONFIG.headers);
const REWRITES = new Map((CONFIG.rewrites || []).map((r) => [r.source, r.destination]));

function applyHeaders(pathname, res) {
  for (const { re, rule } of HEADER_RULES) {
    if (re.test(pathname)) for (const h of rule.headers || []) res.setHeader(h.key, h.value);
  }
}

function sendJson(res, status, body) {
  res.statusCode = status;
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.end(JSON.stringify(body));
}

function wrapResponse(res) {
  res.status = function (code) { this.statusCode = code; return this; };
  res.json = function (body) {
    if (!this.getHeader('Content-Type')) this.setHeader('Content-Type', 'application/json; charset=utf-8');
    this.end(JSON.stringify(body));
    return this;
  };
  res.send = function (body) {
    if (body !== null && typeof body === 'object' && !Buffer.isBuffer(body)) return this.json(body);
    this.end(body);
    return this;
  };
  return res;
}

function parseQuery(searchParams) {
  const out = {};
  for (const [k, v] of searchParams) {
    if (k in out) out[k] = [].concat(out[k], v); else out[k] = v;
  }
  return out;
}

function parseBody(raw, type) {
  if (!raw.length) return undefined;
  const text = raw.toString('utf8');
  if (/application\/json/i.test(type)) return JSON.parse(text);
  if (/application\/x-www-form-urlencoded/i.test(type)) return parseQuery(new URLSearchParams(text));
  return text;
}

function readBody(req, limit) {
  return new Promise((resolve, reject) => {
    const chunks = []; let size = 0;
    req.on('data', (c) => { size += c.length; if (size > limit) { reject(Object.assign(new Error('too_big'), { code: 413 })); req.destroy(); return; } chunks.push(c); });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

function loadHandler(name) {
  if (name === 'editor') return require('./editor.js');
  if (!/^[a-z0-9][a-z0-9-]*$/i.test(name)) return null;
  const file = path.join(ROOT, 'api', name + '.js');
  if (!fs.existsSync(file)) return null;
  const mod = require(file);
  return typeof mod === 'function' ? mod : (mod && typeof mod.default === 'function' ? mod.default : null);
}

async function handleApi(req, res, url, pathname) {
  const name = pathname.replace(/^\/api\//, '').replace(/\/$/, '');
  const handler = loadHandler(name);
  if (!handler) return sendJson(res, 404, { error: 'not_found' });
  let raw = Buffer.alloc(0);
  try { raw = await readBody(req, MAX_BODY); } catch (e) { return sendJson(res, e.code === 413 ? 413 : 400, { error: e.code === 413 ? 'payload_too_large' : 'bad_request' }); }
  try { req.body = parseBody(raw, req.headers['content-type'] || ''); } catch (e) { return sendJson(res, 400, { error: 'invalid_json' }); }
  req.query = parseQuery(url.searchParams);
  wrapResponse(res);
  try { await handler(req, res); }
  catch (e) { console.error('api error', name, e && e.message); if (!res.headersSent) sendJson(res, 500, { error: 'server_error' }); }
}

function resolveStatic(pathname) {
  let rel;
  try { rel = decodeURIComponent(pathname); } catch (e) { return null; }
  if (rel === '/' || rel === '') rel = '/index.html';
  const parts = rel.split('/').filter(Boolean);
  if (!parts.length || parts.some((p) => p.startsWith('.') || p === '..')) return null;
  if (BLOCKED_TOP.has(parts[0].toLowerCase()) || (parts.length === 1 && BLOCKED_FILES.has(parts[0].toLowerCase()))) return null;
  const file = path.join(ROOT, ...parts);
  if (!file.startsWith(ROOT + path.sep)) return null;
  try { if (!fs.statSync(file).isFile()) return null; } catch (e) { return null; }
  return file;
}

function serveStatic(req, res, file) {
  const stat = fs.statSync(file);
  const type = MIME[path.extname(file).toLowerCase()] || 'application/octet-stream';
  if (!res.getHeader('Content-Type')) res.setHeader('Content-Type', type);
  res.setHeader('Accept-Ranges', 'bytes');
  let start = 0; let end = stat.size - 1; let status = 200;
  const range = /^bytes=(\d*)-(\d*)$/.exec(req.headers.range || '');
  if (range && (range[1] || range[2])) {
    if (range[1]) { start = Number(range[1]); if (range[2]) end = Math.min(Number(range[2]), end); }
    else { start = Math.max(0, stat.size - Number(range[2])); }
    if (start > end || start >= stat.size) { res.statusCode = 416; res.setHeader('Content-Range', 'bytes */' + stat.size); return res.end(); }
    status = 206; res.setHeader('Content-Range', 'bytes ' + start + '-' + end + '/' + stat.size);
  }
  res.statusCode = status;
  res.setHeader('Content-Length', end - start + 1);
  if (req.method === 'HEAD') return res.end();
  fs.createReadStream(file, { start, end }).pipe(res);
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://localhost');
  let pathname = url.pathname;
  if (pathname === '/health') { res.setHeader('Content-Type', 'text/plain'); return res.end('ok'); }
  if (REWRITES.has(pathname)) pathname = REWRITES.get(pathname);
  if (pathname === '/api' || pathname.startsWith('/api/')) return handleApi(req, res, url, pathname);
  if (req.method !== 'GET' && req.method !== 'HEAD') return sendJson(res, 405, { error: 'method_not_allowed' });
  const file = resolveStatic(pathname);
  if (!file) { res.statusCode = 404; res.setHeader('Content-Type', 'text/plain; charset=utf-8'); return res.end('Not found'); }
  applyHeaders(pathname, res);
  serveStatic(req, res, file);
});

if (require.main === module) server.listen(PORT, () => console.log('elan-scents listening on ' + PORT));
module.exports = server;
