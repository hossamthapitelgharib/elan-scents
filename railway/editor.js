/* Élan Scents — one guarded editor API endpoint (served by the Cloudflare Worker; also runs under railway/server.js locally).
   Admin only. Writes exactly one file (design/home.json) with one commit per save.
   Repo, path and branch come from server configuration, never from the request. */
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { getContext, requireRoles } = require('../api/_auth');
const ED = require('../design-schema.js');
const { DEFAULT_SITE_ORIGIN } = require('../lib/site-origin.js');

const DESIGN_PATH = 'design/home.json';
const DEFAULT_REPO = 'hossamthapitelgharib/elan-scents';
const MAX_BODY_CHARS = 300000;
const SHA_RE = /^[0-9a-f]{40}$/;
const REQUEST_ID_RE = /^[A-Za-z0-9_-]{8,64}$/;

function reply(res, status, body) {
  res.status(status).setHeader('Content-Type', 'application/json').setHeader('Cache-Control', 'no-store').json(body);
}

function gitBlobSha(text) {
  const bytes = Buffer.from(text, 'utf8');
  return crypto.createHash('sha1').update(Buffer.concat([Buffer.from('blob ' + bytes.length + '\0'), bytes])).digest('hex');
}

/* Production writes to main. Non-production environments must target an isolated branch. */
function config(env) {
  env = env || process.env;
  const environment = String(env.RAILWAY_ENVIRONMENT_NAME || env.EDITOR_ENV || '').toLowerCase();
  const isProd = environment === 'production';
  const token = typeof env.GITHUB_TOKEN === 'string' ? env.GITHUB_TOKEN.trim() : env.GITHUB_TOKEN;
  const repo = env.GITHUB_REPO || DEFAULT_REPO;
  const branch = env.EDITOR_TARGET_BRANCH || (isProd ? 'main' : env.EDITOR_BRANCH);
  const host = env.RAILWAY_PUBLIC_DOMAIN;
  let origin = env.EDITOR_SITE_ORIGIN || (host ? 'https://' + host : '');
  const selfOrigin = host ? ('https://' + String(host).replace(/^https?:\/\//, '').replace(/\/+$/, '')) : '';
  if (isProd && selfOrigin && origin.replace(/\/+$/, '') === selfOrigin) origin = DEFAULT_SITE_ORIGIN;
  const missing = [];
  if (!token) missing.push('GITHUB_TOKEN');
  // A token pasted with a stray space, a quote or a non-Latin letter makes every GitHub request throw, so say so instead of failing later.
  else if (!/^[\x21-\x7e]+$/.test(token)) missing.push('GITHUB_TOKEN (فيه مسافة أو حرف غير صالح، الصقيه من جديد)');
  if (!branch) missing.push('EDITOR_TARGET_BRANCH');
  else if (!/^[\w./-]{1,100}$/.test(branch) || branch.indexOf('..') !== -1) missing.push('EDITOR_TARGET_BRANCH (قيمة غير صالحة)');
  if (!origin) missing.push('EDITOR_SITE_ORIGIN');
  else if (!/^https:\/\/[\w.-]+(:\d+)?$/.test(origin.replace(/\/+$/, ''))) missing.push('EDITOR_SITE_ORIGIN (لازم يبدأ بـ https:// من غير مسار)');
  if (!/^[\w.-]+\/[\w.-]+$/.test(repo)) missing.push('GITHUB_REPO (قيمة غير صالحة)');
  if (missing.length) return { error: 'editor_not_configured', missing };
  if (branch === 'main' && !isProd && env.EDITOR_ALLOW_MAIN_FROM_NONPROD !== '1') return { error: 'main_branch_requires_production', missing: ['EDITOR_ENV=production'] };
  return { token, repo, branch, origin: origin.replace(/\/+$/, ''), isProd };
}

/* Where the committed design file is read from when GitHub is not configured: the repository on disk, or (Cloudflare Workers, which
   have no disk) a source the host provides. selfFetch lets a Worker answer requests for its own /design/home.json from its assets. */
let designSource = null;
let selfFetch = null;
function setDesignSource(fn) { designSource = typeof fn === 'function' ? fn : null; }
function setSelfFetch(fn) { selfFetch = typeof fn === 'function' ? fn : null; }

async function localDesign() {
  try {
    const text = designSource ? await designSource() : fs.readFileSync(path.resolve(__dirname, '..', DESIGN_PATH), 'utf8');
    if (typeof text !== 'string') throw new Error('design file is not available');
    const parsed = JSON.parse(text);
    const n = ED.normalize(parsed, { strict: false });
    return { text, design: n.design, warnings: n.ok && !n.errors.length ? undefined : n.errors.slice(0, 5) };
  } catch (_) {
    return { text: ED.serialize({ version: ED.VERSION }), design: ED.normalize({ version: ED.VERSION }).design };
  }
}

/* A GitHub failure the owner can act on. The detail carries only GitHub's own status and public error text (for example
   "Bad credentials"), never the token; the endpoint is admin-only. */
function tokenShape(token) {
  const t = String(token || '');
  const m = /^(github_pat_|ghp_|gho_|ghu_|ghs_|ghr_)/.exec(t);
  return { type: m ? m[1] : 'unknown', length: t.length };
}

function githubError(code, r, cause, cfg) {
  const detail = {};
  if (r && r.status) detail.githubStatus = r.status;
  if (r && r.json && typeof r.json.message === 'string') detail.githubMessage = r.json.message.slice(0, 200);
  if (cause) detail.cause = String(cause && cause.message ? cause.message : cause).slice(0, 120);
  // Only for "Bad credentials": the kind and length of the token (never its characters) show a truncated or wrong paste.
  if (cfg && r && r.status === 401) detail.token = tokenShape(cfg.token);
  return Object.assign(new Error(code), { status: 502, detail });
}

async function github(cfg, method, path, body) {
  let response;
  try {
    response = await githubFetch(cfg, method, path, body);
  } catch (e) { throw githubError('github_unreachable', null, e); }
  let json = null;
  try { json = await response.json(); } catch (_) { /* empty body */ }
  return { status: response.status, json };
}

async function githubFetch(cfg, method, path, body) {
  return fetch('https://api.github.com/repos/' + cfg.repo + path, {
    method,
    headers: {
      Authorization: 'Bearer ' + cfg.token,
      Accept: 'application/vnd.github+json',
      'X-GitHub-Api-Version': '2022-11-28',
      'User-Agent': 'elan-editor',
      'Content-Type': 'application/json'
    },
    body: body ? JSON.stringify(body) : undefined
  });
}

async function readDesignFile(cfg) {
  const r = await github(cfg, 'GET', '/contents/' + DESIGN_PATH + '?ref=' + encodeURIComponent(cfg.branch));
  if (r.status === 404) return { exists: false };
  if (r.status === 401 || r.status === 403) throw githubError('github_auth_failed', r, null, cfg);
  if (r.status !== 200 || !r.json || typeof r.json.content !== 'string') throw githubError('github_read_failed', r);
  const text = Buffer.from(r.json.content, 'base64').toString('utf8');
  return { exists: true, sha: r.json.sha, text };
}

function parseBody(req) {
  let body = req.body;
  if (typeof body === 'string') { try { body = JSON.parse(body); } catch (_) { return null; } }
  if (!body || typeof body !== 'object' || Array.isArray(body)) return null;
  if (JSON.stringify(body).length > MAX_BODY_CHARS) return null;
  return body;
}

async function actionState(cfg) {
  if (cfg.readOnly) {
    const local = await localDesign();
    const body = { ok: true, revision: gitBlobSha(local.text), design: local.design, branch: cfg.branch || 'main', readOnly: true };
    if (local.warnings) body.warnings = local.warnings;
    return { status: 200, body };
  }
  const file = await readDesignFile(cfg);
  if (!file.exists) return { status: 200, body: { ok: true, revision: null, design: ED.normalize({ version: ED.VERSION }).design, branch: cfg.branch } };
  let parsed = null;
  try { parsed = JSON.parse(file.text); } catch (_) { /* reported below */ }
  const n = ED.normalize(parsed, { strict: false });
  const body = { ok: true, revision: file.sha, design: n.design, branch: cfg.branch };
  if (!n.ok || n.errors.length) body.warnings = n.errors.slice(0, 5);
  return { status: 200, body };
}

async function actionSave(cfg, body) {
  const expected = body.expectedRevision;
  if (expected !== null && !(typeof expected === 'string' && SHA_RE.test(expected))) {
    return { status: 400, body: { ok: false, error: 'expected_revision_required' } };
  }
  if (typeof body.requestId !== 'string' || !REQUEST_ID_RE.test(body.requestId)) {
    return { status: 400, body: { ok: false, error: 'request_id_required' } };
  }
  let text;
  try { text = ED.serialize(body.design); } catch (e) {
    return { status: 400, body: { ok: false, error: 'invalid_design', message: String(e.message || e).slice(0, 300) } };
  }
  if (text.length < 30) return { status: 400, body: { ok: false, error: 'invalid_design' } };
  const desiredSha = gitBlobSha(text);

  const current = await readDesignFile(cfg);
  if (current.exists && current.sha === desiredSha) {
    // Same content is already on the branch: either nothing changed, or a retry after a dropped connection.
    return { status: 200, body: { ok: true, committed: false, unchanged: true, revision: current.sha, branch: cfg.branch } };
  }
  if (current.exists ? current.sha !== expected : expected !== null) {
    return { status: 409, body: { ok: false, error: 'conflict', currentRevision: current.exists ? current.sha : null } };
  }

  const put = await github(cfg, 'PUT', '/contents/' + DESIGN_PATH, {
    message: 'design: update home page (editor)\n\nEditor-Request: ' + body.requestId,
    content: Buffer.from(text, 'utf8').toString('base64'),
    branch: cfg.branch,
    sha: current.exists ? current.sha : undefined
  });

  if (put.status === 200 || put.status === 201) {
    const revision = put.json && put.json.content && put.json.content.sha;
    if (!revision) return { status: 502, body: { ok: false, error: 'github_write_unconfirmed' } };
    return { status: 200, body: { ok: true, committed: true, revision, commit: put.json.commit && put.json.commit.sha, branch: cfg.branch } };
  }
  if (put.status === 401 || put.status === 403) return { status: 502, body: { ok: false, error: 'github_auth_failed', detail: githubError('x', put, null, cfg).detail } };
  if (put.status === 409 || put.status === 422) {
    // Someone changed the file between our read and write, or our own earlier attempt landed. Re-check, never overwrite.
    const again = await readDesignFile(cfg);
    if (again.exists && again.sha === desiredSha) {
      return { status: 200, body: { ok: true, committed: false, unchanged: true, revision: again.sha, branch: cfg.branch } };
    }
    return { status: 409, body: { ok: false, error: 'conflict', currentRevision: again.exists ? again.sha : null } };
  }
  return { status: 502, body: { ok: false, error: 'github_write_failed', detail: githubError('x', put).detail } };
}

/* Published = the live site is serving exactly the committed bytes. */
async function actionStatus(cfg, body) {
  if (typeof body.revision !== 'string' || !SHA_RE.test(body.revision)) {
    return { status: 400, body: { ok: false, error: 'revision_required' } };
  }
  let live = null;
  try {
    const controller = new AbortController();
    const timer = setTimeout(function () { controller.abort(); }, 8000);
    const response = await (selfFetch || fetch)(cfg.origin + '/design/home.json?cb=' + Date.now(), { cache: 'no-store', signal: controller.signal });
    clearTimeout(timer);
    if (response.ok) live = gitBlobSha(await response.text());
  } catch (_) { /* not reachable yet */ }
  return { status: 200, body: { ok: true, published: live === body.revision, revision: body.revision, liveRevision: live } };
}

module.exports = async function editor(req, res) {
  if (req.method !== 'GET' && req.method !== 'POST') return reply(res, 405, { ok: false, error: 'method_not_allowed' });
  try {
    const context = requireRoles(await getContext(req), ['platform_admin']);
    if (context.error) return reply(res, context.status, { ok: false, error: context.error, missing: context.missing || [] });
    let body = {};
    if (req.method === 'POST') {
      body = parseBody(req);
      if (!body) return reply(res, 400, { ok: false, error: 'invalid_request' });
    }
    const action = req.method === 'GET' ? ((req.query && req.query.action) || 'state') : body.action;
    let cfg = config();
    const readOnlyState = req.method === 'GET' && action === 'state' && cfg.error === 'editor_not_configured' && Array.isArray(cfg.missing) && cfg.missing.includes('GITHUB_TOKEN') && !cfg.missing.includes('EDITOR_SITE_ORIGIN') && cfg.missing.every((key) => key === 'GITHUB_TOKEN' || key === 'EDITOR_TARGET_BRANCH');
    if (readOnlyState) {
      cfg = { branch: process.env.EDITOR_TARGET_BRANCH || 'main', readOnly: true };
    }
    if (cfg.error) return reply(res, 503, { ok: false, error: cfg.error, missing: cfg.missing || [] });

    let result;
    if (action === 'state') result = await actionState(cfg);
    else if (action === 'save' && req.method === 'POST') result = await actionSave(cfg, body);
    else if (action === 'status' && req.method === 'POST') result = await actionStatus(cfg, body);
    else return reply(res, 400, { ok: false, error: 'unknown_action' });
    reply(res, result.status, result.body);
  } catch (e) {
    const body = { ok: false, error: (e && e.status && e.message) || 'editor_failed' };
    if (e && e.detail && typeof e.detail === 'object') body.detail = e.detail;
    reply(res, (e && e.status) || 502, body);
  }
};

module.exports.internals = { config, gitBlobSha, DESIGN_PATH };
module.exports.setDesignSource = setDesignSource;
module.exports.setSelfFetch = setSelfFetch;
