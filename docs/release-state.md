# Release state

هذا الملف هو نقطة المراجعة الموحدة قبل وبعد أي إصدار. لا يُعد بديلًا عن سجل Supabase أو النسخ الاحتياطية؛ بل يربطهما بوضوح.

## الحالة الحالية

- **آخر commit محلي:** حدّثه عند كل إصدار.
- **آخر migration موجود محليًا:** `20261102065502_customer_registered_notification` وقت إنشاء هذا الملف.
- **آخر migration مطبق حيًا:** تحقّق منه من `supabase_migrations.schema_migrations` قبل الإصدار.
- **حالة تطابق Git مع قاعدة البيانات:** يجب أن تكون `verified` فقط بعد مقارنة الإصدارات والنصوص.
- **آخر نسخة احتياطية ناجحة:** سجّل مسار ملف `.json` وSHA-256.
- **آخر اختبار استعادة ناجح:** سجّل التاريخ والمشروع المعزول المستخدم.
- **آخر تشغيل اختبارات Node:** سجّل رابط artifact من CI.
- **آخر تشغيل اختبارات Chromium:** سجّل رابط artifact أو رقم workflow.

## بوابة الإصدار

نفّذ محليًا أو في CI:

```bash
npm ci --no-audit --no-fund
npm run check:migrations
npm test
npm run test:browser
```

قبل تطبيق migration يمس البيانات أو الصلاحيات:

```bash
SUPABASE_DB_URL='...' scripts/backup-supabase.sh backups
```

لا تُشغّل الاستعادة إلا على مشروع/قاعدة محددة وبعد مراجعة الملف والـ manifest:

```bash
CONFIRM_RESTORE=YES SUPABASE_DB_URL='...' scripts/restore-supabase.sh backups/supabase-<timestamp>.dump
```

## سياسة الترحيلات

- كل migration جديد يجب أن يملك rollback بنفس الاسم، أو سجلًا صريحًا في `supabase/rollback/irreversible.json`.
- الاستثناء غير القابل للعكس يتطلب backup قبل التطبيق؛ لا تُعد الملفات القديمة القابلة للاستثناء ضمانًا لاستعادة الصفوف المحذوفة.
- لا تُعدّل migration سبق تطبيقه؛ استخدم migration تصحيحيًا جديدًا.
- لا تُنفذ أوامر backup أو restore تلقائيًا من التطبيق أو CI.

## التخزين المركزي للحالات المؤقتة

عند تشغيل أكثر من نسخة من Railway أو Worker-compatible Node host، اضبط:

- `STATE_STORE_URL`: عنوان Upstash/Redis REST endpoint.
- `STATE_STORE_TOKEN`: رمز الوصول السري.
- `STATE_STORE_REQUIRED=1`: اختياري؛ يجعل محددات المعدل ترفض الطلبات عند تعذر المخزن بدل الرجوع إلى عداد محلي.

في غياب هذه المتغيرات يستمر التشغيل المحلي/النسخة الواحدة باستخدام ذاكرة العملية. هذا مقصود للتطوير وليس ضمانًا لتحديد موزع ضد هجوم واسع.
