# Editor package (production) — all on `main`

Entry points and admin UI live under `editor/`.

## Admin UI (private — only via `railway/editor-host.js`)

| Path | Role |
|------|------|
| `editor/login.html` | Login at `/editor` |
| `editor/editor-login.js` | Login form → `/api/editor-login` |
| `editor/editor-login.css` | Login styles |
| `editor/elan-editor.html` | Editor UI after admin session |
| `editor/editor-guard.js` | Logout + session check |

## Site-side tools (public under `/editor/*` only)

Railway serves **only** these filenames as static files from `editor/`:

| Path | URL | Role |
|------|-----|------|
| `editor/edit-boot.js` | `/editor/edit-boot.js` | Loads tools when `?elan_editor=1` + framed |
| `editor/edit-mode.js` | `/editor/edit-mode.js` | Entry; loads implementation from `/edit-mode.js` |
| `editor/elan-host-bridge.js` | `/editor/elan-host-bridge.js` | postMessage bridge |

## Still at repo root (implementation body)

| File | Why |
|------|-----|
| `edit-mode.js` | Full visual edit-mode body (~30KB); entry is under `editor/` |
| `edit-model.js` | Draft model for Node tests / logic |
| `design-schema.js` / `design-layer.js` / `design/` | Shared with the storefront |

## Server

| File | Role |
|------|------|
| `railway/editor-host.js` | Gates `/editor`, login assets, CSP |
| `railway/editor-session.js` | In-memory admin sessions |
| `railway/editor.js` | `/api/editor` writes `design/home.json` |
| `api/editor.js` | Same API surface |

## Do not reintroduce at root

- `edit-boot.js`, `elan-host-bridge.js` — live under `editor/` only
