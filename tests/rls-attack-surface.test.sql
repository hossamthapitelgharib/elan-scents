-- Real-database attack test: what can a hacker with an ordinary account (or none) do to the money, the roles and other people's data?
-- Run as the project owner inside one transaction; everything is rolled back. The users and the store links are synthetic;
-- the two live stores are only read, and anything changed inside the transaction is rolled back.
-- Section 0 pins the grants themselves: it fails on the live database until the migration that revokes the client write
-- grants (see docs/handoff.ar.md, 2026-11-01) is applied; sections 1-7 (the attacks) pass before and after it.
-- Each "attack" runs under the real role (anon / authenticated) with a real JWT subject, so row-level security and grants apply
-- exactly as they do for a request that comes through the public API key. An attack is "blocked" when it raises an error or
-- changes zero rows; it fails the test only when it actually changes or returns a row.
begin;

create function pg_temp.attack(p_uid uuid, p_role text, p_sql text) returns text
language plpgsql as $f$
declare v_n integer; v_state text;
begin
  perform set_config('request.jwt.claims',
    case when p_uid is null then '{}' else json_build_object('sub', p_uid, 'role', p_role)::text end, true);
  execute 'set local role ' || quote_ident(p_role);
  begin
    execute p_sql;
    get diagnostics v_n = row_count;
    v_state := 'rows:' || v_n;
  exception when others then
    v_state := 'err:' || sqlstate;
  end;
  reset role;
  return v_state;
end $f$;

-- An attack counts as blocked only when the database refused it for a security reason: no privilege or row-level-security
-- refusal (42501), a guard trigger (P0001), a view that cannot be written at all (55000), or zero rows reached. Any other error (a typo, a missing column) fails the test,
-- so an attack cannot look blocked by accident.
create function pg_temp.blocked(p_uid uuid, p_role text, p_sql text) returns boolean
language sql as $f$
  select r in ('rows:0', 'err:42501', 'err:P0001', 'err:55000') from (select pg_temp.attack(p_uid, p_role, p_sql) r) t
$f$;

do $$
declare
  u_a     constant uuid := 'c0000000-0000-4000-8000-0000000000a1';  -- ordinary customer A
  u_b     constant uuid := 'c0000000-0000-4000-8000-0000000000a2';  -- ordinary customer B (the victim)
  u_sx    constant uuid := 'c0000000-0000-4000-8000-0000000000a3';  -- store admin of store X only
  u_admin constant uuid := 'c0000000-0000-4000-8000-0000000000a4';  -- platform admin (control)
  v_x uuid;
  v_y uuid;
  sp_x public.store_products;
  sp_y public.store_products;
  v_rate_x numeric;
  v_rate_y numeric;
  v_status_y text;
  v_prod uuid;
  v_n integer;
  v_order uuid;
  v_review uuid;
  v_line numeric;
  v_bad text;
begin
  select id, commission_rate into v_x, v_rate_x from public.stores where slug = 'afnan-egypt';
  select id, commission_rate, status into v_y, v_rate_y, v_status_y from public.stores where slug = 'emarati-scents';
  assert v_x is not null and v_y is not null, 'the two live stores exist to test with';
  select * into sp_x from public.store_products where store_id = v_x order by id limit 1;
  select * into sp_y from public.store_products where store_id = v_y order by id limit 1;
  assert sp_x.id is not null and sp_y.id is not null, 'each store has a catalog row';
  select product_id into v_prod from public.product_sizes where id = sp_x.product_size_id;
  assert v_prod is not null, 'the catalog row has a product';

  insert into auth.users (id, aud, role, email, email_confirmed_at, raw_user_meta_data)
  values (u_a, 'authenticated', 'authenticated', 'attack-a@example.invalid', now(), '{"full_name":"Attacker A"}'::jsonb),
         (u_b, 'authenticated', 'authenticated', 'attack-b@example.invalid', now(), '{"full_name":"Victim B"}'::jsonb),
         (u_sx, 'authenticated', 'authenticated', 'attack-sx@example.invalid', now(), '{"full_name":"Store X admin"}'::jsonb),
         (u_admin, 'authenticated', 'authenticated', 'attack-admin@example.invalid', now(), '{"full_name":"Platform admin"}'::jsonb);
  update public.profiles set role = 'platform_admin' where id = u_admin;
  update public.profiles set role = 'store_admin' where id = u_sx;
  insert into public.store_accounts (store_id, user_id, role) values (v_x, u_sx, 'store_admin');

  -- Victim data the attackers will try to reach.
  insert into public.orders (user_id, status, subtotal, total_amount) values (u_b, 'pending', 100, 100) returning id into v_order;
  insert into public.order_items (order_id, store_product_id, quantity, price_at_time) values (v_order, sp_x.id, 1, 100);
  select price_at_time into v_line from public.order_items where order_id = v_order;  -- the database may set the line price itself
  insert into public.commissions (store_id, order_item_id, rate, amount, status)
    values (v_x, (select id from public.order_items where order_id = v_order), 10, 10, 'pending');
  insert into public.cart_items (user_id, store_product_id, quantity) values (u_b, sp_x.id, 2);
  insert into public.favorites (user_id, product_size_id) values (u_b, sp_x.product_size_id);
  insert into public.reviews (user_id, product_id, rating, comment, is_approved)
    values (u_b, v_prod, 5, 'victim review', false) returning id into v_review;

  ---------------------------------------------------------------------------------------------------------------------
  -- 0. Grants: clients write only the tables the browser really writes. Row-level security stays the main lock, but it must not
  --    be the only one. A new table or a new grant that widens this list fails here, so widening it is always a decision.
  ---------------------------------------------------------------------------------------------------------------------
  select string_agg(c.relname, ', ' order by c.relname) into v_bad
  from pg_class c join pg_namespace n on n.oid = c.relnamespace
  where n.nspname = 'public' and c.relkind in ('r', 'p', 'v', 'm', 'f')
    and (has_table_privilege('anon', c.oid, 'insert') or has_table_privilege('anon', c.oid, 'update') or has_table_privilege('anon', c.oid, 'delete')
         or has_table_privilege('anon', c.oid, 'truncate') or has_any_column_privilege('anon', c.oid, 'insert') or has_any_column_privilege('anon', c.oid, 'update'));
  assert v_bad is null, 'a visitor (anon) may write nothing, found: ' || coalesce(v_bad, '');
  select string_agg(c.relname, ', ' order by c.relname) into v_bad
  from pg_class c join pg_namespace n on n.oid = c.relnamespace
  where n.nspname = 'public' and c.relkind in ('r', 'p', 'v', 'm', 'f')
    and c.relname not in ('analytics_events', 'cart_items', 'contact_messages', 'favorites', 'media_library', 'offers', 'profiles', 'reviews', 'store_products')
    and (has_table_privilege('authenticated', c.oid, 'insert') or has_table_privilege('authenticated', c.oid, 'update') or has_table_privilege('authenticated', c.oid, 'delete')
         or has_table_privilege('authenticated', c.oid, 'truncate') or has_any_column_privilege('authenticated', c.oid, 'insert') or has_any_column_privilege('authenticated', c.oid, 'update'));
  assert v_bad is null, 'a signed-in client may write only the nine browser-written tables, found: ' || coalesce(v_bad, '');
  select string_agg(c.relname || ' (' || r.rolname || ')', ', ' order by c.relname) into v_bad
  from pg_class c join pg_namespace n on n.oid = c.relnamespace, pg_roles r
  where n.nspname = 'public' and c.relkind in ('r', 'p', 'm') and r.rolname in ('anon', 'authenticated')
    and (has_table_privilege(r.rolname, c.oid, 'truncate') or has_table_privilege(r.rolname, c.oid, 'references')
         or has_table_privilege(r.rolname, c.oid, 'trigger') or has_table_privilege(r.rolname, c.oid, 'maintain'));
  assert v_bad is null, 'no client role holds TRUNCATE, REFERENCES, TRIGGER or MAINTAIN, found: ' || coalesce(v_bad, '');
  assert not has_table_privilege('authenticated', 'public.profiles', 'insert') and not has_table_privilege('authenticated', 'public.profiles', 'delete'), 'a client cannot insert or delete profiles';
  assert not has_column_privilege('authenticated', 'public.profiles', 'role', 'update'), 'a client cannot write profiles.role';
  assert not has_column_privilege('authenticated', 'public.profiles', 'role', 'insert'), 'a client cannot insert profiles.role';
  assert has_column_privilege('authenticated', 'public.profiles', 'full_name', 'update') and has_column_privilege('authenticated', 'public.profiles', 'phone', 'update')
    and has_column_privilege('authenticated', 'public.profiles', 'avatar_url', 'update'), 'a customer can still edit his name, phone and avatar';
  assert has_table_privilege('authenticated', 'public.analytics_events', 'insert') and has_table_privilege('authenticated', 'public.contact_messages', 'insert'), 'a customer can still send an event and a contact message';
  assert not has_table_privilege('authenticated', 'public.analytics_events', 'update') and not has_table_privilege('authenticated', 'public.analytics_events', 'delete')
     and not has_table_privilege('authenticated', 'public.contact_messages', 'update') and not has_table_privilege('authenticated', 'public.contact_messages', 'delete'), 'events and contact messages are insert-only for clients';
  assert not has_column_privilege('authenticated', 'public.stores', 'commission_rate', 'update'), 'a client cannot write the commission rate';
  assert not has_table_privilege('authenticated', 'public.commissions', 'insert') and not has_table_privilege('authenticated', 'public.commissions', 'update'), 'a client cannot write commissions';
  assert has_table_privilege('service_role', 'public.commissions', 'insert') and has_table_privilege('service_role', 'public.stores', 'update'), 'the server keeps its write access';
  -- A table created from now on is read-only for clients until its own migration grants more (the default ACL for new tables).
  select string_agg(r.rolname || ':' || x.privilege_type, ', ') into v_bad
  from pg_default_acl d
  join pg_namespace n on n.oid = d.defaclnamespace and n.nspname = 'public'
  cross join lateral aclexplode(d.defaclacl) x
  join pg_roles r on r.oid = x.grantee
  where d.defaclobjtype = 'r' and pg_get_userbyid(d.defaclrole) = 'postgres'
    and r.rolname in ('anon', 'authenticated') and x.privilege_type in ('INSERT', 'UPDATE', 'DELETE', 'TRUNCATE', 'REFERENCES', 'TRIGGER', 'MAINTAIN');
  assert v_bad is null, 'a new table gives clients no write access by default, found: ' || coalesce(v_bad, '');
  assert exists (select 1 from pg_default_acl d join pg_namespace n on n.oid = d.defaclnamespace and n.nspname = 'public' cross join lateral aclexplode(d.defaclacl) x
                 join pg_roles r on r.oid = x.grantee where d.defaclobjtype = 'r' and pg_get_userbyid(d.defaclrole) = 'postgres' and r.rolname = 'authenticated' and x.privilege_type = 'SELECT'),
    'a new table stays readable by clients (row-level security decides which rows)';

  ---------------------------------------------------------------------------------------------------------------------
  -- 1. Roles: nobody can make himself (or anyone) an administrator.
  ---------------------------------------------------------------------------------------------------------------------
  assert pg_temp.blocked(u_a, 'authenticated', format($q$update public.profiles set role = 'platform_admin' where id = %L$q$, u_a)), 'A cannot make himself platform admin';
  assert pg_temp.blocked(u_a, 'authenticated', format($q$update public.profiles set role = 'store_admin' where id = %L$q$, u_a)), 'A cannot make himself store admin';
  assert pg_temp.blocked(u_a, 'authenticated', format($q$update public.profiles set role = 'platform_admin' where id = %L$q$, u_b)), 'A cannot promote another user';
  assert pg_temp.blocked(u_a, 'authenticated', format($q$insert into public.profiles (id, role) values (gen_random_uuid(), 'platform_admin')$q$)), 'A cannot insert an admin profile';
  assert pg_temp.blocked(u_a, 'authenticated', format($q$delete from public.profiles where id = %L$q$, u_b)), 'A cannot delete another profile';
  assert pg_temp.blocked(u_a, 'authenticated', format($q$update public.profiles set full_name = 'pwned' where id = %L$q$, u_b)), 'A cannot rename another user';
  assert pg_temp.blocked(u_sx, 'authenticated', format($q$update public.profiles set role = 'platform_admin' where id = %L$q$, u_sx)), 'a store admin cannot become platform admin';
  assert (select role from public.profiles where id = u_a) = 'customer', 'A is still a customer';
  assert (select role from public.profiles where id = u_b) = 'customer', 'B is still a customer';
  assert (select role from public.profiles where id = u_sx) = 'store_admin', 'the store admin did not change role';
  assert pg_temp.attack(u_a, 'authenticated', format($q$update public.profiles set phone = '+201000000001' where id = %L$q$, u_a)) = 'rows:1', 'A may still edit his own phone';
  assert pg_temp.blocked(u_a, 'authenticated', format($q$select role from public.profiles where id = %L$q$, u_b)), 'A cannot read B''s profile';
  assert pg_temp.blocked(null, 'anon', $q$select 1 from public.profiles$q$), 'a visitor cannot read profiles';
  assert pg_temp.blocked(null, 'anon', format($q$update public.profiles set role = 'platform_admin' where id = %L$q$, u_a)), 'a visitor cannot change a role';

  ---------------------------------------------------------------------------------------------------------------------
  -- 2. Store membership and store settings (including the commission rate).
  ---------------------------------------------------------------------------------------------------------------------
  assert pg_temp.blocked(u_a, 'authenticated', format($q$insert into public.store_accounts (store_id, user_id, role) values (%L, %L, 'store_admin')$q$, v_x, u_a)), 'A cannot link himself to a store';
  assert pg_temp.blocked(u_sx, 'authenticated', format($q$insert into public.store_accounts (store_id, user_id, role) values (%L, %L, 'store_admin')$q$, v_y, u_sx)), 'a store admin cannot link himself to a second store';
  assert pg_temp.blocked(u_sx, 'authenticated', format($q$update public.store_accounts set store_id = %L where user_id = %L$q$, v_y, u_sx)), 'a store admin cannot move his link to another store';
  assert pg_temp.blocked(u_sx, 'authenticated', format($q$delete from public.store_accounts where store_id = %L$q$, v_x)), 'a store admin cannot delete store links';
  assert pg_temp.blocked(u_sx, 'authenticated', format($q$update public.stores set commission_rate = 0 where id = %L$q$, v_x)), 'a store cannot lower its own commission rate';
  assert pg_temp.blocked(u_sx, 'authenticated', format($q$update public.stores set commission_rate = 99 where id = %L$q$, v_y)), 'a store cannot raise a competitor''s commission rate';
  assert pg_temp.blocked(u_sx, 'authenticated', format($q$update public.stores set status = 'suspended' where id = %L$q$, v_y)), 'a store cannot suspend a competitor';
  assert pg_temp.blocked(u_a, 'authenticated', format($q$update public.stores set commission_rate = 0, status = 'suspended', name = 'pwned' where id = %L$q$, v_x)), 'a customer cannot change a store';
  assert pg_temp.blocked(u_a, 'authenticated', $q$insert into public.stores (name, slug, commission_rate, status) values ('Fake', 'fake-attack-store', 0, 'active')$q$), 'a customer cannot create a store';
  assert pg_temp.blocked(u_a, 'authenticated', format($q$delete from public.stores where id = %L$q$, v_x)), 'a customer cannot delete a store';
  assert pg_temp.blocked(null, 'anon', format($q$update public.stores set commission_rate = 0 where id = %L$q$, v_x)), 'a visitor cannot change a commission rate';
  -- The same writes through the read-only views.
  assert pg_temp.blocked(u_a, 'authenticated', format($q$update public.public_stores set name = 'pwned', status = 'suspended' where id = %L$q$, v_x)), 'no write goes through public_stores';
  assert pg_temp.blocked(u_sx, 'authenticated', format($q$update public.public_stores set status = 'suspended' where id = %L$q$, v_y)), 'a store admin cannot write through public_stores';
  assert pg_temp.blocked(u_a, 'authenticated', $q$update public.public_brands set name = 'pwned'$q$), 'no write goes through public_brands';
  assert pg_temp.blocked(u_a, 'authenticated', $q$delete from public.public_brands$q$), 'no delete goes through public_brands';
  assert pg_temp.blocked(u_a, 'authenticated', $q$update public.public_products set name = 'pwned'$q$), 'no write goes through public_products';
  assert pg_temp.blocked(u_a, 'authenticated', $q$update public.cheapest_offers set price = 1$q$), 'no write goes through cheapest_offers';
  assert (select commission_rate from public.stores where id = v_x) is not distinct from v_rate_x, 'store X commission rate is unchanged';
  assert (select commission_rate from public.stores where id = v_y) is not distinct from v_rate_y, 'store Y commission rate is unchanged';
  assert (select status from public.stores where id = v_y) = v_status_y, 'store Y status is unchanged';

  ---------------------------------------------------------------------------------------------------------------------
  -- 3. Commissions and orders: the platform's money.
  ---------------------------------------------------------------------------------------------------------------------
  assert pg_temp.blocked(u_sx, 'authenticated', format($q$update public.commissions set amount = 0, rate = 0, status = 'paid' where store_id = %L$q$, v_x)), 'a store cannot waive or mark its own commission as paid';
  assert pg_temp.blocked(u_sx, 'authenticated', format($q$delete from public.commissions where store_id = %L$q$, v_x)), 'a store cannot delete its commission rows';
  assert pg_temp.blocked(u_sx, 'authenticated', format($q$insert into public.commissions (store_id, rate, amount, status) values (%L, 0, 0, 'paid')$q$, v_x)), 'a store cannot write a commission row';
  assert pg_temp.blocked(u_a, 'authenticated', format($q$insert into public.commissions (store_id, rate, amount, status) values (%L, 0, 0, 'paid')$q$, v_x)), 'a customer cannot write a commission row';
  assert pg_temp.blocked(null, 'anon', $q$delete from public.commissions$q$), 'a visitor cannot delete commissions';
  assert (select count(*) from public.commissions where store_id = v_x and amount = 10 and rate = 10 and status = 'pending') = 1, 'the commission row is untouched';
  assert pg_temp.blocked(u_a, 'authenticated', format($q$insert into public.orders (user_id, status, subtotal, total_amount) values (%L, 'paid', 1, 1)$q$, u_a)), 'a customer cannot insert an order directly';
  assert pg_temp.blocked(u_a, 'authenticated', format($q$update public.orders set status = 'cancelled', total_amount = 0 where id = %L$q$, v_order)), 'A cannot change B''s order';
  assert pg_temp.blocked(u_b, 'authenticated', format($q$update public.orders set total_amount = 1, subtotal = 1 where id = %L$q$, v_order)), 'the owner of an order cannot lower its total either';
  assert pg_temp.blocked(u_b, 'authenticated', format($q$update public.order_items set price_at_time = 1 where order_id = %L$q$, v_order)), 'the owner cannot lower the item price after the fact';
  assert pg_temp.blocked(u_a, 'authenticated', format($q$insert into public.order_items (order_id, store_product_id, quantity, price_at_time) values (%L, %L, 1, 0)$q$, v_order, sp_x.id)), 'A cannot add a free item to B''s order';
  assert pg_temp.blocked(u_a, 'authenticated', format($q$delete from public.orders where id = %L$q$, v_order)), 'A cannot delete B''s order';
  assert pg_temp.blocked(u_sx, 'authenticated', format($q$update public.orders set status = 'delivered' where id = %L$q$, v_order)), 'a store cannot mark an order delivered directly (it goes through the audited API)';
  assert pg_temp.blocked(u_a, 'authenticated', $q$select id from public.orders$q$), 'A cannot list orders';
  assert pg_temp.blocked(u_a, 'authenticated', $q$select id from public.order_items$q$), 'A cannot list order items';
  assert pg_temp.blocked(u_a, 'authenticated', $q$select id from public.commissions$q$), 'A cannot read commissions';
  assert pg_temp.blocked(u_sx, 'authenticated', format($q$select id from public.commissions where store_id = %L$q$, v_y)), 'a store cannot read a competitor''s commissions';
  assert pg_temp.blocked(null, 'anon', $q$select id from public.orders$q$), 'a visitor cannot list orders';
  assert (select status from public.orders where id = v_order) = 'pending' and (select total_amount from public.orders where id = v_order) = 100, 'the order is untouched';
  assert (select price_at_time from public.order_items where order_id = v_order) = v_line, 'the order line is untouched';

  ---------------------------------------------------------------------------------------------------------------------
  -- 4. Catalog and prices of a store belong to that store's members only.
  ---------------------------------------------------------------------------------------------------------------------
  assert pg_temp.blocked(u_a, 'authenticated', format($q$update public.store_products set price = 1 where id = %L$q$, sp_x.id)), 'a customer cannot change a price';
  assert pg_temp.blocked(u_sx, 'authenticated', format($q$update public.store_products set price = 1, stock_quantity = 0 where id = %L$q$, sp_y.id)), 'a store cannot change a competitor''s price or stock';
  assert pg_temp.blocked(u_sx, 'authenticated', format($q$delete from public.store_products where id = %L$q$, sp_y.id)), 'a store cannot delete a competitor''s product';
  assert pg_temp.blocked(u_sx, 'authenticated', format($q$update public.store_products set store_id = %L where id = %L$q$, v_y, sp_x.id)), 'a store cannot move its product into a competitor''s store';
  assert pg_temp.blocked(u_sx, 'authenticated', format($q$insert into public.store_products (store_id, product_size_id, price, stock_quantity) values (%L, %L, 1, 5)$q$, v_y, sp_x.product_size_id)), 'a store cannot add a product to a competitor';
  assert pg_temp.blocked(u_sx, 'authenticated', format($q$insert into public.offers (store_id, title) values (%L, 'pwned')$q$, v_y)), 'a store cannot add an offer to a competitor';
  assert pg_temp.blocked(u_a, 'authenticated', format($q$insert into public.offers (store_id, title) values (%L, 'pwned')$q$, v_x)), 'a customer cannot add an offer';
  assert pg_temp.blocked(u_sx, 'authenticated', format($q$update public.sync_logs set status = 'ok' where store_id = %L$q$, v_y)), 'a store cannot touch a competitor''s sync log';
  assert pg_temp.blocked(u_a, 'authenticated', $q$update public.products set name = 'pwned'$q$), 'a customer cannot rewrite the catalog';
  assert pg_temp.blocked(u_sx, 'authenticated', $q$update public.products set name = 'pwned'$q$), 'a store cannot rewrite the shared catalog';
  assert pg_temp.blocked(u_sx, 'authenticated', $q$update public.product_stats set sales_count = 99999, views_count = 99999$q$), 'a store cannot inflate product statistics';
  assert pg_temp.blocked(u_a, 'authenticated', $q$update public.site_settings set value = '{}'$q$), 'a customer cannot change site settings';
  assert pg_temp.blocked(u_a, 'authenticated', $q$insert into public.site_settings (key, value) values ('attack', 'x')$q$), 'a customer cannot add site settings';
  assert pg_temp.blocked(u_a, 'authenticated', $q$insert into public.media_library (file_url, file_type, is_approved) values ('https://evil.example/x.js', 'image', true)$q$), 'a customer cannot add to the media library';
  assert pg_temp.blocked(u_sx, 'authenticated', $q$insert into public.media_library (file_url, file_type, is_approved) values ('https://evil.example/x.js', 'image', true)$q$), 'a store admin cannot add to the media library';
  assert pg_temp.blocked(u_a, 'authenticated', $q$update public.editor_sections set status = 'archived'$q$), 'a customer cannot edit the home page sections';
  assert pg_temp.blocked(null, 'anon', $q$delete from public.store_products$q$), 'a visitor cannot delete products';

  ---------------------------------------------------------------------------------------------------------------------
  -- 5. Other customers' carts, favourites, reviews and messages.
  ---------------------------------------------------------------------------------------------------------------------
  assert pg_temp.blocked(u_a, 'authenticated', format($q$insert into public.cart_items (user_id, store_product_id, quantity) values (%L, %L, 1)$q$, u_b, sp_y.id)), 'A cannot put things in B''s cart';
  assert pg_temp.blocked(u_a, 'authenticated', format($q$update public.cart_items set quantity = 99 where user_id = %L$q$, u_b)), 'A cannot change B''s cart';
  assert pg_temp.blocked(u_a, 'authenticated', format($q$delete from public.cart_items where user_id = %L$q$, u_b)), 'A cannot empty B''s cart';
  assert pg_temp.blocked(u_a, 'authenticated', format($q$select 1 from public.cart_items where user_id = %L$q$, u_b)), 'A cannot read B''s cart';
  assert pg_temp.blocked(u_a, 'authenticated', format($q$select 1 from public.favorites where user_id = %L$q$, u_b)), 'A cannot read B''s favourites';
  assert pg_temp.blocked(u_a, 'authenticated', format($q$delete from public.favorites where user_id = %L$q$, u_b)), 'A cannot delete B''s favourites';
  assert pg_temp.blocked(u_a, 'authenticated', format($q$insert into public.favorites (user_id, product_size_id) values (%L, %L)$q$, u_b, (select id from public.product_sizes where product_id <> v_prod order by id limit 1))), 'A cannot add favourites for B';
  assert pg_temp.blocked(u_a, 'authenticated', format($q$update public.reviews set comment = 'pwned' where id = %L$q$, v_review)), 'A cannot edit B''s review';
  assert pg_temp.blocked(u_a, 'authenticated', format($q$delete from public.reviews where id = %L$q$, v_review)), 'A cannot delete B''s review';
  assert pg_temp.blocked(u_b, 'authenticated', format($q$update public.reviews set is_approved = true where id = %L$q$, v_review)), 'a customer cannot approve his own review';
  assert pg_temp.blocked(u_a, 'authenticated', format($q$insert into public.reviews (user_id, product_id, rating, comment, is_approved) values (%L, %L, 5, 'self approved', true)$q$, u_a, v_prod)), 'a customer cannot publish a review without moderation';
  assert pg_temp.blocked(u_a, 'authenticated', format($q$insert into public.analytics_events (event_type, user_id) values ('view', %L)$q$, u_b)), 'A cannot write events as B';
  assert pg_temp.blocked(u_a, 'authenticated', $q$select 1 from public.analytics_events$q$), 'A cannot read analytics events';
  assert pg_temp.blocked(u_a, 'authenticated', $q$select 1 from public.contact_messages$q$), 'A cannot read contact messages';
  assert pg_temp.blocked(u_a, 'authenticated', $q$select 1 from public.notifications$q$), 'A cannot read notifications';
  assert pg_temp.blocked(u_a, 'authenticated', $q$select 1 from public.store_order_requests$q$), 'A cannot read store order requests';
  assert pg_temp.blocked(u_sx, 'authenticated', $q$select 1 from public.store_order_requests$q$), 'a store admin reads orders only through the checked API';
  assert pg_temp.blocked(u_a, 'authenticated', $q$select 1 from public.store_integrations$q$), 'A cannot read store integration secrets';
  assert pg_temp.blocked(u_sx, 'authenticated', $q$select 1 from public.store_integrations$q$), 'a store admin cannot read integration secrets through the data API';
  assert pg_temp.blocked(u_a, 'authenticated', $q$select 1 from public.platform_audit_log$q$), 'A cannot read the audit log';
  assert pg_temp.blocked(null, 'anon', $q$select 1 from public.guest_visitors$q$), 'a visitor cannot read other visitors';
  assert pg_temp.blocked(null, 'anon', $q$select 1 from public.customer_product_events$q$), 'a visitor cannot read customer activity';
  assert (select quantity from public.cart_items where user_id = u_b) = 2, 'B''s cart is untouched';
  assert exists (select 1 from public.favorites where user_id = u_b), 'B''s favourites are untouched';
  assert (select comment from public.reviews where id = v_review) = 'victim review' and not (select is_approved from public.reviews where id = v_review), 'B''s review is untouched';

  ---------------------------------------------------------------------------------------------------------------------
  -- 6. Functions a client may call, and who may call them.
  ---------------------------------------------------------------------------------------------------------------------
  select string_agg(p.proname || '(' || pg_get_function_identity_arguments(p.oid) || ')', ', ' order by p.proname) into v_bad
  from pg_proc p join pg_namespace n on n.oid = p.pronamespace
  where n.nspname = 'public' and p.prokind = 'f'
    and has_function_privilege('authenticated', p.oid, 'execute')
    and p.proname not in ('place_store_order', 'replace_customer_cart', 'request_store_order_cancellation');
  assert v_bad is null, 'a signed-in client may call only the three checked customer functions, found: ' || coalesce(v_bad, '');
  select string_agg(p.proname, ', ') into v_bad
  from pg_proc p join pg_namespace n on n.oid = p.pronamespace
  where n.nspname = 'public' and p.prokind = 'f' and has_function_privilege('anon', p.oid, 'execute');
  assert v_bad is null, 'a visitor may call no public function, found: ' || coalesce(v_bad, '');
  assert not has_function_privilege('anon', 'public.place_store_order(jsonb)', 'execute'), 'a visitor cannot place an order';
  assert pg_temp.attack(null, 'anon', $q$select public.place_store_order('{}'::jsonb)$q$) like 'err:%', 'a visitor calling place_store_order is refused';
  assert pg_temp.attack(u_a, 'authenticated', $q$select public.place_store_order('{"storeId":"00000000-0000-0000-0000-000000000000","items":[]}'::jsonb)$q$) like 'err:%', 'an empty or unknown-store order is refused';

  ---------------------------------------------------------------------------------------------------------------------
  -- 7. Control: the platform admin keeps the access the platform needs, so the attacks above are blocked for the right reason.
  ---------------------------------------------------------------------------------------------------------------------
  assert pg_temp.attack(u_admin, 'authenticated', format($q$update public.profiles set full_name = 'Renamed by admin' where id = %L$q$, u_b)) = 'rows:1', 'the platform admin can edit a profile';
  assert pg_temp.attack(u_admin, 'authenticated', $q$insert into public.media_library (file_url, file_type, is_approved) values ('https://example.invalid/a.png', 'image', true)$q$) = 'rows:1', 'the owner''s editor session can still add an upload to the media library';
  assert pg_temp.blocked(u_admin, 'authenticated', $q$delete from public.media_library$q$), 'even the owner''s browser session cannot bulk-delete the media library (the server does that)';
end $$;

rollback;
