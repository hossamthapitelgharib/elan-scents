#!/usr/bin/env node
'use strict';
/* Élan Scents — build step for the Cloudflare Worker (wrangler runs it through build.command, see wrangler.jsonc).

   1. dist/                       the public files, exactly the ones railway/server.js serves (private folders, server code, SQL, the
                                  owner editor page and its login files are never copied), plus a generated _headers file.
   2. cloudflare/generated/       editor-files.js: the private editor pages and scripts, bundled into the Worker instead of served as files.

   _headers is derived from vercel.json (the shared source of cache rules) so both hosts keep the same caching. Cloudflare joins
   the values of rules that match the same URL with commas instead of letting a later rule win, so the rules are resolved here
   against the real file list (later vercel.json rule wins, as in railway/server.js) and written without overlaps. */
const fs = require('fs');
const path = require('path');
const pageHashes = require('../railway/editor-page-hashes.js');

const ROOT = path.resolve(__dirname, '..');

// Keep in step with railway/server.js (tests/cloudflare-build.test.js checks every file of the repository against the running server).
const BLOCKED_TOP = new Set(['api', 'tests', 'supabase', 'railway', 'cloudflare', 'dist', 'node_modules', 'src', 'lib', 'scripts', 'reports', 'docs', '.github', '.git']);
const EDITOR_PUBLIC_FILES = new Set(['edit-model.js', 'editor-data-bridge.js', 'editor-geometry.js', 'editor-live-library.js']);
const BLOCKED_FILES = new Set(['package.json', 'package-lock.json', 'vercel.json', 'server.js', 'wrangler.jsonc', 'wrangler.json', 'wrangler.toml', 'claude.md', 'readme.md']);
// Editor files that only the Worker may serve (after the owner signs in, or for the login page itself).
const PRIVATE_EDITOR_FILES = ['elan-editor.html', 'login.html', 'editor-login.js', 'editor-login.css', 'editor-guard.js', 'editor-media.js', 'reset.html', 'editor-reset.js'];

// Headers every response carries (railway/server.js sends the same baseline).
const BASELINE_HEADERS = [
  ['X-Content-Type-Options', 'nosniff'],
  ['Referrer-Policy', 'strict-origin-when-cross-origin'],
  ['Permissions-Policy', 'camera=(), microphone=(), geolocation=(), payment=(), usb=()'],
  ['Strict-Transport-Security', 'max-age=15552000']
];
// Cloudflare chooses these from the file itself; sending them again could only conflict.
const SKIPPED_HEADERS = new Set(['content-type', 'accept-ranges']);
const MAX_HEADER_RULES = 100;

/* Same decision as resolveStatic() in railway/server.js, for a path relative to the repository root. */
function isPublic(parts) {
  if (!parts.length || parts.some((p) => p.startsWith('.') || p === '..')) return false;
  const top = parts[0].toLowerCase();
  if (top === 'editor') return parts.length === 2 && EDITOR_PUBLIC_FILES.has(parts[1]);
  if (BLOCKED_TOP.has(top) || top.startsWith('elan-editor') || top.startsWith('elan-scents')) return false;
  if (parts.length === 1 && (BLOCKED_FILES.has(parts[0].toLowerCase()) || parts[0].toLowerCase().endsWith('.sql'))) return false;
  return true;
}

function listPublicFiles(root) {
  const out = [];
  (function walk(dir, parts) {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const next = parts.concat(entry.name);
      if (entry.name.startsWith('.')) continue;
      if (entry.isDirectory()) {
        if (parts.length === 0 && (BLOCKED_TOP.has(entry.name.toLowerCase()) || entry.name.toLowerCase().startsWith('elan-editor') || entry.name.toLowerCase().startsWith('elan-scents'))) continue;
        walk(path.join(dir, entry.name), next);
      } else if (entry.isFile() && isPublic(next)) out.push(next.join('/'));
    }
  })(root, []);
  return out.sort();
}

function urlOf(rel) {
  if (!/^[A-Za-z0-9._\/-]+$/.test(rel)) throw new Error('public file name is not safe for a _headers rule: ' + rel);
  return '/' + rel;
}

function compileRules(vercelConfig) {
  return (vercelConfig.headers || []).map((rule) => ({ re: new RegExp('^' + rule.source + '$'), rule }));
}

/* Final headers of one URL path the way railway/server.js computes them: every matching rule, later rules replace earlier ones. */
function headersFor(urlPath, rules) {
  const out = new Map();
  for (const { re, rule } of rules) {
    if (!re.test(urlPath)) continue;
    for (const h of rule.headers || []) {
      if (!SKIPPED_HEADERS.has(h.key.toLowerCase())) out.set(h.key.toLowerCase(), [h.key, h.value]);
    }
  }
  return out;
}

const signature = (map) => JSON.stringify([...map.values()].sort((a, b) => (a[0] < b[0] ? -1 : 1)));

/* Rules without overlaps: a folder whose files all end up with the same headers becomes one "/folder/*" rule, every other file with
   headers gets its own exact rule. */
function resolveRules(files, vercelConfig) {
  const rules = compileRules(vercelConfig);
  for (const [name] of BASELINE_HEADERS) {
    for (const { rule } of rules) for (const h of rule.headers || []) if (h.key.toLowerCase() === name.toLowerCase()) throw new Error('vercel.json sets ' + name + ', which the baseline already sets');
  }
  const byFile = new Map();
  for (const rel of files) byFile.set(rel, headersFor(urlOf(rel), rules));
  const sigOf = (rel) => signature(byFile.get(rel));

  // folder -> signature when every file below it agrees
  const folders = new Map();
  for (const rel of files) {
    const parts = rel.split('/');
    for (let i = 1; i < parts.length; i += 1) {
      const dir = parts.slice(0, i).join('/');
      const sig = sigOf(rel);
      if (!folders.has(dir)) folders.set(dir, sig);
      else if (folders.get(dir) !== sig) folders.set(dir, null);
    }
  }
  const empty = signature(new Map());
  const uniform = [...folders.entries()].filter(([, sig]) => sig !== null && sig !== empty).map(([dir]) => dir);
  const coveredByParent = (dir) => uniform.some((other) => other !== dir && dir.startsWith(other + '/'));
  const out = [];
  const covered = new Set();
  for (const dir of uniform.sort()) {
    if (coveredByParent(dir)) continue;
    const sample = files.find((rel) => rel.startsWith(dir + '/'));
    out.push({ pattern: '/' + dir + '/*', headers: [...byFile.get(sample).values()] });
    for (const rel of files) if (rel.startsWith(dir + '/')) covered.add(rel);
  }
  for (const rel of files) {
    if (covered.has(rel) || sigOf(rel) === empty) continue;
    out.push({ pattern: urlOf(rel), headers: [...byFile.get(rel).values()] });
  }
  // "/" is answered from /index.html by the Worker; give it the rule vercel.json has for it too.
  const root = headersFor('/', rules);
  if (root.size) out.push({ pattern: '/', headers: [...root.values()] });
  return out.sort((a, b) => (a.pattern < b.pattern ? -1 : 1));
}

/* The hero picture of design/home.json, as Link preload values for the storefront page: the browser (and Cloudflare Early Hints)
   start downloading it before the page's own scripts run. Only links design-schema.js would accept, and none with a character that
   could break the header, are used; a design without a hero picture (or a video hero) gives no link. The editor publishes a new
   design with a commit, which runs this build again, so the link follows the design. */
const HERO_PREFIXES = ['/assets/', 'https://sbgdtuqfrnfeggkwqtrw.supabase.co/storage/v1/object/public/site-media/'];
const HERO_IMAGE_EXT = /\.(?:jpe?g|png|webp|gif|avif)(?:[?#]|$)/i;
const HERO_SCREENS = { mobile: '(max-width: 639px)', tablet: '(min-width: 640px) and (max-width: 1023px)', desktop: '(min-width: 1024px)' };
function safeHeroUrl(url) {
  if (typeof url !== 'string' || url.length > 500 || /[\u0000-\u0020\u007f"'<>\\,;]/.test(url) || url.includes('..') || !HERO_IMAGE_EXT.test(url)) return '';
  return HERO_PREFIXES.some((p) => url.startsWith(p) && url.length > p.length) ? url : '';
}
function heroPreloadLinks(root) {
  let design;
  try { design = JSON.parse(fs.readFileSync(path.join(root, 'design', 'home.json'), 'utf8')); } catch (e) { return []; }
  const edits = design && design.edits;
  if (!edits || typeof edits !== 'object') return [];
  const pick = (e) => (e && ((e.style && e.style.media) || (e.media && e.media.src))) || '';
  const byScreen = {};
  for (const screen of Object.keys(HERO_SCREENS)) byScreen[screen] = safeHeroUrl(pick(edits[screen] && edits[screen].hero) || pick(edits.all && edits.all.hero));
  const urls = Object.values(byScreen);
  const link = (url, media) => '<' + url + '>; rel=preload; as=image; fetchpriority=high' + (media ? '; media="' + media + '"' : '');
  if (urls[0] && urls.every((u) => u === urls[0])) return [link(urls[0])];
  return Object.keys(HERO_SCREENS).filter((s) => byScreen[s]).map((s) => link(byScreen[s], HERO_SCREENS[s]));
}

/* Adds the hero Link header to the rules of the pages that carry the storefront (the root and /index.html). */
function withHeroLink(rules, links) {
  if (!links.length) return rules;
  const value = links.join(', ');
  for (const pattern of ['/', '/index.html']) {
    const rule = rules.find((r) => r.pattern === pattern);
    if (rule) rule.headers = rule.headers.filter(([k]) => k.toLowerCase() !== 'link').concat([['Link', value]]);
    else rules.push({ pattern, headers: [['Link', value]] });
  }
  return rules.sort((a, b) => (a.pattern < b.pattern ? -1 : 1));
}

function buildHeadersFile(files, vercelConfig, extra) {
  const rules = withHeroLink(resolveRules(files, vercelConfig), (extra && extra.heroLinks) || []);
  if (rules.length + 1 > MAX_HEADER_RULES) throw new Error('too many _headers rules (' + (rules.length + 1) + ', Cloudflare allows ' + MAX_HEADER_RULES + ')');
  const lines = [
    '# Generated by scripts/build-cloudflare.js from vercel.json. Do not edit: the next build overwrites this file.',
    '/*'
  ];
  for (const [k, v] of BASELINE_HEADERS) lines.push('  ' + k + ': ' + v);
  for (const rule of rules) {
    lines.push('', rule.pattern);
    for (const [k, v] of rule.headers) lines.push('  ' + k + ': ' + v);
  }
  return lines.join('\n') + '\n';
}

function build(options) {
  const opts = Object.assign({ root: ROOT, outDir: path.join(ROOT, 'dist'), generatedDir: path.join(ROOT, 'cloudflare', 'generated') }, options);
  const vercelConfig = JSON.parse(fs.readFileSync(path.join(opts.root, 'vercel.json'), 'utf8'));
  const files = listPublicFiles(opts.root);
  fs.rmSync(opts.outDir, { recursive: true, force: true });
  for (const rel of files) {
    const to = path.join(opts.outDir, ...rel.split('/'));
    fs.mkdirSync(path.dirname(to), { recursive: true });
    fs.copyFileSync(path.join(opts.root, ...rel.split('/')), to);
  }
  fs.writeFileSync(path.join(opts.outDir, '_headers'), buildHeadersFile(files, vercelConfig, { heroLinks: heroPreloadLinks(opts.root) }));

  const editorFiles = {};
  for (const name of PRIVATE_EDITOR_FILES) editorFiles[name] = fs.readFileSync(path.join(opts.root, 'editor', name), 'utf8');
  // CSP hashes of the editor page, computed here so the Worker does not spend CPU scanning the page on its first request.
  editorFiles['elan-editor.hashes.json'] = JSON.stringify(pageHashes.scan(editorFiles['elan-editor.html']));
  fs.mkdirSync(opts.generatedDir, { recursive: true });
  fs.writeFileSync(path.join(opts.generatedDir, 'editor-files.js'),
    "'use strict';\n/* Generated by scripts/build-cloudflare.js. The private editor pages and scripts, bundled into the Worker. */\nmodule.exports = " + JSON.stringify(editorFiles) + ';\n');
  return { files, outDir: opts.outDir, generatedDir: opts.generatedDir };
}

if (require.main === module) {
  const result = build();
  console.log('cloudflare build: ' + result.files.length + ' public files -> ' + path.relative(ROOT, result.outDir) + '/ (+ _headers), editor files bundled');
}

module.exports = { build, listPublicFiles, isPublic, buildHeadersFile, heroPreloadLinks, resolveRules, headersFor, compileRules, BASELINE_HEADERS, PRIVATE_EDITOR_FILES };
