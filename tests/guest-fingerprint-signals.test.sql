-- Run on a scratch database that has supabase/migrations/20261017011558_guest_fingerprint_signals.sql applied.
-- Everything is rolled back. Test data is fake.
begin;
do $$
declare
  a text := repeat('a', 64); b text := repeat('b', 64); c text := repeat('c', 64);
  fp text := repeat('1', 32);
  parts jsonb := jsonb_build_object('gpu', 'aaaaaaaa11', 'screen', 'bbbbbbbb22');
  cands jsonb;
begin
  perform public.guest_signal_store(a, fp, parts, repeat('d',64), repeat('e',64), null, null, null, 3, 20, 2);
  perform public.guest_signal_store(b, fp, parts, repeat('d',64), repeat('e',64), null, null, null, 3, 20, 2);
  cands := public.guest_signal_candidates(a, fp, 'aaaaaaaa11', 'bbbbbbbb22');
  assert jsonb_array_length(cands) = 1 and cands->0->>'analyticsHash' = b, 'the other guest must be a candidate';
  assert (cands->0->>'popularity')::int = 2, 'popularity counts guests that carry the fingerprint';

  assert public.guest_identity_link(a, b, 0.97, '["same_ip"]'::jsonb), 'link accepted';
  assert public.guest_final_id(a) = public.guest_final_id(b), 'linked guests share one final id';
  assert public.guest_final_id(c) = c, 'an unlinked guest keeps its own id';

  insert into public.guest_analytics_visits (visitor_hash, activity_date) values (a, (now() at time zone 'Africa/Cairo')::date), (b, (now() at time zone 'Africa/Cairo')::date), (c, (now() at time zone 'Africa/Cairo')::date)
    on conflict do nothing;
  assert (public.guest_unique_people('today')->>'browsers')::int >= 3, 'browsers counted';
  assert (public.guest_unique_people('today')->>'people')::int = (public.guest_unique_people('today')->>'browsers')::int - 1, 'two linked browsers count as one person';

  -- the 6th link of one guest is refused
  perform public.guest_identity_link(a, repeat('1',64), 0.9, '[]'::jsonb);
  perform public.guest_identity_link(a, repeat('2',64), 0.9, '[]'::jsonb);
  perform public.guest_identity_link(a, repeat('3',64), 0.9, '[]'::jsonb);
  perform public.guest_identity_link(a, repeat('4',64), 0.9, '[]'::jsonb);
  assert not public.guest_identity_link(a, repeat('5',64), 0.9, '[]'::jsonb), 'link cap per guest';
end $$;
rollback;
