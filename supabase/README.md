# Supabase migrations

`migrations/` contains **68** tracked SQL source files for the live Supabase project. The live ledger (`supabase_migrations.schema_migrations`, checked read-only on 2026-10-19) contains **70** records. The two-record difference is the documented historical source gap below. Migration files are kept in ascending version order, and `tests/migrations-consistency.test.js` checks local naming and ordering.

## Live-history gaps

The live ledger has two earlier records without source files in this repository:

- `20261009230647_harden_order_user_binding` (the same migration name is recorded later as `20261010014304`)
- `20261010001456_guest_browser_identity_analytics` (the same migration name is recorded later as `20261010014327`)

Do not reconstruct either missing historical file from a later migration based only on its name.

## Recent applied migrations

The customer, store, and platform access changes applied to the live project include:

- `20261013091458_platform_store_summary_and_customer_rls`
- `20261013101123_product_activity_snapshots`
- `20261013101601_restrict_cart_snapshot_access`
- `20261013104621_store_customer_read_least_privilege`
- `20261013112836_customer_product_rankings`
- `20261013113053_customer_activity_summary_stats_only`
- `20261013113811_private_customer_store_select_server_only`
- `20261014084637_notifications_server_only`
- `20261014093223_platform_customer_detail_product_snapshots`
- `20261014101846_customer_activity_category_views`
- `20261014102019_restrict_customer_activity_view_access`
- `20261014102728_store_integrations_normalized`
- `20261014102847_store_integrations_normalized_idempotent_retry`
- `20261015032124_customer_search_operations`
- `20261015033601_customer_search_retention_365_days`
- `20261016010826_transfer_guest_analytics_on_claim`
- `20261016013630_registered_customer_best_sellers`
- `20261017011522_guest_conversions_and_claim_conversion_record`
- `20261017011533_merge_duplicate_guest_browsers`
- `20261017011558_guest_fingerprint_signals`
- `20261017014836_expire_editor_sections`
- `20261017023202_registered_customer_best_sellers_view` (applied live without a tracked source; the file here is the statement text recovered verbatim from the live ledger, 3473 characters)
- `20261017030354_batch_guest_identity_links` (written as `pending/20261017024500_…`, then applied live as this version)
- `20261017062830_customer_activity_totals_and_guest_cleanup_on_claim`
- `20261019052550_guest_fingerprint_retention_400_days` (written as `pending/20261019000100_…`, then applied live as this version)

Seven more migrations were applied live without a tracked source file. Each file here is the statement text recovered verbatim from the live ledger (read-only). The md5 of every file equals the md5 of the ledger statement; the six files from 2026-10-18 have one trailing newline added, which is removed before comparing:

- `20261018214524_add_registered_customer_best_seller_indexes` (647 characters)
- `20261018215138_track_order_returns_refunds_in_best_sellers` (10917 characters)
- `20261018215203_harden_order_adjustment_quantity_integrity` (1868 characters)
- `20261018215356_create_store_order_request_from_cart` (4210 characters)
- `20261018215409_preserve_cart_item_source_on_order_items` (334 characters)
- `20261018220530_add_store_webhook_inventory_application` (6486 characters)
- `20261019105404_guest_fingerprint_retention_fix_owner_rows` (4916 characters; replaces `purge_expired_guest_fingerprints` so the purge deletes a guest's sessions and product events before the guest row)

Applying a migration to the live project without first writing it under `pending/` breaks the rules below; the next live change should follow the pending-first flow.

Two earlier applied migrations on 2026-10-13 (`20261013014000_harden_anon_grants_rls_initplan_and_order_pricing` and `20261013014023_guest_analytics_explicit_deny`) are also tracked locally. The live ledger is authoritative for version prefixes. Historical `PENDING` comments in immutable migration files are intentionally preserved.

## Rules

- Never edit the contents of an applied migration. A fix is a new migration.
- Write a new migration under `pending/` first; after it is applied, move it to `migrations/` and use the exact version recorded by Supabase.
- Never reuse a migration name at a different version.
- Real-database regression tests live in `tests/*.sql` and run inside `BEGIN ... ROLLBACK`.

## تغييرات معلّقة

لا توجد ترحيلات معلّقة حاليًا؛ مجلد `pending/` فارغ. كان `pending/20261017024500_batch_guest_identity_links.sql` قد طُبّق على المشروع الحي بالإصدار `20261017030354` (نص مطابق حرفيًا للملف المعلّق، 1674 حرفًا)، فنُقل ملفه وملف التراجع المقابل إلى `migrations/` و`rollback/` بهذا الإصدار. يحافظ `api/guest-cart.js` على استدعاء `guest_identity_link` الفردي كمسار احتياطي ويمكن إزالته في تغيير لاحق بعد قياس `guest_identity_link_many` على بيانات حقيقية.

طُبّق `pending/20261019000100_guest_fingerprint_retention_400_days.sql` على المشروع الحي بالإصدار `20261019052550` بموافقة المالك الصريحة بتاريخ 2026-10-19 (بنص الملف نفسه)، فنُقل ملفه وملف التراجع المقابل إلى `migrations/` و`rollback/` بهذا الإصدار. يمسح يومياً (pg_cron، الساعة 03:41 UTC) بيانات بصمة الضيوف بعد **400 يوماً** من آخر ظهور، تنفيذاً لقرار المالك بتاريخ 2026-10-18 وبما يطابق عمر كوكي `elan_gid`: `guest_fingerprints` و`guest_identity_links` وصفوف `guest_visitors` بحالة `guest` فقط (وتُحذف بحثاتهم معها). لا يمسّ عدّادات التحليلات المجمّعة (`guest_analytics_visits` و`guest_product_analytics`) ولا `guest_conversions`. **قرار المالك بتاريخ 2026-10-19: عدّادات التحليلات المجمّعة (`guest_analytics_visits` و`guest_product_analytics`) لا عمر محدداً لها ولا يحذفها مسح العمر، فهي مرتبطة بعمر المنصة وتقوم عليها التحليلات وتطويرها؛ أي مسح عمري مستقبلي يجب ألا يشملها.** (التعليق في ملفَي الترحيل `20261019052550` و`20261019105404` يصف هذا القرار بأنه «منفصل» لأنه كُتب قبله، ولا يُعدَّل لأن الترحيل مطبّق.) ملف التراجع `rollback/20261019052550_guest_fingerprint_retention_400_days.sql` يوقف المسح ولا يستعيد صفوفاً حُذفت، واختبار قاعدة البيانات `tests/guest-fingerprint-retention.test.sql` يُشغَّل على قاعدة تجريبية ثم يتراجع.

ثم طُبّق على المشروع الحي الترحيل `20261019105404_guest_fingerprint_retention_fix_owner_rows` (نصه في `migrations/` مطابق حرفياً لسجل القاعدة): يستبدل الدالة `purge_expired_guest_fingerprints` بحيث تحذف أيضاً `customer_sessions` و`customer_product_events` الخاصة بالضيف المنتهية مدته قبل صف `guest_visitors` نفسه، لأن الجدولين يشترطان مالكاً واحداً بالضبط (ضيف أو عميل) ويشيران للضيف بـ `ON DELETE SET NULL`، فحذف صف الضيف وحده كان سيخرق القاعدة ويُفشل المهمة كلها. هذا هو المقصود: **قرار المالك بتاريخ 2026-10-19 (دورة حياة الضيف)**: الضيف الذي لا يسجّل خلال 400 يوم من آخر ظهور ويبقى ضيفاً يُحذف بالكامل بكل أحداثه، لأن بقاء سجلات الضيوف بلا نهاية غير منطقي. أما من يسجّل قبل ذلك فيتحول من زائر (رقم بصمة) إلى مسجّل (معرّف حساب) وتنتقل معه كل أحداثه كما هي دون حذف شيء منها (المشاهدة والبحث والإضافة والحذف وآخر وضع للسلة)، ثم تُحذف بصمته وما يخصها من عدّادات الزائر المجهولة؛ فينقص ما في سجل الزوار ويزيد ما في سجل المسجلين، دون أن يتأثر المجموع الكلي. وهذا ما تفعله الدالتان الحيتان: `claim_guest_browser_cart` ذات المعاملات الثلاثة عند التسجيل (تنقل الجلسات وأحداث المنتجات والبحثات ثم تحذف البصمات والروابط وعدّادات المتصفح وصف الضيف)، و`purge_expired_guest_fingerprints` بعد 400 يوم (تحذف الضيف وكل أحداثه). ملاحظة: صفوف `guest_analytics_visits` و`guest_product_analytics` التي تخص ضيفاً انتهت مدته تبقى بحسب قرار العدّادات أعلاه؛ تُحذف عند التسجيل فقط. لم يُحذف شيء حتى الآن: أقدم ضيف ظهر في 2026-10-09 فلا يستحق المسح قبل نوفمبر 2027، ولم تعمل المهمة المجدولة بعد وقت التحقق.

## Known divergences

These source files were authored as a different split of statements than the live history; later idempotent migrations re-apply the relevant statements. Keep their contents unchanged.

| File | Chars in repo | Chars in live | Difference |
| --- | --- | --- | --- |
| `20261007032046_checkout_sessions_and_dashboard_permissions.sql` | 3184 | 2851 | Also contains the status-constraint extension applied live as `20261007032140` |
| `20261007032332_link_store_requests_to_checkout_sessions.sql` | 2720 | 2699 | Small wording difference in the function body |
| `20261008024644_extend_notifications_for_dashboard_realtime.sql` | 7041 | 6869 | Also contains the `order_initial` branch applied live as `20261008024719` |

## Filename differs from the live name

Same version and same statements; only the descriptive part of the file name differs from the name Supabase recorded. The live ledger records `store_integrations_normalized` twice (`20261014102728` and `20261014102847`), so the second file keeps a distinct suffix to satisfy the one-name-one-version rule.

| Version | File name | Live name |
| --- | --- | --- |
| `20261007030744` | `store_cancellation_and_cart_restoration` | `add_store_cancellation_and_cart_restoration` |
| `20261007032046` | `checkout_sessions_and_dashboard_permissions` | `add_checkout_sessions_and_dashboard_permissions` |
| `20261014102847` | `store_integrations_normalized_idempotent_retry` | `store_integrations_normalized` |

## Not covered

The base schema (`profiles`, `stores`, `products`, `product_sizes`, `store_products`, `offers`, `cart_items`, and related tables) predates the tracked migration history. A new database cannot be rebuilt from this folder alone; a trusted schema snapshot of the live database is required.
