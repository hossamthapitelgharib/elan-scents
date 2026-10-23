# Élan Scents على Cloudflare Workers

الموقع كله (الملفات الثابتة + `/api/*` + محرر المالك) يعمل من Worker واحد باسم `elan-scents`.
Railway يبقى شغّالاً كما هو حتى يُقرَّر التحويل؛ لا شيء هنا يغيّر سلوكه.

## ماذا يوجد في المستودع
- `wrangler.jsonc`: إعداد الـ Worker (الاسم، مجلد الملفات الثابتة `dist/`، المسارات التي يعمل فيها الكود أولاً، المتغيرات غير السرية).
- `scripts/build-cloudflare.js`: يُشغَّل تلقائياً قبل كل نشر (`build.command`). يبني `dist/` (نفس الملفات العامة التي يقدّمها `railway/server.js` بالضبط، مع ملف `_headers` مولَّد من `vercel.json`) ويضمّ صفحات المحرر الخاصة داخل الـ Worker (`cloudflare/generated/`، غير مرفوع).
- `cloudflare/worker-core.js`: يحوّل الطلب إلى `req`/`res` على طريقة Node ويشغّل نفس ملفات `api/*.js` و`railway/editor-host.js` بدون تعديل في منطقها.
- `cloudflare/api-registry.js`: قائمة ثابتة بدوال الـ API (الحزمة لا تستطيع قراءة المجلد وقت التشغيل). اختبار يفشل إن أضفتَ ملفاً في `api/` ونسيتَ القائمة.
- `tests/cloudflare-*.test.js`: يتأكدان أن الملفات العامة مطابقة لـ Railway بالبايت، وأن رؤوس الكاش مطابقة، وأن ردّ الـ Worker مطابق لردّ خادم Railway لنفس الطلب.

## التفعيل (مرة واحدة، من لوحة Cloudflare)
1. **Workers & Pages ← `elan-scents` ← Settings ← Builds ← Connect**: اربط مستودع GitHub `hossamthapitelgharib/elan-scents` والفرع `main`. اترك Build command فارغاً (الـ Worker يبنّي نفسه)، وأمر النشر الافتراضي `npx wrangler deploy`. كل دفع إلى `main` ينشر بعدها تلقائياً (بما فيه حفظات المحرر).
2. **Settings ← Variables and Secrets**: أضف القيم التالية (الأسرار كـ Secret):

| الاسم | نوعه | ملاحظة |
|---|---|---|
| `SUPABASE_URL` | Variable | نفس قيمة Railway |
| `SUPABASE_ANON_KEY` | Secret | نفس قيمة Railway |
| `SUPABASE_SERVICE_ROLE_KEY` | Secret | نفس قيمة Railway |
| `STORE_ORDER_WEBHOOK_SECRET` | Secret | نفس قيمة Railway (وإلا ترد الـ webhooks بـ 503) |
| `GUEST_HASH_SECRET` | Secret | **إن كان مضبوطاً على Railway انسخ القيمة نفسها حرفياً**؛ أي قيمة أخرى تبدأ كل ضيف من الصفر. وإن لم يكن مضبوطاً هناك فلا تضفه |
| `GITHUB_TOKEN` | Secret | للمحرر (الكتابة على `main`) |

`EDITOR_ENV` و`EDITOR_TARGET_BRANCH` و`GITHUB_REPO` موجودة في `wrangler.jsonc`. أما `EDITOR_SITE_ORIGIN` و`ELAN_EDITOR_ORIGIN` و`ELAN_STORE_ORIGIN` فإن لم تُضبط يستعمل الـ Worker العنوان الذي زرتَه به (المحرر والمتجر على أصل واحد)؛ اضبطها فقط إن استعملت أكثر من نطاق.
3. افتح `https://<الـ worker>.workers.dev/health` (يردّ `ok`) ثم `/` و`/api/config` و`/editor`.

## التحويل الكامل
- النطاق: Settings ← Domains & Routes ← Add Custom Domain.
- غيّر رابط الـ webhook في أي متجر مربوط (`/api/store-order-status` وأخواتها) إلى النطاق الجديد.
- بعد التأكد أوقف خدمة Railway.

## حدود الخطة المجانية (Workers Free)
- الملفات الثابتة بلا حد ولا تُحسب طلبات؛ الطلبات التي تشغّل الكود (`/api/*` و`/editor`) حدّها 100 ألف في اليوم.
- 10 ملي ثانية CPU للطلب الواحد و50 طلباً خارجياً (Supabase/GitHub) للطلب. صفحة المحرر تُحسب هاشاتها وقت البناء لهذا السبب. لو ظهر الخطأ 1102 في اللوحة فالمعالجة تحتاج الخطة المدفوعة (5$ شهرياً) وهذا قرار مالك.
- حدّ الطلبات في `lib/rate-limit.js` وعدّاد محاولات الدخول في الذاكرة، وعلى Cloudflare الذاكرة لكل نسخة تشغيل (isolate)؛ فهو أضعف من Railway ذي النسخة الواحدة. جلسة المحرر (كوكي مشفّر) لا تتأثر.

## تشغيل محلي
`npx wrangler dev` (يحتاج ملف `.dev.vars` فيه نفس الأسرار، وهو مستثنى من Git).
