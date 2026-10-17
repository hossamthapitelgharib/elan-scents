-- تراجع عن supabase/pending/20261017024500_batch_guest_identity_links.sql
-- يُشغّل فقط إذا طُبّق RPC الجماعي واحتجنا إلى إزالته.
begin;
revoke all on function public.guest_identity_link_many(jsonb) from public, anon, authenticated, service_role;
drop function if exists public.guest_identity_link_many(jsonb);
commit;
