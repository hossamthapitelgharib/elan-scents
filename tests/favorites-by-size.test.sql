-- Real-database test for supabase/migrations/20261104160507_favorites_by_size.sql
-- Run AFTER the migration, as the project owner, inside one transaction. Everything is rolled back.
-- The users are synthetic (example.invalid addresses); the catalog rows are only read, plus one synthetic size added inside the transaction.
begin;

do $$
declare
  u1 constant uuid := 'f0000000-0000-4000-8000-0000000000d1';
  u2 constant uuid := 'f0000000-0000-4000-8000-0000000000d2';
  v_product uuid;
  v_other_product uuid;
  v_size1 uuid;
  v_size2 uuid;
  v_row record;
  v_count integer;
begin
  select id into v_product from public.products order by id limit 1;
  select id into v_other_product from public.products where id <> v_product order by id limit 1;
  assert v_product is not null and v_other_product is not null, 'the catalog has at least two products';
  select id into v_size1 from public.product_sizes where product_id = v_product order by id limit 1;
  if v_size1 is null then
    insert into public.product_sizes (product_id, size_ml, size_label) values (v_product, 50, 'test-50') returning id into v_size1;
  end if;
  insert into public.product_sizes (product_id, size_ml, size_label) values (v_product, 9999, 'test-9999') returning id into v_size2;

  insert into auth.users (id, aud, role, email) values
    (u1, 'authenticated', 'authenticated', 'fav-one@example.invalid'),
    (u2, 'authenticated', 'authenticated', 'fav-two@example.invalid');

  -- 1. The row needs only the size: the product is filled in from it.
  insert into public.favorites (user_id, product_size_id) values (u1, v_size1);
  select * into v_row from public.favorites where user_id = u1 and product_size_id = v_size1;
  assert v_row.product_id = v_product, 'the product is taken from the size';

  -- 2. A wrong product sent by the caller is replaced, never trusted.
  insert into public.favorites (user_id, product_size_id, product_id) values (u1, v_size2, v_other_product);
  select * into v_row from public.favorites where user_id = u1 and product_size_id = v_size2;
  assert v_row.product_id = v_product, 'a product that does not match the size is overwritten';

  -- 3. Two sizes of the same perfume can both be favourites; the same size twice cannot.
  select count(*) into v_count from public.favorites where user_id = u1 and product_id = v_product;
  assert v_count = 2, 'two sizes of one product are two favourites';
  begin
    insert into public.favorites (user_id, product_size_id) values (u1, v_size1);
    assert false, 'the same size twice must be refused';
  exception when unique_violation then null;
  end;
  -- ...and the same size is a favourite of each customer separately.
  insert into public.favorites (user_id, product_size_id) values (u2, v_size1);

  -- 4. A size that does not exist is refused.
  begin
    insert into public.favorites (user_id, product_size_id) values (u2, 'f0000000-0000-4000-8000-00000000ffff');
    assert false, 'an unknown size must be refused';
  exception when foreign_key_violation or not_null_violation then null;
  end;

  -- 5. A customer reads, adds and removes only their own rows, as through the public API.
  perform set_config('request.jwt.claims', json_build_object('sub', u1, 'role', 'authenticated')::text, true);
  set local role authenticated;
  select count(*) into v_count from public.favorites;
  assert v_count = 2, 'a customer sees only their own favourites (2), not the other customer''s';
  begin
    insert into public.favorites (user_id, product_size_id) values (u2, v_size2);
    reset role;
    assert false, 'a customer must not write a favourite for someone else';
  exception when insufficient_privilege or check_violation then
    reset role;
  end;
  set local role authenticated;
  delete from public.favorites where user_id = u2;
  get diagnostics v_count = row_count;
  assert v_count = 0, 'a customer cannot delete another customer''s favourites';
  delete from public.favorites where product_size_id = v_size2;
  get diagnostics v_count = row_count;
  assert v_count = 1, 'a customer removes their own favourite';
  reset role;

  -- 6. Visitors have no access at all.
  perform set_config('request.jwt.claims', '{}', true);
  set local role anon;
  begin
    perform 1 from public.favorites;
    reset role;
    assert false, 'a visitor must not read favourites';
  exception when insufficient_privilege then
    reset role;
  end;

  -- 7. Removing the size removes the favourite; removing the account removes its favourites.
  insert into public.favorites (user_id, product_size_id) values (u1, v_size2);
  delete from public.product_sizes where id = v_size2;
  select count(*) into v_count from public.favorites where product_size_id = v_size2;
  assert v_count = 0, 'a favourite goes with its size';
  delete from auth.users where id = u2;
  select count(*) into v_count from public.favorites where user_id = u2;
  assert v_count = 0, 'favourites go with the account';
end $$;

rollback;
