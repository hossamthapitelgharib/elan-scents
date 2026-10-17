const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const root = path.resolve(__dirname, '..');
const read = (f) => fs.readFileSync(path.join(root, f), 'utf8');

test('the editor is served only after login and never remembers the session in the browser', () => {
  assert.ok(fs.existsSync(path.join(root, 'editor/login.html')));
  assert.ok(fs.existsSync(path.join(root, 'editor/elan-editor.html')));
  assert.match(read('editor/elan-editor.html'), /elan-editor-bridge\/v1/);
  assert.doesNotMatch(read('editor/editor-login.js'), /localStorage|sessionStorage|document\.cookie/);
  assert.equal(fs.existsSync(path.join(root, 'editor.html')), false, 'the old root editor.html must not come back');
});

test('edit mode loads only inside the editor window and never for customers', () => {
  const boot = read('edit-boot.js');
  const index = read('index.html');
  assert.match(boot, /elan_editor/);
  assert.match(boot, /window\.parent === window/);
  assert.match(index, /edit-boot\.js\?v=/);
  assert.doesNotMatch(index, /edit-mode\.js|elan-host-bridge\.js/);
});

test('edit mode talks to its own editor window only', () => {
  const mode = read('edit-mode.js');
  assert.match(mode, /function editorParentOrigin\(\)/);
  assert.match(mode, /allowedEditorOrigins: \[editorParentOrigin\(\)\]/);
  assert.doesNotMatch(mode, /allowedEditorOrigins:\s*\[\s*'\*'/);
  assert.doesNotMatch(mode, /localStorage|sessionStorage/);
});

test('moving an element starts with a direct pointer drag and uses original size bounds', () => {
  const mode = read('edit-mode.js');
  const editor = read('editor/elan-editor.html');
  const geometry = read('editor/editor-geometry.js');
  assert.match(mode, /var e, mode = 'move'/);
  assert.match(mode, /Geometry\.move\(g\.r, g\.b/);
  assert.match(mode, /if \(!g\.moved\) return;/);
  assert.doesNotMatch(mode, /registerTool\(\{ id: 'move'/);
  assert.match(geometry, /MIN_WIDTH = 40/);
  assert.match(geometry, /MIN_HEIGHT = 30/);
  assert.doesNotMatch(mode, /movepad/);
  assert.doesNotMatch(mode, /ev\.key\.indexOf\('Arrow'\)/);
  assert.doesNotMatch(editor, /movepad|movePad|openMovePad/);
});

test('a dynamic element opens as its own page and the menu can go back', () => {
  const mode = read('edit-mode.js');
  assert.match(mode, /function enterPage/);
  assert.match(mode, /id: 'open'/);
  assert.match(mode, /id: 'go_back'/);
  assert.match(mode, /id: 'go_home'/);
  assert.match(read('design-layer.js'), /'pcard:'/);            // inner-page elements carry the page in their id
});

test('inner-page element ids are accepted by the design schema so their edits can be saved', () => {
  const ED = require('../design-schema.js');
  const d = ED.normalize({ version: ED.VERSION, edits: { all: {}, desktop: { 'pcard:u6zmj5bpjeh7': { dx: 80, dy: 44 }, 'pg:1abc2d:title': { dy: -10 } } } }, { strict: true });
  assert.ok(d.ok, JSON.stringify(d.errors));
  assert.equal(d.design.edits.desktop['pcard:u6zmj5bpjeh7'].dx, 80);
});

test('new capabilities are added by registering a tool, not by editing the editor', () => {
  const mode = read('edit-mode.js');
  assert.match(mode, /window\.ElanEditTools = \{ register: registerTool, list:/);
  assert.match(read('editor/README.md'), /Adding a new tool/);
});

test('when the editor cannot start, it says why instead of showing no tools', () => {
  const editor = read('editor/elan-editor.html');
  const mode = read('edit-mode.js');
  const api = read('railway/editor.js');
  assert.match(editor, /أدوات التحرير لسه مش شغالة/);
  assert.match(mode, /e\.userMessage = why/);
  assert.match(api, /missing\.push\('GITHUB_TOKEN'\)/);
  const { config } = require('../railway/editor.js').internals;
  const none = config({});
  assert.equal(none.error, 'editor_not_configured');
  assert.ok(none.missing.includes('GITHUB_TOKEN') && none.missing.includes('EDITOR_SITE_ORIGIN'));
  assert.ok(!JSON.stringify(none).includes('ghp_'));
  const ok = config({ GITHUB_TOKEN: 't', EDITOR_TARGET_BRANCH: 'main', EDITOR_SITE_ORIGIN: 'https://example.com', RAILWAY_ENVIRONMENT_NAME: 'production' });
  assert.equal(ok.error, undefined);
  const selfOrigin = config({ GITHUB_TOKEN: 't', EDITOR_TARGET_BRANCH: 'main', EDITOR_SITE_ORIGIN: 'https://editor.example.test', RAILWAY_PUBLIC_DOMAIN: 'editor.example.test', RAILWAY_ENVIRONMENT_NAME: 'production' });
  assert.equal(selfOrigin.origin, 'https://elan-site-production.up.railway.app');
});

test('save error shows which Railway settings are missing', () => {
  const page = read('editor/elan-editor.html');
  assert.match(page, /الناقص: '\+j\.missing\.join/);
});

test('right-click menu is not closed by a repeat selection message for the same element', () => {
  const page = read('editor/elan-editor.html');
  assert.match(page, /liveMenuFor=el\?\.id\|\|null/);
  assert.match(page, /\(m\.element\?\.id\|\|null\)===liveMenuFor/);
});

test('live preview defaults to the configured storefront origin, not the editor origin', () => {
  const page = read('editor/elan-editor.html');
  const host = read('railway/editor-host.js');
  const mode = read('edit-mode.js');
  assert.match(page, /address\.value=\(window\.ELAN_EDITOR_SITE_ORIGIN\|\|\'https:\/\/elan-site-production\.up\.railway\.app\'\)\+'\/'/);
  assert.match(host, /frame-src 'self' \" \+ siteOrigin/);
  assert.match(host, /window\.ELAN_EDITOR_SITE_ORIGIN/);
  assert.match(host, /frame-ancestors 'none'/);
  assert.match(page, /url\.searchParams\.set\('elan_editor_origin',location\.origin\)/);
  assert.match(mode, /allowedEditorOrigins: \[editorParentOrigin\(\)\]/);
});

test('the authenticated editor delegates a short-lived ticket to the storefront iframe without a second login', () => {
  const page = read('editor/elan-editor.html');
  const mode = read('edit-mode.js');
  const bridge = read('elan-host-bridge.js');
  const host = read('railway/editor-host.js');
  const server = read('railway/server.js');
  assert.ok(page.includes("fetch('/api/editor-bridge-ticket'"));
  assert.ok(page.includes("type:'hello',session:bridgeSession,ticket:bridgeTicket"));
  assert.ok(page.includes("type:'auth',session:bridgeSession,ticket:bridgeTicket"));
  assert.ok(page.includes('setInterval(renewBridgeTicket,4*60*1000)'));
  assert.ok(host.includes("req.headers['x-elan-editor-ticket']"));
  assert.ok(mode.includes("options.headers['X-Elan-Editor-Ticket'] = bridgeTicket"));
  assert.ok(mode.includes("https://elan-editor-production-dc4e.up.railway.app"));
  assert.ok(bridge.includes("m.type==='auth'"));
  assert.match(server, /pathname === '\/api\/editor' \|\| pathname === '\/api\/editor-data'/);
});
