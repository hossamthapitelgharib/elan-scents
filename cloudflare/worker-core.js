'use strict';
/* Élan Scents — Cloudflare Workers host (the same site that railway/server.js serves, behind one Worker).

   Static files are served by Cloudflare's asset layer (see scripts/build-cloudflare.js and wrangler.jsonc); this file only
   handles what needs code: /api/*, the private owner editor, /health and the storefront root.
   The 25 handlers in api/ and the editor host in railway/ run unchanged: each request is wrapped in small Node-style
   req/res objects (headers, body events, status/json/send helpers) and the finished res becomes a standard Response.

   Nothing here touches the disk: editor pages come from the bundle (deps.editorFiles) and design/home.json from the assets.
   Every module is required lazily (inside a request) because Workers forbid random-number generation and I/O while the
   bundle is first evaluated, and some of the modules draw random bytes when they load. */

const CONFIG = require('../vercel.json');
const REWRITES = new Map((CONFIG.rewrites || []).map((r) => [r.source, r.destination]));
const MAX_BODY = 1000000;
const MAX_EDITOR_BODY = 300000;

// Same baseline as railway/server.js (HSTS is added only when the request came in over https).
const BASELINE_HEADERS = {
  'X-Content-Type-Options': 'nosniff',
  'Referrer-Policy': 'strict-origin-when-cross-origin',
  'Permissions-Policy': 'camera=(), microphone=(), geolocation=(), payment=(), usb=()'
};
const HSTS = 'max-age=15552000';
// The owner editor and its storefront frame are one origin on Cloudflare. When these are not configured, the origin the
// visitor reached us on is used (the Worker can only be reached through hostnames that route to it).
const ORIGIN_VARS = ['EDITOR_SITE_ORIGIN', 'ELAN_EDITOR_ORIGIN', 'ELAN_STORE_ORIGIN'];

const encoder = new TextEncoder();
const seenOrigins = new Set();
const providerWired = new WeakSet();

function toBuffer(chunk) { return Buffer.from(chunk.buffer, chunk.byteOffset, chunk.byteLength); }

function toBytes(chunk) {
  if (typeof chunk === 'string') return encoder.encode(chunk);
  if (chunk instanceof Uint8Array) return chunk;
  if (chunk instanceof ArrayBuffer) return new Uint8Array(chunk);
  return encoder.encode(String(chunk));
}

function joinBytes(chunks) {
  if (chunks.length === 0) return null;
  if (chunks.length === 1) return chunks[0];
  let size = 0;
  for (const c of chunks) size += c.length;
  const out = new Uint8Array(size);
  let at = 0;
  for (const c of chunks) { out.set(c, at); at += c.length; }
  return out;
}

/* The slice of Node's ServerResponse that the handlers and the editor host use. */
class NodeResponse {
  constructor(method) {
    this.statusCode = 200;
    this.headersSent = false;
    this.ended = false;
    this.response = null;
    this._head = method === 'HEAD';
    this._headers = new Map();
    this._chunks = [];
  }
  setHeader(name, value) { this._headers.set(String(name).toLowerCase(), { name: String(name), value }); return this; }
  getHeader(name) { const h = this._headers.get(String(name).toLowerCase()); return h ? h.value : undefined; }
  hasHeader(name) { return this._headers.has(String(name).toLowerCase()); }
  removeHeader(name) { this._headers.delete(String(name).toLowerCase()); }
  getHeaders() { const out = {}; for (const [k, h] of this._headers) out[k] = h.value; return out; }
  writeHead(status, headers) {
    this.statusCode = status;
    if (headers) for (const k of Object.keys(headers)) this.setHeader(k, headers[k]);
    return this;
  }
  write(chunk) {
    if (this.ended) return false;
    this.headersSent = true;
    if (chunk !== undefined && chunk !== null && chunk !== '') this._chunks.push(toBytes(chunk));
    return true;
  }
  end(chunk) {
    if (this.ended) return this;
    if (chunk !== undefined && chunk !== null && chunk !== '' && typeof chunk !== 'function') this.write(chunk);
    this.headersSent = true;
    this.ended = true;
    const headers = new Headers();
    for (const [key, h] of this._headers) {
      if (key === 'content-length' || key === 'transfer-encoding' || key === 'connection') continue; // the runtime sets these
      if (Array.isArray(h.value)) for (const v of h.value) headers.append(h.name, String(v));
      else headers.set(h.name, String(h.value));
    }
    const status = Number.isInteger(this.statusCode) && this.statusCode >= 200 && this.statusCode <= 599 ? this.statusCode : 500;
    const empty = this._head || status === 204 || status === 205 || status === 304;
    this.response = new Response(empty ? null : joinBytes(this._chunks), { status, headers });
    return this;
  }
}

/* The slice of Node's IncomingMessage the handlers use: lowercase headers, method, url, socket address and the
   data/end/error events (the body is streamed from the Request only when something listens for it). */
function makeRequest(request, url) {
  const headers = {};
  request.headers.forEach((value, key) => { headers[key.toLowerCase()] = value; });
  // The client cannot choose any of these: they identify the caller and the origin to the rate limiter and the editor.
  const caller = headers['cf-connecting-ip'] || '';
  delete headers['x-forwarded-for'];
  headers['x-real-ip'] = caller || 'unknown';
  headers['x-forwarded-proto'] = url.protocol.replace(':', '');
  headers['x-forwarded-host'] = url.host;
  headers.host = url.host;

  const listeners = {};
  let started = false;
  let destroyed = false;
  let reader = null;
  const emit = (name, value) => {
    for (const fn of (listeners[name] || []).slice()) {
      try { fn(value); } catch (e) { console.error('request listener error', e && e.message); }
    }
  };
  async function pump() {
    try {
      if (!request.body) { emit('end'); return; }
      reader = request.body.getReader();
      for (;;) {
        const { done, value } = await reader.read();
        if (destroyed) return;
        if (done) break;
        emit('data', toBuffer(value));
      }
      if (!destroyed) emit('end');
    } catch (e) { if (!destroyed) emit('error', e); }
  }
  const req = {
    method: request.method,
    url: url.pathname + url.search,
    headers,
    socket: { remoteAddress: caller || 'unknown' },
    on(name, fn) {
      (listeners[name] = listeners[name] || []).push(fn);
      if ((name === 'data' || name === 'end') && !started) { started = true; Promise.resolve().then(pump); }
      return req;
    },
    destroy() {
      destroyed = true;
      if (reader) { try { reader.cancel().catch(() => {}); } catch (_) { /* already closed */ } }
    }
  };
  req.once = req.on;
  return req;
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

function sendJson(res, status, body) {
  res.statusCode = status;
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.end(JSON.stringify(body));
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
      if (size > limit) { tooBig = true; req.destroy(); reject(Object.assign(new Error('too_big'), { code: 413 })); return; }
      chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

function loadHandler(deps, name) {
  const api = deps.api || {};
  if (!Object.prototype.hasOwnProperty.call(api, name)) return null; // never reach inherited names such as "constructor"
  const mod = api[name]();
  return typeof mod === 'function' ? mod : (mod && typeof mod.default === 'function' ? mod.default : null);
}

/* Every variable and secret of the Worker becomes process.env (Workers do this by themselves on recent compatibility dates;
   doing it here too keeps the modules working under any date and in tests). */
function syncEnv(env, url) {
  for (const key of Object.keys(env || {})) {
    const value = env[key];
    if (typeof value === 'string' && process.env[key] !== value) process.env[key] = value;
  }
  for (const key of ORIGIN_VARS) if (!(env && typeof env[key] === 'string' && env[key])) process.env[key] = url.origin;
}

function wireProviders(deps, env, url) {
  seenOrigins.add(url.origin);
  const editorHost = deps.editorHost();
  if (deps.editorFiles && !providerWired.has(deps)) {
    editorHost.setFileProvider((name) => (Object.prototype.hasOwnProperty.call(deps.editorFiles, name) ? deps.editorFiles[name] : null));
    providerWired.add(deps);
  }
  return editorHost;
}

/* The editor asks "is the live site serving my commit?" by fetching its own /design/home.json; a Worker cannot reliably call its
   own public URL, so those requests are answered from the deployed assets instead. */
function selfFetch(env) {
  return (target, init) => {
    let u = null;
    try { u = new URL(String(target)); } catch (_) { u = null; }
    if (u && seenOrigins.has(u.origin) && env.ASSETS) return env.ASSETS.fetch(new Request(u.origin + u.pathname));
    return fetch(target, init);
  };
}

async function designSource(env, url) {
  if (!env.ASSETS) return null;
  const r = await env.ASSETS.fetch(new Request(new URL('/design/home.json', url)));
  return r.ok ? r.text() : null;
}

async function handleApi(deps, env, req, res, url, pathname) {
  const editorHost = deps.editorHost();
  if (pathname === '/api/editor' || pathname === '/api/editor-data') {
    await editorHost.attachSession(req, res);
    editorHost.attachBridgeTicket(req);
  }
  const name = pathname.replace(/^\/api\//, '').replace(/\/$/, '');
  const handler = loadHandler(deps, name);
  if (!handler) return sendJson(res, 404, { error: 'not_found' });
  if (name === 'editor') {
    if (typeof handler.setSelfFetch === 'function') handler.setSelfFetch(selfFetch(env));
    if (typeof handler.setDesignSource === 'function') handler.setDesignSource(() => designSource(env, url));
  }
  let raw = Buffer.alloc(0);
  const bodyLimit = pathname === '/api/editor' ? MAX_EDITOR_BODY : MAX_BODY;
  try { raw = await readBody(req, bodyLimit); } catch (e) { return sendJson(res, e.code === 413 ? 413 : 400, { error: e.code === 413 ? 'payload_too_large' : 'bad_request' }); }
  try { req.body = parseBody(raw, req.headers['content-type'] || ''); } catch (e) { return sendJson(res, 400, { error: 'invalid_json' }); }
  req.query = parseQuery(url.searchParams);
  wrapResponse(res);
  try { await handler(req, res); }
  catch (e) { console.error('api error', name, e && e.message); if (!res.headersSent) sendJson(res, 500, { error: 'server_error' }); }
}

/* Static answers produced by the Worker itself get the same baseline headers that _headers gives the asset responses. */
function withBaseline(response, url) {
  const headers = new Headers(response.headers);
  for (const key of Object.keys(BASELINE_HEADERS)) if (!headers.has(key)) headers.set(key, BASELINE_HEADERS[key]);
  if (url.protocol === 'https:' && !headers.has('Strict-Transport-Security')) headers.set('Strict-Transport-Security', HSTS);
  return new Response(response.body, { status: response.status, statusText: response.statusText, headers });
}

/* Cloudflare's asset layer ignores a Range header and answers 200 with the whole file. Safari and iOS will not play a <video>
   unless the server answers byte ranges (206), so video files are routed through the Worker (run_worker_first in wrangler.jsonc;
   tests/cloudflare-build.test.js fails if a video file is missing there) and sliced here, the way railway/server.js does. */
const RANGE_EXTENSIONS = /\.(mp4|webm)$/i;

/* A single "bytes=a-b", "bytes=a-" or "bytes=-n" range inside a file of `size` bytes: { start, end } (inclusive), 'invalid' when
   it cannot be satisfied (416), or null when the header is something else (several ranges, another unit): answer the whole file. */
function parseRange(header, size) {
  const m = /^bytes=(\d*)-(\d*)$/.exec(String(header || '').trim());
  if (!m || (m[1] === '' && m[2] === '')) return null;
  let start; let end;
  if (m[1] === '') {
    const last = Number(m[2]);
    start = Math.max(0, size - last); end = size - 1;
    if (last === 0) return 'invalid';
  } else {
    start = Number(m[1]);
    end = m[2] === '' ? size - 1 : Math.min(Number(m[2]), size - 1);
  }
  if (start >= size || start > end) return 'invalid';
  return { start, end };
}

async function serveAssetWithRange(request, env, url) {
  const wanted = request.headers.get('range');
  const ifRange = request.headers.get('if-range');
  const headers = new Headers(request.headers);
  headers.delete('range'); headers.delete('if-range');
  const asset = await env.ASSETS.fetch(new Request(url, { method: 'GET', headers }));
  if (asset.status !== 200) return withBaseline(asset, url); // 304, 404 ...
  const out = new Headers(asset.headers);
  out.set('Accept-Ranges', 'bytes');
  const head = request.method === 'HEAD';
  const whole = () => withBaseline(new Response(head ? null : asset.body, { status: 200, headers: out }), url);
  // If-Range names the version the client already holds part of; a different version means "send the whole file".
  if (!wanted || (ifRange && ifRange !== out.get('etag'))) return whole();
  const bytes = new Uint8Array(await asset.arrayBuffer());
  const range = parseRange(wanted, bytes.length);
  if (range === null) return withBaseline(new Response(head ? null : bytes, { status: 200, headers: out }), url);
  if (range === 'invalid') {
    out.set('Content-Range', 'bytes */' + bytes.length);
    return withBaseline(new Response(null, { status: 416, headers: out }), url);
  }
  out.set('Content-Range', 'bytes ' + range.start + '-' + range.end + '/' + bytes.length);
  return withBaseline(new Response(head ? null : bytes.subarray(range.start, range.end + 1), { status: 206, headers: out }), url);
}

function notFound(url) {
  return withBaseline(new Response('Not found', { status: 404, headers: { 'Content-Type': 'text/plain; charset=utf-8' } }), url);
}

async function settle(res) {
  if (!res.ended) {
    console.error('request finished without a response');
    sendJson(res, 500, { error: 'server_error' });
  }
  return res.response;
}

/* deps = { api: { name: () => handler }, editorHost: () => module, editorFiles: { fileName: text } } (see cloudflare/index.mjs). */
async function handleRequest(request, env, ctx, deps) {
  const url = new URL(request.url);
  env = env || {};
  syncEnv(env, url);
  const req = makeRequest(request, url);
  const res = new NodeResponse(request.method);
  for (const key of Object.keys(BASELINE_HEADERS)) res.setHeader(key, BASELINE_HEADERS[key]);
  if (url.protocol === 'https:') res.setHeader('Strict-Transport-Security', HSTS);

  let pathname = url.pathname;
  if ((request.method === 'GET' || request.method === 'HEAD') && RANGE_EXTENSIONS.test(pathname) && env.ASSETS) return serveAssetWithRange(request, env, url);
  if (pathname === '/health') { res.setHeader('Content-Type', 'text/plain'); res.end('ok'); return settle(res); }

  let editorHost;
  try {
    editorHost = wireProviders(deps, env, url);
    if (await editorHost.handle(req, res, pathname)) return settle(res);
  } catch (e) {
    console.error('editor host error', e && e.message);
    if (!res.headersSent) sendJson(res, 500, { error: 'server_error' });
    return settle(res);
  }

  if (REWRITES.has(pathname)) pathname = REWRITES.get(pathname);
  if (pathname === '/api' || pathname.startsWith('/api/')) { await handleApi(deps, env, req, res, url, pathname); return settle(res); }

  if (request.method !== 'GET' && request.method !== 'HEAD') { sendJson(res, 405, { error: 'method_not_allowed' }); return settle(res); }
  // Every other file is answered by the asset layer before this code runs. The storefront root is the one path it does not map
  // (html_handling is "none" so that /account.html and friends keep their exact addresses), so it is served from here.
  if (pathname === '/' && env.ASSETS) {
    const asset = await env.ASSETS.fetch(new Request(new URL('/index.html', url), { method: request.method, headers: request.headers }));
    return asset.status === 404 ? notFound(url) : withBaseline(asset, url);
  }
  return notFound(url);
}

module.exports = { handleRequest, NodeResponse, makeRequest, parseRange, RANGE_EXTENSIONS, BASELINE_HEADERS, REWRITES };
