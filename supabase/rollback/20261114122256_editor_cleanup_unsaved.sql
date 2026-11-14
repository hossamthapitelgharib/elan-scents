-- Takes the cleanup away. The table only remembers what the editor created; dropping it deletes no catalog row or section.
drop function if exists public.editor_cleanup_unsaved(text[], interval);
drop table if exists public.editor_created_records;
