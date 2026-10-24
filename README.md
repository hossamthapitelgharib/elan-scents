# Élan Scents

<<<<<<< Updated upstream
متجر عطور الخليج — الواجهة العامة + لوحة الإديتور على Cloudflare Workers (Worker واحد وأصل واحد): https://elan-scents.hossamthapitelgharib.workers.dev
=======
متجر عطور الخليج — الواجهة العامة + لوحة الإديتور على Worker واحد في Cloudflare: `https://elan-scents.hossamthapitelgharib.workers.dev` (Railway أُغلق، قرار 2026-10-24).
>>>>>>> Stashed changes

## التشغيل

```bash
<<<<<<< Updated upstream
npm start          # node railway/server.js — تشغيل محلي للتجربة فقط (الإنتاج على Cloudflare)
=======
npm start          # خادم Node محلي للتجربة (railway/server.js) — وهو أيضاً المرجع الذي تقارن به الاختبارات رد الـ Worker
>>>>>>> Stashed changes
npm test           # node --test tests/*.test.js
npm run build:cloudflare   # يبني dist/ لـ Cloudflare (يُشغَّل تلقائياً قبل كل نشر)
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
<<<<<<< Updated upstream
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
=======
| `cloudflare/` + `wrangler.jsonc` + `scripts/build-cloudflare.js` | الاستضافة: Worker واحد (ملفات ثابتة + `/api/*` + الإديتور). التفاصيل في `cloudflare/README.md` |
| `railway/` | كود الخادم المشترك (`editor-host.js` وأخواته) وخادم Node المحلي `server.js`؛ الاسم قديم والمضيف Cloudflare |
| `vercel.json` | قواعد الـ rewrites والـ headers (مصدرها المشترك: يقرأها الـ Worker ويولّد منها `_headers`) |

## متغيرات البيئة (Cloudflare)

القيم العامة (`SUPABASE_URL` و`SUPABASE_ANON_KEY` و`EDITOR_ENV` و`EDITOR_TARGET_BRANCH` و`GITHUB_REPO`) في `wrangler.jsonc`. الأسرار تُضاف من لوحة Cloudflare: Workers & Pages ← `elan-scents` ← Settings ← Variables and Secrets (لا يمكن قراءتها بعد الحفظ):

- `SUPABASE_SERVICE_ROLE_KEY` — سر
- `STORE_ORDER_WEBHOOK_SECRET` — سر webhooks المتاجر (بدونه ترد الـ webhooks بـ 503)
- `GITHUB_TOKEN` — للحفظ من الإديتور على `design/home.json` (توكن GitHub دقيق الصلاحيات: Contents قراءة وكتابة على هذا المستودع فقط)
- `GUEST_HASH_SECRET` — اختياري (16 حرفاً فأكثر)؛ مفتاح تشفير هوية الضيوف، وإن لم يُضبط يُستخدم مفتاح service-role
- `EDITOR_SITE_ORIGIN` — اختياري؛ إن لم يُضبط يستعمل الـ Worker العنوان الذي زرتَه به

## لينك المحرر

- المحرر يعمل على `https://elan-scents.hossamthapitelgharib.workers.dev/editor`.
>>>>>>> Stashed changes

## صلاحيات Claude على المستودع

- Claude له **صلاحية كاملة للرفع المباشر** على GitHub (على `main`) وهو **غير مطالَب بفتح Pull Request**، بقرار صاحب المشروع.
- اختبارات أي عمل تُرفع معه إلى `tests/` ولا تبقى محلياً أو في جلسة العمل فقط.
<<<<<<< Updated upstream
- بعد الرفع يتحقق Claude من نجاح GitHub Actions ومن نشر Workers Builds على Cloudflare، ويصلح فوراً بكوميت جديد إن ظهر خطأ.
- **لا ترحيلات معلّقة ولا انتظار موافقة** (قرار المالك 2026-10-20): Claude يطبّق ترحيلات Supabase بنفسه بعد اختبارها داخل معاملة مُلغاة، ويغيّر متغيرات الاستضافة (Cloudflare) عند الحاجة، ويبلّغ بنتيجة ما فعله.
=======
- بعد الرفع يتحقق Claude من نجاح GitHub Actions ومن نشر Cloudflare (النشر تلقائي من `main` عبر Workers Builds)، ويصلح فوراً بكوميت جديد إن ظهر خطأ.
- **لا ترحيلات معلّقة ولا انتظار موافقة** (قرار المالك 2026-10-20): Claude يطبّق ترحيلات Supabase بنفسه بعد اختبارها داخل معاملة مُلغاة، ويغيّر إعدادات النشر عند الحاجة، ويبلّغ بنتيجة ما فعله.
>>>>>>> Stashed changes
- بطاقة موافقة من حسام تُطلب في الضرورة القصوى فقط: حذف لا رجعة فيه خارج قرار مسجّل، أو ما يكلّف مالاً، أو كشف بيانات العملاء، أو تغيير سلوك الدفع، أو تغيير `GUEST_HASH_SECRET` (القائمة الكاملة في `CLAUDE.md`).

## ملاحظات

- مجلد `editor/` **لا يُخدم كملفات عامة**؛ الدخول عبر `/editor` فقط بعد جلسة أدمن.
- المستودع المنفصل `elan-editor` نسخة أقدم موازية — الإنتاج يعتمد هذا المستودع.
