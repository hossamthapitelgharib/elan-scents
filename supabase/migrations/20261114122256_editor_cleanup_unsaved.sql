-- Sections and catalog records that the editor creates the moment the owner makes them (before the page is saved) used to stay in the database
-- for ever when the page was never saved (owner, 13 Nov 2026: "any section or brand created but not saved must be removed from the database").
--
-- editor_created_records remembers what the EDITOR created (a section, or a brand / occasion / note that did not exist before); the server records
-- it right after creating it. editor_cleanup_unsaved(keep_refs) is run by the server after every successful save with the list of section ids the
-- saved page uses. It removes ONLY remembered records that are older than the grace period and not used by the saved page:
--   * a section whose id is not on the saved page (its items go with it),
--   * a brand / occasion / note that no product uses and no remaining section filters by.
-- Anything the editor did not create is never touched (the sections and brands that already exist today are not remembered, so they stay).
-- A section that IS on a saved page stops being remembered: later removing it from the page does not delete it. Stores are not handled here:
-- a store has many dependants (products, offers, integrations) that cascade, so it is never removed automatically.
create table public.editor_created_records (
  kind       text not null check (kind in ('section', 'brand', 'occasion', 'note')),
  record_id  uuid not null,
  created_at timestamptz not null default now(),
  primary key (kind, record_id)
);

comment on table public.editor_created_records is 'What the editor created (section, brand, occasion, note) and that the saved page may not use yet; read and cleared by editor_cleanup_unsaved. Server only.';

alter table public.editor_created_records enable row level security;
revoke all on public.editor_created_records from public, anon, authenticated;
grant all on public.editor_created_records to service_role;

create or replace function public.editor_cleanup_unsaved(p_keep_refs text[], p_grace interval default interval '3 days')
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
  -- Never run without knowing what the saved page uses, and never on a record that may still be open in another editor tab.
  if p_keep_refs is null then raise exception 'keep list required'; end if;
  if p_grace is null or p_grace < interval '1 day' then raise exception 'grace period too short'; end if;
  v_cut := now() - p_grace;

  -- A section the saved page uses is saved: stop remembering it.
  delete from public.editor_created_records t
   using public.editor_sections s
   where t.kind = 'section' and t.record_id = s.id and s.element_id = any (p_keep_refs);

  -- Sections the page never used (their items go with them).
  with gone as (
    delete from public.editor_sections s
     using public.editor_created_records t
     where t.kind = 'section' and t.record_id = s.id and t.created_at < v_cut
       and not (s.element_id = any (p_keep_refs))
    returning s.id
  )
  delete from public.editor_created_records r using gone g where r.kind = 'section' and r.record_id = g.id;
  get diagnostics v_sections = row_count;

  -- Brands nobody uses: no product, and no section left that filters by the brand.
  with gone as (
    delete from public.brands b
     using public.editor_created_records t
     where t.kind = 'brand' and t.record_id = b.id and t.created_at < v_cut
       and not exists (select 1 from public.products p where p.brand_id = b.id)
       and not exists (select 1 from public.editor_sections s where lower(btrim(s.filters ->> 'brand')) = lower(btrim(b.name)))
    returning b.id
  )
  delete from public.editor_created_records r using gone g where r.kind = 'brand' and r.record_id = g.id;
  get diagnostics v_brands = row_count;

  with gone as (
    delete from public.occasions o
     using public.editor_created_records t
     where t.kind = 'occasion' and t.record_id = o.id and t.created_at < v_cut
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
     where t.kind = 'note' and t.record_id = n.id and t.created_at < v_cut
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

revoke all on function public.editor_cleanup_unsaved(text[], interval) from public, anon, authenticated;
grant execute on function public.editor_cleanup_unsaved(text[], interval) to service_role;
