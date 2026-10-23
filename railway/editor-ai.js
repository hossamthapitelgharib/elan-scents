/* Élan Scents — AI image generation for the editor's media library (server only, admin only).
   Off until OPENAI_API_KEY is set on the server; the key never reaches the browser or any response.
   Guards: explicit cost confirmation on every request, a rolling 24-hour cap (ELAN_AI_DAILY_LIMIT, default 10),
   one generation at a time per server instance, and the returned bytes must really be a PNG.
   A generated image is stored in the same bucket and table as uploads (source 'ai_generated'). It is never
   applied to the page by this module: the owner still picks it for an element and presses Save. */
'use strict';

const crypto = require('node:crypto');
const { looksLike, MAX_BYTES } = require('./editor-media.js');

const BUCKET = 'site-media';
const SIZES = new Set(['1024x1024', '1536x1024', '1024x1536']);
const QUALITIES = new Set(['low', 'medium', 'high']);
const DEFAULT_DAILY_LIMIT = 10;
const MAX_DAILY_LIMIT = 200;
const PROVIDER_TIMEOUT_MS = 110000;

function fail(code, status) { return Object.assign(new Error(code), { status }); }

function settings() {
  const env = process.env;
  const limit = Number.parseInt(env.ELAN_AI_DAILY_LIMIT, 10);
  const model = String(env.ELAN_AI_IMAGE_MODEL || '').trim();
  const quality = String(env.ELAN_AI_IMAGE_QUALITY || '').trim();
  return {
    key: String(env.OPENAI_API_KEY || '').trim(),
    model: /^gpt-image-[a-z0-9.-]{1,30}$/.test(model) ? model : 'gpt-image-1',
    quality: QUALITIES.has(quality) ? quality : 'medium',
    dailyLimit: Number.isInteger(limit) && limit >= 0 && limit <= MAX_DAILY_LIMIT ? limit : DEFAULT_DAILY_LIMIT
  };
}

function cleanPrompt(value) {
  if (typeof value !== 'string') throw fail('invalid_ai_prompt', 400);
  const prompt = value.normalize('NFKC').replace(/\s+/g, ' ').trim();
  if (prompt.length < 3 || prompt.length > 1000 || /[\u0000-\u001f\u007f]/.test(prompt)) throw fail('invalid_ai_prompt', 400);
  return prompt;
}

module.exports = function createAi(sb) {
  /* One generation at a time on this server, so the daily cap cannot be raced past. */
  let chain = Promise.resolve();
  function serialized(task) {
    const run = chain.then(task);
    chain = run.catch(() => {});
    return run;
  }

  async function usedLast24h(ctx) {
    const since = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
    const rows = await sb(ctx, 'media_library', '?select=id&source=eq.ai_generated&created_at=gte.' + encodeURIComponent(since) + '&limit=1000');
    return Array.isArray(rows) ? rows.length : 0;
  }

  async function status(ctx) {
    const cfg = settings();
    const used = await usedLast24h(ctx);
    return { configured: !!cfg.key, dailyLimit: cfg.dailyLimit, usedLast24h: used, remaining: Math.max(0, cfg.dailyLimit - used), model: cfg.model, quality: cfg.quality };
  }

  async function requestImage(cfg, prompt, size) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), PROVIDER_TIMEOUT_MS);
    let response;
    try {
      response = await fetch('https://api.openai.com/v1/images/generations', {
        method: 'POST',
        signal: controller.signal,
        headers: { Authorization: 'Bearer ' + cfg.key, 'Content-Type': 'application/json' },
        body: JSON.stringify({ model: cfg.model, prompt, size, quality: cfg.quality, output_format: 'png', n: 1 })
      });
    } catch (_) {
      throw fail('ai_provider_unreachable', 502);
    } finally {
      clearTimeout(timer);
    }
    let body = null;
    try { body = await response.json(); } catch (_) { /* handled below */ }
    if (!response.ok) {
      // The provider's own message can echo parts of the key; only our own codes leave this module.
      const detail = String((body && body.error && (body.error.code || body.error.type || '')) || '') + ' ' + String((body && body.error && body.error.message) || '');
      if (response.status === 429) throw fail('ai_rate_limited', 429);
      if (response.status === 401 || response.status === 403) throw fail('ai_not_authorized', 502);
      if (response.status === 400 && /moderation|content_policy|safety/i.test(detail)) throw fail('ai_prompt_rejected', 400);
      throw fail('ai_provider_failed', 502);
    }
    const encoded = body && Array.isArray(body.data) && body.data[0] && body.data[0].b64_json;
    if (typeof encoded !== 'string' || !encoded) throw fail('ai_provider_failed', 502);
    const bytes = Buffer.from(encoded, 'base64');
    if (!bytes.length || bytes.length > MAX_BYTES || !looksLike(bytes, 'image/png')) throw fail('ai_provider_failed', 502);
    return bytes;
  }

  async function store(ctx, bytes, prompt) {
    const path = 'ai/' + new Date().getUTCFullYear() + '/' + crypto.randomBytes(10).toString('hex') + '.png';
    const auth = { apikey: ctx.serviceRoleKey, Authorization: 'Bearer ' + ctx.serviceRoleKey };
    let up;
    try {
      up = await fetch(ctx.supabaseUrl + '/storage/v1/object/' + BUCKET + '/' + path, { method: 'POST', headers: { ...auth, 'Content-Type': 'image/png', 'x-upsert': 'false' }, body: bytes });
    } catch (_) {
      throw fail('storage_unreachable', 502);
    }
    if (!up.ok) throw fail('upload_failed', 502);
    const url = ctx.supabaseUrl + '/storage/v1/object/public/' + BUCKET + '/' + path;
    try {
      const rows = await sb(ctx, 'media_library', '', 'POST', [{
        file_url: url, file_type: 'image', source: 'ai_generated', title: prompt.slice(0, 120), alt_text: prompt.slice(0, 300),
        category: 'general', storage_path: path, mime_type: 'image/png', size_bytes: bytes.length, is_approved: true
      }]);
      const row = Array.isArray(rows) ? rows[0] : null;
      if (!row || !row.id) throw fail('library_record_failed', 502);
      return { id: row.id, name: row.title || prompt.slice(0, 120), src: url, url, type: 'image', category: 'general', source: 'ai_generated' };
    } catch (error) {
      // No orphan files: if the library record was not confirmed, take the stored image back out.
      try { await fetch(ctx.supabaseUrl + '/storage/v1/object/' + BUCKET + '/' + path, { method: 'DELETE', headers: auth }); } catch (_) { /* best effort */ }
      throw error && error.status ? error : fail('library_record_failed', 502);
    }
  }

  async function generate(ctx, input) {
    const cfg = settings();
    if (!cfg.key) throw fail('ai_not_configured', 503);
    if (!input || input.confirmCost !== true) throw fail('cost_confirmation_required', 400);
    const prompt = cleanPrompt(input.prompt);
    const size = input.size == null ? '1024x1024' : String(input.size);
    if (!SIZES.has(size)) throw fail('invalid_ai_size', 400);
    return serialized(async () => {
      const used = await usedLast24h(ctx);
      if (used >= cfg.dailyLimit) throw fail('ai_daily_limit_reached', 429);
      const bytes = await requestImage(cfg, prompt, size);
      return store(ctx, bytes, prompt);
    });
  }

  return { status, generate };
};

module.exports.settings = settings;
module.exports.cleanPrompt = cleanPrompt;
