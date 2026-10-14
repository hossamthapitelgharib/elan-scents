# سجل اختبارات منصة العملاء — 14 أكتوبر 2026

**المستودع:** `hossamthapitelgharib/elan-scents`
**الفرع:** `docs/customer-platform-audit`
**المنطقة الزمنية:** الرياض (UTC+03:00)
**الأرشيف الخام:** `elan-local-test-logs-2026-10-14-customer-platform.zip`
**الرفع التلقائي:** [تشغيل GitHub Actions 38550340978](https://github.com/hossamthapitelgharib/elan-scents/actions/runs/38550340978)

## الخلاصة

- آخر مجموعة مركزة تخص العملاء/المتاجر/الصلاحيات/السلال والجلسات والترتيب والواجهات والترحيلات: **72 اختبارًا، 72 نجاحًا، 0 إخفاق**.
- آخر تشغيل كامل عبر `npm test`: **195 اختبارًا، 181 نجاحًا، 14 إخفاقًا**.
- أخفقت خطوة الاختبار في تشغيل GitHub Actions، لكن خطوة **Upload test reports** نجحت بسبب `if: always()` ورفعت تقرير TAP كـArtifact؛ مدة الاحتفاظ 30 يومًا.
- اختبار التوجيه/أصل التذييل: فشل قبل الإصلاح (**0/1**) ثم نجح بعد الإصلاح (**1/1**).

## تشغيلات الاختبار المسجلة في جلسة اليوم

| الوقت (+03) | المجموعة/الأمر | الاختبارات / ناجح / فاشل | الملاحظة |
|---|---|---:|---|
| 12:29 | `npm test` | 186 / 171 / 15 | خط الأساس قبل تغييرات هذه الجولة؛ التقرير الخام المؤرخ داخل الأرشيف. |
| 12:41 | `npm run test:raw` | 187 / 172 / 15 | بعد ترحيل تفاصيل لقطات المنتجات. |
| 12:45 | اختبارات العملاء المركزة | 32 / 32 / 0 | ناجحة. |
| 12:50 | `npm run test:raw` | 187 / 172 / 15 | بعد فصل سكربت لوحة العملاء عن المنصة. |
| 12:53 | `npm run test:raw` | 187 / 172 / 15 | قبل إصلاح اختبار أصل التذييل. |
| 12:53 | اختبارات العملاء المركزة | 32 / 32 / 0 | إعادة تحقق ناجحة. |
| 12:53 | اختبار تنقل/تذييل منفرد | 1 / 0 / 1 | كشف مرجع صورة تذييل غير موجود؛ أُصلح. |
| 12:55 | اختبار تنقل/تذييل منفرد | 1 / 1 / 0 | نجاح بعد الإصلاح. |
| 12:55 | التشغيل الكامل بعد الإصلاح | 187 / 173 / 14 | آخر إخفاقات المجموعة الكاملة مصنفة أدناه. |
| 12:57 | اختبارات العملاء المركزة النهائية | 32 / 32 / 0 | آخر فحص مركز ناجح، مع `git diff --check` وسلامة ملفات السكربت/الأصل. |
| 13:03 | `npm test` | 187 / 173 / 14 | إعادة تشغيل رسمية ولّدت `test-20261014T100335Z.md` و`latest.json` محليًا، وتُرفع تقارير CI كـArtifact. |
| 13:14 | اختبارات العملاء والمتاجر والصلاحيات والترحيلات | 65 / 65 / 0 | شملت اختبار تدفق المشاهدة والبحث والإضافة والحذف عبر واجهة الهوية إلى API للزائر والعميل المسجل. |
| 13:14 | `npm test` بعد اختبار تدفق الأحداث الجديد | 188 / 174 / 14 | لا تزال الإخفاقات الـ14 نفسها في اختبارات storefront/editor خارج نطاق هذا الجزء؛ أُرفق السجل الخام. |
| 13:20 | مجموعة العملاء والمتاجر والصلاحيات والترحيلات بعد إضافة views | 66 / 66 / 0 | شملت الترحيلات الجديدة ومطابقة أرقامها مع سجل Supabase. |
| 13:21 | `npm test` بعد إضافة جداول الأنشطة المنطقية | 189 / 175 / 14 | لا تزال الإخفاقات الـ14 نفسها في اختبارات storefront/editor؛ أُرفق السجل الخام. |
| 13:30 | مجموعة العملاء والمتاجر والتكاملات والصلاحيات والترحيلات | 72 / 72 / 0 | تضمنت API التكاملات normalized، إخفاء الأسرار، legacy fallback، وربط الإعداد بـ`store_id`. |
| 13:30 | `npm test` بعد تطبيع إعدادات تكامل المتاجر | 195 / 181 / 14 | الإخفاقات الـ14 نفسها في اختبارات storefront/editor؛ أُرفق السجل الخام. |

> سجلات TAP الخام للتشغيلات المتاحة مضمّنة في الأرشيف المرتبط أعلاه؛ كما يحفظ سجل `2026-10-13-14-test-history.md` تشغيلات GitHub Actions والمحلية السابقة لهذا العمل.

## إخفاقات المجموعة الكاملة في آخر تشغيل

الإخفاقات الـ14 المسجلة في آخر تشغيل كامل (195 اختبارًا) هي في اختبارات واجهة/محرر أقدم من نطاق لوحة العملاء:

1. `hero autoplays and keeps its fallback play button hidden until needed`
2. `storefront is full width, prevents horizontal overflow, and locks scroll for overlays and menu`
3. `about, contact and every footer part are editable elements with stable ids`
4. `edit mode knows the new element kinds`
5. `keeps editor state readable but refuses writes when GitHub is not configured`
6. `format apply only sends what the owner changed and opens with the real values`
7. `the storefront loads an extra web font only when a saved design uses it`
8. `the library button opens the archive and image library in live mode`
9. `the menu is built from a tool registry so new capabilities are one register() call`
10. `inner pages keep their own edits, separate from the home page`
11. `editor login reports role-check failures separately from wrong passwords`
12. `edits may replace the media of an element with an allowed url only`
13. `uploads accept real mp4 and webm files, nothing else posing as video`
14. `the storefront layer paints replaced media and the live edit mode can set it`

لم تُحذف هذه الاختبارات أو تُخفَ. يجب فتح عمل مستقل لإصلاحها. نتائج مجموعة العملاء المركزة مستقلة عنها ونجحت كاملة.

## فحص الأمان الحي لقاعدة البيانات

استعلام صلاحيات read-only على Supabase أثبت أن `anon_can_select=false` و`authenticated_can_select=false` على جداول نشاط العملاء الأساسية والـ6 views الجديدة. للـviews الجديدة `service_role` يملك `SELECT` فقط ولا يملك `INSERT/UPDATE/DELETE`. على `store_integrations` الوصول ممنوع عن `anon` و`authenticated`، و`service_role` لديه صلاحية الخادم. لم تُضف سجلات اختبار إلى بيانات العملاء الحقيقية.

## الرفع التلقائي من الآن فصاعدًا

- الأمر المحلي `npm test` ينشئ تقريرًا زمنيًا كاملًا في `reports/test-runs/` حتى عند الفشل.
- GitHub Actions يشغّل `npm test` تلقائيًا عند الدفع إلى أي فرع أو فتح/تحديث Pull Request إلى `main`.
- خطوة رفع الأرشيف تستخدم `if: always()` وترفع `reports/test-runs/` حتى لو فشلت الاختبارات، لمدة 30 يومًا.
- تشغيل GitHub Actions رقم `38550340978` تحقق عملي على آخر commit: فشل test step ونجحت upload step؛ تقريره يثبت 195 اختبارًا ورفع الـArtifact.

**حد مهم:** التشغيل المحلي يحفظ التقرير في مساحة العمل فقط؛ الرفع البعيد كـGitHub Artifact يتم تلقائيًا عند تنفيذ التشغيل عبر GitHub Actions، مثل كل push أو Pull Request، وليس عبر دفع commit من داخل كل أمر اختبار محلي.
