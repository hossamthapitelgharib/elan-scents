# تقرير توافق إعدادات Railway والنشر من `main`

**التاريخ:** 2026-10-10
**المشروع:** Élan Scents
**المستودع:** `hossamthapitelgharib/elan-scents`

## النتيجة التنفيذية

تم فحص إعدادات المشروع بعد تحويل Railway إلى النشر المباشر من فرع `main`.
الإعدادات الموجودة داخل المستودع متوافقة مع هذا المسار، ولا توجد ملفات تفرض النشر من فرع `railway-host` أو من فرع آخر.

## الملفات التي تم فحصها

### `package.json`

- أمر التشغيل:

```text
npm start -> node railway/server.js
```

- أمر الاختبارات:

```text
npm test -> node --test tests/*.test.js
```

- الحد الأدنى لإصدار Node.js هو `20`، وRailway يستطيع اكتشاف أمر التشغيل تلقائيًا من `package.json`.

### `railway/server.js`

- خادم Railway مستقل ولا يعتمد على حزم خارجية.
- يقرأ المنفذ من `process.env.PORT`.
- يخدم الملفات الثابتة ومسارات `/api/*`.
- لا يحتوي على أي اختيار لفرع Git أو مصدر نشر.
- يستخدم `vercel.json` فقط لقراءة الـrewrites والـheaders المشتركة، وليس لتحديد منصة أو فرع النشر.

### `vercel.json`

- يحتوي على rewrites وheaders مشتركة بين بيئات التشغيل.
- لا يحتوي على إعداد نشر أو اسم فرع.
- بقاؤه مقصود للحفاظ على توافق المسارات والـcache headers مع Railway.

### `.github/workflows/tests.yml`

- يعمل عند `push` إلى `main`.
- يعمل عند `pull_request` نحو `main`.
- يستخدم Node.js 22.
- ينفذ `npm test`.

## حالة الفروع

- الفرع المعتمد: `main`
- آخر commit وقت الفحص: `627d859`
- فرع `railway-host` تم حذفه من GitHub.
- تم تنظيف مرجع `origin/railway-host` المحلي.
- لا توجد تعديلات محلية غير محفوظة.

## التحقق التشغيلي

- Railway يعيد `200 OK` من `/health`.
- الصفحة الرئيسية على Railway تعمل وتعيد `200 OK`.
- لوحة المنصة وفلاترها ظاهرة من النسخة المنشورة.
- آخر GitHub Actions على commit `627d859` نجح.
- الاختبارات المحلية: **73/73 ناجحة**.

## ملاحظة Supabase

يوجد ملف migration جديد داخل:

```text
supabase/pending/20261010030000_harden_anon_grants_rls_initplan_and_order_pricing.sql
```

هذا الملف محفوظ على `main` لكنه لم يُطبّق على قاعدة Supabase بعد، لأنه يحتاج موافقة مالك المشروع قبل التطبيق. بعد تطبيقه يجب نقله إلى `supabase/migrations/` وإعادة تسميته برقم الإصدار الذي تسجله قاعدة البيانات.

## الخلاصة

إعدادات المستودع متوافقة مع النشر المباشر من `main`. أي تحديث جديد على `main` يمكن أن يطلق Railway تلقائيًا، بشرط استمرار تفعيل GitHub Autodeploy من إعدادات خدمة Railway.
