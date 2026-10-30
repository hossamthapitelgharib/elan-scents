-- Platform phase: the platform dashboard reads the audit log.
-- platform_audit_log (store phase) only holds ids. This service-role function joins what a platform admin needs to
-- read it: the actor's email, the store name and the email of the account the action was about (null when that
-- user or store no longer exists). Nothing is written. Page size is clamped to 1..101 so the API can ask for one
-- row more than it shows to know if there is another page.
begin;

create or replace function public.platform_audit_entries(p_limit integer default 50, p_offset integer default 0)
returns table (
  id uuid,
  created_at timestamptz,
  action text,
  target_type text,
  target_id uuid,
  actor_email text,
  store_id uuid,
  store_name text,
  subject_email text,
  details jsonb
)
language sql
stable
security definer
set search_path to 'public', 'private', 'auth', 'pg_temp'
as $function$
  select l.id, l.created_at, l.action, l.target_type, l.target_id,
         actor.email::text,
         s.id, s.name,
         subject.email::text,
         l.details
  from public.platform_audit_log l
  left join auth.users actor on actor.id = l.actor_id
  left join public.stores s on s.id = case
    when l.details->>'store_id' ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
    then (l.details->>'store_id')::uuid end
  left join auth.users subject on subject.id = case
    when l.details->>'user_id' ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
    then (l.details->>'user_id')::uuid end
  order by l.created_at desc, l.id desc
  limit greatest(1, least(coalesce(p_limit, 50), 101))
  offset greatest(0, coalesce(p_offset, 0))
$function$;

revoke all on function public.platform_audit_entries(integer, integer) from public, anon, authenticated;
grant execute on function public.platform_audit_entries(integer, integer) to service_role;

commit;
