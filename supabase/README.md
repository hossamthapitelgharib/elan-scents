# Supabase migrations

`migrations/` mirrors the migration history of the live Supabase project (`supabase_migrations.schema_migrations`):
the numeric prefix of every file is **exactly the version recorded by the live database**, in the same order (30 files).
`tests/migrations-consistency.test.js` enforces the naming rules below.

## Rules

- Never edit the content of a file in `migrations/` once it has been applied. A fix is a new migration.
- A new migration is written to `pending/` first. After the project owner approves it and it is applied to the live
  database, move it to `migrations/` and rename it with the version the database recorded
  (`select version, name from supabase_migrations.schema_migrations order by version desc limit 1`).
- One migration, one file. The same migration name must never appear twice with two different versions.
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
