/* Élan Scents — editor API (ONE function: Vercel Hobby allows 12, so every editor action lives here).
   Admin only. Writes exactly one file (design/home.json) with one commit per save.
   Repo, path and branch come from server configuration, never from the request. */
const crypto = require('crypto');
const { getContext, requireRoles } = require('../api/_auth');
const ED = require('../design-schema.js');

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

/* Production writes to main. A preview deployment writes ONLY to the branch it was built from,
   so testing the editor can never touch production. */
function config(env) {
  env = env || process.env;
  const isProd = env.VERCEL_ENV === 'production' || env.EDITOR_ENV === 'production';
  const token = env.GITHUB_TOKEN;
  const repo = env.GITHUB_REPO || DEFAULT_REPO;
  const branch = env.EDITOR_TARGET_BRANCH || (isProd ? 'main' : env.VERCEL_GIT_COMMIT_REF);
  const host = isProd ? env.VERCEL_PROJECT_PRODUCTION_URL : env.VERCEL_BRANCH_URL;
  const origin = env.EDITOR_SITE_ORIGIN || (host ? 'https://' + host : '');
  if (!token || !branch || !origin) return { error: 'editor_not_configured' };
  if (!/^[\w.-]+\/[\w.-]+$/.test(repo)) return { error: 'editor_not_configured' };
  if (!/^[\w./-]{1,100}$/.test(branch) || branch.indexOf('..') !== -1) return { error: 'editor_not_configured' };
  if (!/^https:\/\/[\w.-]+(:\d+)?$/.test(origin.replace(/\/+$/, ''))) return { error: 'editor_not_configured' };
  if (branch === 'main' && !isProd && env.EDITOR_ALLOW_MAIN_FROM_PREVIEW !== '1') return { error: 'preview_cannot_write_main' };
  return { token, repo, branch, origin: origin.replace(/\/+$/, ''), isProd };
}

async function github(cfg, method, path, body) {
  const response = await fetch('https://api.github.com/repos/' + cfg.repo + path, {
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
  let json = null;
  try { json = await response.json(); } catch (_) { /* empty body */ }
  return { status: response.status, json };
}

async function readDesignFile(cfg) {
  const r = await github(cfg, 'GET', '/contents/' + DESIGN_PATH + '?ref=' + encodeURIComponent(cfg.branch));
  if (r.status === 404) return { exists: false };
  if (r.status === 401 || r.status === 403) throw Object.assign(new Error('github_auth_failed'), { status: 502 });
  if (r.status !== 200 || !r.json || typeof r.json.content !== 'string') throw Object.assign(new Error('github_read_failed'), { status: 502 });
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
  if (put.status === 401 || put.status === 403) return { status: 502, body: { ok: false, error: 'github_auth_failed' } };
  if (put.status === 409 || put.status === 422) {
    // Someone changed the file between our read and write, or our own earlier attempt landed. Re-check, never overwrite.
    const again = await readDesignFile(cfg);
    if (again.exists && again.sha === desiredSha) {
      return { status: 200, body: { ok: true, committed: false, unchanged: true, revision: again.sha, branch: cfg.branch } };
    }
    return { status: 409, body: { ok: false, error: 'conflict', currentRevision: again.exists ? again.sha : null } };
  }
  return { status: 502, body: { ok: false, error: 'github_write_failed' } };
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
    const response = await fetch(cfg.origin + '/design/home.json?cb=' + Date.now(), { cache: 'no-store', signal: controller.signal });
    clearTimeout(timer);
    if (response.ok) live = gitBlobSha(await response.text());
  } catch (_) { /* not reachable yet */ }
  return { status: 200, body: { ok: true, published: live === body.revision, revision: body.revision, liveRevision: live } };
}

module.exports = async function editor(req, res) {
  if (req.method !== 'GET' && req.method !== 'POST') return reply(res, 405, { ok: false, error: 'method_not_allowed' });
  try {
    const context = requireRoles(await getContext(req), ['platform_admin']);
    if (context.error) return reply(res, context.status, { ok: false, error: context.error });
    const cfg = config();
    if (cfg.error) return reply(res, 503, { ok: false, error: cfg.error });

    let body = {};
    if (req.method === 'POST') {
      body = parseBody(req);
      if (!body) return reply(res, 400, { ok: false, error: 'invalid_request' });
    }
    const action = req.method === 'GET' ? ((req.query && req.query.action) || 'state') : body.action;

    let result;
    if (action === 'state') result = await actionState(cfg);
    else if (action === 'save' && req.method === 'POST') result = await actionSave(cfg, body);
    else if (action === 'status' && req.method === 'POST') result = await actionStatus(cfg, body);
    else return reply(res, 400, { ok: false, error: 'unknown_action' });
    reply(res, result.status, result.body);
  } catch (e) {
    reply(res, (e && e.status) || 502, { ok: false, error: (e && e.status && e.message) || 'editor_failed' });
  }
};

module.exports.internals = { config, gitBlobSha, DESIGN_PATH };
