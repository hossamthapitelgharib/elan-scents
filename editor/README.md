# Editor layout (production)

The live editor runs **on the same Railway service as the storefront** (`elan-scents`).

## Runtime paths

| Path | Role |
|------|------|
| `editor/login.html` | Login page served at `/editor` when there is no session |
| `editor/editor-login.js` | Login form → `/api/editor-login` |
| `editor/editor-login.css` | Login styles |
| `editor/elan-editor.html` | Editor UI (only after admin session) |
| `editor/editor-guard.js` | Logout + session check inside the editor page |
| `railway/editor-host.js` | Gates `/editor`, login assets, CSP |
| `railway/editor-session.js` | In-memory admin sessions |
| `railway/editor.js` | `/api/editor` — reads/writes `design/home.json` on GitHub |

## Storefront design layer (customers + iframe preview)

| File | Role |
|------|------|
| `design-schema.js` | Shared schema (browser + Node) |
| `design-layer.js` | Applies `/design/home.json` after `render()` |
| `design/home.json` | Published design data |
| `edit-boot.js` | Loads edit tools only when `?elan_editor=1` inside iframe |
| `edit-mode.js` | Visual edit mode inside the framed site |
| `elan-host-bridge.js` | postMessage bridge parent ↔ iframe |
| `edit-model.js` | Pure draft model (undo/redo); used by tests / editor logic |

## Removed (do not reintroduce)

- `editor.html` — localStorage prototype (deleted 2026-10-12)
- root `editor-login.js` — moved to `editor/editor-login.js`
- `edit-host.js` — superseded by `edit-mode.js`
- `elan-editor-handoff-summary.md`, `elan-editor-master-spec.md`, `elan-original-tools-golden.json` — outdated docs/snapshots

## Separate repo

`hossamthapitelgharib/elan-editor` is a **standalone** older parallel deploy. Production uses **this** repo only.
