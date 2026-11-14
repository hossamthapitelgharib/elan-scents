-- Real-database test for editor_cleanup_unsaved (supabase/migrations/*_editor_cleanup_unsaved.sql): what the editor created but the saved page never used
-- is removed after the grace period; everything else stays. Run AFTER the migration, as the project owner, inside one transaction; everything is rolled back.
-- Only synthetic rows named «zz-test …» are created; real catalog rows are only read (and remembered inside this transaction to prove they survive).
begin;

do $$
declare
  v_size uuid;
  v_real_brand uuid; v_real_occ uuid; v_real_note uuid; v_plain_brand uuid;
  s_old uuid; s_new uuid; s_kept uuid; s_untracked uuid; s_mine uuid;
  b_gone uuid; b_used uuid; b_recent uuid;
  o_gone uuid; n_gone uuid;
  v_res jsonb; v_n integer; v_denied boolean;
begin
  select id into v_size from public.product_sizes order by id limit 1;
  select b.id into v_real_brand from public.brands b where exists (select 1 from public.products p where p.brand_id = b.id) order by b.id limit 1;
  select o.id into v_real_occ from public.occasions o where exists (select 1 from public.product_occasions po where po.occasion_id = o.id) order by o.id limit 1;
  select n.id into v_real_note from public.aromatic_notes n where exists (select 1 from public.product_notes pn where pn.note_id = n.id) order by n.id limit 1;
  assert v_size is not null and v_real_brand is not null and v_real_occ is not null and v_real_note is not null, 'the catalog has a size, a used brand, a used occasion and a used note';

  insert into public.editor_sections (element_id, name, purpose, selection_mode, filters) values ('x-zz-old', 'zz-test old', 'test', 'manual', '{}'::jsonb) returning id into s_old;
  insert into public.editor_sections (element_id, name, purpose, selection_mode, filters) values ('x-zz-new', 'zz-test new', 'test', 'manual', '{}'::jsonb) returning id into s_new;
  insert into public.editor_sections (element_id, name, purpose, selection_mode, filters) values ('x-zz-kept', 'zz-test kept', 'test', 'manual', '{}'::jsonb) returning id into s_kept;
  insert into public.editor_sections (element_id, name, purpose, selection_mode, filters) values ('x-zz-untracked', 'zz-test untracked', 'test', 'manual', '{}'::jsonb) returning id into s_untracked;
  insert into public.editor_sections (element_id, name, purpose, selection_mode, filters) values ('x-zz-mine', 'zz-test mine', 'test', 'auto', jsonb_build_object('brand', 'zz-test brand used')) returning id into s_mine;
  insert into public.editor_section_items (section_id, product_size_id, sort_order) values (s_old, v_size, 0);

  insert into public.brands (name, slug) values ('zz-test brand gone', 'zz-test-brand-gone') returning id into b_gone;
  insert into public.brands (name, slug) values ('zz-test brand used', 'zz-test-brand-used') returning id into b_used;
  insert into public.brands (name, slug) values ('zz-test brand recent', 'zz-test-brand-recent') returning id into b_recent;
  insert into public.brands (name, slug) values ('zz-test brand plain', 'zz-test-brand-plain') returning id into v_plain_brand;
  insert into public.occasions (name, key) values ('zz-test occ gone', 'zz-test-occ-gone') returning id into o_gone;
  insert into public.aromatic_notes (name, key) values ('zz-test note gone', 'zz-test-note-gone') returning id into n_gone;

  -- what the editor "created" (four days ago, except the recent ones); the real rows are remembered too, to prove a used one is never removed
  insert into public.editor_created_records (kind, record_id, created_at) values
    ('section', s_old, now() - interval '4 days'), ('section', s_new, now() - interval '1 day'), ('section', s_kept, now() - interval '4 days'), ('section', s_mine, now() - interval '4 days'),
    ('brand', b_gone, now() - interval '4 days'), ('brand', b_used, now() - interval '4 days'), ('brand', b_recent, now() - interval '1 hour'), ('brand', v_real_brand, now() - interval '4 days'),
    ('occasion', o_gone, now() - interval '4 days'), ('occasion', v_real_occ, now() - interval '4 days'),
    ('note', n_gone, now() - interval '4 days'), ('note', v_real_note, now() - interval '4 days');

  -- Safety rails: no list of what the page uses, or a grace shorter than a day, never runs.
  v_denied := false; begin perform public.editor_cleanup_unsaved(null); exception when others then v_denied := true; end;
  assert v_denied, 'a missing keep list is refused';
  v_denied := false; begin perform public.editor_cleanup_unsaved(array['x-zz-kept'], interval '1 hour'); exception when others then v_denied := true; end;
  assert v_denied, 'a grace shorter than a day is refused';
  assert exists (select 1 from public.editor_sections where id = s_old), 'the refused calls removed nothing';

  v_res := public.editor_cleanup_unsaved(array['x-zz-kept', 'x-zz-mine']);
  assert (v_res ->> 'sections')::int = 1, 'exactly the old unused section went: ' || v_res::text;
  assert not exists (select 1 from public.editor_sections where id = s_old), 'the old section the page never used is gone';
  assert not exists (select 1 from public.editor_section_items where section_id = s_old), 'its items went with it';
  assert exists (select 1 from public.editor_sections where id = s_new), 'a recent section is kept (it may be open in another tab)';
  assert exists (select 1 from public.editor_sections where id = s_kept), 'a section the saved page uses is kept';
  assert exists (select 1 from public.editor_sections where id = s_untracked), 'a section the editor did not create is never touched';
  assert not exists (select 1 from public.editor_created_records where kind = 'section' and record_id = s_kept), 'a section on a saved page is no longer remembered';
  assert exists (select 1 from public.editor_created_records where kind = 'section' and record_id = s_new), 'a recent section is still remembered';

  assert not exists (select 1 from public.brands where id = b_gone), 'an old brand nobody uses is gone';
  assert exists (select 1 from public.brands where id = b_used), 'a brand a remaining section filters by is kept';
  assert exists (select 1 from public.brands where id = b_recent), 'a recent brand is kept';
  assert exists (select 1 from public.brands where id = v_real_brand), 'a brand with products is never removed';
  assert exists (select 1 from public.brands where id = v_plain_brand), 'a brand the editor did not create is never touched';
  assert not exists (select 1 from public.editor_created_records where kind = 'brand' and record_id = v_real_brand), 'a brand that products use is forgotten, not deleted';
  assert not exists (select 1 from public.occasions where id = o_gone), 'an unused occasion the editor created is gone';
  assert exists (select 1 from public.occasions where id = v_real_occ), 'an occasion with products is never removed';
  assert not exists (select 1 from public.aromatic_notes where id = n_gone), 'an unused note the editor created is gone';
  assert exists (select 1 from public.aromatic_notes where id = v_real_note), 'a note with products is never removed';
  assert (v_res ->> 'brands')::int = 1 and (v_res ->> 'occasions')::int = 1 and (v_res ->> 'notes')::int = 1, 'one brand, one occasion and one note went: ' || v_res::text;

  -- Running it again changes nothing.
  v_res := public.editor_cleanup_unsaved(array['x-zz-kept', 'x-zz-mine']);
  assert v_res = jsonb_build_object('sections', 0, 'brands', 0, 'occasions', 0, 'notes', 0), 'a second run finds nothing more: ' || v_res::text;

  -- Clients can neither read the table nor run the cleanup.
  set local role anon;
  v_denied := false; begin perform 1 from public.editor_created_records; exception when insufficient_privilege then v_denied := true; end;
  assert v_denied, 'anon cannot read editor_created_records';
  v_denied := false; begin perform public.editor_cleanup_unsaved(array['x']); exception when insufficient_privilege then v_denied := true; end;
  assert v_denied, 'anon cannot run the cleanup';
  reset role;
  set local role authenticated;
  v_denied := false; begin perform 1 from public.editor_created_records; exception when insufficient_privilege then v_denied := true; end;
  assert v_denied, 'a signed-in user cannot read editor_created_records';
  v_denied := false; begin perform public.editor_cleanup_unsaved(array['x']); exception when insufficient_privilege then v_denied := true; end;
  assert v_denied, 'a signed-in user cannot run the cleanup';
  reset role;
end $$;
rollback;
