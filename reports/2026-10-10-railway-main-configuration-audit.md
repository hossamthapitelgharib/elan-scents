# تقرير إعداد Railway والنشر من `main`

**آخر تحديث:** 2026-10-11
**المشروع:** Élan Scents
**المستودع:** `hossamthapitelgharib/elan-scents`

## النتيجة

Railway هو مضيف المشروع الوحيد. يبدأ الموقع من فرع `main` باستخدام `npm start`، ويشغّل `node railway/server.js`. خادم Railway يقدّم ملفات الموقع ومسارات `/api/*` ويحتوي بنفسه على قواعد aliases والكاش ونطاقات فيديو الهيرو، ولا يقرأ ملف إعداد تابعًا لمضيف آخر.

## التشغيل

- `PORT` يحدد منفذ HTTP الذي يقدمه Railway.
- `/health` نقطة فحص صحة الخدمة.
- `/api/*` تُمرر إلى معالجات `api/`، بينما يوجّه محرر المالك المعزول عبر `railway/editor-host.js` و`railway/editor.js`.
- يفعّل `.github/workflows/tests.yml` اختبارات `npm test` عند دفع التغييرات إلى `main` أو إنشاء طلب دمج.

## متغيرات الخدمة

تتطلب خدمة الموقع `SUPABASE_URL` و`SUPABASE_ANON_KEY` و`SUPABASE_SERVICE_ROLE_KEY` و`STORE_ORDER_WEBHOOK_SECRET` و`DASHBOARD_TOKEN`. يحتاج محرر التصميم إلى `GITHUB_TOKEN` و`EDITOR_TARGET_BRANCH=main` و`EDITOR_SITE_ORIGIN`؛ ويحدد `RAILWAY_ENVIRONMENT_NAME=production` بيئة الإنتاج. إذا كان المحرر خدمة منفصلة، يشير `EDITOR_SITE_ORIGIN` إلى النطاق العام لخدمة الموقع.

## التحقق

اختبارات Railway المحلية تتأكد من الاستجابة عند `/health`، تقديم الموقع والأصول، aliases، حماية الملفات الداخلية، رؤوس الكاش، ونطاقات الفيديو. لا يثبت نجاح الاختبار المحلي اكتمال نشر الإنتاج؛ يجب التحقق من `/health` على عنوان Railway الفعلي.
