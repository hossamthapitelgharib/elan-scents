# Supabase migrations

`migrations/` contains **52** tracked SQL source files for the live Supabase project. The live ledger currently contains **54** records. The two-record difference is the documented historical source gap below. Migration files are kept in ascending version order, and `tests/migrations-consistency.test.js` checks local naming and ordering.

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

Two earlier applied migrations on 2026-10-13 (`20261013014000_harden_anon_grants_rls_initplan_and_order_pricing` and `20261013014023_guest_analytics_explicit_deny`) are also tracked locally. The live ledger is authoritative for version prefixes. Historical `PENDING` comments in immutable migration files are intentionally preserved.

## Rules

- Never edit the contents of an applied migration. A fix is a new migration.
- Write a new migration under `pending/` first; after it is applied, move it to `migrations/` and use the exact version recorded by Supabase.
- Never reuse a migration name at a different version.
- Real-database regression tests live in `tests/*.sql` and run inside `BEGIN ... ROLLBACK`.

## Known divergences

These source files were authored as a different split of statements than the live history; later idempotent migrations re-apply the relevant statements. Keep their contents unchanged.

| File | Chars in repo | Chars in live | Difference |
| --- | --- | --- | --- |
| `20261007032046_checkout_sessions_and_dashboard_permissions.sql` | 3184 | 2851 | Also contains the status-constraint extension applied live as `20261007032140` |
| `20261007032332_link_store_requests_to_checkout_sessions.sql` | 2720 | 2699 | Small wording difference in the function body |
| `20261008024644_extend_notifications_for_dashboard_realtime.sql` | 7041 | 6869 | Also contains the `order_initial` branch applied live as `20261008024719` |

## Not covered

The base schema (`profiles`, `stores`, `products`, `product_sizes`, `store_products`, `offers`, `cart_items`, and related tables) predates the tracked migration history. A new database cannot be rebuilt from this folder alone; a trusted schema snapshot of the live database is required.
