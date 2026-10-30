# Supabase migrations

`migrations/` contains **86** tracked SQL source files for the live Supabase project, one for every record of the live ledger (`supabase_migrations.schema_migrations`, 86 records, checked read-only on 2026-10-30). Migration files are kept in ascending version order, and `tests/migrations-consistency.test.js` checks local naming and ordering. The Supabase GitHub integration compares the versions of the ledger with the files here and refuses to run ("Remote migration versions not found in local migrations directory") when a ledger version has no file, so every version recorded live must have a file.

## Earlier runs recorded twice

Two migrations were run twice on the live project, the first time under an earlier version. Their earlier records had no source file until 2026-10-24, which made the integration's "Supabase Preview" check fail. Each file below is the statement text recovered **verbatim from the live ledger** (read-only); its md5 equals the md5 of the ledger statement. Their names end in `_earlier_run` because a migration name must not appear twice under different versions (`tests/migrations-consistency.test.js`); the integration matches on the version only.

- `20261009230647_harden_order_user_binding_earlier_run` (4432 characters, md5 `00be6300a1f9b9a3f308159a25309dc1`): the first run of `harden_order_user_binding`. It differs from the later record `20261010014304_harden_order_user_binding` (5082 characters), which is the final form.
- `20261010001456_guest_browser_identity_analytics_earlier_run` (12895 characters, md5 `b25c1766865869c3fd07609cbccff46e`): the first run of `guest_browser_identity_analytics`. Its statement is identical to the later record `20261010014327_guest_browser_identity_analytics`, whose file here additionally keeps the author's comment lines.

These two files are history only: they are already applied live and must never be run again by hand. Do not delete or edit them.

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
- `20261020101127_restore_best_seller_audit_breakdown` (written as `pending/20261020010000_…`, then applied live as this version; restores the best-seller audit fields that `20261018215138` dropped)
- `20261020103154_guest_retention_delete_expired_guest_counters` (written as `pending/20261020000100_…`, then applied live as this version; see the owner decision of 2026-10-20 below)
- `20261020115120_harden_adjustment_trigger_fn_and_add_fk_indexes` (applied live with the owner's explicit approval and tracked directly under `migrations/`, without a `pending/` step: revokes client EXECUTE on the trigger function `validate_store_order_item_adjustment()`, adds six missing foreign-key indexes, and makes the `store_shipments_owner_read` policy evaluate `(select auth.uid())`; tests `tests/db-hardening-acl-and-indexes.test.js` and `.test.sql`)
- `20261021104519_guest_product_analytics_primary_key` (applied live with the owner's explicit approval on 2026-10-21 after a run inside a rolled-back transaction on the live project, written as `pending/20261021000100_…` and moved here under the recorded version: promotes the existing UNIQUE constraint on `guest_product_analytics (visitor_hash, product_id, activity_date, event_type)` to the primary key; every upsert infers its target from that column list, so nothing else changed. Rollback in `rollback/`; tests: `tests/guest-product-analytics-primary-key.test.js` and `.test.sql`)
- `20261024165336_customer_data_hardening` (applied live by Claude on 2026-10-24 under the owner's standing decision, after a run inside a rolled-back transaction on the live project; it changes no order, price or tracking behaviour: cart quantity ceiling of 99 on `cart_items`, `replace_customer_cart` hardened (one transaction, at most 100 lines, quantity clamped to 1..99) and granted to signed-in users so the browser saves the cart in one call, length and format ceilings on the customer text columns of `checkout_sessions`, `store_order_requests`, `contact_messages`, `reviews` and `profiles`, `handle_new_user` cuts the sign-up name to 120 characters, and the anonymous insert policy on the unused `analytics_events` table is removed. Rollback in `rollback/`; tests: `tests/customer-data-hardening.test.js` and `.test.sql`)
- `20261025051356_guest_identity_hardening` (applied live by Claude on 2026-10-25 under the owner's standing decision, after a run inside a rolled-back transaction on the live project; it touches no customer, order or price: the legacy two-argument `claim_guest_browser_cart` is dropped (the API no longer falls back to it), `guest_identity_link` keeps one person to at most 8 browsers however the links chain, `guest_signal_candidates` returns exact fingerprint matches before the fifty most recent look-alikes, `guest_signal_store` stores a fingerprint only for a browser that already has a visit row, and `resolve_guest_browser` / `save_guest_browser_cart` accept at most 2000 brand-new guests per hour (index `guest_visitors_first_seen_idx`; existing guests are never affected). The file is the statement text from the live ledger (md5 `993ac45b3af4940a3e2510ad4468ad53`). Rollback in `rollback/`; tests: `tests/guest-identity-hardening.test.js` and `.test.sql`)
- `20261027041127_server_confirmed_orders` (applied live by Claude on 2026-10-27 after the owner's approval card of 2026-10-26 (order flow, tracking numbers) and a run inside a rolled-back transaction on the live project, which left no trace; the live database had no order or checkout session yet. Adds `public.place_store_order(jsonb)`: one transaction that checks the lines the customer saw (store product, quantity 1..99, unchanged price, stock), makes the store's saved-cart rows equal to them, makes the tracking number on the server (`private.new_tracking_number()`: `ELN-<Cairo date>-<6 random digits>`, never used before; a number sent by the browser is ignored), creates the checkout session and the store order request through the existing functions, and remembers a retry key in `private.store_order_idempotency` (RLS on, no policy, cleaned after 7 days by the cron job `order-idempotency-retention-7d`) so a repeated call returns the same order. At most 20 orders per customer per hour. `create_checkout_session` and `create_store_order_request_from_cart` are unchanged and stay callable for browsers that still hold the previous script. The file is the statement text from the live ledger (md5 `711638aafde18c70713a25d81fb2acfc`). Rollback in `rollback/`; tests: `tests/place-store-order.test.js` and `.test.sql`)
- `20261027105200_customer_cancellation_requests` (applied live by Claude on 2026-10-27 after the owner's approval card of 2026-10-26 (customer cancellation request) and a run inside a rolled-back transaction on the live project, which left no trace. Adds `public.store_order_cancellation_requests` (one row per order, server-only: RLS on, no policy, no client privilege) and `public.request_store_order_cancellation(order id, reason)`: a signed-in customer asks to cancel HIS OWN order, only while it is `awaiting_store_confirmation`; the order row is locked, nothing is cancelled automatically and the order keeps its status, a repeated call returns the first request, the reason is at most 500 characters, and the customer, the platform admins and the store are notified through `emit_order_notification` (`customer_cancel_requested`). The store answers with the actions it already has (reject = accept the cancellation, confirm = decline it); the state the customer sees is derived from the order status. The file is the statement text from the live ledger (md5 `271e91a294f343b01a6e93cdf63b7893`). Rollback in `rollback/`; tests: `tests/customer-cancellation-requests.test.js` and `.test.sql`)
- `20261028105801_customer_searches_keep_registered_customers` (applied live on 2026-10-28 under the owner's decision of the same day that nothing belonging to a registered customer is deleted automatically: `purge_expired_customer_searches()` now deletes only the searches of visitors who never registered, the schedule and grants are unchanged. The file is the statement text from the live ledger (md5 `73d9ce5679ad3a010d3929489b40c83e`). Rollback in `rollback/`)
- `20261028163408_store_phase_hardening` (applied live by Claude on 2026-10-28 under the owner's standing decision and the order-flow decision of 2026-10-26, after a run inside a rolled-back transaction on the live project, which left no trace; the live database had no order and no store account yet. (1) The three older order functions (`create_checkout_session`, `create_store_order_request`, `create_store_order_request_from_cart`: the caller chooses the tracking number) are closed to clients and kept for `service_role`; the storefront only uses `place_store_order`, and the two legacy `own_insert` policies on `orders` and `order_items` are dropped. (2) Data rules: offer title 1..200 characters, description at most 2000, discount value above 0 (percentage at most 100), end date not before start date; the store, logo, image and product links must be http(s). (3) Trigger `guard_platform_columns` on `store_products`: a signed-in user who is not a platform admin cannot set or change `is_catalog_bestseller` (it feeds the public ranking); the server sync, which has no user, and platform admins can. (4) `public.platform_audit_log`, server-only (ids only, no personal data). (5) `platform_store_accounts`, `platform_link_store_account(store, email, actor)` and `platform_unlink_store_account(account, actor)`, `service_role` only: linking needs a confirmed email, refuses a platform admin and a customer who has orders, turns the profile role customer into store_admin on the first link and back on the last unlink, and writes the audit log. The file is the statement text from the live ledger (md5 `9175d9deb8cc10d867acb640ac075644`). Rollback in `rollback/`; tests: `tests/store-phase-hardening.test.js` and `.test.sql`)
- `20261029050311_forget_guest_browser` (applied live on 2026-10-29 by another Claude session under the owner's decision of the same day that a visitor's refusal erases that browser's fingerprint and activity; the file and its test were pushed by that session in `6b80857`; `forget_guest_browser` is `service_role` only)
- `20261029063246_public_read_store_product_coming_soon_flag` (applied live by Claude on 2026-10-29 under the owner's standing decision, after a run inside a rolled-back transaction on the live project, which left no trace: a column-level `GRANT SELECT (is_coming_soon)` on `public.store_products` to `anon` and `authenticated`, so the storefront can mark the products a store flagged as coming soon; the table keeps no table-wide read and the visible rows are still decided by RLS; rollback in `rollback/`)
- `20261030063700_platform_audit_entries` (applied live by Claude on 2026-10-30 under the owner's standing decision, after a run inside a rolled-back transaction on the live project, which left no trace. Adds `public.platform_audit_entries(limit, offset)`, `service_role` only, read-only: the platform audit log joined with the actor's email, the store name and the email of the account an action was about, newest first, page size clamped to 1..101. The platform dashboard reads it through `/api/platform-audit-log`. The file is the statement text from the live ledger (md5 `1dcd9859e872d907d8ae125e628f974f`). Rollback in `rollback/`; tests: `tests/platform-audit-log.test.js` and `tests/platform-audit-entries.test.sql`)
- `20261030114314_platform_store_summary_review_count` (applied live by Claude on 2026-10-30 under the owner's standing decision, after a run inside a rolled-back transaction on the live project, which left no trace. Same signature and grants as before (`service_role` only); `review_order_count` of `platform_store_summary()` now counts an order as needing review when its status is `needs_review` or its reconciliation is `mismatched`, the rule the platform order summary and the order panel already use, so the store panel and the platform dashboard give the same number for the same orders. The file is the statement text from the live ledger (md5 `4207a5ae09a6e1d498c89ed4709e97bf`). Rollback in `rollback/`; test: `tests/platform-store-summary-review.test.sql`)

Nine more migrations were applied live without a tracked source file. Each file here is the statement text recovered verbatim from the live ledger (read-only). The md5 of every file equals the md5 of the ledger statement; the files from 2026-10-18 and the two editor-section files from 2026-10-19 have one trailing newline added, which is removed before comparing:

- `20261018214524_add_registered_customer_best_seller_indexes` (647 characters)
- `20261018215138_track_order_returns_refunds_in_best_sellers` (10917 characters)
- `20261018215203_harden_order_adjustment_quantity_integrity` (1868 characters)
- `20261018215356_create_store_order_request_from_cart` (4210 characters)
- `20261018215409_preserve_cart_item_source_on_order_items` (334 characters)
- `20261018220530_add_store_webhook_inventory_application` (6486 characters)
- `20261019105404_guest_fingerprint_retention_fix_owner_rows` (4916 characters; replaces `purge_expired_guest_fingerprints` so the purge deletes a guest's sessions and product events before the guest row)
- `20261019163540_archive_expired_editor_sections` (1228 characters; added `private.archive_expired_editor_sections()` and the cron job `archive-expired-editor-sections`, a duplicate of the existing `expire-editor-sections`)
- `20261019222030_remove_duplicate_archive_expired_editor_sections` (590 characters; removes only that duplicate cron job and function again, leaving `20261017014836_expire_editor_sections` in charge)

Applying a migration to the live project without first writing it under `pending/` was against the rules that applied at the time. It happened for the nine files above, and once more with the owner's explicit approval for `20261020115120`. Since the owner's decision of 2026-10-20 (see the rules below) there is no pending-first step any more.

Two earlier applied migrations on 2026-10-13 (`20261013014000_harden_anon_grants_rls_initplan_and_order_pricing` and `20261013014023_guest_analytics_explicit_deny`) are also tracked locally. The live ledger is authoritative for version prefixes. Historical `PENDING` comments in immutable migration files are intentionally preserved.

## Rules

- Never edit the contents of an applied migration. A fix is a new migration.
- There are no pending migrations (owner decision of 2026-10-20): Claude applies a migration itself on the owner's behalf. It first tests it on the live project inside a transaction that is rolled back, then applies it with `apply_migration`, then adds its file to `migrations/` and its rollback to `rollback/` using the exact version Supabase recorded, and checks the result on the database. `supabase/pending/` is no longer used. Details and the few cases that still need an approval card are in `CLAUDE.md`.
- Never reuse a migration name at a different version.
- Real-database regression tests live in `tests/*.sql` and run inside `BEGIN ... ROLLBACK`.

## الترحيلات المعلّقة وقرارات المالك

لا توجد ترحيلات معلّقة حاليًّا. طُبّق بتاريخ 2026-10-21 بموافقة المالك الصريحة الترحيل `20261021104519_guest_product_analytics_primary_key` (كُتب أولًا باسم `pending/20261021000100_…`): يحوّل القيد الفريد الموجود على `guest_product_analytics` (على `visitor_hash, product_id, activity_date, event_type`، وكلها NOT NULL) إلى مفتاح أساسي، فزال تنبيه Supabase `no_primary_key`. اختُبر على القاعدة الحية داخل معاملة مُلغاة (`tests/guest-product-analytics-primary-key.test.sql`) فلم يترك أثرًا، ثم طُبّق وتحقّقنا منه (القيد `guest_product_analytics_pkey` قائم والصفوف الثلاثة كما هي). وكل ما كُتب معلّقًا طُبّق على المشروع الحي ونُقل مع ملف التراجع المقابل إلى `migrations/` و`rollback/` بالإصدار الذي سجّلته Supabase. وبقرار المالك بتاريخ 2026-10-20 لا ترحيلات معلّقة مستقبلًا: يطبّق Claude الترحيلات بنفسه بعد اختبارها داخل معاملة مُلغاة على القاعدة الحية، ثم يسجّل ملفها وملف التراجع بالإصدار الذي سجّلته القاعدة (التفاصيل في `CLAUDE.md`).

- `20261017030354_batch_guest_identity_links`: نص مطابق حرفيًا للملف المعلّق (1674 حرفًا). يحافظ `api/guest-cart.js` على استدعاء `guest_identity_link` الفردي كمسار احتياطي، ويمكن إزالته في تغيير لاحق بعد قياس `guest_identity_link_many` على بيانات حقيقية.
- `20261019052550_guest_fingerprint_retention_400_days`: طُبّق بموافقة المالك الصريحة بتاريخ 2026-10-19 بنص الملف نفسه. يمسح يوميًا (pg_cron، الساعة 03:41 UTC) بيانات بصمة الضيوف بعد **400 يومًا** من آخر ظهور، تنفيذًا لقرار المالك بتاريخ 2026-10-18 وبما يطابق عمر كوكي `elan_gid`: `guest_fingerprints` و`guest_identity_links` وصفوف `guest_visitors` بحالة `guest` فقط (وتُحذف بحثاتهم معها). ملف التراجع `rollback/20261019052550_guest_fingerprint_retention_400_days.sql` يوقف المسح ولا يستعيد صفوفًا حُذفت، واختبار قاعدة البيانات `tests/guest-fingerprint-retention.test.sql` يُشغَّل على قاعدة تجريبية ثم يتراجع.
- `20261019105404_guest_fingerprint_retention_fix_owner_rows`: نصه في `migrations/` مطابق حرفيًا لسجل القاعدة. يستبدل الدالة `purge_expired_guest_fingerprints` بحيث تحذف أيضًا `customer_sessions` و`customer_product_events` الخاصة بالضيف المنتهية مدته قبل صف `guest_visitors` نفسه، لأن الجدولين يشترطان مالكًا واحدًا بالضبط (ضيف أو عميل) ويشيران للضيف بـ `ON DELETE SET NULL`، فحذف صف الضيف وحده كان سيخرق القاعدة ويُفشل المهمة كلها. لم تعمل المهمة المجدولة بعد وقت التحقق ولم يُحذف شيء: أقدم ضيف ظهر في 2026-10-09 فلا يستحق المسح قبل نوفمبر 2027.
- `20261020101127_restore_best_seller_audit_breakdown`: يستعيد حقول تدقيق الأكثر مبيعًا التي أسقطها `20261018215138`.

### قرار المالك بتاريخ 2026-10-19 (حلّ محلّه قرار 2026-10-20 فيما يخص عدّادات الضيف)

قرار المالك بتاريخ 2026-10-19 كان أن عدّادات التحليلات المجمّعة (`guest_analytics_visits` و`guest_product_analytics`) لا عمر محددًا لها ولا يحذفها مسح العمر. التعليق في ملفَّي الترحيل `20261019052550` و`20261019105404` يصف هذا القرار بأنه «منفصل» لأنه كُتب قبله، ولا يُعدَّل لأن الترحيل مطبّق.

### قرار المالك بتاريخ 2026-10-20: عدّادات الضيف تنتهي مع الضيف

لوحة المنصة أربع مجموعات عدّادات: **الزوار** بكل أحداثهم، و**المسجلون** بكل أحداثهم، و**الأكثر مبيعًا**، و**المجموع** (الزوار والمسجلون معًا بكل الأحداث). والقاعدة:

- ضيف لم يسجّل خلال 400 يوم من آخر ظهور يُحذف بالكامل بكل أحداثه، فتنقص عدّادات الزوار بكل أحداثها وينقص المجموع تلقائيًا.
- ضيف يسجّل قبل ذلك يتحول من رقم بصمة إلى معرّف حساب وتنتقل معه كل أحداثه كما هي (المشاهدة والبحث والإضافة والحذف وآخر وضع للسلة)، ثم تُحذف بصمته وما يخصها؛ فتنقص عدّادات الزوار وتزيد عدّادات المسجلين ويبقى المجموع كما هو.
- `guest_analytics_visits` و`guest_product_analytics` هما عدّادات الزوار نفسها (صف لكل متصفح مشفّر)، وتنتهي مع وجود الزائر بالمسح بعد 400 يوم أو بالتسجيل.

التسجيل تنفّذه `claim_guest_browser_cart` ذات المعاملات الثلاثة (تنقل الجلسات وأحداث المنتجات والبحثات ثم تحذف البصمات والروابط وعدّادات المتصفح وصف الضيف). كانت الدالة الحية تترك الانقضاء بعد 400 يوم ناقصًا: تحذف الضيف وأحداثه لكن تترك صفوفه في `guest_analytics_visits` و`guest_product_analytics`. الترحيل **`20261020103154_guest_retention_delete_expired_guest_counters`** (وتراجعه في `rollback/`) يكمّل ذلك: يحذف كل صفوف أي متصفح لم يظهر له أي نشاط (صف عدّاد أو بصمة) خلال المدة، دفعة واحدة لكل أيامه، ولا يمسّ أيام ضيف ما زال نشطًا. لا يحذف `guest_conversions` ولا بيانات المسجلين ولا الأكثر مبيعًا. اختباره `tests/guest-fingerprint-retention.test.sql` (يغطي الجلسات والأحداث والبحثات والعدّادات) نجح على قاعدة تجريبية قبل التطبيق ويفشل على الدالة السابقة. طُبّق على المشروع الحي بالإصدار `20261020103154`؛ ولم يُحذف شيء وقت التطبيق لأن أقدم صف عدّاد ضيف يعود إلى 2026-10-10 والمدة 400 يوم.

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

The base schema (`profiles`, `stores`, `products`, `product_sizes`, `store_products`, `offers`, `cart_items`, and related tables) predates the tracked migration history. A new database cannot be rebuilt from this folder alone.

`schema-snapshot/` holds a read-only, structure-only snapshot of the live database (tables, columns, constraints, indexes, policies, grants, triggers, function signatures with definition hashes, views, cron jobs, storage buckets). It documents what the live schema looks like; it is not a restore script. Its `README.md` explains the files, the md5 table that `tests/schema-snapshot.test.js` checks, and how to re-run `generate.sql` to detect drift. When a migration changes the live schema, refresh the affected snapshot file in the same change.
