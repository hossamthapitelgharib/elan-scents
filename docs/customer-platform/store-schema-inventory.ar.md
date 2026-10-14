# جرد قاعدة بيانات المتاجر ولوحتي المتاجر والمنصة

**مصدر الجرد:** مخطط Supabase الحي، قيود المفاتيح الخارجية، واجهات `api/platform-stores.js` و`api/platform-store-detail.js`، وملفات اللوحات. تاريخ الفحص: 2026-10-14. يصف الجرد أسماء الحقول فقط، ولا يتضمن أسماء متاجر أو بيانات عملاء.

## ما هو موجود في Supabase الآن

| الجدول | السجلات الحالية | الحقول الحالية |
|---|---:|---|
| `stores` | 2 | `id`, `name`, `slug`, `logo_url`, `image_url`, `short_description`, `website_url`, `status`, `commission_rate`, `priority_rank`, `created_at`, `updated_at` |
| `store_accounts` | 0 | `id`, `store_id`, `user_id`, `role`, `created_at`, `updated_at` |
| `store_products` | 14 | `id`, `store_id`, `product_size_id`, `price`, `original_price`, `discount_percentage`, `stock_quantity`, `is_available`, `is_new_arrival`, `is_coming_soon`, `price_includes_tax`, `price_includes_shipping`, `currency`, `data_source`, `sync_status`, `last_synced_at`, `created_at`, `updated_at`, `product_url`, `is_catalog_bestseller` |
| `offers` | 3 | `id`, `store_id`, `product_size_id`, `title`, `description`, `discount_type`, `discount_value`, `start_date`, `end_date`, `is_active`, `created_at`, `updated_at` |
| `store_integrations` | 0 | `id`, `store_id`, `enabled`, `base_url`, `cart_url`, `api_base_url`, `catalog_endpoint`, `api_key`, `webhook_secret`, `notes`, `created_at`, `updated_at` |
| `sync_logs` | 0 | `id`, `store_id`, `status`, `message`, `records_count`, `created_at`, `updated_at` |
| `store_order_requests` | 0 | `id`, `tracking_number`, `store_id`, `user_id`, `customer_name`, `customer_phone`, `customer_email`, `customer_address`, `customer_notes`, `status`, `subtotal`, `shipping_amount`, `total_amount`, `currency`, `store_order_reference`, `failure_reason`, `initial_payload`, `latest_store_payload`, `reconciliation_status`, `mismatch_fields`, `created_at`, `updated_at`, `checkout_tracking_number`, `checkout_session_id` |
| `store_order_request_items` | 0 | `id`, `request_id`, `store_product_id`, `product_size_id`, `product_name`, `brand_name`, `size_label`, `quantity`, `unit_price`, `line_total`, `currency`, `created_at` |
| `store_order_notifications` | 0 | `id`, `request_id`, `tracking_number`, `event_type`, `store_status`, `match_status`, `mismatch_fields`, `payload`, `received_at`, `idempotency_key` |
| `store_shipments` | 0 | `id`, `request_id`, `store_id`, `carrier_name`, `tracking_code`, `shipping_status`, `status_note`, `estimated_delivery_at`, `delivered_at`, `created_at`, `updated_at` |
| `commissions` | 0 | `id`, `store_id`, `order_item_id`, `rate`, `amount`, `status`, `created_at`, `updated_at` |

### جداول تشغيل ومراجعة مرتبطة بالمتاجر والطلبات

| الجدول | الحقول المسجلة | العلاقة الأساسية |
|---|---|---|
| `order_operation_events` | `id`, `checkout_session_id`, `request_id`, `actor_user_id`, `actor_role`, `event_type`, `source`, `before_state`, `after_state`, `payload`, `created_at` | سجل أحداث؛ يمكن أن يرتبط بجلسة checkout أو طلب متجر أو مسؤول. |
| `order_reconciliation_checks` | `id`, `request_id`, `notification_id`, `tracking_number`, `event_type`, `initial_payload`, `store_payload`, `mismatch_fields`, `match_status`, `checked_at` | يتبع الطلب والإشعار، ويحفظ نتيجة مطابقة حالة المتجر. |
| `store_order_cart_restorations` | `id`, `request_id`, `restore_token`, `tracking_number`, `user_id`, `customer_phone`, `customer_email`, `items`, `reason`, `status`, `restored_at`, `created_at` | مرتبط بطلب وإمكانية استعادة سلة؛ يحتوي بيانات عميل، لذا لا يُعرض في لوحة المتاجر العامة. |

توجد كذلك view باسم `public_stores` للقراءة العامة وفق سياساتها، وليست بديلًا عن جداول إدارة المتاجر.

## العلاقات المؤكدة من قيود قاعدة البيانات

- `store_accounts.store_id`, `store_products.store_id`, `offers.store_id`, `store_integrations.store_id`, `sync_logs.store_id` ← `stores.id`.
- `store_accounts.user_id` ← `auth.users.id`؛ عدد الحسابات المرتبطة حاليًا صفر.
- `store_products.product_size_id` و`offers.product_size_id` و`store_order_request_items.product_size_id` ← `product_sizes.id`.
- `store_order_requests.store_id` ← `stores.id`؛ و`user_id` ← `auth.users.id`؛ و`checkout_session_id` ← `checkout_sessions.id`.
- `store_order_request_items.request_id` ← `store_order_requests.id`، و`store_product_id` ← `store_products.id`.
- `store_shipments.request_id` و`store_id` ← الطلب والمتجر؛ `commissions.order_item_id` ← `order_items.id` و`store_id` ← `stores.id`.
- إشعارات التشغيل والمطابقة وسجل الأحداث ترتبط بالطلب وفق قواعد `SET NULL` أو `CASCADE` المسجلة في القيود.

## ما يظهر في اللوحات الآن

### لوحة المتاجر — مدير المنصة فقط

`stores-dashboard.html` وواجهات `/api/platform-stores` و`/api/platform-store-detail` تعرض:

- قائمة المتاجر وحالتها والحسابات المرتبطة وعدد المنتجات المتاحة/الكل والعروض النشطة والطلبات المفتوحة والمراجعة والشحن والعمولة.
- تفاصيل المتجر بأقسام: الملخص والحسابات، الكتالوج والمخزون، العروض، الطلبات، الشحن، العمولات، المزامنة، والمطابقة والتدقيق.
- العمليات غير المرتبطة بطلب، مع حقول تشغيلية فقط.
- لا تُعرض بيانات اتصال العميل ولا الحمولات الخام في جداول التشغيل العامة.

### لوحة إدارة المنصة — مدير المنصة فقط

`platform-dashboard.html` تعرض مجاميع العملاء المسجلين والزوار، والطلبات المكتملة/المفتوحة/المحتاجة للمراجعة، والمتاجر النشطة والمنتجات المتاحة والعروض النشطة وطلبات المتاجر المفتوحة أو المحتاجة للمراجعة. التفاصيل تنتقل إلى لوحة العملاء أو لوحة المتاجر؛ لا تُكرر بيانات الأشخاص فيها.

## الحالة الفعلية: ما أنشئ وما لم يُملأ

- المخطط موجود على نطاق تشغيلي واسع للمتجر والكتالوج والعروض والمزامنة والطلب والشحن والعمولة والتسوية.
- المخطط وحده لا يعني أن سير العمل مستخدم: الجداول الفارغة حاليًا هي الحسابات المرتبطة، التكاملات، سجلات المزامنة، الطلبات، الشحنات والعمولات. لذلك لا يوجد سجل بيانات تشغيلية حقيقية لاختبار هذه المسارات في Supabase حتى لحظة الجرد.
- جداول التكاملات تحفظ `api_key` و`webhook_secret` كحقول `text` مقيدة بالوصول الخادمي، والواجهة تخفي الأسرار؛ لم يثبت وجود تشفير على مستوى التطبيق. يلزم قرار منفصل قبل إدخال أسرار حقيقية أو اعتماد خدمة/سياسة تشفير.

## فجوات أو قرارات مالك لم يُفترض إغلاقها

1. بيانات اعتماد المتجر نفسه: لا توجد في `stores` حقول تواصل تجاري/قانوني أو عنوان وفواتير/ضرائب أو حسابات صرف؛ لا نضيفها قبل تحديد المطلوب والجهة التي تراها.
2. دورة حياة المتجر: المطلوب حاليًا status وaccounts فقط؛ شروط التحقق، إيقاف/إعادة تفعيل، طلب الانضمام والمراجعة تحتاج قواعد عمل من المالك.
3. الأسرار: اختيار تخزين service-managed في قاعدة البيانات أو تشفير على مستوى التطبيق/خزنة أسرار، وسياسة تدوير/إبطال المفتاح.
4. الجداول المالية والصلاحيات: `commissions` فيها نسبة ومبلغ وحالة، لكن حالة التسوية المتوقعة، عملة التسوية، ومَن يغيّر الحالة تحتاج اعتمادًا قبل إضافة عمليات مالية.

لا تُضاف بيانات مالية أو شخصية جديدة لمجرد أن الطلب قال «كل شيء»؛ هذه البنود تحدد أولًا ثم تطبق باختبارات وصلاحيات صريحة.
