# مراجعة امتثال المرحلة 01 — الكتالوج والفلاتر

آخر مراجعة: 2026-11-06. المصدر: `docs/01-catalog-filters-data-foundation.ar.md`، الشيفرة الحالية، وسجل مشروع Supabase الحي `sbgdtuqfrnfeggkwqtrw`.

## قرارات العقد

- نطاق المقارنة هو عروض المتاجر النشطة المربوطة بالمنصة فقط، والعملة الحالية EGP. `catalog_platform_offers` هو مصدر العرض الأساسي الوحيد لكل `product_size_id`، مع ترتيب السعر ثم العمولة ثم الأولوية ثم `store_id` و`store_product_id` كفواصل ثابتة.
- الأهلية: المتجر active، العرض available، `sync_status='synced'`، والمخزون موجب أو `NULL`؛ `NULL` يعني مجهولًا ومتاحًا وفق العقد. العملة الأخرى مرفوضة بقيد قاعدة البيانات. العرض والسعر ومعرّف `store_product_id` من الصف نفسه.
- `catalog_eligible_offers` يحوي جميع العروض المؤهلة، و`catalog_platform_offers` يختار صفًا واحدًا. `catalog_global_offers` و`cheapest_offers` واجهتا توافق تفوضان الاختيار إلى المصدر canonical.
- واجهة المنتج تعرض سطرًا لكل `product_size_id` (حجم قابل للشراء)، لا سطرًا واحدًا لكل `product_id`. تبقى الأحجام المختلفة منفصلة.
- عقد الواجهة: `id`, `pid`, `sizeMl`, `gender`, `cats/occs/notes` كمفاتيح مستقرة، `categoryIds/occasionIds/noteIds`, `allEligibleOffers`, `globalOffer`, و`offersByStore` للتحقق فقط. لا helper يختار سعرًا من القائمة؛ غياب `globalOffer` يعني لا سعر ولا عرض.
- فلتر المتجر يقارن `store_id` بمالك `globalOffer` فقط. واجهات الكتالوج ومحرر الأقسام يستخدمان مفاتيح/UUIDs، لا label أو ترتيب array. `products.gender` مستقل عن علاقات category التجارية.
- RPC المحرر `catalog_filter_product_sizes` يجمع dimensions بـAND، ويستعمل `EXISTS` لكل category/occasion/note لمنع تضاعف النتائج؛ نتيجة كل size تتضمن السعر ومعرف العرض canonical معًا. التنفيذ مصرح به لـ`service_role` فقط.

## تقرير data audit قبل القيود

قراءة فقط من القاعدة الحية قبل migration الجديدة: الجنس `men=5`, `women=3`, `unisex=2`؛ لا قيم جنس غير معروفة ولا منتج منشور/نشط بلا جنس. العملة الوحيدة `EGP` (14 عرضًا). taxonomy keys بلا null أو تكرار، وأسماء taxonomy بلا تكرار؛ روابط المناسبات والنوتات اليتيمة صفر. يوجد **7 روابط قديمة متعارضة بين gender وتصنيف الجنس، تخص 6 منتجات تجريبية**. لم تُعدّل ولا تُحذف هذه الروابط: `products.gender` مصدر فلتر الجنس، بينما `category_id` يظل فلترًا تجاريًا منفصلًا. جداول taxonomy لا تحمل عمود نشاط؛ المفاتيح الخارجية تمنع الروابط إلى سجلات غير موجودة. indexes الموجودة على علاقات الربط ذات PK `(product_id, relation_id)` وفهرس عكسي على `relation_id`؛ أضيف فهرس جزئي `(gender, brand_id, id)` للمنتجات المنشورة النشطة.

## قائمة ملف 01 (18 اختبار قبول)

1. A=100 وB=120، العام/فلتر A يعيد A/100 وفلتر B لا يعيد الحجم: مغطى في SQL test.
2. B غير المتاح لا يظهر ولا يغير A: مغطى.
3. المخزون NULL مؤهل والصفر غير مؤهل: مغطى.
4. sync غير synced مرفوض: مغطى.
5. المتجر inactive مرفوض: مغطى.
6. السعر لا يتغير بفلتر المتجر، والفلتر يقيّد مالك العرض: مغطى SQL وmodule.
7. الجنس من `products.gender` حتى دون category relation: مغطى module وواجهة البيانات.
8. تقاطع gender+occasion+note: مغطى في SQL وmodule.
9. مفاتيح taxonomy ثابتة حتى مع اختلاف الاسم: مغطى باختبارات keys والـfixture.
10. التعادل حتمي: مغطى SQL بترتيب العمولة/الأولوية/المتجر.
11. العملة غير EGP مرفوضة: قيد ومغطى SQL.
12. 50ml لا يطابق 100ml: مغطى filter module بالـsize_ml.
13. السعر و`store_product_id` متطابقان حتى عقد الطلب: مغطى loader/card/cart/order contracts.
14. unavailable/unsynced/inactive خارج eligible: مغطى SQL.
15. NULL stock موحد بين المنصة والمحرر: مصدر RPC هو `catalog_platform_offers` نفسها؛ مغطى contract.
16. تغيير label لا يغير الفلتر: مفاتيح stable واختبار label متغير؛ لا تستخدم labels في قيمة الفلتر.
17. gender دون category: مغطى.
18. AND عبر الأبعاد، OR داخل البعد فقط إذا دعمه العقد: لا يقبل RPC إلا UUID واحد لكل dimension حاليًا؛ AND مطبق. لا توجد multi-value arrays في العقد، لذلك OR غير مطلوب/غير مدعوم.

## حالة التنفيذ

### إعادة مطابقة 2026-11-08

الـ18 اختبار قبول في هذه المرحلة ما زالت مغطاة، وأضيفت تغطية انحدار لفجوتين وجدتا في المراجعة: لا يجوز لفلتر «قريبًا» عرض صف بلا `globalOffer`، والسيكشن اليدوي يرشح فقط إذا كان المتجر مالك العرض العام عند وجود `filters.store`. كما أصبح كل عرض واجهة يحمل `stockUnknown` عندما تكون قيمة المخزون `NULL` بدل ترك دلالة المخزون ضمنية. الاختبارات المركزة بعد ذلك **43/43**، وفحص الصياغة و`git diff --check` ناجحان.

- أضيفت migration `20261106215242_catalog_offer_single_source_and_filter_rpc`، وسُجلت في Supabase. شُغّل SQL contract test على القاعدة داخل transaction ثم `ROLLBACK`؛ أكدت القراءة اللاحقة عدم بقاء صفوف الاختبار.
- فحوص الوحدة والعقد والـeditor وstorefront المركزة تمر (66/66 في آخر run مركّز قبل إضافة تغييرات العقد اللاحقة؛ يعاد تشغيلها قبل الدمج).
- `npm run check:migrations` يمر. الملاحظة القديمة عن `tests/live-turnstile-auth-probe.test.js` وغياب `playwright` لم تعد تمثل الحالة الحالية؛ تم تثبيت الاعتماديات، وأصبح التشغيل الكامل يعاد الآن في بيئة المستودع قبل كل رفع.

## مثال عقد للمرحلة الثانية

```js
{
  id: 'product_size_id', pid: 'product_id', sizeMl: 50, gender: 'men',
  cats: ['men'], occs: ['work'], notes: ['oud'],
  allEligibleOffers: [{ storeId: 'store-a', storeProductId: 'sp-a', price: 100, cur: 'EGP', avail: true }],
  globalOffer: { storeId: 'store-a', storeProductId: 'sp-a', price: 100, cur: 'EGP', avail: true },
  offersByStore: { 'store-a': { storeProductId: 'sp-a', price: 100, cur: 'EGP', avail: true } }
}
```

`globalOffer` وحده مصدر السعر القابل للعرض. `offersByStore` للتحقق لا لاختيار عرض آخر. عند اختيار متجر يجب مطابقة مالك `globalOffer`، والكارت يحفظ `storeProductId`.
