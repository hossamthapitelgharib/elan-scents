-- Back to the first version (judged by "used by the saved page", 3 days). Nothing is deleted from the catalog or from editor_sections by this.
drop function if exists public.editor_keep_created(text);
drop function if exists public.editor_cleanup_unsaved(text[], interval, text);
alter table public.editor_created_records drop column if exists session_id;

create function public.editor_cleanup_unsaved(p_keep_refs text[], p_grace interval default interval '3 days')
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
  if p_keep_refs is null then raise exception 'keep list required'; end if;
  if p_grace is null or p_grace < interval '1 day' then raise exception 'grace period too short'; end if;
  v_cut := now() - p_grace;
  delete from public.editor_created_records t using public.editor_sections s where t.kind = 'section' and t.record_id = s.id and s.element_id = any (p_keep_refs);
  with gone as (delete from public.editor_sections s using public.editor_created_records t where t.kind = 'section' and t.record_id = s.id and t.created_at < v_cut and not (s.element_id = any (p_keep_refs)) returning s.id)
  delete from public.editor_created_records r using gone g where r.kind = 'section' and r.record_id = g.id;
  get diagnostics v_sections = row_count;
  with gone as (delete from public.brands b using public.editor_created_records t where t.kind = 'brand' and t.record_id = b.id and t.created_at < v_cut and not exists (select 1 from public.products p where p.brand_id = b.id) and not exists (select 1 from public.editor_sections s where lower(btrim(s.filters ->> 'brand')) = lower(btrim(b.name))) returning b.id)
  delete from public.editor_created_records r using gone g where r.kind = 'brand' and r.record_id = g.id;
  get diagnostics v_brands = row_count;
  with gone as (delete from public.occasions o using public.editor_created_records t where t.kind = 'occasion' and t.record_id = o.id and t.created_at < v_cut and not exists (select 1 from public.product_occasions po where po.occasion_id = o.id) and not exists (select 1 from public.editor_sections s where lower(btrim(s.filters ->> 'occ')) in (lower(btrim(o.name)), lower(btrim(coalesce(o.key, ''))))) returning o.id)
  delete from public.editor_created_records r using gone g where r.kind = 'occasion' and r.record_id = g.id;
  get diagnostics v_occasions = row_count;
  with gone as (delete from public.aromatic_notes n using public.editor_created_records t where t.kind = 'note' and t.record_id = n.id and t.created_at < v_cut and not exists (select 1 from public.product_notes pn where pn.note_id = n.id) and not exists (select 1 from public.editor_sections s where lower(btrim(s.filters ->> 'note')) in (lower(btrim(n.name)), lower(btrim(coalesce(n.key, ''))))) returning n.id)
  delete from public.editor_created_records r using gone g where r.kind = 'note' and r.record_id = g.id;
  get diagnostics v_notes = row_count;
  delete from public.editor_created_records t where t.kind = 'section' and not exists (select 1 from public.editor_sections s where s.id = t.record_id);
  delete from public.editor_created_records t where t.kind = 'brand' and (not exists (select 1 from public.brands b where b.id = t.record_id) or exists (select 1 from public.products p where p.brand_id = t.record_id));
  delete from public.editor_created_records t where t.kind = 'occasion' and (not exists (select 1 from public.occasions o where o.id = t.record_id) or exists (select 1 from public.product_occasions po where po.occasion_id = t.record_id));
  delete from public.editor_created_records t where t.kind = 'note' and (not exists (select 1 from public.aromatic_notes n where n.id = t.record_id) or exists (select 1 from public.product_notes pn where pn.note_id = t.record_id));
  return jsonb_build_object('sections', v_sections, 'brands', v_brands, 'occasions', v_occasions, 'notes', v_notes);
end;
$function$;
revoke all on function public.editor_cleanup_unsaved(text[], interval) from public, anon, authenticated;
grant execute on function public.editor_cleanup_unsaved(text[], interval) to service_role;
