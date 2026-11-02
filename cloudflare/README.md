# Élan Scents على Cloudflare Workers

المتجر وواجهات `/api/*` ومحرر المالك تُشغّلها نسخة Cloudflare Worker واحدة باسم `elan-scents`. الإعداد في `wrangler.jsonc`، ونشر الإنتاج عبر Cloudflare Workers Builds المرتبط بفرع `main`.

## المكونات
- `wrangler.jsonc`: اسم Worker، تاريخ التوافق، إعداد الملفات العامة ومتغيرات التشغيل غير السرية.
- `scripts/build-cloudflare.js`: يبني `dist/` للملفات العامة، ويولّد حزمة صفحات المحرر الخاصة في `cloudflare/generated/` قبل النشر.
- `cloudflare/worker-core.js`: طبقة طلبات واستجابات Worker وتوجيه المسارات إلى الدوال.
- `cloudflare/api-registry.js`: قائمة صريحة بدوال `api/` ووحدات المحرر من `backend/`؛ يختبر CI تطابق القائمة مع الملفات.
- `backend/`: تنفيذ Node.js مشترك لمضيف الاختبار المحلي ووحدات المحرر؛ لا يُنشر كمجلد عام. يجب أن يتطابق سلوك الخادم المحلي مع Worker.
- `vercel.json`: المصدر المشترك لقواعد الرؤوس وإعادة الكتابة؛ يبني منه السكربت قواعد Cloudflare ويستخدمه الخادم المحلي للاختبارات.
- `tests/cloudflare-*.test.js`: تقارن الملفات العامة والرؤوس وسلوك Worker بالخادم المحلي.

## الأسرار والإعداد
من لوحة Cloudflare: Workers & Pages ← `elan-scents` ← Settings ← Variables and Secrets. تُحفظ القيم السرية كـSecret ولا تضاف إلى Git.

| المتغير | مطلوب | الاستخدام |
|---|---:|---|
| `SUPABASE_SERVICE_ROLE_KEY` | نعم | وظائف API الإدارية والمحرر |
| `GITHUB_TOKEN` | للمحرر | قراءة وكتابة التصميم في هذا المستودع؛ بدونه يعمل المحرر للقراءة فقط |
| `STORE_ORDER_WEBHOOK_SECRET` | عند ربط webhooks | مصادقة webhooks المتاجر |
| `GUEST_HASH_SECRET` | اختياري | مفتاح ثابت لهوية الزوار؛ إن غاب تستخدم الخدمة المفتاح الافتراضي المحدد في الكود |

القيم العامة `SUPABASE_URL` و`SUPABASE_ANON_KEY`، وإعدادات المحرر `EDITOR_ENV` و`EDITOR_TARGET_BRANCH` و`GITHUB_REPO` محفوظة في `wrangler.jsonc`. افتراضيًا يعمل الموقع والمحرر على أصل واحد؛ لا تضبط `EDITOR_SITE_ORIGIN` أو `ELAN_EDITOR_ORIGIN` أو `ELAN_STORE_ORIGIN` إلا عند استخدام نطاقات مختلفة.

## تحقق ونشر
1. شغّل `npm ci` ثم `npm test` و`npm run build:cloudflare`.
2. شغّل `npm run test:browser` بعد `npx playwright install chromium`.
3. على Cloudflare، تحقق من `/health` ثم `/` و`/api/config` و`/editor`.
4. راقب GitHub Actions: اختبارات Node، فحص Worker، واختبارات النشر الحي/المراقبة وفق ملفات workflow.

ملفات الفيديو التي تتطلب طلبات `Range` يجب أن تبقى ضمن `run_worker_first` في `wrangler.jsonc`؛ يوجد اختبار يمنع نسيانها. لا تُضف أسرارًا إلى ملفات الإعداد العامة أو سجلات الاختبارات.

## التشغيل المحلي للاختبارات
`npm start` يشغّل الخادم المحلي على `PORT` أو المنفذ 3000. `npx wrangler dev` يشغّل Worker محليًا، ويمكن وضع الأسرار اللازمة في `.dev.vars` (مستثنى من Git).
