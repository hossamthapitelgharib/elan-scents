/* Élan Scents — Cloudflare Worker entry (see cloudflare/README.md and wrangler.jsonc).
   `npm run build:cloudflare` (run automatically by wrangler through build.command) creates dist/ and
   cloudflare/generated/editor-files.js before this file is bundled. */
import core from './worker-core.js';
import registry from './api-registry.js';
import editorFiles from './generated/editor-files.js';

const deps = { api: registry.api, editorHost: registry.editorHost, editorFiles };

export default {
  async fetch(request, env, ctx) {
    try {
      return await core.handleRequest(request, env, ctx, deps);
    } catch (e) {
      console.error('worker error', e && e.message);
      return new Response(JSON.stringify({ error: 'server_error' }), { status: 500, headers: { 'Content-Type': 'application/json; charset=utf-8' } });
    }
  }
};
