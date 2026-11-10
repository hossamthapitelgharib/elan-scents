-- Real-database test for the signup carry (supabase/migrations/*_signup_carry.sql): the cart and hearts a visitor had when he created his
-- account reach the account even when the confirmation link is opened in another browser, and a guest cart claimed later never doubles them.
-- Run AFTER the migration, as the project owner, inside one transaction; everything is rolled back. The users are synthetic (example.invalid);
-- the catalog rows (store products, sizes) are only read.
begin;

do $$
declare
  u_new  constant uuid := 'f0000000-0000-4000-8000-0000000000e1';
  u_conf constant uuid := 'f0000000-0000-4000-8000-0000000000e2';
  u_old  constant uuid := 'f0000000-0000-4000-8000-0000000000e3';
  u_adm  constant uuid := 'f0000000-0000-4000-8000-0000000000e4';
  u_two  constant uuid := 'f0000000-0000-4000-8000-0000000000e5';
  u_never constant uuid := 'f0000000-0000-4000-8000-0000000000e6';
  v_sp1 uuid; v_sz1 uuid; v_sp2 uuid; v_sz2 uuid; v_sz3 uuid;
  v_row public.signup_carry%rowtype;
  v_res jsonb; v_ok boolean; v_n integer; v_q integer;
  v_fp constant text := repeat('c', 64);
  v_an constant text := repeat('d', 64);
begin
  select sp.id, sp.product_size_id into v_sp1, v_sz1 from public.store_products sp order by sp.id limit 1;
  select sp.id, sp.product_size_id into v_sp2, v_sz2 from public.store_products sp where sp.product_size_id <> v_sz1 order by sp.id limit 1;
  select ps.id into v_sz3 from public.product_sizes ps where ps.id not in (v_sz1, v_sz2) order by ps.id limit 1;
  assert v_sp1 is not null and v_sp2 is not null and v_sz3 is not null, 'the catalog has two store products of different sizes and a third size';

  insert into auth.users (id, aud, role, email, created_at, email_confirmed_at) values
    (u_new,  'authenticated', 'authenticated', 'carry-new@example.invalid',  now(), null),
    (u_conf, 'authenticated', 'authenticated', 'carry-conf@example.invalid', now(), now()),
    (u_old,  'authenticated', 'authenticated', 'carry-old@example.invalid',  now() - interval '3 days', null),
    (u_adm,  'authenticated', 'authenticated', 'carry-adm@example.invalid',  now(), null),
    (u_two,  'authenticated', 'authenticated', 'carry-two@example.invalid',  now(), null),
    (u_never,'authenticated', 'authenticated', 'carry-never@example.invalid',now() - interval '40 days', null);
  insert into public.profiles (id, role) values (u_new,'customer'),(u_conf,'customer'),(u_old,'customer'),(u_adm,'platform_admin'),(u_two,'customer'),(u_never,'customer')
    on conflict (id) do update set role = excluded.role;

  -- 1. A new unconfirmed customer's lists are stored after being re-read: bad lines dropped, quantities clamped, one line per store product.
  v_ok := public.stash_signup_carry(u_new,
    jsonb_build_array(
      jsonb_build_object('sid', v_sz1, 'storeProductId', v_sp1, 'q', 2),
      jsonb_build_object('sid', v_sz1, 'storeProductId', v_sp1, 'q', 4),                    -- same line twice: the larger
      jsonb_build_object('sid', v_sz2, 'storeProductId', v_sp2, 'q', 500),                  -- clamped to 99
      jsonb_build_object('storeProductId', 'not-a-uuid', 'q', 1),
      jsonb_build_object('storeProductId', gen_random_uuid(), 'q', 1),                      -- no such store product
      to_jsonb('text'::text), to_jsonb(7)),
    jsonb_build_array(v_sz1::text, v_sz3::text, v_sz1::text, 'junk', gen_random_uuid()::text, 5));
  assert v_ok, 'a new unconfirmed customer can stash';
  select * into v_row from public.signup_carry where user_id = u_new;
  assert jsonb_array_length(v_row.cart) = 2, 'two valid lines survive: ' || v_row.cart::text;
  assert (select (e->>'q')::int from jsonb_array_elements(v_row.cart) e where (e->>'storeProductId')::uuid = v_sp1) = 4, 'a repeated line keeps the larger quantity';
  assert (select (e->>'q')::int from jsonb_array_elements(v_row.cart) e where (e->>'storeProductId')::uuid = v_sp2) = 99, 'a quantity is clamped to 99';
  assert (select (e->>'sid')::uuid from jsonb_array_elements(v_row.cart) e where (e->>'storeProductId')::uuid = v_sp2) = v_sz2, 'the size comes from the store product, not from the caller';
  assert jsonb_array_length(v_row.favs) = 2, 'two distinct real sizes survive: ' || v_row.favs::text;
  assert v_row.consumed_at is null;

  -- 2. Who may stash: not a confirmed account, not an old one, not a non-customer, not an unknown user, not empty or malformed lists.
  assert not public.stash_signup_carry(u_conf, jsonb_build_array(jsonb_build_object('storeProductId', v_sp1, 'q', 1)), '[]'), 'a confirmed account cannot be written to';
  assert not public.stash_signup_carry(u_old,  jsonb_build_array(jsonb_build_object('storeProductId', v_sp1, 'q', 1)), '[]'), 'an account older than 24 hours cannot';
  assert not public.stash_signup_carry(u_adm,  jsonb_build_array(jsonb_build_object('storeProductId', v_sp1, 'q', 1)), '[]'), 'a non-customer cannot';
  assert not public.stash_signup_carry(gen_random_uuid(), jsonb_build_array(jsonb_build_object('storeProductId', v_sp1, 'q', 1)), '[]'), 'an unknown user cannot';
  assert not public.stash_signup_carry(null, '[]', '[]'), 'no user';
  assert not public.stash_signup_carry(u_two, '[]', '[]'), 'two empty lists store nothing';
  assert not public.stash_signup_carry(u_two, '{"a":1}'::jsonb, '[]'), 'a cart that is not a list is refused';
  assert not public.stash_signup_carry(u_two, '[]', '"x"'::jsonb), 'hearts that are not a list are refused';
  assert not exists (select 1 from public.signup_carry where user_id in (u_conf, u_old, u_adm, u_two)), 'none of those left a row';

  -- 3. Stashing again before it is taken replaces the lists.
  assert public.stash_signup_carry(u_new, jsonb_build_array(jsonb_build_object('storeProductId', v_sp1, 'q', 3)), '[]');
  select * into v_row from public.signup_carry where user_id = u_new;
  assert jsonb_array_length(v_row.cart) = 1 and jsonb_array_length(v_row.favs) = 0, 'the newest lists replace the older ones';

  -- 4. An account that has not confirmed takes nothing; the row stays for later.
  v_res := public.claim_signup_carry(u_new);
  assert not (v_res->>'claimed')::boolean, 'not confirmed yet';
  assert exists (select 1 from public.signup_carry where user_id = u_new and consumed_at is null), 'the row waits';
  assert not exists (select 1 from public.cart_items where user_id = u_new), 'nothing was moved';

  -- 5. Confirmed: the lists land in the account, once. The account already holds the line with the larger quantity: it keeps it.
  assert public.stash_signup_carry(u_new,
    jsonb_build_array(jsonb_build_object('storeProductId', v_sp1, 'q', 2), jsonb_build_object('storeProductId', v_sp2, 'q', 1)),
    jsonb_build_array(v_sz1::text, v_sz3::text));
  update auth.users set email_confirmed_at = now() where id = u_new;
  insert into public.cart_items (user_id, store_product_id, quantity) values (u_new, v_sp1, 5);
  v_res := public.claim_signup_carry(u_new);
  assert (v_res->>'claimed')::boolean and (v_res->>'cart')::int = 2 and (v_res->>'favs')::int = 2, 'claimed: ' || v_res::text;
  select quantity into v_q from public.cart_items where user_id = u_new and store_product_id = v_sp1;
  assert v_q = 5, 'the larger quantity stays, never the sum (' || v_q || ')';
  select quantity into v_q from public.cart_items where user_id = u_new and store_product_id = v_sp2;
  assert v_q = 1, 'a new line arrives with its quantity';
  select count(*) into v_n from public.favorites where user_id = u_new;
  assert v_n = 2, 'both hearts arrive';
  assert (select product_id from public.favorites where user_id = u_new and product_size_id = v_sz1) = (select product_id from public.product_sizes where id = v_sz1), 'the heart''s product is filled from its size';
  select * into v_row from public.signup_carry where user_id = u_new;
  assert v_row.consumed_at is not null and v_row.cart = '[]'::jsonb and v_row.favs = '[]'::jsonb, 'the row is emptied and marked used';
  assert not (public.claim_signup_carry(u_new)->>'claimed')::boolean, 'a second claim takes nothing';
  assert not public.stash_signup_carry(u_new, jsonb_build_array(jsonb_build_object('storeProductId', v_sp1, 'q', 1)), '[]'), 'a confirmed account cannot be stashed to again';

  -- 6. The guest cart of the browser that registered is claimed later (it signs in there): the quantities are not doubled.
  perform public.resolve_guest_browser(v_fp, v_an);
  perform public.save_guest_browser_cart(v_fp, v_an, jsonb_build_array(
    jsonb_build_object('sid', v_sz1, 'storeProductId', v_sp1, 'q', 5), jsonb_build_object('sid', v_sz2, 'storeProductId', v_sp2, 'q', 1)));
  v_res := public.claim_guest_browser_cart(v_fp, v_an, u_new);
  assert (v_res->>'claimed')::boolean, 'the guest cart is claimed';
  select quantity into v_q from public.cart_items where user_id = u_new and store_product_id = v_sp1;
  assert v_q = 5, 'the same line from the guest cart is not added again (' || v_q || ')';
  select quantity into v_q from public.cart_items where user_id = u_new and store_product_id = v_sp2;
  assert v_q = 1, 'nor the second line (' || v_q || ')';
  select count(*) into v_n from public.cart_items where user_id = u_new;
  assert v_n = 2, 'still two lines';

  -- 7. Old rows of accounts that never confirmed go on the next stash; a confirmed account's row is never dropped.
  insert into public.signup_carry (user_id, cart, favs, created_at) values (u_never, jsonb_build_array(jsonb_build_object('storeProductId', v_sp1, 'q', 1)), '[]', now() - interval '40 days');
  insert into public.signup_carry (user_id, cart, favs, created_at) values (u_conf, '[]', '[]', now() - interval '40 days');
  assert public.stash_signup_carry(u_two, jsonb_build_array(jsonb_build_object('storeProductId', v_sp1, 'q', 1)), '[]');
  assert not exists (select 1 from public.signup_carry where user_id = u_never), 'the stale row of an unconfirmed account is dropped';
  assert exists (select 1 from public.signup_carry where user_id = u_conf), 'the row of a confirmed account is kept';

  -- 8. The row goes with its account.
  delete from auth.users where id = u_two;
  assert not exists (select 1 from public.signup_carry where user_id = u_two), 'deleting the account deletes its row';
end $$;

-- 9. Clients can neither read nor write the table, nor call the two functions: only the server (service_role) can.
do $$
declare v_denied boolean;
begin
  perform set_config('request.jwt.claims', json_build_object('sub', 'f0000000-0000-4000-8000-0000000000e1', 'role', 'authenticated')::text, true);
  set local role authenticated;
  v_denied := false; begin perform 1 from public.signup_carry; exception when insufficient_privilege then v_denied := true; end;
  assert v_denied, 'authenticated cannot read signup_carry';
  v_denied := false; begin insert into public.signup_carry (user_id) values ('f0000000-0000-4000-8000-0000000000e1'); exception when insufficient_privilege then v_denied := true; end;
  assert v_denied, 'authenticated cannot write signup_carry';
  v_denied := false; begin perform public.stash_signup_carry('f0000000-0000-4000-8000-0000000000e1', '[]', '[]'); exception when insufficient_privilege then v_denied := true; end;
  assert v_denied, 'authenticated cannot call stash_signup_carry';
  v_denied := false; begin perform public.claim_signup_carry('f0000000-0000-4000-8000-0000000000e1'); exception when insufficient_privilege then v_denied := true; end;
  assert v_denied, 'authenticated cannot call claim_signup_carry';
  reset role;
  set local role anon;
  v_denied := false; begin perform 1 from public.signup_carry; exception when insufficient_privilege then v_denied := true; end;
  assert v_denied, 'anon cannot read signup_carry';
  v_denied := false; begin perform public.claim_signup_carry('f0000000-0000-4000-8000-0000000000e1'); exception when insufficient_privilege then v_denied := true; end;
  assert v_denied, 'anon cannot call claim_signup_carry';
  reset role;
end $$;
rollback;
