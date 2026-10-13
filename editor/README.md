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

## Removed from repo root (do not reintroduce)

- `editor.html` — localStorage prototype, not production
- root `editor.js` — old form UI (API is `railway/editor.js`)
- root `editor-login.js` — duplicate of `editor/editor-login.js`
- `edit-host.js` — superseded by `edit-mode.js` (recoverable from git history)

## Separate repo

`hossamthapitelgharib/elan-editor` is a **standalone** editor service (older parallel deploy). Production uses **this** repo only.


## How the editor works (mouse only)

| Gesture | What happens |
|---------|--------------|
| **Right-click** an element (or empty space) | Selects it and opens the tools menu next to the pointer |
| Menu → **تحريك العنصر** | Arms the move for that one element. Hold the left button on it and drag anywhere; releasing the button ends the move. To move another element, right-click it and choose the tool again |
| **Left-click** a dynamic element (a card that opens another page) | Enters that page inside the editor box. Each page keeps its own edits, and the home page is untouched. Menu → **رجوع للصفحة السابقة / الرئيسية** to leave |
| **Double-click** text | Edit it with the keyboard |
| Drag the corner handle of the selected element | Resize |
| **Esc** | Cancels an armed move |

Dragging without choosing the move tool does nothing, so nothing is moved by accident.

## Adding a new tool (future capabilities)

The right-click menu is built from the list in `edit-mode.js`. A new capability is one `register` call and needs no change to the editor window:

```js
window.ElanEditTools.register({
  id: 'my_tool',                       // unique id
  label: 'اسم الأداة في القايمة',        // text shown in the menu
  when: function (info) { return !!info; },   // optional: when the tool is enabled (info = the element under the pointer, or null)
  run: function (c) { /* c.id = element id, c.info = its details, c.at = pointer position */ return null; }
});
```

A tool that needs a panel can set `ui: '<name>'` and the editor window decides how to show it (as `format` does). Elements get stable ids from `ElanDesignLayer.elements()`; inner pages prefix their ids with the page (`pcard:`, `pg:`), so edits never leak between pages.
