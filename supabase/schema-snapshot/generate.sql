-- Read-only catalog query that regenerates the files in this folder from the live database.
-- It reads system catalogs only (pg_catalog, cron.job, storage.buckets, supabase_migrations.schema_migrations
-- version numbers); it never reads application rows and never changes anything.
-- Output: one row per snapshot file (file, md5, chars, txt) plus a 'ledger' row (migration count and latest version).
-- A file on disk is `txt` followed by one newline. Its md5 is the md5 of `txt`, that is the file minus its last newline.
-- Compare `md5` with the table in README.md to detect drift.
with tb as (
  select c.oid, c.relname, c.relrowsecurity from pg_class c join pg_namespace n on n.oid=c.relnamespace where n.nspname='public' and c.relkind='r'
), cols as (
  select a.attrelid as oid, string_agg('  ' || a.attname || ' ' || format_type(a.atttypid, a.atttypmod) || case when a.attnotnull then ' NOT NULL' else '' end || coalesce(' DEFAULT ' || regexp_replace(pg_get_expr(d.adbin, d.adrelid), '\s+', ' ', 'g'), ''), E'\n' order by a.attnum) as txt
  from pg_attribute a left join pg_attrdef d on d.adrelid=a.attrelid and d.adnum=a.attnum where a.attnum>0 and not a.attisdropped group by a.attrelid
), cons as (
  select k.conrelid as oid, string_agg('  CONSTRAINT ' || k.conname || ' ' || regexp_replace(pg_get_constraintdef(k.oid), '\s+', ' ', 'g'), E'\n' order by array_position(array['p','u','f','c'], k.contype::text), k.conname) as txt
  from pg_constraint k where k.contype in ('p','u','f','c') group by k.conrelid
), idx as (
  select i.indrelid as oid, string_agg('  ' || replace(pg_get_indexdef(i.indexrelid), 'public.', ''), E'\n' order by ic.relname) as txt
  from pg_index i join pg_class ic on ic.oid=i.indexrelid where not exists (select 1 from pg_constraint k where k.conindid=i.indexrelid and k.contype in ('p','u','x')) group by i.indrelid
), pol as (
  select p.polrelid as oid, string_agg('  POLICY ' || p.polname || ' ' || case when p.polpermissive then 'PERMISSIVE' else 'RESTRICTIVE' end || ' FOR ' || case p.polcmd when 'r' then 'SELECT' when 'a' then 'INSERT' when 'w' then 'UPDATE' when 'd' then 'DELETE' else 'ALL' end || ' TO ' || coalesce((select string_agg(r.rolname, ',' order by r.rolname) from pg_roles r where r.oid = any(p.polroles)), 'public') || coalesce(' USING (' || regexp_replace(pg_get_expr(p.polqual, p.polrelid), '\s+', ' ', 'g') || ')', '') || coalesce(' WITH CHECK (' || regexp_replace(pg_get_expr(p.polwithcheck, p.polrelid), '\s+', ' ', 'g') || ')', ''), E'\n' order by p.polname) as txt
  from pg_policy p group by p.polrelid
), trg as (
  select t.tgrelid as oid, string_agg('  ' || replace(pg_get_triggerdef(t.oid), 'public.', ''), E'\n' order by t.tgname) as txt from pg_trigger t where not t.tgisinternal group by t.tgrelid
), colg as (
  select z.oid, string_agg('  COLUMN GRANTS ' || z.acl || ': ' || z.cols, E'\n' order by z.acl) as txt from (
    select y.oid, y.acl, string_agg(y.attname, ',' order by y.attnum) as cols from (
      select a.attrelid as oid, a.attname, a.attnum, (select string_agg(coalesce(r.rolname,'PUBLIC') || '=' || lower(g.privilege_type), ',' order by r.rolname, g.privilege_type) from aclexplode(a.attacl) g left join pg_roles r on r.oid=g.grantee) as acl
      from pg_attribute a where a.attacl is not null and a.attnum>0 and not a.attisdropped
    ) y group by y.oid, y.acl
  ) z group by z.oid
), tg as (
  select tb.oid, (select string_agg(r.rolname || '=' || coalesce(nullif(case when has_table_privilege(r.oid, tb.oid, 'SELECT') then 'r' else '' end || case when has_table_privilege(r.oid, tb.oid, 'INSERT') then 'a' else '' end || case when has_table_privilege(r.oid, tb.oid, 'UPDATE') then 'w' else '' end || case when has_table_privilege(r.oid, tb.oid, 'DELETE') then 'd' else '' end || case when has_table_privilege(r.oid, tb.oid, 'TRUNCATE') then 'D' else '' end || case when has_table_privilege(r.oid, tb.oid, 'REFERENCES') then 'x' else '' end || case when has_table_privilege(r.oid, tb.oid, 'TRIGGER') then 't' else '' end, ''), '-'), ' ' order by r.rolname) from pg_roles r where r.rolname in ('anon','authenticated','service_role')) as txt from tb
), blk as (
  select tb.relname, concat_ws(E'\n', 'TABLE ' || tb.relname || '  rls=' || case when tb.relrowsecurity then 'on' else 'off' end || '  grants: ' || tg.txt, cols.txt, cons.txt, idx.txt, colg.txt, pol.txt, trg.txt) as txt
  from tb join tg on tg.oid=tb.oid left join cols on cols.oid=tb.oid left join cons on cons.oid=tb.oid left join idx on idx.oid=tb.oid left join colg on colg.oid=tb.oid left join pol on pol.oid=tb.oid left join trg on trg.oid=tb.oid
), f as (
  select n.nspname, p.proname, p.oid, p.prosecdef, p.provolatile, p.proconfig, p.proacl, pg_get_function_identity_arguments(p.oid) as args, pg_get_function_result(p.oid) as res, l.lanname, pg_get_userbyid(p.proowner) as owner
  from pg_proc p join pg_namespace n on n.oid=p.pronamespace join pg_language l on l.oid=p.prolang
  where n.nspname in ('public','private') and p.prokind='f' and not exists (select 1 from pg_depend d where d.objid=p.oid and d.deptype='e')
), ftxt as (
  select nspname, proname, args, 'FUNCTION ' || nspname || '.' || proname || '(' || args || ') RETURNS ' || regexp_replace(res, '\s+', ' ', 'g') || ' | ' || lanname || ' | ' || case when prosecdef then 'SECURITY DEFINER' else 'SECURITY INVOKER' end || ' | ' || case provolatile when 'i' then 'IMMUTABLE' when 's' then 'STABLE' else 'VOLATILE' end || coalesce(' | config=' || array_to_string(proconfig, ';'), '') || ' | owner=' || owner || ' | exec=' || concat_ws(',', case when proacl is null or exists (select 1 from aclexplode(proacl) g where g.grantee=0 and g.privilege_type='EXECUTE') then 'PUBLIC' end, case when has_function_privilege('anon', oid, 'EXECUTE') then 'anon' end, case when has_function_privilege('authenticated', oid, 'EXECUTE') then 'authenticated' end, case when has_function_privilege('service_role', oid, 'EXECUTE') then 'service_role' end) || ' | md5=' || md5(pg_get_functiondef(oid)) as line from f
), ext as (
  select string_agg('  ' || e.extname || ' ' || e.extversion || ' (schema ' || n.nspname || ')', E'\n' order by e.extname) as txt from pg_extension e join pg_namespace n on n.oid=e.extnamespace
), sp as (
  select string_agg('  ' || s.nspname || ': ' || (select string_agg(r.rolname || '=' || case when has_schema_privilege(r.oid, s.oid, 'USAGE') then 'U' else '-' end || case when has_schema_privilege(r.oid, s.oid, 'CREATE') then 'C' else '-' end, ' ' order by r.rolname) from pg_roles r where r.rolname in ('anon','authenticated','service_role')), E'\n' order by s.nspname) as txt from pg_namespace s where s.nspname in ('public','private','storage','auth')
), da as (
  select string_agg('  ' || pg_get_userbyid(d.defaclrole) || ' in ' || coalesce(n.nspname::text, '(all schemas)') || ' on ' || d.defaclobjtype::text || ': ' || array_to_string(d.defaclacl, ' '), E'\n' order by pg_get_userbyid(d.defaclrole), n.nspname, d.defaclobjtype::text) as txt from pg_default_acl d left join pg_namespace n on n.oid=d.defaclnamespace
), vw as (
  select string_agg(v.blk, E'\n' order by v.relname) as txt from (
    select c.relname, 'VIEW ' || c.relname || ' | ' || case when exists (select 1 from unnest(c.reloptions) o where o = 'security_invoker=true') then 'security_invoker' else 'owner-privileges' end
      || ' | grants: ' || (select string_agg(r.rolname || '=' || coalesce(nullif(case when has_table_privilege(r.oid, c.oid, 'SELECT') then 'r' else '' end || case when has_table_privilege(r.oid, c.oid, 'INSERT') then 'a' else '' end || case when has_table_privilege(r.oid, c.oid, 'UPDATE') then 'w' else '' end || case when has_table_privilege(r.oid, c.oid, 'DELETE') then 'd' else '' end, ''), '-'), ' ' order by r.rolname) from pg_roles r where r.rolname in ('anon','authenticated','service_role'))
      || E'\n  cols: ' || (select string_agg(a.attname || ' ' || format_type(a.atttypid, a.atttypmod), ', ' order by a.attnum) from pg_attribute a where a.attrelid=c.oid and a.attnum>0 and not a.attisdropped)
      || E'\n  def_md5=' || md5(pg_get_viewdef(c.oid, true)) as blk
    from pg_class c join pg_namespace n on n.oid=c.relnamespace where n.nspname='public' and c.relkind in ('v','m')
  ) v
), cr as (
  select string_agg('  ' || j.jobname || ' | ' || j.schedule || ' | active=' || j.active::text || E'\n    ' || regexp_replace(j.command, '\s+', ' ', 'g'), E'\n' order by j.jobname) as txt from cron.job j
), st as (
  select string_agg('  bucket ' || b.id || ' | public=' || b.public::text || ' | file_size_limit=' || coalesce(b.file_size_limit::text, 'null') || ' | allowed_mime_types=' || coalesce(array_to_string(b.allowed_mime_types, ','), 'null'), E'\n' order by b.id) as txt from storage.buckets b
), op as (
  select string_agg('  POLICY ' || p.schemaname || '.' || p.tablename || ' ' || p.policyname || ' ' || p.permissive || ' FOR ' || p.cmd || ' TO ' || array_to_string(p.roles, ',') || coalesce(' USING (' || regexp_replace(p.qual, '\s+', ' ', 'g') || ')', '') || coalesce(' WITH CHECK (' || regexp_replace(p.with_check, '\s+', ' ', 'g') || ')', ''), E'\n' order by p.schemaname, p.tablename, p.policyname) as txt from pg_policies p where p.schemaname <> 'public'
), ot as (
  select string_agg('  ' || n.nspname || '.' || c.relname || ': ' || regexp_replace(pg_get_triggerdef(t.oid), '\s+', ' ', 'g'), E'\n' order by n.nspname, c.relname, t.tgname) as txt from pg_trigger t join pg_class c on c.oid=t.tgrelid join pg_namespace n on n.oid=c.relnamespace where not t.tgisinternal and n.nspname = 'auth'
), pub as (
  select string_agg('  ' || p.pubname || ': ' || p.schemaname || '.' || p.tablename, E'\n' order by p.pubname, p.schemaname, p.tablename) as txt from pg_publication_tables p where p.schemaname = 'public'
), misc as (
  select concat_ws(E'\n\n', 'EXTENSIONS' || E'\n' || coalesce(ext.txt, '  (none)'), 'SCHEMA PRIVILEGES (U=usage C=create)' || E'\n' || coalesce(sp.txt, '  (none)'), 'DEFAULT PRIVILEGES' || E'\n' || coalesce(da.txt, '  (none)'), 'VIEWS' || E'\n' || coalesce(vw.txt, '  (none)'), 'PG_CRON JOBS' || E'\n' || coalesce(cr.txt, '  (none)'), 'STORAGE BUCKETS' || E'\n' || coalesce(st.txt, '  (none)'), 'POLICIES OUTSIDE public' || E'\n' || coalesce(op.txt, '  (none)'), 'TRIGGERS ON auth TABLES' || E'\n' || coalesce(ot.txt, '  (none)'), 'REALTIME PUBLICATION TABLES (public)' || E'\n' || coalesce(pub.txt, '  (none)')) as txt from ext, sp, da, vw, cr, st, op, ot, pub
)

, parts as (
  select 'tables-1' as file, string_agg(txt, E'\n\n' order by relname) as txt from blk where relname < 'favorites'
  union all select 'tables-2', string_agg(txt, E'\n\n' order by relname) from blk where relname >= 'favorites' and relname < 'order_reconciliation_checks'
  union all select 'tables-3', string_agg(txt, E'\n\n' order by relname) from blk where relname >= 'order_reconciliation_checks' and relname < 'store_order_item_adjustments'
  union all select 'tables-4', string_agg(txt, E'\n\n' order by relname) from blk where relname >= 'store_order_item_adjustments'
  union all select 'functions', string_agg(line, E'\n' order by nspname, proname, args) from ftxt
  union all select 'misc', txt from misc
)
select file, md5(txt) as md5, length(txt) as chars, txt from parts
union all select 'ledger', null, null, count(*)::text || ' latest ' || max(version) from supabase_migrations.schema_migrations
order by file;
