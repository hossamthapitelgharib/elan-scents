# Élan Scents Editor — file map

The editor's browser UI and editor-only implementation live in `editor/`. This inventory distinguishes editor-owned files from storefront-shared code and runtime adapters that must stay in their framework locations.

## Admin interface (private)

| Path | Purpose |
|---|---|
| `editor/login.html` | Owner login page served at `/editor` |
| `editor/editor-login.js` | Login form client for `/api/editor-login` |
| `editor/editor-login.css` | Login page styles |
| `editor/elan-editor.html` | Authenticated editor UI |
| `editor/editor-guard.js` | Logout control and session-expiry guard |

The editor host (`railway/editor-host.js`) gates the UI and protects its source. Do not expose `editor/elan-editor.html`, `editor/login.html`, or `editor/editor-guard.js` as ordinary static files.

## Site-side editor tools (public only under `/editor/*`)

| Path | Served URL | Purpose |
|---|---|---|
| `editor/edit-boot.js` | `/editor/edit-boot.js` | Loads tools only when the storefront is framed with `?elan_editor=1` |
| `editor/edit-mode.js` | `/editor/edit-mode.js` | Full visual edit-mode implementation |
| `editor/edit-model.js` | `/editor/edit-model.js` | Draft model; also imported by Node tests |
| `editor/elan-host-bridge.js` | `/editor/elan-host-bridge.js` | Same-origin postMessage bridge |

The Railway allowlist in `railway/server.js` controls the public editor-tool filenames. Keep these files in sync with that allowlist and Railway's no-store headers. The normal storefront only loads `editor/edit-boot.js`; customers do not load the editor implementation.

## Integration files (kept in framework/shared locations)

| Path | Why it stays outside `editor/` |
|---|---|
| `railway/editor-host.js`, `railway/editor-session.js` | Railway route/session adapters and private UI gate |
| `railway/editor.js` | The single editor API handler, mounted by `railway/server.js` |
| `design-schema.js`, `design-layer.js`, `design/home.json` | Shared with storefront rendering and design persistence |
| `supabase/migrations/*editor*.sql` | Ordered database migrations; must remain in Supabase's migration directory |
| `tests/*editor*`, `tests/edit-model.test.js` | Regression and security tests for editor behavior |

## Organization rules

- Keep editor-only browser implementation and UI assets in `editor/`.
- Keep storefront-shared design logic/data at the project root and `design/`.
- Keep request handlers in the hosting locations (`api/` and `railway/`) and migrations in `supabase/migrations/`.
- Do not add duplicate editor implementation files at the repository root.
- Preserve the API URLs and static allowlists when moving files; update tests and this inventory in the same change.
