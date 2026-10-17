-- يُشغّل بعد 20261017024500_batch_guest_identity_links.sql داخل معاملة واحدة.
-- يستخدم هذا الاختبار تجزئات اصطناعية فقط ويتراجع عن كل تغيير.
begin;

do $$
declare
  v_a text := md5('identity-batch-a') || md5('identity-batch-a-2');
  v_b text := md5('identity-batch-b') || md5('identity-batch-b-2');
  v_c text := md5('identity-batch-c') || md5('identity-batch-c-2');
  v_d text := md5('identity-batch-d') || md5('identity-batch-d-2');
  v_result integer;
begin
  assert not has_function_privilege('anon', 'public.guest_identity_link_many(jsonb)', 'EXECUTE'), 'anon cannot run batch link';
  assert not has_function_privilege('authenticated', 'public.guest_identity_link_many(jsonb)', 'EXECUTE'), 'authenticated cannot run batch link';
  assert has_function_privilege('service_role', 'public.guest_identity_link_many(jsonb)', 'EXECUTE'), 'server can run batch link';

  v_result := public.guest_identity_link_many(jsonb_build_array(
    jsonb_build_object('a', v_a, 'b', v_b, 'score', 0.95, 'reasons', jsonb_build_array('test-a')),
    jsonb_build_object('a', v_c, 'b', v_d, 'score', 0.97, 'reasons', jsonb_build_array('test-b'))
  ));
  assert v_result = 2, 'two valid links are created in one call';
  assert public.guest_final_id(v_a) = least(v_a, v_b), 'first pair resolves to one final id';
  assert public.guest_final_id(v_c) = least(v_c, v_d), 'second pair resolves to one final id';

  assert public.guest_identity_link_many(jsonb_build_object('not', 'an array')) = 0, 'non-array payload is rejected safely';
  assert public.guest_identity_link_many(jsonb_build_array(
    jsonb_build_object('a', 'invalid', 'b', v_a, 'score', 0.95, 'reasons', jsonb_build_array())
  )) = 0, 'malformed hashes are ignored';
  raise notice 'ALL CHECKS PASSED';
end $$;

rollback;
