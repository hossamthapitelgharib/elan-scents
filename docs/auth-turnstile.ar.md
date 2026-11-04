# التحقق من أن الزائر إنسان (Cloudflare Turnstile)

**الحالة — 4 نوفمبر 2026:** حماية CAPTCHA في Supabase يجب أن تبقى مفعّلة. أظهرت سجلات Auth طلبات `/signup` مرفوضة بـ`captcha_failed` و`invalid-input-secret`؛ أي إن السر المحفوظ في Supabase غير صالح/منتهي أو لا يطابق Turnstile widget. وظهر أيضًا `no captcha_token found` حين كان مفتاح الموقع العام غير متاح. لذلك لا تُعالج المشكلة بإيقاف CAPTCHA.

**Widget Cloudflare:** `Elan Scents account forms`، وضع `managed`، والنطاق المسموح `elan-scents.hossamthapitelgharib.workers.dev`. المفتاح العام: `0x4AAAAAAFvBW0Qsb8VBNT08`. لا تحفظ Secret في Git أو Worker vars ولا ترسله في المحادثة.

## الإجراء اللازم لإصلاح الإعداد الحي

1. في Cloudflare Dashboard افتح **Turnstile** ثم widget **Elan Scents account forms**، ودوّر **Secret key** لأن القيمة الحالية في Supabase مرفوضة.
2. افتح مشروع Supabase `sbgdtuqfrnfeggkwqtrw` ثم **Authentication → Protection**. اختر Cloudflare Turnstile، ألصق السر الجديد في حقل السر، واترك **Enable CAPTCHA protection** مفعّلًا ثم احفظ.
3. لا تشارك السر. أرسل فقط تأكيدًا نصيًا بأن الحفظ اكتمل؛ بعدها يُرفع إعداد المفتاح العام للواجهة وتُجرى اختبارات signup/login/reset على الهاتف.

## سلوك الواجهة

`turnstile.js` يجلب المفتاح العام من `/api/config`، يشغّل widget Managed عند الحاجة، ويحصل على token جديد لكل إرسال، ثم يضعه في `gotrue_meta_security.captcha_token` قبل طلب Supabase. لا يُجرى تحقق Siteverify ثانٍ في Worker؛ Supabase هو من يتحقق من token.

صار غياب المفتاح يفشل مغلقًا بدل إرسال طلب Auth بلا token. في الإصدار الحالي، التغيير جاهز محليًا ولم يُدفع بعد؛ لا يُنشر قبل حفظ Secret الصحيح في Supabase حتى لا نعرض challenge لا يمكن اعتماده.

## المسارات

| النموذج | الملف |
|---|---|
| إنشاء حساب ودخول العميل من المتجر | `app-core.js` (`authSubmit`) |
| دخول صفحة «طلباتي» وكل لوحات الإدارة | `portal.js` (`Portal.login`) |
| «نسيت كلمة المرور» في صفحة الحساب | `account.js` |
| دخول المحرر و«نسيت كلمة السر» فيه | `editor/editor-login.js` ثم `railway/editor-session.js` |

الاختبارات الآلية تستخدم مفتاحًا مصطنعًا، ولا تثبت صحة السر الإنتاجي أو نجاح الهاتف. بعد إصلاح السر اختبر إنشاء حساب تجريبي جديد، تأكيد البريد، الخروج والدخول، والاستعادة على الهاتف. لا تستخدم حساب عميل ولا تضع بياناته أو token في سجلات الاختبار.
