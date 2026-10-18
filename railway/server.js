/* Élan Scents — Railway host.
   Serves the same static files and the same /api/* handlers that Vercel serves,
   and reads headers/rewrites from vercel.json so both hosts stay identical.
   No dependencies. Start: node railway/server.js */
const http = require('http');
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');
const editorHost = require('./editor-host.js');

const ROOT = path.resolve(__dirname, '..');
const PORT = Number(process.env.PORT) || 3000;
const MAX_BODY = 1000000;
const MAX_EDITOR_BODY = 300000;
const CONFIG = (() => { try { return JSON.parse(fs.readFileSync(path.join(ROOT, 'vercel.json'), 'utf8')); } catch (e) { return {}; } })();

const MIME = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8', '.svg': 'image/svg+xml', '.png': 'image/png', '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg', '.webp': 'image/webp', '.gif': 'image/gif', '.ico': 'image/x-icon', '.mp4': 'video/mp4',
  '.webm': 'video/webm', '.woff2': 'font/woff2', '.woff': 'font/woff', '.ttf': 'font/ttf', '.txt': 'text/plain; charset=utf-8',
  '.md': 'text/markdown; charset=utf-8'
};

// Never serve server-side or repo-internal files.
// Full editor UI stays private (served only via editor-host); only explicitly allow-listed,
// browser-safe editor/store scripts may be fetched directly.
const BLOCKED_TOP = new Set(['api', 'tests', 'supabase', 'railway', 'node_modules', 'src', 'lib', 'scripts', 'reports', '.github', '.git']);
const EDITOR_PUBLIC_FILES = new Set(['edit-model.js', 'editor-data-bridge.js', 'editor-geometry.js', 'editor-live-library.js']);
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
    const chunks = []; let size = 0; let tooBig = false;
    req.on('data', (c) => {
      if (tooBig) return;
      size += c.length;
      if (size > limit) { tooBig = true; reject(Object.assign(new Error('too_big'), { code: 413 })); return; }
      chunks.push(c);
    });
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
  if (pathname === '/api/editor' || pathname === '/api/editor-data') {
    await editorHost.attachSession(req, res);
    editorHost.attachBridgeTicket(req);
  }
  const name = pathname.replace(/^\/api\//, '').replace(/\/$/, '');
  const handler = loadHandler(name);
  if (!handler) return sendJson(res, 404, { error: 'not_found' });
  let raw = Buffer.alloc(0);
  const bodyLimit = pathname === '/api/editor' ? MAX_EDITOR_BODY : MAX_BODY;
  try { raw = await readBody(req, bodyLimit); } catch (e) { return sendJson(res, e.code === 413 ? 413 : 400, { error: e.code === 413 ? 'payload_too_large' : 'bad_request' }); }
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
  const top = parts[0].toLowerCase();
  if (top === 'editor') {
    // Allow only the site-side edit tools; never the HTML/login/guard.
    if (parts.length !== 2 || !EDITOR_PUBLIC_FILES.has(parts[1])) return null;
  } else if (BLOCKED_TOP.has(top) || top.startsWith('elan-editor') || top.startsWith('elan-scents') || (parts.length === 1 && BLOCKED_FILES.has(parts[0].toLowerCase()))) {
    return null;
  }
  const file = path.join(ROOT, ...parts);
  if (!file.startsWith(ROOT + path.sep)) return null;
  try { if (!fs.statSync(file).isFile()) return null; } catch (e) { return null; }
  return file;
}

/* Text files are compressed once per file version and kept in memory (a few hundred KB in total). */
const COMPRESSIBLE = new Set(['.html', '.js', '.css', '.json', '.svg', '.txt', '.md']);
const encodedCache = new Map();
function pickEncoding(header) {
  const h = String(header || '').toLowerCase();
  if (/(^|[\s,])br\s*(;|,|$)/.test(h)) return 'br';
  if (/(^|[\s,])gzip\s*(;|,|$)/.test(h)) return 'gzip';
  return null;
}
function encodedBody(file, stat, encoding) {
  const key = encoding + '|' + file + '|' + stat.size + '|' + stat.mtimeMs;
  let body = encodedCache.get(key);
  if (!body) {
    const raw = fs.readFileSync(file);
    body = encoding === 'br'
      ? zlib.brotliCompressSync(raw, { params: { [zlib.constants.BROTLI_PARAM_QUALITY]: 6, [zlib.constants.BROTLI_PARAM_SIZE_HINT]: raw.length } })
      : zlib.gzipSync(raw, { level: 6 });
    if (encodedCache.size >= 300) encodedCache.delete(encodedCache.keys().next().value);
    encodedCache.set(key, body);
  }
  return body;
}
function notModified(req, etag, stat) {
  const none = req.headers['if-none-match'];
  if (none) {
    const weak = (v) => v.trim().replace(/^W\//, '');
    return none.trim() === '*' || none.split(',').some((v) => weak(v) === weak(etag));
  }
  const since = Date.parse(req.headers['if-modified-since'] || '');
  return Number.isFinite(since) && Math.floor(stat.mtimeMs / 1000) * 1000 <= since;
}

function serveStatic(req, res, file) {
  const stat = fs.statSync(file);
  const ext = path.extname(file).toLowerCase();
  const type = MIME[ext] || 'application/octet-stream';
  if (!res.getHeader('Content-Type')) res.setHeader('Content-Type', type);
  res.setHeader('Accept-Ranges', 'bytes');
  // A file with no cache rule is revalidated every time: without this, validators below would let browsers guess a freshness lifetime.
  if (!res.getHeader('Cache-Control')) res.setHeader('Cache-Control', 'no-cache');
  // Validators let browsers ask "has it changed?" and get a tiny 304 instead of the whole file again.
  const etag = 'W/"' + stat.size.toString(16) + '-' + Math.floor(stat.mtimeMs).toString(16) + '"';
  res.setHeader('ETag', etag);
  res.setHeader('Last-Modified', new Date(stat.mtimeMs).toUTCString());
  const compressible = COMPRESSIBLE.has(ext) && stat.size >= 1024;
  if (compressible) res.setHeader('Vary', 'Accept-Encoding');
  let start = 0; let end = stat.size - 1; let status = 200;
  const range = /^bytes=(\d*)-(\d*)$/.exec(req.headers.range || '');
  if (!range && notModified(req, etag, stat)) { res.statusCode = 304; return res.end(); }
  if (range && (range[1] || range[2])) {
    if (range[1]) { start = Number(range[1]); if (range[2]) end = Math.min(Number(range[2]), end); }
    else { start = Math.max(0, stat.size - Number(range[2])); }
    if (start > end || start >= stat.size) { res.statusCode = 416; res.setHeader('Content-Range', 'bytes */' + stat.size); return res.end(); }
    status = 206; res.setHeader('Content-Range', 'bytes ' + start + '-' + end + '/' + stat.size);
  } else if (compressible) {
    const encoding = pickEncoding(req.headers['accept-encoding']);
    if (encoding) {
      const body = encodedBody(file, stat, encoding);
      res.statusCode = 200;
      res.setHeader('Content-Encoding', encoding);
      res.setHeader('Content-Length', body.length);
      return res.end(req.method === 'HEAD' ? undefined : body);
    }
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
  if (pathname === '/' && process.env.EDITOR_ROOT_REDIRECT === '1' && (req.method === 'GET' || req.method === 'HEAD')) {
    res.statusCode = 302;
    res.setHeader('Location', '/editor');
    res.setHeader('Cache-Control', 'no-store');
    return res.end();
  }
  try { if (await editorHost.handle(req, res, pathname)) return; } catch (e) { console.error('editor host error', e && e.message); if (!res.headersSent) return sendJson(res, 500, { error: 'server_error' }); return; }
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
