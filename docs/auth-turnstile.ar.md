# التحقق من أن الزائر إنسان (Cloudflare Turnstile)

**الحالة (1 نوفمبر 2026):** الكود منشور والويدجت مُنشأ في Cloudflare، لكن **مفتاح التفعيل داخل Supabase لم يُضغط بعد**. إلى أن يفعّله المالك لا يتغير شيء على الزائر: الصندوق لا يظهر إلا إن طلبه Cloudflare، والطلبات تعمل كما كانت.

## ما هو
حماية تسجيل الحسابات وطلبات استعادة كلمة السر من الروبوتات. مجانية بلا حد. الزائر العادي لا يرى شيئًا في الغالب؛ وإن شكّ Cloudflare يظهر له صندوق يضغط عليه.

## أين تعمل
| النموذج | الملف |
|---|---|
| إنشاء حساب وتسجيل الدخول من المتجر | `app-core.js` (`authSubmit`) |
| دخول صفحة «طلباتي» وكل لوحات الإدارة | `portal.js` (`Portal.login`) |
| «نسيت كلمة المرور» في صفحة الحساب | `account.js` |
| دخول المحرر و«نسيت كلمة السر» فيه | `editor/editor-login.js` ثم `railway/editor-session.js` |

الأساس كله `turnstile.js`. اختباره في `tests/turnstile.test.js`.

## ما تغيّر في الموقع
- متغير `TURNSTILE_SITE_KEY` (مفتاح عام) في `wrangler.jsonc`، ويصل المتصفح من `/api/config`.
- سياسة الأمان تسمح بسكربت وإطار `https://challenges.cloudflare.com` فقط.
- الويدجت اسمه `Elan Scents account forms` ومحدود بنطاق `elan-scents.hossamthapitelgharib.workers.dev`.

## خطوات المالك لتفعيلها (بعد أن يتأكد أن النماذج تعمل)
1. لوحة Cloudflare ← **Turnstile** ← الويدجت `Elan Scents account forms` ← انسخ **Secret key**. لا ترسله لأحد في محادثة.
2. لوحة Supabase ← **Authentication** ← **Attack Protection** (أو Settings ← Bot and Abuse Protection) ← فعّل **Enable CAPTCHA protection** ← اختر **Turnstile** ← الصق الـSecret key ← **Save**.
3. جرّب بالترتيب: تسجيل حساب جديد من المتجر، ثم دخول، ثم «نسيت كلمة المرور» من صفحة الحساب، ثم دخول إحدى اللوحات، ثم دخول المحرر و«نسيت كلمة السر» فيه.

## التراجع
إن فشل أي نموذج بعد التفعيل: أوقف **Enable CAPTCHA protection** في Supabase وحفظ. كل النماذج تعود تعمل في لحظتها (الكود يبعث الرمز ويتجاهله Supabase وهو مطفأ).

## ملاحظات
- لو حجب متصفح الزائر `challenges.cloudflare.com` (مانع إعلانات مثلًا) تظهر له جملة تطلب تعطيله، ولا يمكنه التسجيل أو الدخول حتى يفعل. هذا ثمن الحماية.
- ترقية مفتاح Supabase أو تدويره لا تمس هذا الإعداد. تدوير المفتاح السري للويدجت من Cloudflare يحتاج لصقه من جديد في Supabase.
- عند شراء نطاق خاص: أضفه إلى نطاقات الويدجت في Cloudflare، وإلا لن يظهر الصندوق على النطاق الجديد.
