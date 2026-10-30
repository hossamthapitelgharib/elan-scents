-- Rolls back migrations/20261030063700_platform_audit_entries.sql.
-- The platform dashboard's audit log section (GET /api/platform-audit-log) stops working until the function is back.
-- The audit table itself and its rows are not touched.
begin;

drop function if exists public.platform_audit_entries(integer, integer);

commit;
