-- Stage 1 follow-up (docs/purchase-flow-correction-plan.ar.md): the list of stores that are technically linked is read by the server
-- (GET /api/store-order-readiness) and not with a browser token, like every other function since 4 Nov 2026
-- (tests/rls-attack-surface.test.sql section 6: no public function is callable by anon or authenticated).
revoke all on function public.store_order_readiness() from public, anon, authenticated;
grant execute on function public.store_order_readiness() to service_role;
