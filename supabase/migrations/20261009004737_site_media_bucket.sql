-- Bucket for editor media. Public READ by URL (the customer site must display these files);
-- WRITE/LIST/DELETE restricted to platform admins. File paths will be random uuids (unguessable).
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values (
  'site-media', 'site-media', true, 52428800,
  array['image/jpeg','image/png','image/webp','image/gif','image/avif','video/mp4','video/webm']
)
on conflict (id) do nothing;

-- Upsert needs INSERT + SELECT + UPDATE, so all are granted to admins only.
create policy "site_media_admin_select" on storage.objects for select to authenticated
  using (bucket_id = 'site-media' and (select private.is_platform_admin()));
create policy "site_media_admin_insert" on storage.objects for insert to authenticated
  with check (bucket_id = 'site-media' and (select private.is_platform_admin()));
create policy "site_media_admin_update" on storage.objects for update to authenticated
  using (bucket_id = 'site-media' and (select private.is_platform_admin()))
  with check (bucket_id = 'site-media' and (select private.is_platform_admin()));
create policy "site_media_admin_delete" on storage.objects for delete to authenticated
  using (bucket_id = 'site-media' and (select private.is_platform_admin()));