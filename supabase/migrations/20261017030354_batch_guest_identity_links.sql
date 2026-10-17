-- يجمع روابط الهوية المقبولة من طلب identify واحد في استدعاء PostgREST واحد.
-- ترحيل معلّق فقط؛ لا يُطبّق على المشروع الحي دون موافقة المالك الصريحة.
begin;

create or replace function public.guest_identity_link_many(p_links jsonb)
returns integer
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_link jsonb;
  v_a text;
  v_b text;
  v_score numeric;
  v_reasons jsonb;
  v_linked integer := 0;
begin
  if coalesce(jsonb_typeof(p_links), '') <> 'array' then
    return 0;
  end if;
  if jsonb_array_length(p_links) > 50 then
    return 0;
  end if;

  for v_link in select value from jsonb_array_elements(p_links) loop
    if jsonb_typeof(v_link) <> 'object'
       or coalesce(v_link->>'a', '') !~ '^[a-f0-9]{64}$'
       or coalesce(v_link->>'b', '') !~ '^[a-f0-9]{64}$'
       or coalesce(v_link->>'score', '') !~ '^[0-9]+(\.[0-9]+)?$'
       or coalesce(jsonb_typeof(v_link->'reasons'), '') <> 'array' then
      continue;
    end if;

    v_a := v_link->>'a';
    v_b := v_link->>'b';
    v_score := (v_link->>'score')::numeric;
    if v_score < 0 or v_score > 2 then
      continue;
    end if;
    v_reasons := v_link->'reasons';

    if public.guest_identity_link(v_a, v_b, v_score, v_reasons) then
      v_linked := v_linked + 1;
    end if;
  end loop;

  return v_linked;
end;
$$;

revoke all on function public.guest_identity_link_many(jsonb) from public, anon, authenticated;
grant execute on function public.guest_identity_link_many(jsonb) to service_role;
comment on function public.guest_identity_link_many(jsonb) is
  'تضيف حتى 50 رابط هوية سبق التحقق منه في استدعاء خادمي واحد؛ ولا تنقل السلال أو الأنشطة.';

commit;
