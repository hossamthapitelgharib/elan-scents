-- Run on a database that has the forget_guest_browser migration applied. It was also run on the live project before the
-- migration was applied (the function was created inside the same transaction) and everything rolled back. Test data is fake.
-- A visitor who refuses tracking in the privacy policy has the fingerprint and every activity record of that browser erased;
-- nothing that belongs to another visitor or to a registered customer is touched.
begin;
do $$
declare
  me_fp text := repeat('a', 64);   me_an text := repeat('b', 64);
  other_fp text := repeat('c', 64); other_an text := repeat('d', 64);
  conv_fp text := repeat('e', 64);
  pid uuid; me_id uuid; other_id uuid; conv_id uuid;
  sid_me uuid := gen_random_uuid(); sid_other uuid := gen_random_uuid(); sid_cust uuid := gen_random_uuid();
  cust uuid := gen_random_uuid();
  r jsonb;
begin
  select id into pid from public.products limit 1;
  if pid is null then
    insert into public.products default values returning id into pid; -- scratch databases only; the live table always has rows
  end if;

  insert into auth.users (id, aud, role, email, encrypted_password, raw_app_meta_data, raw_user_meta_data, email_confirmed_at, created_at, updated_at)
  values (cust, 'authenticated', 'authenticated', 'fixture-' || cust::text || '@example.invalid', '', '{}'::jsonb, '{"full_name":"forget-fixture"}'::jsonb, now(), now(), now());

  insert into public.guest_visitors (fingerprint_hash, status, cart_snapshot) values (me_fp, 'guest', '[{"sid":"x","q":1}]'::jsonb) returning id into me_id;
  insert into public.guest_visitors (fingerprint_hash, status) values (other_fp, 'guest') returning id into other_id;
  -- a visitor row that already converted belongs to a registered customer: never touched
  insert into public.guest_visitors (fingerprint_hash, status, converted_user_id, converted_at) values (conv_fp, 'converted', cust, now()) returning id into conv_id;

  insert into public.customer_sessions (session_id, guest_id) values (sid_me, me_id), (sid_other, other_id);
  insert into public.customer_sessions (session_id, user_id) values (sid_cust, cust);
  insert into public.customer_product_events (session_id, guest_id, product_id, event_type) values (sid_me, me_id, pid, 'view'), (sid_me, me_id, pid, 'cart_add'), (sid_other, other_id, pid, 'view');
  insert into public.customer_product_events (session_id, user_id, product_id, event_type, occurred_at) values (sid_cust, cust, pid, 'view', now() - interval '800 days');
  insert into public.customer_searches (session_id, guest_id, search_text) values (sid_me, me_id, 'fake search me'), (sid_other, other_id, 'fake search other');
  insert into public.customer_searches (session_id, user_id, search_text, occurred_at) values (sid_cust, cust, 'fake search customer', now() - interval '800 days');

  insert into public.guest_fingerprints (analytics_hash, fp_hash) values (me_an, repeat('1', 32)), (me_an, repeat('2', 32)), (other_an, repeat('3', 32));
  insert into public.guest_identity_links (hash_a, hash_b, score) values (least(me_an, other_an), greatest(me_an, other_an), 0.9);
  insert into public.guest_analytics_visits (visitor_hash, activity_date) values (me_an, current_date), (me_an, current_date - 3), (other_an, current_date);
  insert into public.guest_product_analytics (visitor_hash, product_id, activity_date, event_type) values (me_an, pid, current_date, 'view'), (other_an, pid, current_date, 'view');
  insert into public.guest_conversions (visitor_hash, user_id, first_seen_date, converted_on) values (repeat('f', 64), cust, current_date - 5, current_date);

  r := public.forget_guest_browser(me_fp, me_an);
  assert (r->>'forgotten')::boolean, 'a valid pair of hashes is processed';
  assert (r->>'visitors')::int = 1 and (r->>'events')::int = 2 and (r->>'sessions')::int = 1 and (r->>'searches')::int = 1, 'the visitor''s own rows are counted: ' || r::text;

  -- everything of this browser is gone
  assert not exists (select 1 from public.guest_visitors where fingerprint_hash = me_fp), 'visitor row (and its cart snapshot) is gone';
  assert not exists (select 1 from public.customer_sessions where guest_id = me_id), 'its sessions are gone';
  assert not exists (select 1 from public.customer_product_events where guest_id = me_id), 'its product events are gone';
  assert not exists (select 1 from public.customer_searches where search_text = 'fake search me'), 'its searches are gone';
  assert not exists (select 1 from public.guest_fingerprints where analytics_hash = me_an), 'its fingerprints are gone';
  assert not exists (select 1 from public.guest_identity_links where hash_a = me_an or hash_b = me_an), 'its identity links are gone';
  assert not exists (select 1 from public.guest_analytics_visits where visitor_hash = me_an), 'its visit counters are gone';
  assert not exists (select 1 from public.guest_product_analytics where visitor_hash = me_an), 'its product counters are gone';

  -- nothing else is touched
  assert exists (select 1 from public.guest_visitors where fingerprint_hash = other_fp), 'another visitor is kept';
  assert exists (select 1 from public.customer_product_events where guest_id = other_id), 'another visitor''s events are kept';
  assert exists (select 1 from public.customer_searches where search_text = 'fake search other'), 'another visitor''s searches are kept';
  assert exists (select 1 from public.guest_fingerprints where analytics_hash = other_an), 'another visitor''s fingerprint is kept';
  assert exists (select 1 from public.guest_analytics_visits where visitor_hash = other_an), 'another visitor''s counters are kept';
  assert exists (select 1 from public.guest_product_analytics where visitor_hash = other_an), 'another visitor''s product counters are kept';
  assert exists (select 1 from public.customer_sessions where user_id = cust), 'a registered customer''s session is kept';
  assert exists (select 1 from public.customer_product_events where user_id = cust), 'a registered customer''s event is kept';
  assert exists (select 1 from public.customer_searches where user_id = cust and search_text = 'fake search customer'), 'a registered customer''s old search is kept';
  assert exists (select 1 from public.guest_conversions where user_id = cust), 'the conversion record is kept';

  -- a converted visitor row is never touched, even with its own hashes
  r := public.forget_guest_browser(conv_fp, repeat('9', 64));
  assert exists (select 1 from public.guest_visitors where id = conv_id), 'a converted visitor row is kept';
  assert (r->>'visitors')::int = 0, 'nothing deleted for a converted row';

  -- running it again deletes nothing more
  r := public.forget_guest_browser(me_fp, me_an);
  assert (r->>'visitors')::int = 0 and (r->>'events')::int = 0 and (r->>'signal_rows')::int = 0, 'idempotent';

  -- malformed hashes are refused quietly and delete nothing
  r := public.forget_guest_browser('not-a-hash', me_an);
  assert not (r->>'forgotten')::boolean, 'a malformed fingerprint hash is refused';
  r := public.forget_guest_browser(other_fp, null);
  assert not (r->>'forgotten')::boolean, 'a missing analytics hash is refused';
  assert exists (select 1 from public.guest_visitors where fingerprint_hash = other_fp), 'a refused call deletes nothing';

  -- not callable by the browser roles
  assert not has_function_privilege('anon', 'public.forget_guest_browser(text,text)', 'execute'), 'anon cannot call it';
  assert not has_function_privilege('authenticated', 'public.forget_guest_browser(text,text)', 'execute'), 'authenticated cannot call it';
  assert has_function_privilege('service_role', 'public.forget_guest_browser(text,text)', 'execute'), 'service_role can call it';
end;
$$;
rollback;
