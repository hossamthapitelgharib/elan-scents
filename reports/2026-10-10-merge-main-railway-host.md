# تقرير دمج `main` و`railway-host`

**التاريخ:** 2026-10-10  
**المشروع:** Élan Scents  
**المستودع:** `hossamthapitelgharib/elan-scents`

## التنفيذ

- تم جلب آخر نسخة من فرعي `main` و`railway-host`.
- تم دمج `origin/main` داخل `origin/railway-host`.
- تم حل تعارض `index.html` بالحفاظ على ملفات Railway الخاصة، ومنها:
  - طبقة التصميم `design-schema.js` و`design-layer.js`.
  - هوية المتصفح وسلة الزائر.
  - تحسين تشغيل فيديو الواجهة.
- تم حذف أربع migrations مكررة غير موجودة في سجل Supabase، مع الإبقاء على النسخ المطابقة لسجل قاعدة البيانات.
- تم توحيد الفرعين على نفس merge commit:

```text
696594fa8b0be89e0ad220d78a1b955dd7474f41
```

الـcommit له والدان:

```text
8c12a18e044ac0420ffa1064afcc1b3f2a13c769  railway-host
7b7893367ddcde2ef0440708eea9457f5436c633  main
```

## Supabase

تمت مراجعة سجل migrations للمشروع `sbgdtuqfrnfeggkwqtrw`.

- سجل قاعدة البيانات يحتوي على migrations الصحيحة حتى:
  - `20261009230647_harden_order_user_binding`
  - `20261010001456_guest_browser_identity_analytics`
- لم يتم تطبيق أي migration جديدة؛ لأن التعديلات المدمجة تضمنت ملفات موجودة بالفعل في سجل Supabase.
- تم حذف النسخ المكررة ذات التوقيت المختلف حتى لا يتم تنفيذ migration واحدة باسمين/إصدارين.

## الاختبارات

تم تشغيل:

```bash
node --test tests/*.test.js
```

النتيجة بعد معالجة تكرار migrations:

- **73 اختبارًا ناجحًا**
- **0 فشل**
- فحص صياغة JavaScript نجح.
- فحص `git diff --check` نجح.
- اختبارات تصميم الواجهة، سلة الزائر، هوية المتصفح، صلاحيات الطلبات، توافق Railway، وملفات Supabase نجحت.

## Railway

تم فحص المنصة:

```text
https://elan-site-production.up.railway.app/
```

قبل الدمج كانت النسخة الحية مطابقة للـcommit:

```text
8c12a18e044ac0420ffa1064afcc1b3f2a13c769
```

بعد رفع merge commit إلى GitHub، ظل رابط Railway يعرض الإصدار القديم `20261009-11` خلال فترة التحقق الممتدة. لذلك لم يتم اعتبار النشر ناجحًا؛ فالـGitHub والدمج سليمين، لكن Railway لم يلتقط التحديث تلقائيًا حتى وقت إعداد هذا التقرير.

## الحالة النهائية

- الدمج: **تم**
- GitHub `main`: **تم التحديث**
- GitHub `railway-host`: **تم التحديث**
- Supabase: **تمت المراجعة، ولا توجد migration جديدة مطلوبة**
- الاختبارات: **73/73 ناجحة**
- Railway: **ما زال يعرض النسخة السابقة وينتظر تشغيل النشر التلقائي أو معالجة Webhook Railway**
