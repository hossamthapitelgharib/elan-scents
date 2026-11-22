-- Catalog waiting room (owner's agreement of 17 Nov 2026, restated 19 Nov 2026 08:45 and 20 Nov 2026 15:30).
--
-- A perfume a store sends whose brand is NOT on the platform WAITS: nothing is created for it and nothing is thrown away.
-- The moment a brand card for that brand exists (created, renamed, re-activated, or given an alias), its waiting perfumes are
-- placed by themselves: the perfume, its size and the store's offer are written, and from then on the normal visibility rules
-- decide what the visitor sees (cheapest eligible offer per size; a brand carried by one store makes that store the cheapest).
--
-- ONE entry point for every perfume that reaches the platform: public.catalog_receive_items(store, items, source). The trial
-- loader uses it today and the real store sync will call the very same function, so nothing built now is redone at linking time.
--
-- Everything here is server-only: no grant to anon or authenticated, RLS on with no policy, functions executable by service_role only.

-- ---------------------------------------------------------------------------------------------------------------------
-- 1. The name shown for a perfume: an ALL-CAPS name is shown in Title Case (the rule the trial catalogs already follow);
--    a name that has any lower-case Latin letter is the store's own spelling and stays as it is.
-- ---------------------------------------------------------------------------------------------------------------------
create or replace function private.catalog_display_name(p text)
returns text
language plpgsql
immutable
set search_path = pg_catalog
as $function$
declare
  v_name text := btrim(regexp_replace(coalesce(p, ''), '\s+', ' ', 'g'));
  v_out text;
begin
  if v_name = '' or v_name ~ '[a-z]' then
    return v_name;
  end if;
  select string_agg(
           case
             when t.tok ~ '[0-9]' or t.tok in ('AM', 'PM') then t.tok
             else (select string_agg(upper(left(h.x, 1)) || lower(substr(h.x, 2)), '-' order by h.o)
                     from unnest(string_to_array(t.tok, '-')) with ordinality as h(x, o))
           end,
           ' ' order by t.n)
    into v_out
    from unnest(string_to_array(v_name, ' ')) with ordinality as t(tok, n);
  return v_out;
end
$function$;

-- ---------------------------------------------------------------------------------------------------------------------
-- 2. Other spellings of a brand ("Khadlaj" for the card KHADLAJ PERFUMES). A store writes its brand its own way; the
--    platform matches the normalized text (lower case, no accents, letters and digits only) against the brand name first
--    and then against these aliases. A brand matching nothing waits.
-- ---------------------------------------------------------------------------------------------------------------------
create table public.catalog_brand_aliases (
  id uuid primary key default gen_random_uuid(),
  brand_id uuid not null references public.brands(id) on delete cascade,
  alias_text text not null check (btrim(alias_text) <> '' and char_length(alias_text) <= 120),
  alias_norm text generated always as (private.bundle_norm(alias_text)) stored,
  created_at timestamptz not null default now(),
  constraint catalog_brand_aliases_norm_nonempty check (alias_norm <> '')
);
create unique index catalog_brand_aliases_norm_key on public.catalog_brand_aliases (alias_norm);
create index catalog_brand_aliases_brand_idx on public.catalog_brand_aliases (brand_id);

-- ---------------------------------------------------------------------------------------------------------------------
-- 3. The waiting room: one row per (store, brand, perfume, size). Re-sending the same perfume updates its row.
--    status 'waiting' = the brand is not on the platform (released by itself later);
--    status 'held'    = the perfume cannot be placed without a human decision (the reason says why); it is never lost and never guessed.
-- ---------------------------------------------------------------------------------------------------------------------
create table public.catalog_waiting_items (
  id uuid primary key default gen_random_uuid(),
  store_id uuid not null references public.stores(id) on delete cascade,
  data_source text not null check (data_source in ('store_catalog', 'trial_catalog')),
  brand_text text not null check (btrim(brand_text) <> '' and char_length(brand_text) <= 120),
  brand_norm text generated always as (private.bundle_norm(brand_text)) stored,
  name text not null check (btrim(name) <> '' and char_length(name) <= 200),
  name_norm text generated always as (private.bundle_norm(name)) stored,
  size_ml integer not null check (size_ml between 1 and 5000),
  gender text check (gender in ('men', 'women', 'unisex')),
  price numeric not null check (price > 0),
  stock_quantity integer not null check (stock_quantity >= 0),
  is_available boolean not null,
  currency text not null default 'EGP' check (currency = 'EGP'),
  product_url text check (product_url is null or (char_length(product_url) <= 2000 and product_url ~* '^https?://[^[:space:]]+$')),
  status text not null default 'waiting' check (status in ('waiting', 'held')),
  reason text,
  last_error text,
  received_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  released_at timestamptz,
  constraint catalog_waiting_items_norm_nonempty check (brand_norm <> '' and name_norm <> '')
);
create unique index catalog_waiting_items_key on public.catalog_waiting_items (store_id, brand_norm, name_norm, size_ml);
create index catalog_waiting_items_open_idx on public.catalog_waiting_items (brand_norm) where released_at is null and status = 'waiting';

create trigger set_updated_at before update on public.catalog_waiting_items
  for each row execute function private.set_updated_at();

alter table public.catalog_brand_aliases enable row level security;
alter table public.catalog_waiting_items enable row level security;
revoke all on table public.catalog_brand_aliases from public, anon, authenticated;
revoke all on table public.catalog_waiting_items from public, anon, authenticated;

-- ---------------------------------------------------------------------------------------------------------------------
-- 4. What is wrong with one item the store sent. The store sends structured fields; nothing is guessed. An item missing a
--    field is answered with the reason, never completed by the platform.
-- ---------------------------------------------------------------------------------------------------------------------
create or replace function private.catalog_item_problem(p jsonb)
returns text
language plpgsql
immutable
set search_path = pg_catalog
as $function$
-- Every check is its own statement: a cast is only reached after the JSON type was proven, whatever the planner prefers.
begin
  if jsonb_typeof(p) is distinct from 'object' then return 'not_an_object'; end if;

  if jsonb_typeof(p -> 'brand') is distinct from 'string' then return 'brand_missing'; end if;
  if btrim(p ->> 'brand') = '' or char_length(p ->> 'brand') > 120 then return 'brand_missing'; end if;

  if jsonb_typeof(p -> 'name') is distinct from 'string' then return 'name_missing'; end if;
  if btrim(p ->> 'name') = '' or char_length(p ->> 'name') > 200 then return 'name_missing'; end if;

  if jsonb_typeof(p -> 'size_ml') is distinct from 'number' then return 'size_invalid'; end if;
  if (p ->> 'size_ml')::numeric <> trunc((p ->> 'size_ml')::numeric) or (p ->> 'size_ml')::numeric not between 1 and 5000 then return 'size_invalid'; end if;

  if jsonb_typeof(p -> 'price') is distinct from 'number' then return 'price_invalid'; end if;
  if round((p ->> 'price')::numeric, 2) <= 0 or (p ->> 'price')::numeric > 10000000 then return 'price_invalid'; end if;

  if jsonb_typeof(p -> 'stock_quantity') is distinct from 'number' then return 'stock_invalid'; end if;
  if (p ->> 'stock_quantity')::numeric <> trunc((p ->> 'stock_quantity')::numeric) or (p ->> 'stock_quantity')::numeric not between 0 and 1000000 then return 'stock_invalid'; end if;

  if jsonb_typeof(p -> 'currency') is not null and jsonb_typeof(p -> 'currency') <> 'null' then
    if jsonb_typeof(p -> 'currency') <> 'string' then return 'currency_not_egp'; end if;
    if upper(btrim(p ->> 'currency')) <> 'EGP' then return 'currency_not_egp'; end if;
  end if;

  if jsonb_typeof(p -> 'gender') is not null and jsonb_typeof(p -> 'gender') <> 'null' then
    if jsonb_typeof(p -> 'gender') <> 'string' then return 'gender_invalid'; end if;
    if (p ->> 'gender') not in ('men', 'women', 'unisex') then return 'gender_invalid'; end if;
  end if;

  if jsonb_typeof(p -> 'available') is not null and jsonb_typeof(p -> 'available') <> 'null' then
    if jsonb_typeof(p -> 'available') <> 'boolean' then return 'available_invalid'; end if;
  end if;

  if jsonb_typeof(p -> 'product_url') is not null and jsonb_typeof(p -> 'product_url') <> 'null' then
    if jsonb_typeof(p -> 'product_url') <> 'string' then return 'url_invalid'; end if;
    if btrim(p ->> 'product_url') <> '' then
      if char_length(p ->> 'product_url') > 2000 then return 'url_invalid'; end if;
      if (p ->> 'product_url') !~* '^https?://[^[:space:]]+$' then return 'url_invalid'; end if;
    end if;
  end if;
  return null;
end
$function$;

-- ---------------------------------------------------------------------------------------------------------------------
-- 5. Which brand card does this normalized brand text belong to? The brand name wins; then an alias. Two active brands with
--    the same normalized name are not guessed between: the caller holds the item with the reason.
-- ---------------------------------------------------------------------------------------------------------------------
create or replace function private.catalog_resolve_brand(p_brand_norm text)
returns uuid
language plpgsql
stable
security definer
set search_path = public, private, pg_temp
as $function$
declare
  v_ids uuid[];
begin
  if coalesce(p_brand_norm, '') = '' then return null; end if;
  select array_agg(b.id order by b.created_at, b.id) into v_ids
    from public.brands b where b.is_active and private.bundle_norm(b.name) = p_brand_norm;
  if cardinality(v_ids) = 1 then return v_ids[1]; end if;
  if cardinality(v_ids) > 1 then raise exception 'ambiguous_brand' using errcode = 'P0001'; end if;
  select array_agg(distinct a.brand_id) into v_ids
    from public.catalog_brand_aliases a join public.brands b on b.id = a.brand_id and b.is_active
   where a.alias_norm = p_brand_norm;
  if cardinality(v_ids) = 1 then return v_ids[1]; end if;
  return null;
end
$function$;

-- ---------------------------------------------------------------------------------------------------------------------
-- 6. Put one perfume in its place: the perfume (found by brand + normalized name, else created), its size, and the store's
--    offer. Returns NULL when placed, otherwise the reason the item must be held. Never overwrites an offer that came
--    from another data source (a trial row is not replaced by a real one by accident, nor the reverse).
-- ---------------------------------------------------------------------------------------------------------------------
create or replace function private.catalog_place_item(
  p_store uuid, p_brand uuid, p_name text, p_gender text, p_size integer,
  p_price numeric, p_stock integer, p_available boolean, p_url text, p_source text)
returns text
language plpgsql
security definer
set search_path = public, private, pg_temp
as $function$
declare
  v_norm text := private.bundle_norm(p_name);
  v_prods uuid[];
  v_prod uuid;
  v_size uuid;
  v_base text;
  v_slug text;
  v_i integer := 1;
  v_rows integer;
begin
  select array_agg(p.id order by p.created_at, p.id) into v_prods
    from public.products p where p.brand_id = p_brand and private.bundle_norm(p.name) = v_norm;
  if cardinality(v_prods) > 1 then return 'ambiguous_product'; end if;

  if cardinality(v_prods) = 1 then
    v_prod := v_prods[1];
    if p_gender is not null then
      update public.products set gender = p_gender where id = v_prod and gender is null;
    end if;
  else
    v_base := trim(both '-' from regexp_replace(
                translate(lower(p_name), 'àáâãäåèéêëìíîïòóôõöùúûüçñ', 'aaaaaaeeeeiiiiooooouuuucn'), '[^a-z0-9]+', '-', 'g'));
    if v_base = '' then v_base := 'p-' || substr(md5(v_norm), 1, 10); end if;
    v_base := (select b.slug from public.brands b where b.id = p_brand) || '-' || v_base;
    v_slug := v_base;
    while exists (select 1 from public.products where slug = v_slug) loop
      v_i := v_i + 1;
      if v_i > 50 then return 'slug_exhausted'; end if;
      v_slug := v_base || '-' || v_i;
    end loop;
    insert into public.products (brand_id, name, slug, gender, status, is_active)
    values (p_brand, private.catalog_display_name(p_name), v_slug, p_gender, 'published', true)
    returning id into v_prod;
  end if;

  insert into public.product_sizes (product_id, size_ml, size_label)
  values (v_prod, p_size, p_size || 'ml')
  on conflict (product_id, size_label) do update set size_ml = excluded.size_ml
  returning id into v_size;

  insert into public.store_products as sp (store_id, product_size_id, price, stock_quantity, is_available, currency, data_source, sync_status, last_synced_at, product_url)
  values (p_store, v_size, round(p_price, 2), p_stock, p_available, 'EGP', p_source, 'synced', now(), nullif(btrim(coalesce(p_url, '')), ''))
  on conflict (store_id, product_size_id) do update
    set price = excluded.price,
        stock_quantity = excluded.stock_quantity,
        is_available = excluded.is_available,
        sync_status = 'synced',
        last_synced_at = now(),
        product_url = coalesce(excluded.product_url, sp.product_url)
    where sp.data_source = excluded.data_source;
  get diagnostics v_rows = row_count;
  if v_rows = 0 then return 'source_conflict'; end if;
  return null;
end
$function$;

-- ---------------------------------------------------------------------------------------------------------------------
-- 7. Release the waiting perfumes of a brand (or of every brand when none is given). One bad item never stops the others:
--    its error is written on its own row and the rest go on.
-- ---------------------------------------------------------------------------------------------------------------------
create or replace function private.catalog_release_waiting(p_brand uuid default null)
returns integer
language plpgsql
security definer
set search_path = public, private, pg_temp
as $function$
declare
  r record;
  v_brand uuid;
  v_reason text;
  n integer := 0;
begin
  for r in
    select w.*
      from public.catalog_waiting_items w
     where w.released_at is null and w.status = 'waiting'
       and (p_brand is null
            or w.brand_norm in (select private.bundle_norm(b.name) from public.brands b where b.id = p_brand and b.is_active
                                union
                                select a.alias_norm from public.catalog_brand_aliases a join public.brands b on b.id = a.brand_id and b.is_active where a.brand_id = p_brand))
     order by w.received_at, w.id
  loop
    begin
      v_brand := private.catalog_resolve_brand(r.brand_norm);
      if v_brand is null then continue; end if;
      v_reason := private.catalog_place_item(r.store_id, v_brand, r.name, r.gender, r.size_ml, r.price, r.stock_quantity, r.is_available, r.product_url, r.data_source);
      if v_reason is null then
        update public.catalog_waiting_items set released_at = now(), last_error = null where id = r.id;
        n := n + 1;
      else
        update public.catalog_waiting_items set status = 'held', reason = v_reason, last_error = null where id = r.id;
      end if;
    exception when others then
      update public.catalog_waiting_items set last_error = left(sqlerrm, 300) where id = r.id;
    end;
  end loop;
  return n;
end
$function$;

-- ---------------------------------------------------------------------------------------------------------------------
-- 8. THE entry point: a store sends perfumes, each is placed or waits (or is refused with its reason, or held for a decision).
--    items: [{brand, name, size_ml, price, stock_quantity, gender?, available?, currency?, product_url?}, ...] (at most 1000).
-- ---------------------------------------------------------------------------------------------------------------------
create or replace function public.catalog_receive_items(p_store_id uuid, p_items jsonb, p_data_source text default 'store_catalog')
returns jsonb
language plpgsql
security definer
set search_path = public, private, pg_temp
as $function$
declare
  v_item jsonb;
  v_pos integer := 0;
  v_results jsonb := '[]'::jsonb;
  v_problem text;
  v_status text;
  v_reason text;
  v_brand text;
  v_name text;
  v_size integer;
  v_price numeric;
  v_stock integer;
  v_available boolean;
  v_gender text;
  v_url text;
  v_bn text;
  v_nn text;
  v_brand_id uuid;
  n_placed integer := 0;
  n_waiting integer := 0;
  n_held integer := 0;
  n_rejected integer := 0;
begin
  if p_store_id is null or not exists (select 1 from public.stores s where s.id = p_store_id) then
    raise exception 'unknown store' using errcode = '22023';
  end if;
  if p_data_source is null or p_data_source not in ('store_catalog', 'trial_catalog') then
    raise exception 'unknown data source' using errcode = '22023';
  end if;
  if p_items is null or jsonb_typeof(p_items) <> 'array' then
    raise exception 'p_items must be a JSON array of objects' using errcode = '22023';
  end if;
  if jsonb_array_length(p_items) > 1000 then
    raise exception 'at most 1000 items per call' using errcode = '22023';
  end if;

  for v_item in select e.value from jsonb_array_elements(p_items) as e loop
    v_pos := v_pos + 1;
    v_status := null;
    v_reason := null;
    v_problem := private.catalog_item_problem(v_item);
    if v_problem is not null then
      v_status := 'rejected';
      v_reason := v_problem;
    else
      v_brand := btrim(v_item ->> 'brand');
      v_name := btrim(v_item ->> 'name');
      v_size := (v_item ->> 'size_ml')::numeric::integer;
      v_price := round((v_item ->> 'price')::numeric, 2);
      v_stock := (v_item ->> 'stock_quantity')::numeric::integer;
      v_gender := nullif(v_item ->> 'gender', '');
      v_url := nullif(btrim(coalesce(v_item ->> 'product_url', '')), '');
      v_available := coalesce(case when jsonb_typeof(v_item -> 'available') = 'boolean' then (v_item ->> 'available')::boolean end, v_stock > 0);
      v_bn := private.bundle_norm(v_brand);
      v_nn := private.bundle_norm(v_name);
      if v_bn = '' then
        v_status := 'rejected'; v_reason := 'brand_missing';
      elsif v_nn = '' then
        v_status := 'rejected'; v_reason := 'name_missing';
      else
        begin
          v_brand_id := private.catalog_resolve_brand(v_bn);
          if v_brand_id is null then
            v_status := 'waiting';
          else
            v_reason := private.catalog_place_item(p_store_id, v_brand_id, v_name, v_gender, v_size, v_price, v_stock, v_available, v_url, p_data_source);
            v_status := case when v_reason is null then 'placed' else 'held' end;
          end if;
        exception when others then
          v_status := 'held';
          v_reason := left(case when sqlerrm = 'ambiguous_brand' then sqlerrm else 'error: ' || sqlerrm end, 200);
        end;

        if v_status in ('waiting', 'held') then
          insert into public.catalog_waiting_items as w
            (store_id, data_source, brand_text, name, size_ml, gender, price, stock_quantity, is_available, product_url, status, reason)
          values (p_store_id, p_data_source, v_brand, v_name, v_size, v_gender, v_price, v_stock, v_available, v_url, v_status, v_reason)
          on conflict (store_id, brand_norm, name_norm, size_ml) do update
            set data_source = excluded.data_source, brand_text = excluded.brand_text, name = excluded.name, gender = excluded.gender,
                price = excluded.price, stock_quantity = excluded.stock_quantity, is_available = excluded.is_available,
                product_url = excluded.product_url, status = excluded.status, reason = excluded.reason,
                released_at = null, last_error = null;
        else
          update public.catalog_waiting_items w
             set released_at = now(), reason = null, last_error = null
           where w.store_id = p_store_id and w.brand_norm = v_bn and w.name_norm = v_nn and w.size_ml = v_size and w.released_at is null;
        end if;
      end if;
    end if;

    if v_status = 'placed' then n_placed := n_placed + 1;
    elsif v_status = 'waiting' then n_waiting := n_waiting + 1;
    elsif v_status = 'held' then n_held := n_held + 1;
    else n_rejected := n_rejected + 1;
    end if;
    v_results := v_results || jsonb_build_array(jsonb_strip_nulls(jsonb_build_object('pos', v_pos, 'status', v_status, 'reason', v_reason)));
  end loop;

  return jsonb_build_object('store_id', p_store_id, 'data_source', p_data_source, 'received', v_pos,
                            'placed', n_placed, 'waiting', n_waiting, 'held', n_held, 'rejected', n_rejected,
                            'items', v_results);
end
$function$;

-- The same release the trigger runs, for the server to call again (a retry, or after a bulk change).
create or replace function public.catalog_release_waiting(p_brand_id uuid default null)
returns integer
language sql
security definer
set search_path = public, private, pg_temp
as $function$
  select private.catalog_release_waiting(p_brand_id);
$function$;

-- ---------------------------------------------------------------------------------------------------------------------
-- 9. Automatic release: a brand card created, renamed or re-activated, or an alias added, places its waiting perfumes.
--    The brand write itself never fails because of the waiting room: a problem is a warning and the items stay waiting.
-- ---------------------------------------------------------------------------------------------------------------------
create or replace function private.brands_release_waiting()
returns trigger
language plpgsql
security definer
set search_path = public, private, pg_temp
as $function$
begin
  if new.is_active then
    begin
      perform private.catalog_release_waiting(new.id);
    exception when others then
      raise warning 'catalog waiting room: release for brand % failed: %', new.id, sqlerrm;
    end;
  end if;
  return null;
end
$function$;

create trigger brands_release_waiting
  after insert or update of name, is_active on public.brands
  for each row execute function private.brands_release_waiting();

create or replace function private.aliases_release_waiting()
returns trigger
language plpgsql
security definer
set search_path = public, private, pg_temp
as $function$
begin
  begin
    perform private.catalog_release_waiting(new.brand_id);
  exception when others then
    raise warning 'catalog waiting room: release for alias % failed: %', new.id, sqlerrm;
  end;
  return null;
end
$function$;

create trigger catalog_brand_aliases_release_waiting
  after insert or update of alias_text, brand_id on public.catalog_brand_aliases
  for each row execute function private.aliases_release_waiting();

-- ---------------------------------------------------------------------------------------------------------------------
-- 10. Who may call what: the server alone.
-- ---------------------------------------------------------------------------------------------------------------------
revoke all on function private.catalog_display_name(text) from public, anon, authenticated;
revoke all on function private.catalog_item_problem(jsonb) from public, anon, authenticated;
revoke all on function private.catalog_resolve_brand(text) from public, anon, authenticated;
revoke all on function private.catalog_place_item(uuid, uuid, text, text, integer, numeric, integer, boolean, text, text) from public, anon, authenticated;
revoke all on function private.catalog_release_waiting(uuid) from public, anon, authenticated;
revoke all on function private.brands_release_waiting() from public, anon, authenticated;
revoke all on function private.aliases_release_waiting() from public, anon, authenticated;
revoke all on function public.catalog_receive_items(uuid, jsonb, text) from public, anon, authenticated;
revoke all on function public.catalog_release_waiting(uuid) from public, anon, authenticated;
grant execute on function public.catalog_receive_items(uuid, jsonb, text) to service_role;
grant execute on function public.catalog_release_waiting(uuid) to service_role;

-- ---------------------------------------------------------------------------------------------------------------------
-- 11. Spellings already agreed in the trial catalogs (the extractor's alias list for the ten brands that existed), plus the one
--     the new card needs ("Khadlaj" for KHADLAJ PERFUMES). Seeded only where the brand card exists.
-- ---------------------------------------------------------------------------------------------------------------------
insert into public.catalog_brand_aliases (brand_id, alias_text)
select b.id, v.alias_text
  from (values
    ('afnan', 'Afnan Perfumes'),
    ('afnan', 'Afnan Perfumes Egypt'),
    ('arabiyat-prestige', 'Arabiyat'),
    ('lattafa', 'Lattafa Perfumes'),
    ('maison-alhambra', 'Alhambra'),
    ('khadlaj-perfumes', 'Khadlaj')
  ) as v(slug, alias_text)
  join public.brands b on b.slug = v.slug
on conflict (alias_norm) do nothing;
