-- Owner, 14 Nov 2026: a saved section or brand is NEVER removed, used or not. Only what was created in an editor session that ended WITHOUT a save goes
-- (the owner pressed «خروج», or closed the browser or the tab). The first version judged "used by the saved page"; this one judges "saved or not":
--   * every record the editor creates is remembered with the id of the editor session (one open editor tab) that created it;
--   * a successful save makes everything that session created permanent: editor_keep_created(session) forgets it, so nothing ever removes it;
--   * leaving the editor without saving removes what that session created (and nothing saved uses): editor_cleanup_unsaved(keep_refs, session => ...);
--   * a session that never got to say goodbye (battery, crash) is swept after 3 days: the same function without a session, with a grace period.
-- Nothing the editor did not create is touched; stores are never removed (their dependants cascade).
alter table public.editor_created_records add column session_id text;
comment on column public.editor_created_records.session_id is 'The editor session (one open editor tab) that created the record. Null: only the abandoned-session sweep can remove it.';

drop function public.editor_cleanup_unsaved(text[], interval);

create function public.editor_cleanup_unsaved(p_keep_refs text[], p_grace interval default interval '3 days', p_session text default null)
returns jsonb
language plpgsql
security definer
set search_path to 'pg_catalog', 'public', 'pg_temp'
as $function$
declare
  v_cut timestamptz;
  v_sections integer := 0;
  v_brands integer := 0;
  v_occasions integer := 0;
  v_notes integer := 0;
begin
  -- Never run without knowing what the saved page uses.
  if p_keep_refs is null then raise exception 'keep list required'; end if;
  if p_session is not null then
    -- Leaving without a save: that one session, no waiting.
    if length(p_session) < 16 then raise exception 'session required'; end if;
    v_cut := now();
  else
    -- A session that never ended properly: only records older than the grace period, whichever session made them.
    if p_grace is null or p_grace < interval '1 day' then raise exception 'grace period too short'; end if;
    v_cut := now() - p_grace;
  end if;

  -- A section the saved page uses is saved: stop remembering it.
  delete from public.editor_created_records t
   using public.editor_sections s
   where t.kind = 'section' and t.record_id = s.id and s.element_id = any (p_keep_refs);

  with gone as (
    delete from public.editor_sections s
     using public.editor_created_records t
     where t.kind = 'section' and t.record_id = s.id and t.created_at <= v_cut
       and (p_session is null or t.session_id = p_session)
       and not (s.element_id = any (p_keep_refs))
    returning s.id
  )
  delete from public.editor_created_records r using gone g where r.kind = 'section' and r.record_id = g.id;
  get diagnostics v_sections = row_count;

  with gone as (
    delete from public.brands b
     using public.editor_created_records t
     where t.kind = 'brand' and t.record_id = b.id and t.created_at <= v_cut
       and (p_session is null or t.session_id = p_session)
       and not exists (select 1 from public.products p where p.brand_id = b.id)
       and not exists (select 1 from public.editor_sections s where lower(btrim(s.filters ->> 'brand')) = lower(btrim(b.name)))
    returning b.id
  )
  delete from public.editor_created_records r using gone g where r.kind = 'brand' and r.record_id = g.id;
  get diagnostics v_brands = row_count;

  with gone as (
    delete from public.occasions o
     using public.editor_created_records t
     where t.kind = 'occasion' and t.record_id = o.id and t.created_at <= v_cut
       and (p_session is null or t.session_id = p_session)
       and not exists (select 1 from public.product_occasions po where po.occasion_id = o.id)
       and not exists (select 1 from public.editor_sections s
                        where lower(btrim(s.filters ->> 'occ')) in (lower(btrim(o.name)), lower(btrim(coalesce(o.key, '')))))
    returning o.id
  )
  delete from public.editor_created_records r using gone g where r.kind = 'occasion' and r.record_id = g.id;
  get diagnostics v_occasions = row_count;

  with gone as (
    delete from public.aromatic_notes n
     using public.editor_created_records t
     where t.kind = 'note' and t.record_id = n.id and t.created_at <= v_cut
       and (p_session is null or t.session_id = p_session)
       and not exists (select 1 from public.product_notes pn where pn.note_id = n.id)
       and not exists (select 1 from public.editor_sections s
                        where lower(btrim(s.filters ->> 'note')) in (lower(btrim(n.name)), lower(btrim(coalesce(n.key, '')))))
    returning n.id
  )
  delete from public.editor_created_records r using gone g where r.kind = 'note' and r.record_id = g.id;
  get diagnostics v_notes = row_count;

  -- A remembered record that no longer exists (removed by hand) or that a product now uses is simply forgotten.
  delete from public.editor_created_records t where t.kind = 'section' and not exists (select 1 from public.editor_sections s where s.id = t.record_id);
  delete from public.editor_created_records t where t.kind = 'brand' and (not exists (select 1 from public.brands b where b.id = t.record_id) or exists (select 1 from public.products p where p.brand_id = t.record_id));
  delete from public.editor_created_records t where t.kind = 'occasion' and (not exists (select 1 from public.occasions o where o.id = t.record_id) or exists (select 1 from public.product_occasions po where po.occasion_id = t.record_id));
  delete from public.editor_created_records t where t.kind = 'note' and (not exists (select 1 from public.aromatic_notes n where n.id = t.record_id) or exists (select 1 from public.product_notes pn where pn.note_id = t.record_id));

  return jsonb_build_object('sections', v_sections, 'brands', v_brands, 'occasions', v_occasions, 'notes', v_notes);
end;
$function$;

revoke all on function public.editor_cleanup_unsaved(text[], interval, text) from public, anon, authenticated;
grant execute on function public.editor_cleanup_unsaved(text[], interval, text) to service_role;

-- A save went through: everything that session created is now permanent, used by the page or not.
create function public.editor_keep_created(p_session text)
returns integer
language plpgsql
security definer
set search_path to 'pg_catalog', 'public', 'pg_temp'
as $function$
declare v_kept integer;
begin
  if p_session is null or length(p_session) < 16 then raise exception 'session required'; end if;
  delete from public.editor_created_records where session_id = p_session;
  get diagnostics v_kept = row_count;
  return v_kept;
end;
$function$;

revoke all on function public.editor_keep_created(text) from public, anon, authenticated;
grant execute on function public.editor_keep_created(text) to service_role;
