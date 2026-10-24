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

## متغيرات البيئة (Cloudflare Worker)

القيم العامة (`SUPABASE_URL` و`SUPABASE_ANON_KEY` و`EDITOR_ENV` و`EDITOR_TARGET_BRANCH` و`GITHUB_REPO`) في `wrangler.jsonc`. الأسرار تُضاف من لوحة Cloudflare ← Worker ← Settings ← Variables and Secrets:

- `SUPABASE_SERVICE_ROLE_KEY`
- `STORE_ORDER_WEBHOOK_SECRET` — سر webhooks المتاجر (بدونه ترد الـ webhooks بـ 503)
- `GITHUB_TOKEN` — للحفظ من الإديتور على `design/home.json` (صلاحية Contents قراءة وكتابة على هذا المستودع)
- `EDITOR_SITE_ORIGIN` — اختياري: أصل الموقع العام؛ إن لم يُضبط استُعمل العنوان الذي زاره المالك

## لينك المحرر

- المحرر يعمل على `https://elan-scents.hossamthapitelgharib.workers.dev/editor` (نفس الـ Worker ونفس الأصل مع المتجر).
- خدمة `elan-editor` القديمة في Railway لا تخدم شيئاً سوى تحويل `302` إلى هذا اللينك. التفاصيل في `CLAUDE.md`.

## صلاحيات Claude على المستودع

- Claude له **صلاحية كاملة للرفع المباشر** على GitHub (على `main`) وهو **غير مطالَب بفتح Pull Request**، بقرار صاحب المشروع.
- اختبارات أي عمل تُرفع معه إلى `tests/` ولا تبقى محلياً أو في جلسة العمل فقط.
- بعد الرفع يتحقق Claude من نجاح GitHub Actions ومن نشر Workers Builds على Cloudflare، ويصلح فوراً بكوميت جديد إن ظهر خطأ.
- **لا ترحيلات معلّقة ولا انتظار موافقة** (قرار المالك 2026-10-20): Claude يطبّق ترحيلات Supabase بنفسه بعد اختبارها داخل معاملة مُلغاة، ويغيّر متغيرات الاستضافة (Cloudflare) عند الحاجة، ويبلّغ بنتيجة ما فعله.
- بطاقة موافقة من حسام تُطلب في الضرورة القصوى فقط: حذف لا رجعة فيه خارج قرار مسجّل، أو ما يكلّف مالاً، أو كشف بيانات العملاء، أو تغيير سلوك الدفع، أو تغيير `GUEST_HASH_SECRET` (القائمة الكاملة في `CLAUDE.md`).

## ملاحظات

- مجلد `editor/` **لا يُخدم كملفات عامة**؛ الدخول عبر `/editor` فقط بعد جلسة أدمن.
- المستودع المنفصل `elan-editor` نسخة أقدم موازية — الإنتاج يعتمد هذا المستودع.
