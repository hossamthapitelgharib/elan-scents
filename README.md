# Élan Scents

متجر عطور الخليج — الواجهة العامة + لوحة الإديتور على Cloudflare Workers (Worker واحد وأصل واحد): https://elan-scents.hossamthapitelgharib.workers.dev

## التشغيل

```bash
npm start          # node railway/server.js — تشغيل محلي للتجربة فقط (الإنتاج على Cloudflare)
npm test           # node --test tests/*.test.js
```

النشر تلقائي: كل رفعة على `main` ينشرها Workers Builds. الإعداد والأسرار في `cloudflare/README.md`.

فحص الصحة: `GET /health`

## البنية المختصرة

| المسار | الدور |
|--------|--------|
| `index.html` + `app.js` / `app-core.js` | واجهة المتجر |
| `design/` + `design-schema.js` + `design-layer.js` | طبقة التصميم المنشورة |
| `edit-boot.js` / `edit-mode.js` / `elan-host-bridge.js` (في الجذر) | وضع التحرير داخل iframe فقط (`?elan_editor=1`) |
| `editor/` | صفحة الإديتور + دخول المالكة (تُخدم عبر `railway/editor-host.js`) |
| `api/*` | واجهات المتجر والطلبات |
| `cloudflare/` + `wrangler.jsonc` + `scripts/build-cloudflare.js` | الـ Worker الذي يخدم الموقع كله (ملفات ثابتة + `/api/*` + الإديتور) |
| `railway/server.js` | خادم Node للتشغيل المحلي ولاختبارات المطابقة مع الـ Worker (ليس مضيف الإنتاج) |
| `vercel.json` | قواعد الـ rewrites والـ headers (يقرأها الـ Worker وخادم التشغيل المحلي) |

## أين أجد التفاصيل

| أريد أن أعرف | الملف |
|---|---|
| قواعد العمل الجماعي، صلاحيات Claude، متى تُطلب بطاقة موافقة، متغيرات الـ Worker والأسرار، لينك المحرر | `CLAUDE.md` |
| إعداد Cloudflare Worker والنشر | `cloudflare/README.md` |
| المحرر وكيف تُضاف أداة جديدة | `editor/README.md` |
| قاعدة البيانات والترحيلات ولقطة المخطط | `supabase/README.md` و`supabase/schema-snapshot/README.md` |
| الاختبارات وكيف تُشغَّل | `tests/README.md` |
| ما أُنجز وما هو مفتوح للنسخة التالية | `docs/handoff.ar.md` |
| منصة العملاء والمتاجر (المتطلبات والإغلاقات والجاهزية) | `docs/customer-platform/README.ar.md` |

## ملاحظات

- مجلد `editor/` **لا يُخدم كملفات عامة**؛ الدخول عبر `/editor` فقط بعد جلسة أدمن.
- المستودع المنفصل `elan-editor` نسخة أقدم موازية — الإنتاج يعتمد هذا المستودع.
