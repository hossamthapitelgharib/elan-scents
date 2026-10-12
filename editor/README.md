# Editor package (production)

All editor code lives under `editor/` on `main`.

## Admin UI (not public static files)

| Path | Role |
|------|------|
| `editor/login.html` | Login at `/editor` when there is no session |
| `editor/editor-login.js` | Login form → `/api/editor-login` |
| `editor/editor-login.css` | Login styles |
| `editor/elan-editor.html` | Editor UI (only after admin session) |
| `editor/editor-guard.js` | Logout + session check inside the editor page |

Served only by `railway/editor-host.js`.

## Site-side edit tools (public, iframe only)

| Path | URL | Role |
|------|-----|------|
| `editor/edit-boot.js` | `/editor/edit-boot.js` | Loads tools only when `?elan_editor=1` and framed |
| `editor/edit-mode.js` | `/editor/edit-mode.js` | Visual edit mode inside the framed site |
| `editor/edit-model.js` | `/editor/edit-model.js` | Pure draft model (undo/redo); tests / logic |
| `editor/elan-host-bridge.js` | `/editor/elan-host-bridge.js` | postMessage bridge parent ↔ iframe |

Railway allows **only** these four files under `/editor/*` as static assets. HTML/login/guard stay private.

## Shared with the storefront (root)

| File | Role |
|------|------|
| `design-schema.js` | Shared schema (browser + Node) |
| `design-layer.js` | Applies `/design/home.json` after `render()` |
| `design/home.json` | Published design data |

## Server pieces

| File | Role |
|------|------|
| `railway/editor-host.js` | Gates `/editor`, login assets, CSP |
| `railway/editor-session.js` | In-memory admin sessions |
| `railway/editor.js` | `/api/editor` — reads/writes `design/home.json` |
| `api/editor.js` | Same API surface for Vercel-compatible path |

## Removed (do not reintroduce at repo root)

- Root `edit-boot.js`, `edit-mode.js`, `edit-model.js`, `elan-host-bridge.js` — moved here
- `editor.html`, root `editor-login.js`, `edit-host.js` — deleted earlier
