# مرجع تقني موحد: دخول المحرر وTurnstile ورؤوس الأمان

**تاريخ الفحص:** 5 نوفمبر 2026
**الخدمة:** Élan Scents، Cloudflare Workers وSupabase Auth
**الحالة:** سبب فشل الدخول عولج في الإنتاج؛ فُحصت الرؤوس الحية واختبارات CSP من دون الحاجة إلى تعديل السياسة.

## المشكلة والسبب الجذري

كانت صفحة المحرر تعرض «حصلت مشكلة، حاول مرة أخرى» عند تسجيل الدخول. لم يكن السبب كلمة مرور غير صحيحة أو تعطل Turnstile. وصل الطلب إلى Cloudflare Worker، ثم فشل Worker في إصدار جلسة المحرر المشفرة لأن سر الجلسة المستقل `EDITOR_SESSION_SECRET` لم يكن مضبوطًا في البيئة الحية.

في نافذة سجلات المحاولة ظهرت استجابتان `POST /api/editor-login` برمز `503`. وأظهر فحص bindings وجود `SUPABASE_SERVICE_ROLE_KEY` وغياب `EDITOR_SESSION_SECRET`. يقرأ `railway/editor-session.js` سر الجلسة المستقل فقط؛ وإذا غاب، لا تستطيع `seal()` إنشاء cookie. في الإنتاج يرفض مسار الدخول إصدار جلسة مؤقتة ويعيد `503 editor_session_configuration_missing`. لم تكن واجهة `editor/editor-login.js` تعرف هذا الرمز، لذلك عرضت رسالة عامة.

سجلات Supabase Auth في النافذة نفسها تضمنت password-grant ناجحًا برمز `200`، لكن لا يوجد correlation ID يربط سجل Auth بعينه بطلب Worker بعينه. الدليل الحاسم هو حالة Worker، فرع الخطأ في كود إنشاء الجلسة، وغياب الـbinding من إعداد الإصدار الحي. أزيل fallback الذي كان سيستخدم مفتاح `SUPABASE_SERVICE_ROLE_KEY` لتشفير الجلسات عمدًا، لفصل سر الجلسة عن صلاحيات قاعدة البيانات.

## الإصلاح المنفذ

أُنشئ سر عشوائي مستقل وأُضيف مباشرة إلى Cloudflare Worker باسم `EDITOR_SESSION_SECRET` ونوع `secret_text`. أصبح deployment `aa93e0bd-629a-4055-810e-b5fea65a77c7` نشطًا بنسبة 100%، بالإصدار `50d05671-c5f4-46e2-b79a-7618d957d85f`. بقيت قيمة السر في Cloudflare ولم تُكتب في Git أو هذا التقرير.

أضيفت إلى `editor/editor-login.js` رسالة محددة للرمز `editor_session_configuration_missing` حتى لا يتحول نقص الإعداد مستقبلًا إلى الرسالة العامة. وأضيف اختبار يثبت أن الإنتاج يفشل مغلقًا عند غياب السر. كما ضُبطت بيئة workerd/CI على سر وهمي غير إنتاجي لاختبار cookie مشفر، وصُحح اختبار smoke للـwebhook كي يتوقع سياسة الإيقاف المقصودة `410 legacy_webhook_disabled`.

**لم تُعطّل CAPTCHA أو Turnstile ولم تُغيّر أسرارهما ضمن هذا الإصلاح.** سر Turnstile الخاص يبقى في إعدادات CAPTCHA لدى Supabase؛ أما `TURNSTILE_SITE_KEY` فهو مفتاح عام يقدمه Worker للمتصفح.

## سجلات ما بعد الإصلاح

في الفترة من 10:16 إلى 10:35 بتوقيت `+02:00`، أظهر استعلام Cloudflare Observability عدد 24 حدثًا لمسارات المحرر. كانت جميعها `200` بمستوى `info`، وشملت تسجيل دخول ناجحًا عند نحو 10:26، وطلبات جلسة وبيانات وbridge ticket، ثم تسجيل خروج ناجحًا. لم تظهر في هذه العينة استجابات `4xx` أو `5xx`.

وأظهرت سجلات Supabase Auth في الفترة نفسها ستة طلبات password-grant ناجحة بحالة `200` ولم يظهر رمز خطأ CAPTCHA ضمن النتائج المجمعة. هذه مؤشرات على سلامة مسار الخدمة بعد الإصلاح، وليست بديلًا عن اختبار كلمة مرور المالك على جهازه.

## سياسة CSP الخاصة بـTurnstile

توصي وثائق Cloudflare بأن تسمح سياسة CSP بتحميل `api.js` وإطار التحدي من `https://challenges.cloudflare.com`. وتذكر أن `connect-src 'self'` مطلوب عندما يُستخدم Turnstile بوضع pre-clearance. القيم الحية أدناه تحقق متطلبات السكربت والإطار، كما تتضمن `connect-src` مصدر الصفحة نفسه؛ لذلك لم يكن هناك نقص في السماح المطلوب ولم تُوسَّع السياسة [1].

### الصفحة الرئيسية وصفحات الحساب

فُحصت الاستجابة الحية لكل من `/` و`/account.html` عبر GET، وكانت الحالة `200`. سياسة الصفحة المرصودة:

```text
default-src 'self';
script-src 'self' https://challenges.cloudflare.com;
script-src-attr 'none';
style-src 'self' 'unsafe-inline' https://fonts.googleapis.com;
img-src 'self' https: data: blob:;
media-src 'self' https://sbgdtuqfrnfeggkwqtrw.supabase.co;
font-src 'self' https://fonts.gstatic.com;
connect-src 'self' https://sbgdtuqfrnfeggkwqtrw.supabase.co;
frame-src https://challenges.cloudflare.com;
frame-ancestors 'self';
base-uri 'self'; form-action 'self'; object-src 'none'
```

هذه السياسة تسمح لصفحات الحساب بتحميل سكربت Turnstile وإطاره فقط من نطاق الخدمة. وهي تمنع event-handler attributes عبر `script-src-attr 'none'`، ولا تسمح بالـ`eval` أو wildcard في مصادر السكربت. الاتصالات من صفحات الحساب مقصورة على الموقع ومشروع Supabase، وهو مطلوب لمسارات Auth والبيانات. وجود `'self'` يحقق شرط pre-clearance المذكور في توثيق Cloudflare إذا استُخدم هذا الوضع مستقبلًا.

### صفحة دخول المحرر

استجابة `/editor` الحية كانت `200`، وتحمل سياسة منفصلة مناسبة لصفحة الدخول ذاتها:

```text
default-src 'self';
script-src 'self' https://challenges.cloudflare.com;
frame-src https://challenges.cloudflare.com;
style-src 'self'; img-src 'self' data:;
connect-src 'self';
frame-ancestors 'none'; base-uri 'none'; form-action 'self'
```

هذا يسمح للمتصفح بتحميل Turnstile من نطاقه، بينما يرسل نموذج المحرر طلباته إلى Worker على نفس الموقع. كما تمنع `frame-ancestors 'none'` تضمين صفحة الدخول داخل إطار، ويضاف إليها `X-Frame-Options: DENY`. لم يُضف نطاق Supabase إلى `connect-src` لهذه الصفحة لأن اتصال Auth يمر عبر `/api/editor-login` على Worker؛ لا يحتاج المتصفح إلى اتصال Supabase مباشر في هذا المسار.

### الرؤوس الأمنية الأخرى

ظهرت على الاستجابات الحية التي فُحصت الرؤوس التالية: `X-Content-Type-Options: nosniff`، و`Referrer-Policy: strict-origin-when-cross-origin`، وسياسة `Permissions-Policy` التي تمنع الكاميرا والميكروفون والموقع والدفع وUSB، و`Strict-Transport-Security: max-age=15552000`. صفحات الحساب وصفحة المحرر تحمل `Cache-Control: no-store`. نقطة `/api/config` ترجع JSON وتحمل baseline headers؛ عدم إرسال CSP خاص بالوثائق عليها متوافق مع اختبارات المشروع.

لاحظت السياسة أيضًا السماح بـ`https:` في `img-src` و`'unsafe-inline'` في `style-src` للصفحات العامة. هذان الاستثناءان ليسا مطلوبين لتشغيل Turnstile بحسب وثائق Cloudflare، ولم أوسعهما أو أضيقهما ضمن هذه المراجعة حتى لا تتأثر الصور أو الأنماط المعتمدة في المتجر. يمكن تقليصهما مستقبلًا في مراجعة مستقلة بعد حصر كل مصادر الصور والأنماط.

## مصدر السياسة والاختبارات

ملف `vercel.json` هو مصدر CSP المشترك للصفحات العامة. يولّد `scripts/build-cloudflare.js` ملف `_headers` الخاص بـCloudflare منه، بدل تعريف سياسة مختلفة لكل استضافة. صفحة دخول المحرر لها CSP منفصلة ينشئها `railway/editor-host.js`؛ والكود نفسه يُستخدم في Worker.

اختبارات `tests/page-csp.test.js` تتحقق من ضيق `script-src` و`frame-src` و`connect-src`، وتثبت أن الصفحة الرئيسية وصفحات الحساب تحمل السياسة نفسها على الخادم وملف Cloudflare `_headers`. كما تتحقق من عدم وضع CSP على ملفات JavaScript وواجهات API. وتتحقق اختبارات `tests/turnstile.test.js` من السماح بنطاق Turnstile في سياسة الصفحات واستخدام الواجهة للرمز الأمني. واختبارات `tests/security-headers.test.js` تغطي الرؤوس الأساسية.

## نتائج التحقق

- المجموعة الكاملة: `npm test` — **1181 نجاحًا، صفر فشل**.
- فحص workerd: `scripts/cloudflare-smoke.js` — **34 نجاحًا، صفر فشل**، ويشمل إنشاء cookie مشفر وقبوله ورفض cookie معدّل.
- اختبارات CSP وTurnstile والرؤوس: `node --test tests/page-csp.test.js tests/turnstile.test.js tests/security-headers.test.js` — **37 نجاحًا، صفر فشل**.
- بناء Cloudflare Worker نجح وأنتج 68 ملفًا عامًا مع تضمين ملفات المحرر.
- GitHub Actions على commit `e57b4e5`: نجح Regression tests (`41993888105`) وCloudflare Worker check (`41993888078`).
- فحص الرؤوس الحية للصفحة الرئيسية والحساب و`/editor` و`/api/config` أعاد `200`، والسياسات الفعلية طابقت إعدادات المشروع. لم تُجر أي تغييرات على Security Headers في هذه المراجعة.

## إرشادات التشغيل والصيانة

1. عند تغيير مصدر الصفحة أو المضيف أو طريقة Turnstile، عدّل CSP في المصدر المعتمد، ثم شغّل اختبارات `page-csp` و`turnstile` و`security-headers` وأعد بناء Worker. لا تعدّل `_headers` المولّد وحده.
2. أبقِ `https://challenges.cloudflare.com` ضمن `script-src` و`frame-src`. وإذا فُعّل pre-clearance، يجب أن يبقى `'self'` ضمن `connect-src`.
3. لا تضف wildcard أو `https:` إلى مصادر السكربت أو الاتصالات لتجاوز أخطاء CSP. لا تضع سر Turnstile في المتصفح أو Git.
4. قبل اعتماد أي نشر، افحص الرؤوس الفعلية من استجابة الموقع، لا ملف الإعداد فقط. تأكد من CSP للصفحة العامة وصفحة الحساب وصفحة دخول المحرر، ومن baseline headers و`Cache-Control: no-store` لصفحات المصادقة.
5. احتفظ بـ`EDITOR_SESSION_SECRET` كـWorker Secret منفصل عن `SUPABASE_SERVICE_ROLE_KEY`. تغيير سر الجلسة يبطل cookies التي شُفرت بالسر السابق، لذلك خطط له باعتباره تسجيل خروج للمحررين.

## مراجع المشروع

- إعداد CSP العام: `vercel.json`.
- مولد رؤوس Cloudflare: `scripts/build-cloudflare.js`.
- CSP الخاص بصفحة المحرر ومسار الدخول: `railway/editor-host.js`.
- تحميل Turnstile وإدارة الرمز: `turnstile.js`.
- اختبارات CSP وTurnstile والرؤوس: `tests/page-csp.test.js` و`tests/turnstile.test.js` و`tests/security-headers.test.js`.
- السبب الجذري وتغيير سر الجلسة: `railway/editor-session.js`، `editor/editor-login.js`، والـdeployment المشار إليه أعلاه.

## المراجع الخارجية

[1]: https://developers.cloudflare.com/turnstile/reference/content-security-policy/ "Cloudflare Turnstile Content Security Policy"
