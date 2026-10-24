# Élan Scents على Cloudflare Workers

الموقع كله (الملفات الثابتة + `/api/*` + محرر المالك) يعمل من Worker واحد باسم `elan-scents`.
<<<<<<< Updated upstream
هذا هو مضيف المشروع (قرار حسام 2026-10-22). على Railway بقيت خدمة `elan-editor` فقط، تحوّل لينك المحرر القديم إلى هنا.
=======
العنوان الحالي: `https://elan-scents.hossamthapitelgharib.workers.dev`. Railway أُغلق (قرار 2026-10-24) ولا يُستعمل بعد الآن؛ ملفات `railway/` بقيت لأن الـ Worker يشغّل كودها نفسه.
>>>>>>> Stashed changes

## ماذا يوجد في المستودع
- `wrangler.jsonc`: إعداد الـ Worker (الاسم، مجلد الملفات الثابتة `dist/`، المسارات التي يعمل فيها الكود أولاً، المتغيرات غير السرية).
- `scripts/build-cloudflare.js`: يُشغَّل تلقائياً قبل كل نشر (`build.command`). يبني `dist/` (نفس الملفات العامة التي يقدّمها `railway/server.js` بالضبط، مع ملف `_headers` مولَّد من `vercel.json`) ويضمّ صفحات المحرر الخاصة داخل الـ Worker (`cloudflare/generated/`، غير مرفوع).
- `cloudflare/worker-core.js`: يحوّل الطلب إلى `req`/`res` على طريقة Node ويشغّل نفس ملفات `api/*.js` و`railway/editor-host.js` بدون تعديل في منطقها.
- فيديو الصفحة الرئيسية (`assets/hero.mp4`) يمر عبر الـ Worker (`run_worker_first`) لأن طبقة الملفات الثابتة في Cloudflare لا تردّ على طلبات `Range` (تعيد الملف كاملاً بـ 200) وSafari/iPhone لا يشغّل الفيديو بدونها؛ `worker-core.js` يردّ بـ 206. أي فيديو جديد يُضاف إلى `run_worker_first` (اختبار يفشل إن نُسي).
- `cloudflare/api-registry.js`: قائمة ثابتة بدوال الـ API (الحزمة لا تستطيع قراءة المجلد وقت التشغيل). اختبار يفشل إن أضفتَ ملفاً في `api/` ونسيتَ القائمة.
- `tests/cloudflare-*.test.js`: يتأكدان أن الملفات العامة مطابقة لـ Railway بالبايت، وأن رؤوس الكاش مطابقة، وأن ردّ الـ Worker مطابق لردّ خادم Railway لنفس الطلب.

<<<<<<< Updated upstream
## الإعداد (مرة واحدة، من لوحة Cloudflare)
1. **Workers & Pages ← `elan-scents` ← Settings ← Builds**: المستودع `hossamthapitelgharib/elan-scents` والفرع `main` مربوطان؛ كل دفع إلى `main` يُبنى ويُنشر تلقائياً (بما فيه حفظات المحرر) وتظهر نتيجته على الكوميت باسم «Workers Builds: elan-scents». Build command فارغ (الـ Worker يبنّي نفسه)، وأمر النشر `npx wrangler deploy`.
2. **Settings ← Variables and Secrets**: أضف الأسرار التالية بنوع **Secret** (لا تُكتب في الكود ولا في المحادثات):
=======
## التفعيل (مرة واحدة، من لوحة Cloudflare)
1. (تمّ) **Workers & Pages ← `elan-scents` ← Settings ← Builds ← Connect**: اربط مستودع GitHub `hossamthapitelgharib/elan-scents` والفرع `main`. اترك Build command فارغاً (الـ Worker يبنّي نفسه)، وأمر النشر الافتراضي `npx wrangler deploy`. كل دفع إلى `main` ينشر بعدها تلقائياً (بما فيه حفظات المحرر).
2. **Settings ← Variables and Secrets**: أضف القيم التالية (الأسرار كـ Secret):
>>>>>>> Stashed changes

| الاسم | مطلوب؟ | ملاحظة |
|---|---|---|
<<<<<<< Updated upstream
| `SUPABASE_SERVICE_ROLE_KEY` | نعم | بدونه لا تعمل دوال `/api` ولا دخول المحرر بالبريد. من Supabase ← Project Settings ← API Keys، أو انسخه من Variables في خدمة Railway `elan-editor` |
| `GITHUB_TOKEN` | للمحرر | بدونه يعمل المحرر للقراءة فقط ولا يحفظ على `main`. صلاحية Contents: Read and write على هذا المستودع |
| `STORE_ORDER_WEBHOOK_SECRET` | للـ webhooks | بدونه ترد الـ webhooks بـ 503 (آمن). مضبوط الآن (فحص `live-check`). يُعطى للمتجر عند ربطه |
| `GUEST_HASH_SECRET` | لا | إن لم يُضبط يُستعمل `SUPABASE_SERVICE_ROLE_KEY` وهو القيمة التي كان مضبوطاً عليها على Railway، فيستمر سجل الضيوف. لا تضعه بقيمة أخرى |
=======
| `SUPABASE_SERVICE_ROLE_KEY` | Secret | من لوحة Supabase ← Project Settings ← API ← `service_role` |
| `STORE_ORDER_WEBHOOK_SECRET` | Secret | قيمة عشوائية جديدة (٣٢ حرفاً فأكثر)؛ لا يوجد متجر مربوط الآن فلا يلزم نقل قيمة قديمة. بدونه ترد الـ webhooks بـ 503 |
| `GUEST_HASH_SECRET` | Secret | قيمة عشوائية جديدة (16 حرفاً فأكثر) — مستحسن، حتى لا يبدأ الضيوف من الصفر إن دُوِّر مفتاح service-role لاحقاً. لا يوجد ضيوف مسجلون الآن (قرار 2026-10-24) |
| `GITHUB_TOKEN` | Secret | للمحرر (الكتابة على `main`): توكن GitHub دقيق الصلاحيات، Contents قراءة وكتابة على هذا المستودع فقط |
>>>>>>> Stashed changes

`SUPABASE_URL` و`SUPABASE_ANON_KEY` (قيمتان عامتان يستلمهما متصفح كل زائر من `/api/config`) و`EDITOR_ENV` و`EDITOR_TARGET_BRANCH` و`GITHUB_REPO` موجودة في `wrangler.jsonc`، فلا تضفها. أما `EDITOR_SITE_ORIGIN` و`ELAN_EDITOR_ORIGIN` و`ELAN_STORE_ORIGIN` فإن لم تُضبط يستعمل الـ Worker العنوان الذي زرتَه به (المحرر والمتجر على أصل واحد)؛ اضبطها فقط إن استعملت أكثر من نطاق.
3. افتح `https://elan-scents.hossamthapitelgharib.workers.dev/health` (يردّ `ok`) ثم `/` و`/api/config` و`/editor`.

<<<<<<< Updated upstream
## نطاق خاص (لاحقاً)
- النطاق: Settings ← Domains & Routes ← Add Custom Domain. الموقع الآن على `workers.dev` بقرار حسام.
- غيّر رابط الـ webhook في أي متجر مربوط (`/api/store-order-status` وأخواتها) إلى العنوان الجديد، وحدّث Site URL وRedirect URLs في Supabase ← Authentication ← URL Configuration.
=======
## التحويل الكامل
- النطاق: Settings ← Domains & Routes ← Add Custom Domain.
- غيّر رابط الـ webhook في أي متجر مربوط (`/api/store-order-status` وأخواتها) إلى النطاق الجديد.
- Railway أُغلق ولا يلزم أي إجراء عليه من هنا.
>>>>>>> Stashed changes

## حدود الخطة المجانية (Workers Free)
- الملفات الثابتة بلا حد ولا تُحسب طلبات؛ الطلبات التي تشغّل الكود (`/api/*` و`/editor`) حدّها 100 ألف في اليوم.
- 10 ملي ثانية CPU للطلب الواحد و50 طلباً خارجياً (Supabase/GitHub) للطلب. صفحة المحرر تُحسب هاشاتها وقت البناء لهذا السبب. لو ظهر الخطأ 1102 في اللوحة فالمعالجة تحتاج الخطة المدفوعة (5$ شهرياً) وهذا قرار مالك.
- حدّ الطلبات في `lib/rate-limit.js` وعدّاد محاولات الدخول في الذاكرة، وعلى Cloudflare الذاكرة لكل نسخة تشغيل (isolate)؛ فهو أضعف من Railway ذي النسخة الواحدة. جلسة المحرر (كوكي مشفّر) لا تتأثر.

## تشغيل محلي
`npx wrangler dev` (يحتاج ملف `.dev.vars` فيه نفس الأسرار، وهو مستثنى من Git).
