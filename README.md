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
| `edit-boot.js` / `edit-mode.js` / `elan-host-bridge.js` (في الجذر) | وضع التحرير داخل iframe فقط (`?elan_editor=1`) |
| `editor/` | صفحة الإديتور + دخول المالكة (تُخدم عبر `railway/editor-host.js`) |
| `api/*` | واجهات المتجر والطلبات |
| `railway/server.js` | الخادم الوحيد (ملفات ثابتة + `/api/*` + الإديتور) |
| `vercel.json` | قواعد الـ rewrites والـ headers (يقرأها خادم Railway أيضاً) |

## متغيرات البيئة (Railway)

- `SUPABASE_URL` / `SUPABASE_ANON_KEY` / `SUPABASE_SERVICE_ROLE_KEY`
- `GITHUB_TOKEN` — للحفظ من الإديتور على `design/home.json`
- `EDITOR_TARGET_BRANCH` — افتراضي `editor-staging` (`main` يحتاج موافقة صريحة)
- `EDITOR_SITE_ORIGIN` — أصل الموقع العام

## صلاحيات Claude على المستودع

- Claude له **صلاحية كاملة للرفع المباشر** على GitHub (على `main`) وهو **غير مطالَب بفتح Pull Request**، بقرار صاحب المشروع.
- اختبارات أي عمل تُرفع معه إلى `tests/` ولا تبقى محلياً أو في جلسة العمل فقط.
- بعد الرفع يتحقق Claude من نجاح GitHub Actions ومن نشر Railway، ويصلح فوراً بكوميت جديد إن ظهر خطأ.
- ما يحتاج موافقة صريحة يبقى كما هو في `CLAUDE.md`: تطبيق الترحيلات على Supabase، وتغيير متغيرات Railway، وأي عملية على الإنتاج.
- التفاصيل الكاملة في `CLAUDE.md`.

## ملاحظات

- مجلد `editor/` **لا يُخدم كملفات عامة**؛ الدخول عبر `/editor` فقط بعد جلسة أدمن.
- المستودع المنفصل `elan-editor` نسخة أقدم موازية — الإنتاج يعتمد هذا المستودع.
