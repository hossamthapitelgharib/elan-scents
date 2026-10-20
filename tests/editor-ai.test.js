const test = require('node:test');
const assert = require('node:assert/strict');
const editorData = require('../railway/editor-data.js');

const KEY = 'sk-test-openai-key-123456';
const PNG = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.from('fake-image-bytes')]);
const JPEG = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.from('not-a-png-at-all')]);

function makeRes() {
  return {
    statusCode: 200, headers: {}, body: null,
    status(code) { this.statusCode = code; return this; },
    setHeader(name, value) { this.headers[name.toLowerCase()] = value; return this; },
    json(value) { this.body = value; return this; }
  };
}

test('AI image generation is guarded, capped, never leaks the key and never leaves orphan files', async (t) => {
  const saved = { fetch: global.fetch, url: process.env.SUPABASE_URL, role: process.env.SUPABASE_SERVICE_ROLE_KEY, key: process.env.OPENAI_API_KEY, limit: process.env.ELAN_AI_DAILY_LIMIT };
  process.env.SUPABASE_URL = 'https://supabase.test';
  process.env.SUPABASE_SERVICE_ROLE_KEY = 'test-service-role';
  process.env.ELAN_AI_DAILY_LIMIT = '2';
  delete process.env.OPENAI_API_KEY;

  const state = { openai: [], storage: [], mediaRows: [], deletes: [], provider: null, recordFails: false };
  const okImage = () => ({ ok: true, status: 200, json: async () => ({ data: [{ b64_json: PNG.toString('base64') }] }) });
  state.provider = okImage;

  global.fetch = async (url, options = {}) => {
    const method = options.method || 'GET';
    if (String(url).startsWith('https://api.openai.com/')) {
      state.openai.push({ url: String(url), headers: options.headers, body: JSON.parse(options.body) });
      const next = state.provider();
      if (next instanceof Error) throw next;
      return next;
    }
    const parsed = new URL(url);
    if (parsed.pathname.startsWith('/storage/v1/object/')) {
      assert.equal(options.headers.apikey, 'test-service-role');
      if (method === 'POST') { state.storage.push({ path: parsed.pathname, headers: options.headers, body: options.body }); return { ok: true, status: 200, json: async () => ({}) }; }
      if (method === 'DELETE') { state.deletes.push(parsed.pathname); return { ok: true, status: 200, json: async () => ({}) }; }
    }
    if (parsed.pathname === '/rest/v1/media_library') {
      assert.equal(options.headers.apikey, 'test-service-role');
      if (method === 'GET') return { ok: true, status: 200, json: async () => state.mediaRows.map((r) => ({ id: r.id })) };
      if (method === 'POST') {
        if (state.recordFails) return { ok: false, status: 500, json: async () => ({ message: 'boom' }) };
        const row = { id: '90000000-0000-4000-8000-00000000000' + (state.mediaRows.length + 1), ...JSON.parse(options.body)[0] };
        state.mediaRows.push(row);
        return { ok: true, status: 201, json: async () => [row] };
      }
    }
    return { ok: false, status: 404, json: async () => ({ message: 'unexpected request' }) };
  };

  async function post(body) { const res = makeRes(); await editorData({ method: 'POST', query: {}, body, headers: {}, __editorKeyAdmin: true }, res); return res; }
  async function get(query) { const res = makeRes(); await editorData({ method: 'GET', query, headers: {}, __editorKeyAdmin: true }, res); return res; }
  const reset = () => { state.openai.length = 0; state.storage.length = 0; state.deletes.length = 0; state.mediaRows.length = 0; state.recordFails = false; state.provider = okImage; };
  const ask = { action: 'ai.generate', prompt: 'زجاجة عطر ذهبية على رخام أسود', confirmCost: true };

  try {
    await t.test('off until the server has a key: status says so and nothing is sent anywhere', async () => {
      const status = await get({ action: 'ai.status' });
      assert.equal(status.statusCode, 200);
      assert.deepEqual(status.body.ai, { configured: false, dailyLimit: 2, usedLast24h: 0, remaining: 2, model: 'gpt-image-1', quality: 'medium' });
      const res = await post(ask);
      assert.equal(res.statusCode, 503);
      assert.equal(res.body.error, 'ai_not_configured');
      assert.equal(state.openai.length, 0);
    });

    process.env.OPENAI_API_KEY = KEY;

    await t.test('every request must confirm the cost and carry a clean prompt and a known size', async () => {
      reset();
      assert.equal((await post({ ...ask, confirmCost: undefined })).body.error, 'cost_confirmation_required');
      assert.equal((await post({ ...ask, confirmCost: 'yes' })).body.error, 'cost_confirmation_required');
      for (const prompt of ['', 'ab', 'x'.repeat(1001), 'bad\u0007prompt', 42, null]) {
        const res = await post({ ...ask, prompt });
        assert.equal(res.statusCode, 400, JSON.stringify(prompt));
        assert.equal(res.body.error, 'invalid_ai_prompt');
      }
      assert.equal((await post({ ...ask, size: '9999x9999' })).body.error, 'invalid_ai_size');
      assert.equal(state.openai.length, 0, 'nothing reaches the provider (and nothing is billed) for a refused request');
    });

    await t.test('a confirmed request generates, stores and records the image, and the key stays server-side', async () => {
      reset();
      const res = await post({ ...ask, prompt: '  زجاجة   عطر\nذهبية  ' });
      assert.equal(res.statusCode, 200, JSON.stringify(res.body));
      assert.equal(state.openai.length, 1);
      const sent = state.openai[0];
      assert.equal(sent.url, 'https://api.openai.com/v1/images/generations');
      assert.equal(sent.headers.Authorization, 'Bearer ' + KEY);
      assert.deepEqual(sent.body, { model: 'gpt-image-1', prompt: 'زجاجة عطر ذهبية', size: '1024x1024', quality: 'medium', output_format: 'png', n: 1 });
      assert.equal(state.storage.length, 1);
      assert.match(state.storage[0].path, /^\/storage\/v1\/object\/site-media\/ai\/\d{4}\/[0-9a-f]{20}\.png$/);
      assert.equal(state.storage[0].headers['Content-Type'], 'image/png');
      assert.ok(Buffer.from(state.storage[0].body).equals(PNG));
      const row = state.mediaRows[0];
      assert.equal(row.source, 'ai_generated');
      assert.equal(row.file_type, 'image');
      assert.equal(row.mime_type, 'image/png');
      assert.equal(row.size_bytes, PNG.length);
      assert.equal(row.is_approved, true);
      assert.equal(row.title, 'زجاجة عطر ذهبية');
      assert.equal(row.file_url, 'https://supabase.test' + state.storage[0].path.replace('/storage/v1/object/', '/storage/v1/object/public/'));
      assert.deepEqual(res.body.item, { id: row.id, name: 'زجاجة عطر ذهبية', src: row.file_url, url: row.file_url, type: 'image', category: 'general', source: 'ai_generated' });
      assert.ok(!JSON.stringify(res.body).includes(KEY));
    });

    await t.test('the rolling 24-hour cap stops the request before the provider is called', async () => {
      reset();
      assert.equal((await post(ask)).statusCode, 200);
      assert.equal((await post(ask)).statusCode, 200);
      const third = await post(ask);
      assert.equal(third.statusCode, 429);
      assert.equal(third.body.error, 'ai_daily_limit_reached');
      assert.equal(state.openai.length, 2);
      const status = await get({ action: 'ai.status' });
      assert.deepEqual([status.body.ai.configured, status.body.ai.usedLast24h, status.body.ai.remaining], [true, 2, 0]);
    });

    await t.test('simultaneous requests cannot race past the cap', async () => {
      reset();
      process.env.ELAN_AI_DAILY_LIMIT = '1';
      try {
        const results = await Promise.all([post(ask), post(ask), post(ask)]);
        assert.deepEqual(results.map((r) => r.statusCode).sort(), [200, 429, 429]);
        assert.equal(state.openai.length, 1);
        assert.equal(state.mediaRows.length, 1);
      } finally { process.env.ELAN_AI_DAILY_LIMIT = '2'; }
    });

    await t.test('provider failures become safe codes and never echo provider text or the key', async () => {
      const cases = [
        [() => ({ ok: false, status: 429, json: async () => ({ error: { message: 'rate limit for ' + KEY } }) }), 429, 'ai_rate_limited'],
        [() => ({ ok: false, status: 401, json: async () => ({ error: { message: 'Incorrect API key provided: ' + KEY } }) }), 502, 'ai_not_authorized'],
        [() => ({ ok: false, status: 400, json: async () => ({ error: { code: 'moderation_blocked', message: 'rejected by the safety system' } }) }), 400, 'ai_prompt_rejected'],
        [() => ({ ok: false, status: 500, json: async () => ({ error: { message: 'oops ' + KEY } }) }), 502, 'ai_provider_failed'],
        [() => ({ ok: true, status: 200, json: async () => ({ data: [] }) }), 502, 'ai_provider_failed'],
        [() => ({ ok: true, status: 200, json: async () => ({ data: [{ b64_json: JPEG.toString('base64') }] }) }), 502, 'ai_provider_failed'],
        [() => new Error('socket hang up ' + KEY), 502, 'ai_provider_unreachable']
      ];
      for (const [provider, status, code] of cases) {
        reset();
        state.provider = provider;
        const res = await post(ask);
        assert.equal(res.statusCode, status, code);
        assert.equal(res.body.error, code);
        assert.ok(!JSON.stringify(res.body).includes(KEY), 'the key never appears in a response');
        assert.equal(state.storage.length, 0, 'nothing is stored when the provider did not return a real PNG');
        assert.equal(state.mediaRows.length, 0);
      }
    });

    await t.test('if the library record is not confirmed the stored image is taken back out', async () => {
      reset();
      state.recordFails = true;
      const res = await post(ask);
      assert.equal(res.statusCode, 502);
      assert.equal(state.storage.length, 1);
      assert.deepEqual(state.deletes, [state.storage[0].path]);
      assert.equal(state.mediaRows.length, 0);
    });
  } finally {
    global.fetch = saved.fetch;
    for (const [name, value] of [['SUPABASE_URL', saved.url], ['SUPABASE_SERVICE_ROLE_KEY', saved.role], ['OPENAI_API_KEY', saved.key], ['ELAN_AI_DAILY_LIMIT', saved.limit]]) {
      if (value === undefined) delete process.env[name]; else process.env[name] = value;
    }
  }
});
