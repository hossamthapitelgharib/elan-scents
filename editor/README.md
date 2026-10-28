# Editor layout (production)

The live editor runs **on the same Cloudflare Worker and the same origin as the storefront** (`elan-scents`, https://elan-scents.hossamthapitelgharib.workers.dev/editor).

## Runtime paths

| Path | Role |
|------|------|
| `editor/login.html` | Login page served at `/editor` when there is no session |
| `editor/editor-login.js` | Login form → `/api/editor-login` |
| `editor/editor-login.css` | Login styles |
| `editor/elan-editor.html` | Editor UI (only after admin session) |
| `editor/editor-guard.js` | Logout + session check inside the editor page |
| `railway/editor-host.js` | Gates `/editor`, login assets, CSP |
| `railway/editor-session.js` | Admin sessions: encrypted browser-session cookie (sliding idle timeout, renewed on use) |
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

Same mouse model as the original editor: **right-click = the tools menu, left-click + drag = move.**

| Gesture | What happens |
|---------|--------------|
| **Right-click** an element (or empty space) | Selects it and opens the tools menu next to the pointer. The 17 original tools come first, in the original order and with the original enablement (empty space: only the creation tools); the tools added later (إنشاء صورة, فتح العنصر, رجوع…) come after them |
| **Left-click + drag** an element | Moves it straight away, no tool to arm |
| Drag a **card** (inside its strip) or a page **section / extra block** | Automatic displacement, like the original flow: it goes next to the sibling nearest to the pointer, every other one shifts to make room, a gold bar shows where it will land, and the new order is saved (`design.order` for sections and blocks, `design.cardOrder` for cards, per page). Hold **Alt** to place it freely instead |
| Drag a title, a text, the hero or a footer part | Free-form: moves by an offset, nothing else is displaced |
| Drag the corner handle of the selected element | Resize |
| **Left-click** a dynamic element (a card that opens another page) | Enters that page inside the editor box. Each page keeps its own edits, and the home page is untouched. Menu → **رجوع للصفحة السابقة / الرئيسية** to leave |
| **Double-click** text | Edit it with the keyboard (Enter saves, Esc cancels) |
| Menu → **إنشاء كتلة نصية / بانر صورة أو فيديو** | Creates a block in the page flow at the click point; the sections around it make room |
| Menu → **إنشاء نص** | Creates a free text laid over the page exactly where you clicked; it takes no room in the flow, so nothing is displaced |
| Menu → **نسخ العنصر** | Copies an extra block (20px down and to the side, like the original), or turns a card into a banner / a title into a text block / a picture into an image block, right after its section. A section or the hero cannot be copied yet |
| Menu → **تعديل النص بالكيبورد** on a section / the hero | Edits the text the element owns: its title, or the headline of the hero |
| **Esc**, a left click or a scroll | Closes the tools menu; during a drag, Esc cancels it and puts the element back |

## Pictures and videos

Menu → **رفع صورة أو فيديو داخل العناصر أو الهيرو**, **إنشاء بانر صورة أو فيديو** and **إنشاء صورة أو فيديو** open the same picker: the library (pictures and videos, a video shows its first frame), upload from the device, or AI generation (pictures only, needs a key and your approval of the cost).

| | Pictures | Videos |
|--|----------|--------|
| Types | JPG, PNG, WebP, GIF, AVIF | MP4 (H.264) and WebM |
| Size | up to 10 MB | up to 50 MB: the `site-media` bucket's own limit (`storage.buckets.file_size_limit`), which Supabase enforces itself |
| Path | browser → `/api/editor-upload` (the Worker) → the bucket | browser → the bucket **directly** (see below); the Worker never holds the video |
| Storage | the `site-media` bucket and a row in `media_library` (`file_type` image / video) | same |
| Checked by the server | MIME type **and** the file's own first bytes must agree (an AVIF cannot pass as MP4, a Matroska file cannot pass as WebM) | same, but after the upload: the server reads the first 256 bytes and the size of the stored file; a file that fails is deleted from the bucket and never reaches the library |
| Where it can go | a card, a section background, the hero, a banner, an image block | a card or element picture is swapped for the video in place; the hero keeps its video element; a banner plays it behind its text (`video` field, one of picture / video at a time); an image block shows it as a moving picture |

A video on the page plays by itself, muted and looping, inline (browsers refuse sound without a tap). Undo restores what was there before. Videos from the bucket are allowed in the public pages' policy (`media-src` in `vercel.json`); a new video host would need to be added there too.

**How a video is uploaded.** (1) The picker asks `POST /api/editor-upload-sign` (`{type, size}`); the server picks the file name and asks Supabase Storage for a one-time signed upload address, as the admin's own session (no service key). (2) The picker `PUT`s the file (a form with `cacheControl` and the file, the same request `supabase-js` `uploadToSignedUrl` sends) to that address with the public anon key, and shows the progress. (3) The picker calls `POST /api/editor-upload-done` (`{path, type, name}`); the server fetches `bytes=0-255` of the public file, checks the signature and the real size, then inserts the `media_library` row. The editor page's policy allows `connect-src` to the Supabase origin for this (`railway/editor-host.js`); the Worker only handles small JSON. Pictures are small and keep going through the server.

**Limits and types are the bucket's, not the Worker's.** The server's `MAX_VIDEO_BYTES` (`railway/editor-media.js`) mirrors the bucket's 50 MB so the answer comes early with a clear message. To allow bigger videos raise the bucket limit in Supabase (the project's global storage limit also applies and depends on the plan), then that constant and the 50 in `editor/editor-media.js`. To allow another video type (for example `video/quicktime`) add it to the bucket's allowed MIME types, to `VIDEO_TYPES` and `looksLike` in the server file, and test that browsers can play it: MP4 (H.264) and WebM are the only two every browser plays; a phone's `.mov` is often HEVC, which Chrome and Firefox do not play.

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
