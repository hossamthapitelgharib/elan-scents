# Supabase migrations

`migrations/` keeps the SQL source files tracked for the live Supabase project (`supabase_migrations.schema_migrations`).
It currently contains 43 files. Numeric prefixes match the live versions for tracked migrations and remain in ascending order.
`tests/migrations-consistency.test.js` enforces the local naming and ordering rules.

## Live-history gaps

The live migration ledger currently contains 45 records. Two earlier records have no source file in this repository:

- `20261009230647_harden_order_user_binding` (the same migration name is recorded later as `20261010014304`)
- `20261010001456_guest_browser_identity_analytics` (the same migration name is recorded later as `20261010014327`)

Do not reconstruct the missing historical files from the later files based only on their names.

The migrations applied on 2026-10-13 were moved unchanged from `pending/` using the versions recorded by Supabase:
`20261013014000_harden_anon_grants_rls_initplan_and_order_pricing` and
`20261013014023_guest_analytics_explicit_deny`. The customer/store dashboard migration was also applied as
`20261013091458_platform_store_summary_and_customer_rls`, followed by `20261013101123_product_activity_snapshots` for full product snapshots and deletion-safe activity history, then `20261013101601_restrict_cart_snapshot_access` to keep the snapshot column private from customer clients, `20261013104621_store_customer_read_least_privilege` to remove anonymous reads from private customer/store-operation tables and limit public catalog access to required columns, `20261013112836_customer_product_rankings` for server-only, paginated product rankings across customer activity periods and event types, `20261013113053_customer_activity_summary_stats_only` to avoid calculating those rankings twice, and `20261013113811_private_customer_store_select_server_only` to route sensitive order and store-operation reads through role-checked server APIs. Historical `PENDING` comments in earlier files are intentionally preserved because applied migration contents are immutable; the live migration ledger is authoritative.

## Rules

- Never edit the content of a file in `migrations/` once it has been applied. A fix is a new migration.
- A new migration is written to `pending/` first. After the project owner approves it and it is applied to the live
  database, move it to `migrations/` and rename it with the version the database recorded
  (`select version, name from supabase_migrations.schema_migrations order by version desc limit 1`).
- Within this repository, one migration name must never appear twice under different versions.
- Real-database tests live in `tests/*.sql` and run inside `BEGIN ... ROLLBACK`.

## Known divergences (history, not errors)

These three files were authored in the repository as a different split of the same statements than the live history.
The final schema is identical because the migrations that follow re-apply the same statements idempotently.
Their content is kept untouched.

| File | Chars in repo | Chars in live | Why it differs |
| --- | --- | --- | --- |
| `20261007032046_checkout_sessions_and_dashboard_permissions.sql` | 3184 | 2851 | also contains the status-constraint extension that live applied as `20261007032140` |
| `20261007032332_link_store_requests_to_checkout_sessions.sql` | 2720 | 2699 | small wording difference in the function body |
| `20261008024644_extend_notifications_for_dashboard_realtime.sql` | 7041 | 6869 | also contains the `order_initial` branch that live applied as `20261008024719` |

## Not covered

The base schema (`profiles`, `stores`, `products`, `product_sizes`, `store_products`, `offers`, `cart_items`, ...) predates the
tracked migration history, so a brand new database cannot be rebuilt from this folder alone.
A schema snapshot of the live database would be needed for that.
