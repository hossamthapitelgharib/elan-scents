-- Real-database test for the editor's cleanup of unsaved creations (supabase/migrations/*_editor_cleanup_by_session.sql).
-- Owner, 14 Nov 2026: what is SAVED is never removed, used or not; only what an editor session created and never saved is removed
-- (when the owner leaves without saving). Run AFTER the migration, as the project owner, inside one transaction; everything is rolled back.
-- Only synthetic rows named «zz-test …» are created; real catalog rows are only read (and remembered inside this transaction to prove they survive).
begin;

do $$
declare
  S1 constant text := 'zz-test-session-0001';
  S2 constant text := 'zz-test-session-0002';
  S3 constant text := 'zz-test-session-0003';
  v_size uuid;
  v_real_brand uuid; v_real_occ uuid; v_real_note uuid; v_plain_brand uuid;
  s_unsaved uuid; s_onpage uuid; s_other uuid; s_mine uuid; s_untracked uuid; s_crash uuid; s_nosession uuid; s_nosession_new uuid;
  b_gone uuid; b_used uuid; b_other uuid; b_crash uuid;
  o_gone uuid; n_gone uuid;
  v_res jsonb; v_n integer; v_denied boolean;
begin
  select id into v_size from public.product_sizes order by id limit 1;
  select b.id into v_real_brand from public.brands b where exists (select 1 from public.products p where p.brand_id = b.id) order by b.id limit 1;
  select o.id into v_real_occ from public.occasions o where exists (select 1 from public.product_occasions po where po.occasion_id = o.id) order by o.id limit 1;
  select n.id into v_real_note from public.aromatic_notes n where exists (select 1 from public.product_notes pn where pn.note_id = n.id) order by n.id limit 1;
  assert v_size is not null and v_real_brand is not null and v_real_occ is not null and v_real_note is not null, 'the catalog has a size, a used brand, a used occasion and a used note';

  insert into public.editor_sections (element_id, name, purpose, selection_mode, filters) values ('x-zz-unsaved', 'zz-test unsaved', 'test', 'manual', '{}'::jsonb) returning id into s_unsaved;
  insert into public.editor_sections (element_id, name, purpose, selection_mode, filters) values ('x-zz-onpage', 'zz-test on the saved page', 'test', 'manual', '{}'::jsonb) returning id into s_onpage;
  insert into public.editor_sections (element_id, name, purpose, selection_mode, filters) values ('x-zz-other', 'zz-test other tab', 'test', 'manual', '{}'::jsonb) returning id into s_other;
  insert into public.editor_sections (element_id, name, purpose, selection_mode, filters) values ('x-zz-mine', 'zz-test mine', 'test', 'auto', jsonb_build_object('brand', 'zz-test brand used')) returning id into s_mine;
  insert into public.editor_sections (element_id, name, purpose, selection_mode, filters) values ('x-zz-untracked', 'zz-test untracked', 'test', 'manual', '{}'::jsonb) returning id into s_untracked;
  insert into public.editor_sections (element_id, name, purpose, selection_mode, filters) values ('x-zz-crash', 'zz-test crashed tab', 'test', 'manual', '{}'::jsonb) returning id into s_crash;
  insert into public.editor_sections (element_id, name, purpose, selection_mode, filters) values ('x-zz-nosession-old', 'zz-test no session old', 'test', 'manual', '{}'::jsonb) returning id into s_nosession;
  insert into public.editor_sections (element_id, name, purpose, selection_mode, filters) values ('x-zz-nosession-new', 'zz-test no session new', 'test', 'manual', '{}'::jsonb) returning id into s_nosession_new;
  insert into public.editor_section_items (section_id, product_size_id, sort_order) values (s_unsaved, v_size, 0);

  insert into public.brands (name, slug) values ('zz-test brand gone', 'zz-test-brand-gone') returning id into b_gone;
  insert into public.brands (name, slug) values ('zz-test brand used', 'zz-test-brand-used') returning id into b_used;
  insert into public.brands (name, slug) values ('zz-test brand other', 'zz-test-brand-other') returning id into b_other;
  insert into public.brands (name, slug) values ('zz-test brand crash', 'zz-test-brand-crash') returning id into b_crash;
  insert into public.brands (name, slug) values ('zz-test brand plain', 'zz-test-brand-plain') returning id into v_plain_brand;
  insert into public.occasions (name, key) values ('zz-test occ gone', 'zz-test-occ-gone') returning id into o_gone;
  insert into public.aromatic_notes (name, key) values ('zz-test note gone', 'zz-test-note-gone') returning id into n_gone;

  -- what the editor "created": session 1 (the one that leaves without saving), session 2 (another tab that will save), session 3 (a tab that crashed 4 days ago),
  -- and records from before sessions were tracked (no session); the real rows are remembered too, to prove a used one is never removed
  insert into public.editor_created_records (kind, record_id, session_id, created_at) values
    ('section', s_unsaved, S1, now() - interval '5 minutes'), ('section', s_onpage, S1, now() - interval '5 minutes'), ('section', s_mine, S2, now() - interval '5 minutes'),
    ('brand', b_gone, S1, now() - interval '5 minutes'), ('brand', b_used, S1, now() - interval '5 minutes'), ('brand', v_real_brand, S1, now() - interval '5 minutes'),
    ('occasion', o_gone, S1, now() - interval '5 minutes'), ('occasion', v_real_occ, S1, now() - interval '5 minutes'),
    ('note', n_gone, S1, now() - interval '5 minutes'), ('note', v_real_note, S1, now() - interval '5 minutes'),
    ('section', s_other, S2, now() - interval '5 minutes'), ('brand', b_other, S2, now() - interval '5 minutes'),
    ('section', s_crash, S3, now() - interval '4 days'), ('brand', b_crash, S3, now() - interval '4 days'),
    ('section', s_nosession, null, now() - interval '4 days'), ('section', s_nosession_new, null, now() - interval '1 hour');

  -- Safety rails: no list of what the page uses, a session id that is too short, or a sweep with a grace shorter than a day never run.
  v_denied := false; begin perform public.editor_cleanup_unsaved(null, p_session => S1); exception when others then v_denied := true; end;
  assert v_denied, 'a missing keep list is refused';
  v_denied := false; begin perform public.editor_cleanup_unsaved(array['x-zz-onpage'], p_session => 'short'); exception when others then v_denied := true; end;
  assert v_denied, 'a session id that is too short is refused';
  v_denied := false; begin perform public.editor_cleanup_unsaved(array['x-zz-onpage'], interval '1 hour'); exception when others then v_denied := true; end;
  assert v_denied, 'a sweep with a grace shorter than a day is refused';
  v_denied := false; begin perform public.editor_keep_created(null); exception when others then v_denied := true; end;
  assert v_denied, 'keeping with no session is refused';
  v_denied := false; begin perform public.editor_keep_created('short'); exception when others then v_denied := true; end;
  assert v_denied, 'keeping with a short session id is refused';
  assert exists (select 1 from public.editor_sections where id = s_unsaved), 'the refused calls removed nothing';

  -- 1. Session 1 leaves WITHOUT saving: what it created goes at once (no waiting), except what the saved page uses.
  v_res := public.editor_cleanup_unsaved(array['x-zz-onpage'], p_session => S1);
  assert (v_res ->> 'sections')::int = 1, 'exactly the one unsaved section went: ' || v_res::text;
  assert not exists (select 1 from public.editor_sections where id = s_unsaved), 'the section that was never saved is gone';
  assert not exists (select 1 from public.editor_section_items where section_id = s_unsaved), 'its items went with it';
  assert exists (select 1 from public.editor_sections where id = s_onpage), 'a section the saved page uses is kept even if its save was not reported';
  assert not exists (select 1 from public.editor_created_records where kind = 'section' and record_id = s_onpage), 'and it is no longer remembered';
  assert not exists (select 1 from public.brands where id = b_gone), 'a brand created and never saved, that nobody uses, is gone';
  assert exists (select 1 from public.brands where id = b_used), 'a brand a remaining section filters by is kept';
  assert exists (select 1 from public.brands where id = v_real_brand), 'a brand with products is never removed';
  assert not exists (select 1 from public.editor_created_records where kind = 'brand' and record_id = v_real_brand), 'a brand that products use is forgotten, not deleted';
  assert not exists (select 1 from public.occasions where id = o_gone), 'an unsaved occasion nobody uses is gone';
  assert exists (select 1 from public.occasions where id = v_real_occ), 'an occasion with products is never removed';
  assert not exists (select 1 from public.aromatic_notes where id = n_gone), 'an unsaved note nobody uses is gone';
  assert exists (select 1 from public.aromatic_notes where id = v_real_note), 'a note with products is never removed';
  assert (v_res ->> 'brands')::int = 1 and (v_res ->> 'occasions')::int = 1 and (v_res ->> 'notes')::int = 1, 'one brand, one occasion and one note went: ' || v_res::text;
  -- ...and nothing of any other session, of the abandoned ones, or that the editor did not create:
  assert exists (select 1 from public.editor_sections where id = s_other), 'another open tab keeps what it created';
  assert exists (select 1 from public.brands where id = b_other), 'and its brand';
  assert (select count(*) from public.editor_sections where id in (s_crash, s_nosession, s_nosession_new, s_mine, s_untracked)) = 5, 'other sessions, old ones and untracked sections are not touched by a session leaving';
  assert (select count(*) from public.brands where id in (b_crash, v_plain_brand)) = 2, 'neither are their brands';
  v_res := public.editor_cleanup_unsaved(array['x-zz-onpage'], p_session => S1);
  assert v_res = jsonb_build_object('sections', 0, 'brands', 0, 'occasions', 0, 'notes', 0), 'a second run finds nothing more: ' || v_res::text;

  -- 2. Session 2 SAVES: everything it created becomes permanent, used by the page or not.
  assert public.editor_keep_created(S2) = 3, 'the save made the three records of session 2 permanent';
  assert public.editor_keep_created(S2) = 0, 'a second keep finds nothing';
  v_res := public.editor_cleanup_unsaved(array['x-zz-nothing-uses-these'], p_session => S2);
  assert v_res = jsonb_build_object('sections', 0, 'brands', 0, 'occasions', 0, 'notes', 0), 'leaving after a save removes nothing: ' || v_res::text;
  assert (select count(*) from public.editor_sections where id in (s_other, s_mine)) = 2 and exists (select 1 from public.brands where id = b_other), 'saved sections and brands stay even though no page uses them';
  v_res := public.editor_cleanup_unsaved(array['x-zz-nothing-uses-these']);
  assert (select count(*) from public.editor_sections where id in (s_other, s_mine)) = 2 and exists (select 1 from public.brands where id = b_other), 'and the sweep never takes them either';

  -- 3. Nobody said goodbye (a crash): only the sweep, only after 3 days, finds them.
  assert exists (select 1 from public.editor_sections where id = s_crash) is false and exists (select 1 from public.brands where id = b_crash) is false, 'the 4-day-old records of the crashed session went with the sweep';
  assert (v_res ->> 'sections')::int >= 2 and (v_res ->> 'brands')::int >= 1, 'the crashed tab (section + brand) and the old untracked-session section went: ' || v_res::text;
  assert not exists (select 1 from public.editor_sections where id = s_nosession), 'a record from before sessions were tracked is swept once it is old';
  assert exists (select 1 from public.editor_sections where id = s_nosession_new), 'a recent one is kept (it may be open in a tab)';
  assert exists (select 1 from public.editor_sections where id = s_untracked), 'a section the editor did not create is never touched';
  assert exists (select 1 from public.brands where id = v_plain_brand), 'a brand the editor did not create is never touched';

  -- Clients can neither read the table nor run the cleanup or the keep.
  set local role anon;
  v_denied := false; begin perform 1 from public.editor_created_records; exception when insufficient_privilege then v_denied := true; end;
  assert v_denied, 'anon cannot read editor_created_records';
  v_denied := false; begin perform public.editor_cleanup_unsaved(array['x'], p_session => S1); exception when insufficient_privilege then v_denied := true; end;
  assert v_denied, 'anon cannot run the cleanup';
  v_denied := false; begin perform public.editor_keep_created(S1); exception when insufficient_privilege then v_denied := true; end;
  assert v_denied, 'anon cannot make anything permanent';
  reset role;
  set local role authenticated;
  v_denied := false; begin perform 1 from public.editor_created_records; exception when insufficient_privilege then v_denied := true; end;
  assert v_denied, 'a signed-in user cannot read editor_created_records';
  v_denied := false; begin perform public.editor_cleanup_unsaved(array['x'], p_session => S1); exception when insufficient_privilege then v_denied := true; end;
  assert v_denied, 'a signed-in user cannot run the cleanup';
  v_denied := false; begin perform public.editor_keep_created(S1); exception when insufficient_privilege then v_denied := true; end;
  assert v_denied, 'a signed-in user cannot make anything permanent';
  reset role;
end $$;
rollback;
