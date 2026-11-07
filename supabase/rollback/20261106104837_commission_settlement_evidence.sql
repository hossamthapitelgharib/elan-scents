begin;

drop policy if exists commission_evidence_service_role_select on storage.objects;
drop policy if exists commission_evidence_service_role_insert on storage.objects;
drop policy if exists commission_evidence_service_role_delete on storage.objects;

drop table if exists public.commission_settlement_evidence;
delete from storage.buckets where id = 'commission-payment-evidence'
  and not exists (select 1 from storage.objects where bucket_id = 'commission-payment-evidence' limit 1);

commit;
