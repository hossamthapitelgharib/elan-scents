# Élan Scents

متجر عطور الخليج — الواجهة العامة + لوحة الإديتور على نفس خدمة Railway.

## التشغيل

```bash
npm start          # node railway/server.js
npm test           # node --test tests/*.test.js
```

فحص الصحة: `GET /health`

## البنية المختصرة

| المسار | الدور |
|--------|--------|
| `index.html` + `app.js` / `app-core.js` | واجهة المتجر |
| `design/` + `design-schema.js` + `design-layer.js` | طبقة التصميم المنشورة |
| `edit-boot.js` / `edit-mode.js` / `elan-host-bridge.js` (الجذر) | وضع التحرير داخل iframe فقط (`?elan_editor=1`) |
| `editor/` | صفحة الإديتور + دخول المالكة (تُخدم عبر `railway/editor-host.js`) |
| `api/*` | واجهات المتجر والطلبات |
| `railway/server.js` | الخادم الوحيد (ملفات ثابتة + `/api/*` + الإديتور) |
| `vercel.json` | قواعد الـ rewrites والـ headers (يقرأها خادم Railway أيضاً) |

## متغيرات البيئة (Railway)

- `SUPABASE_URL` / `SUPABASE_ANON_KEY` / `SUPABASE_SERVICE_ROLE_KEY`
- `GITHUB_TOKEN` — للحفظ من الإديتور على `design/home.json`
- `EDITOR_TARGET_BRANCH` — افتراضي `editor-staging` (`main` يحتاج موافقة صريحة)
- `EDITOR_SITE_ORIGIN` — أصل الموقع العام

## ملاحظات

- مجلد `editor/` **لا يُخدم كملفات عامة**؛ الدخول عبر `/editor` فقط بعد جلسة أدمن.
- المستودع المنفصل `elan-editor` نسخة أقدم موازية — الإنتاج يعتمد هذا المستودع.
