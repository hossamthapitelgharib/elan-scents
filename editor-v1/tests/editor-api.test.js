const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const handler = require('../api/editor.js');
const ED = require('../design-schema.js');

const { gitBlobSha } = handler.internals;
const SB = 'https://sb.example.test';
const EMPTY = ED.serialize({ version: 1 });
const sha40 = (c) => c.repeat(40);

function envFor(extra) {
  return Object.assign({
    SUPABASE_URL: SB, SUPABASE_SERVICE_ROLE_KEY: 'service', GITHUB_TOKEN: 'ghp_test',
    VERCEL_ENV: 'preview', VERCEL_GIT_COMMIT_REF: 'editor-v1', VERCEL_BRANCH_URL: 'elan-git-editor-v1.vercel.app'
  }, extra || {});
}

function fakeGithub(initialText) {
  const st = { file: initialText === null ? null : initialText, puts: [], calls: [], nextPut: null };
  st.handle = (url, opts) => {
    st.calls.push({ url, method: (opts && opts.method) || 'GET' });
    if (/\/contents\/design\/home\.json/.test(url) && (!opts || !opts.method || opts.method === 'GET')) {
      if (st.file === null) return { status: 404, json: {} };
      return { status: 200, json: { sha: gitBlobSha(st.file), content: Buffer.from(st.file).toString('base64') } };
    }
    if (/\/contents\/design\/home\.json/.test(url) && opts.method === 'PUT') {
      const body = JSON.parse(opts.body);
      st.puts.push({ url, body });
      if (st.nextPut) { const n = st.nextPut; st.nextPut = null; if (n.applyText) st.file = n.applyText; return { status: n.status, json: {} }; }
      const currentSha = st.file === null ? undefined : gitBlobSha(st.file);
      if (body.sha !== currentSha) return { status: 409, json: {} };
      st.file = Buffer.from(body.content, 'base64').toString('utf8');
      return { status: 200, json: { content: { sha: gitBlobSha(st.file) }, commit: { sha: sha40('c') } } };
    }
    return { status: 500, json: {} };
  };
  return st;
}

async function run({ method = 'POST', body, query, role = 'platform_admin', token = 'good', env, github, live }) {
  const savedEnv = {};
  const e = envFor(env);
  Object.keys(e).forEach((k) => { savedEnv[k] = process.env[k]; process.env[k] = e[k]; });
  ['GITHUB_TOKEN', 'VERCEL_ENV', 'VERCEL_GIT_COMMIT_REF', 'VERCEL_BRANCH_URL', 'EDITOR_TARGET_BRANCH', 'EDITOR_SITE_ORIGIN'].forEach((k) => { if (!(k in e)) { savedEnv[k] = process.env[k]; delete process.env[k]; } });
  const realFetch = global.fetch;
  const siteCalls = [];
  global.fetch = async (url, opts) => {
    url = String(url);
    let r;
    if (url.startsWith(SB + '/auth/v1/user')) r = token === 'good' ? { status: 200, json: { id: 'u1' } } : { status: 401, json: {} };
    else if (url.startsWith(SB + '/rest/v1/profiles')) r = { status: 200, json: [{ id: 'u1', role }] };
    else if (url.startsWith('https://api.github.com/')) r = github.handle(url, opts);
    else { siteCalls.push(url); r = live ? live(url) : { status: 404, text: '' }; }
    return { ok: r.status >= 200 && r.status < 300, status: r.status, json: async () => r.json, text: async () => (r.text === undefined ? '' : r.text) };
  };
  const res = { statusCode: 0, headers: {}, body: null, status(c) { this.statusCode = c; return this; }, setHeader(k, v) { this.headers[k] = v; return this; }, json(b) { this.body = b; return this; } };
  const req = { method, headers: token ? { authorization: 'Bearer ' + token } : {}, body, query };
  try { await handler(req, res); } finally {
    global.fetch = realFetch;
    Object.keys(savedEnv).forEach((k) => { if (savedEnv[k] === undefined) delete process.env[k]; else process.env[k] = savedEnv[k]; });
  }
  return { res, siteCalls };
}

const goodDesign = () => ({ version: 1, sections: { offers: { hidden: true } }, order: [], blocks: [], texts: {} });
const saveBody = (over) => Object.assign({ action: 'save', design: goodDesign(), expectedRevision: gitBlobSha(EMPTY), requestId: 'req-12345678' }, over || {});

test('the project stays within the Vercel Hobby limit of 12 functions', () => {
  const files = fs.readdirSync(path.join(__dirname, '..', 'api')).filter((f) => f.endsWith('.js') && !f.startsWith('_'));
  assert.ok(files.length <= 12, 'functions: ' + files.length);
  assert.ok(files.includes('editor.js'));
});

test('git blob hashing matches git itself', () => {
  assert.equal(gitBlobSha('hello\n'), 'ce013625030ba8dba906f756967f9e9ca394464a');
});

test('rejects anonymous callers and non-admin roles before touching GitHub', async () => {
  const gh = fakeGithub(EMPTY);
  assert.equal((await run({ method: 'GET', token: '', github: gh })).res.statusCode, 401);
  assert.equal((await run({ method: 'GET', token: 'bad', github: gh })).res.statusCode, 401);
  for (const role of ['customer', 'store_admin']) {
    assert.equal((await run({ method: 'GET', role, github: gh })).res.statusCode, 403, role);
  }
  assert.equal(gh.calls.length, 0);
});

test('only GET and POST are accepted and unknown actions are refused', async () => {
  const gh = fakeGithub(EMPTY);
  assert.equal((await run({ method: 'DELETE', github: gh })).res.statusCode, 405);
  assert.equal((await run({ body: { action: 'drop_database' }, github: gh })).res.statusCode, 400);
  assert.equal((await run({ method: 'GET', query: { action: 'save' }, github: gh })).res.statusCode, 400);
});

test('refuses to run when GitHub is not configured', async () => {
  const r = await run({ method: 'GET', env: { GITHUB_TOKEN: '' }, github: fakeGithub(EMPTY) });
  assert.equal(r.res.statusCode, 503);
  assert.equal(r.res.body.error, 'editor_not_configured');
});

test('a preview can never write to main, and production writes to main', async () => {
  const gh = fakeGithub(EMPTY);
  const bad = await run({ method: 'GET', env: { VERCEL_GIT_COMMIT_REF: 'main' }, github: gh });
  assert.equal(bad.res.statusCode, 503);
  assert.equal(bad.res.body.error, 'preview_cannot_write_main');
  const prod = await run({ method: 'GET', env: { VERCEL_ENV: 'production', VERCEL_PROJECT_PRODUCTION_URL: 'elan.example.test' }, github: gh });
  assert.equal(prod.res.statusCode, 200);
  assert.equal(prod.res.body.branch, 'main');
  const preview = await run({ method: 'GET', github: gh });
  assert.equal(preview.res.body.branch, 'editor-v1');
});

test('state returns the committed design and its revision', async () => {
  const text = ED.serialize(goodDesign());
  const gh = fakeGithub(text);
  const r = await run({ method: 'GET', github: gh });
  assert.equal(r.res.statusCode, 200);
  assert.equal(r.res.body.revision, gitBlobSha(text));
  assert.deepEqual(r.res.body.design.sections, { offers: { hidden: true } });
  assert.equal(gh.puts.length, 0, 'state must be read-only');
});

test('save commits exactly one file, on the configured branch, with the expected sha', async () => {
  const gh = fakeGithub(EMPTY);
  const r = await run({ body: saveBody({ path: 'app.js', branch: 'main', repo: 'evil/repo' }), github: gh });
  assert.equal(r.res.statusCode, 200, JSON.stringify(r.res.body));
  assert.equal(r.res.body.committed, true);
  assert.equal(gh.puts.length, 1);
  const put = gh.puts[0];
  assert.match(put.url, /\/repos\/hossamthapitelgharib\/elan-scents\/contents\/design\/home\.json$/);
  assert.equal(put.body.branch, 'editor-v1');
  assert.equal(put.body.sha, gitBlobSha(EMPTY));
  assert.equal(Buffer.from(put.body.content, 'base64').toString('utf8'), ED.serialize(goodDesign()));
  assert.equal(r.res.body.revision, gitBlobSha(ED.serialize(goodDesign())));
  assert.equal(gh.calls.every((c) => !/app\.js|index\.html|style\.css/.test(c.url)), true);
});

test('save refuses invalid designs, missing revision and missing request id without calling GitHub to write', async () => {
  const gh = fakeGithub(EMPTY);
  const cases = [
    saveBody({ design: { version: 1, sections: { nope: {} } } }),
    saveBody({ design: null }),
    saveBody({ design: { version: 1, blocks: [{ id: 'x-a', type: 'image', src: 'javascript:alert(1)' }] } }),
    saveBody({ expectedRevision: undefined }),
    saveBody({ expectedRevision: 'not-a-sha' }),
    saveBody({ requestId: 'short' })
  ];
  for (const c of cases) assert.equal((await run({ body: c, github: gh })).res.statusCode, 400);
  assert.equal(gh.puts.length, 0);
});

test('a stale revision is rejected and nothing is overwritten', async () => {
  const newer = ED.serialize({ version: 1, texts: { ar: { magic: 'تعديل من مكان آخر' } } });
  const gh = fakeGithub(newer);
  const r = await run({ body: saveBody(), github: gh });
  assert.equal(r.res.statusCode, 409);
  assert.equal(r.res.body.error, 'conflict');
  assert.equal(r.res.body.currentRevision, gitBlobSha(newer));
  assert.equal(gh.puts.length, 0);
  assert.equal(gh.file, newer);
});

test('a race between read and write is caught by GitHub and reported as a conflict', async () => {
  const gh = fakeGithub(EMPTY);
  gh.nextPut = { status: 409, applyText: ED.serialize({ version: 1, texts: { en: { magic: 'x' } } }) };
  const r = await run({ body: saveBody(), github: gh });
  assert.equal(r.res.statusCode, 409);
  assert.equal(r.res.body.error, 'conflict');
});

test('retrying a save that already landed is a safe no-op success (network dropped after commit)', async () => {
  const gh = fakeGithub(EMPTY);
  gh.nextPut = { status: 422, applyText: ED.serialize(goodDesign()) };
  const first = await run({ body: saveBody(), github: gh });
  assert.equal(first.res.statusCode, 200);
  assert.equal(first.res.body.unchanged, true);
  const retry = await run({ body: saveBody(), github: gh });
  assert.equal(retry.res.statusCode, 200);
  assert.equal(retry.res.body.committed, false);
  assert.equal(retry.res.body.revision, gitBlobSha(ED.serialize(goodDesign())));
});

test('GitHub failures are reported clearly and never as success', async () => {
  const gh = fakeGithub(EMPTY);
  gh.nextPut = { status: 403 };
  const auth = await run({ body: saveBody(), github: gh });
  assert.equal(auth.res.statusCode, 502);
  assert.equal(auth.res.body.error, 'github_auth_failed');
  const gh2 = fakeGithub(EMPTY);
  gh2.nextPut = { status: 500 };
  const fail = await run({ body: saveBody(), github: gh2 });
  assert.equal(fail.res.statusCode, 502);
  assert.equal(fail.res.body.ok, false);
});

test('first save creates the file when it does not exist yet', async () => {
  const gh = fakeGithub(null);
  const r = await run({ body: saveBody({ expectedRevision: null }), github: gh });
  assert.equal(r.res.statusCode, 200);
  assert.equal(gh.puts[0].body.sha, undefined);
});

test('status reports published only when the live site serves the committed bytes', async () => {
  const text = ED.serialize(goodDesign());
  const rev = gitBlobSha(text);
  const gh = fakeGithub(text);
  const live = await run({ body: { action: 'status', revision: rev }, github: gh, live: () => ({ status: 200, text }) });
  assert.equal(live.res.body.published, true);
  assert.match(live.siteCalls[0], /^https:\/\/elan-git-editor-v1\.vercel\.app\/design\/home\.json\?cb=/);
  const old = await run({ body: { action: 'status', revision: rev }, github: gh, live: () => ({ status: 200, text: EMPTY }) });
  assert.equal(old.res.body.published, false);
  const down = await run({ body: { action: 'status', revision: rev }, github: gh, live: () => ({ status: 503, text: '' }) });
  assert.equal(down.res.body.published, false);
  assert.equal((await run({ body: { action: 'status', revision: 'zzz' }, github: gh })).res.statusCode, 400);
});
