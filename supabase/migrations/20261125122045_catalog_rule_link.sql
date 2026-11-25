-- Catalog rule link (owner's decisions of 23 and 24 Nov 2026).
--
-- STATUS: applied on the live database on 2026-11-25 after the owner's approval card ("apply it and record his two decisions, load nothing").
-- It was tested first inside a transaction that was rolled back (tests/catalog-rule-link.test.sql). The undo script is supabase/rollback/<same version>_catalog_rule_link.sql.
--
-- WHAT IT DOES. The automatic rule (lib/catalog-classify.js) reads what the MERCHANT wrote: section names, labels, title, description. This migration lets
-- the ONE entry point public.catalog_receive_items carry the rule's answer, so nothing is picked by hand and nothing is redone when real stores are linked:
--   * a perfume item may carry `offers`: the names of the merchant's offer sections it is in. They are saved as offer messages on that perfume's size
--     (and wait with a perfume whose brand has no card yet, written when it is released from the waiting room). No price is ever touched.
--   * an item with kind = 'bundle' is a store product the rule found to be a bundle: written with the merchant's own title and FULL text, its contents
--     lines as pieces. A SURE bundle is published; a DOUBTFUL one is written as a draft (hidden from visitors) with the rule's reasons, and waits
--     for the owner.
--   * the owner's answer on a doubtful product is kept once, per store and product, in catalog_owner_decisions, and is honoured on every later sync.
-- Nothing a visitor sees changes until a caller starts sending these fields. Everything here is server-only (no grant to anon or authenticated,
-- RLS on with no policy, functions executable by service_role only).

-- ---------------------------------------------------------------------------------------------------------------------
-- 1. Columns
-- ---------------------------------------------------------------------------------------------------------------------
alter table public.store_bundles
  add column if not exists source_key text,                                   -- the merchant's own product handle: the key of this product across syncs
  add column if not exists review_note text,                                  -- why the rule was in doubt (the owner reads it)
  add column if not exists offer_titles text[] not null default '{}';        -- the merchant's offer sections this bundle is in (shown later)
alter table public.store_bundles
  add constraint store_bundles_source_key_len check (source_key is null or char_length(source_key) between 1 and 300);
create unique index store_bundles_source_key_uq on public.store_bundles (store_id, source_key) where source_key is not null;

alter table public.offers
  add column if not exists catalog_source text;                               -- 'store_catalog' | 'trial_catalog' for a message the catalog wrote; null = written by hand
alter table public.offers
  add constraint offers_catalog_source_check check (catalog_source is null or catalog_source in ('store_catalog', 'trial_catalog'));
create unique index offers_catalog_title_uq on public.offers (store_id, product_size_id, lower(btrim(title)))
  where catalog_source is not null and product_size_id is not null;

alter table public.catalog_waiting_items
  add column if not exists offers jsonb not null default '[]'::jsonb;        -- the offer sections of a perfume that waits for its brand card
alter table public.catalog_waiting_items
  add constraint catalog_waiting_items_offers_array check (jsonb_typeof(offers) = 'array' and jsonb_array_length(offers) <= 20);

create table public.catalog_owner_decisions (
  id uuid primary key default gen_random_uuid(),
  store_id uuid not null references public.stores (id) on delete cascade,
  source_key text not null check (char_length(source_key) between 1 and 300),
  decision text not null check (decision in ('bundle', 'not_bundle')),
  note text check (note is null or char_length(note) <= 500),
  decided_at timestamptz not null default now()
);
create unique index catalog_owner_decisions_key on public.catalog_owner_decisions (store_id, source_key);
alter table public.catalog_owner_decisions enable row level security;
revoke all on table public.catalog_owner_decisions from public, anon, authenticated;

-- ---------------------------------------------------------------------------------------------------------------------
-- 2. Small helpers
-- ---------------------------------------------------------------------------------------------------------------------
create or replace function private.catalog_source_key(p text)
returns text
language sql
immutable
set search_path = pg_catalog
as $function$
  select nullif(lower(btrim(coalesce(p, ''))), '');
$function$;

-- offers: absent or null is fine; otherwise a JSON array of at most 20 non-empty strings of at most 200 characters
create or replace function private.catalog_offers_problem(p jsonb)
returns text
language plpgsql
immutable
set search_path = pg_catalog
as $function$
declare
  e jsonb;
begin
  if p is null or jsonb_typeof(p) = 'null' then return null; end if;
  if jsonb_typeof(p) <> 'array' then return 'offers_invalid'; end if;
  if jsonb_array_length(p) > 20 then return 'offers_invalid'; end if;
  for e in select x.value from jsonb_array_elements(p) as x loop
    if jsonb_typeof(e) <> 'string' then return 'offers_invalid'; end if;
    if char_length(btrim(e #>> '{}')) not between 1 and 200 then return 'offers_invalid'; end if;
  end loop;
  return null;
end
$function$;

-- the offer names of an item, trimmed, the first spelling of each kept, no repeats
create or replace function private.catalog_offer_titles(p jsonb)
returns text[]
language sql
immutable
set search_path = pg_catalog
as $function$
  select coalesce(array_agg(t order by o), '{}'::text[])
    from (select distinct on (lower(btrim(x.v))) btrim(x.v) as t, x.o
            from jsonb_array_elements_text(case when jsonb_typeof(p) = 'array' then p else '[]'::jsonb end) with ordinality as x(v, o)
           where btrim(x.v) <> ''
           order by lower(btrim(x.v)), x.o) d;
$function$;

-- the size row of a perfume (brand + normalized name + size): null unless there is exactly one
create or replace function private.catalog_size_id(p_brand uuid, p_name text, p_size integer)
returns uuid
language plpgsql
stable
security definer
set search_path = public, private, pg_temp
as $function$
declare
  v_ids uuid[];
begin
  select array_agg(ps.id) into v_ids
    from public.products p join public.product_sizes ps on ps.product_id = p.id
   where p.brand_id = p_brand and private.bundle_norm(p.name) = private.bundle_norm(p_name) and ps.size_label = p_size || 'ml';
  if cardinality(v_ids) = 1 then return v_ids[1]; end if;
  return null;
end
$function$;

-- Writes the merchant's offer sections of ONE perfume size as offer messages. A section the merchant took the product out of makes the message it
-- wrote go quiet (is_active = false): nothing is ever deleted. A message written by hand is adopted when its name is the same; a message another
-- data source wrote is never overwritten.
create or replace function private.catalog_apply_offers(p_store uuid, p_size uuid, p_source text, p_titles text[])
returns integer
language plpgsql
security definer
set search_path = public, private, pg_temp
as $function$
declare
  t text;
  n integer := 0;
begin
  update public.offers o set is_active = false
   where o.store_id = p_store and o.product_size_id = p_size and o.catalog_source = p_source and o.is_active
     and lower(btrim(o.title)) <> all (coalesce(p_titles, '{}'::text[]));
  foreach t in array coalesce(p_titles, '{}'::text[]) loop
    update public.offers o set is_active = true, catalog_source = p_source
     where o.store_id = p_store and o.product_size_id = p_size and o.kind = 'offer'
       and lower(btrim(o.title)) = lower(btrim(t)) and (o.catalog_source is null or o.catalog_source = p_source);
    if found then
      n := n + 1;
    else
      insert into public.offers (store_id, product_size_id, title, kind, is_active, catalog_source)
      values (p_store, p_size, left(btrim(t), 200), 'offer', true, p_source)
      on conflict do nothing;
      if found then n := n + 1; end if;
    end if;
  end loop;
  return n;
end
$function$;

-- ---------------------------------------------------------------------------------------------------------------------
-- 3. A bundle item is checked before anything is written (a bad one is refused with its reason and never stops the others)
-- ---------------------------------------------------------------------------------------------------------------------
create or replace function private.catalog_bundle_problem(p jsonb)
returns text
language plpgsql
immutable
set search_path = pg_catalog
as $function$
declare
  e jsonb;
  v text;
begin
  if jsonb_typeof(p) is distinct from 'object' then return 'not_an_object'; end if;

  if jsonb_typeof(p -> 'source_key') is distinct from 'string' then return 'source_key_missing'; end if;
  if btrim(p ->> 'source_key') = '' or char_length(p ->> 'source_key') > 300 then return 'source_key_missing'; end if;

  if jsonb_typeof(p -> 'title') is distinct from 'string' then return 'title_missing'; end if;
  if btrim(p ->> 'title') = '' or char_length(btrim(p ->> 'title')) > 300 then return 'title_missing'; end if;

  if jsonb_typeof(p -> 'bundle') is distinct from 'string' or (p ->> 'bundle') not in ('yes', 'review') then return 'bundle_state_invalid'; end if;

  if jsonb_typeof(p -> 'description') is not null and jsonb_typeof(p -> 'description') <> 'null' then
    if jsonb_typeof(p -> 'description') <> 'string' or char_length(p ->> 'description') > 20000 then return 'description_invalid'; end if;
  end if;

  if jsonb_typeof(p -> 'price') is distinct from 'number' then return 'price_invalid'; end if;
  if round((p ->> 'price')::numeric, 2) <= 0 or (p ->> 'price')::numeric > 10000000 then return 'price_invalid'; end if;

  if jsonb_typeof(p -> 'stock_quantity') is distinct from 'number' then return 'stock_invalid'; end if;
  if (p ->> 'stock_quantity')::numeric <> trunc((p ->> 'stock_quantity')::numeric) or (p ->> 'stock_quantity')::numeric not between 0 and 1000000 then return 'stock_invalid'; end if;

  if jsonb_typeof(p -> 'currency') is not null and jsonb_typeof(p -> 'currency') <> 'null' then
    if jsonb_typeof(p -> 'currency') <> 'string' or upper(btrim(p ->> 'currency')) <> 'EGP' then return 'currency_not_egp'; end if;
  end if;

  if jsonb_typeof(p -> 'available') is not null and jsonb_typeof(p -> 'available') <> 'null' then
    if jsonb_typeof(p -> 'available') <> 'boolean' then return 'available_invalid'; end if;
  end if;

  if jsonb_typeof(p -> 'product_url') is not null and jsonb_typeof(p -> 'product_url') <> 'null' then
    if jsonb_typeof(p -> 'product_url') <> 'string' then return 'url_invalid'; end if;
    if btrim(p ->> 'product_url') <> '' then
      if char_length(p ->> 'product_url') > 2000 or (p ->> 'product_url') !~* '^https?://[^[:space:]]+$' then return 'url_invalid'; end if;
    end if;
  end if;

  if jsonb_typeof(p -> 'brand') is not null and jsonb_typeof(p -> 'brand') <> 'null' then
    if jsonb_typeof(p -> 'brand') <> 'string' or char_length(p ->> 'brand') > 120 then return 'brand_invalid'; end if;
  end if;

  if jsonb_typeof(p -> 'pieces') is not null and jsonb_typeof(p -> 'pieces') <> 'null' then
    if jsonb_typeof(p -> 'pieces') <> 'array' or jsonb_array_length(p -> 'pieces') > 40 then return 'pieces_invalid'; end if;
    for e in select x.value from jsonb_array_elements(p -> 'pieces') as x loop
      if jsonb_typeof(e) <> 'string' or char_length(btrim(e #>> '{}')) > 200 then return 'pieces_invalid'; end if;
    end loop;
  end if;

  if jsonb_typeof(p -> 'reasons') is not null and jsonb_typeof(p -> 'reasons') <> 'null' then
    if jsonb_typeof(p -> 'reasons') <> 'array' or jsonb_array_length(p -> 'reasons') > 20 then return 'reasons_invalid'; end if;
    for e in select x.value from jsonb_array_elements(p -> 'reasons') as x loop
      if jsonb_typeof(e) <> 'string' then return 'reasons_invalid'; end if;
    end loop;
  end if;

  v := private.catalog_offers_problem(p -> 'offers');
  if v is not null then return v; end if;
  return null;
end
$function$;

-- ---------------------------------------------------------------------------------------------------------------------
-- 4. One bundle product from a store. The owner's decision (if any) wins over the rule; the rule's 'yes' publishes; its 'review' waits as a draft.
--    A bundle stands on its own: its pieces are the merchant's contents lines as text, and a bundle written this way carries no composition key,
--    so it is never merged with another store's bundle (it never hides, and is never hidden by, another store's offer).
--    An older bundle of the same store (found by the merchant's product link) is ADOPTED, not duplicated: its pieces stay as they are.
-- ---------------------------------------------------------------------------------------------------------------------
create or replace function private.catalog_receive_bundle(p_store uuid, p_item jsonb, p_source text)
returns jsonb
language plpgsql
security definer
set search_path = public, private, pg_temp
as $function$
declare
  v_problem text;
  v_key text; v_title text; v_desc text; v_price numeric; v_stock integer; v_avail boolean; v_url text;
  v_rule text; v_decision text; v_final text;
  v_brand_text text; v_brand_id uuid;
  v_offers text[]; v_note text;
  v_ex record; v_bundle uuid; v_sole boolean;
  v_base text; v_slug text; v_i integer := 1;
  v_piece text; v_ml integer;
begin
  v_problem := private.catalog_bundle_problem(p_item);
  if v_problem is not null then return jsonb_build_object('status', 'rejected', 'reason', v_problem); end if;

  v_key := private.catalog_source_key(p_item ->> 'source_key');
  v_title := btrim(p_item ->> 'title');
  v_desc := nullif(btrim(coalesce(p_item ->> 'description', '')), '');
  v_price := round((p_item ->> 'price')::numeric, 2);
  v_stock := (p_item ->> 'stock_quantity')::numeric::integer;
  v_avail := coalesce(case when jsonb_typeof(p_item -> 'available') = 'boolean' then (p_item ->> 'available')::boolean end, v_stock > 0);
  v_url := nullif(btrim(coalesce(p_item ->> 'product_url', '')), '');
  v_rule := p_item ->> 'bundle';
  v_offers := private.catalog_offer_titles(p_item -> 'offers');
  v_note := nullif(left(coalesce((select string_agg(x.v, ' | ' order by x.o)
                                    from jsonb_array_elements_text(case when jsonb_typeof(p_item -> 'reasons') = 'array' then p_item -> 'reasons' else '[]'::jsonb end)
                                         with ordinality as x(v, o)), ''), 1000), '');
  v_brand_text := nullif(btrim(coalesce(p_item ->> 'brand', '')), '');

  select d.decision into v_decision from public.catalog_owner_decisions d where d.store_id = p_store and d.source_key = v_key;
  v_final := case v_decision
               when 'bundle' then 'published'
               when 'not_bundle' then 'declined'
               else case when v_rule = 'yes' then 'published' else 'draft' end
             end;

  select sb.id, sb.bundle_id, sb.data_source into v_ex
    from public.store_bundles sb
   where sb.store_id = p_store
     and (sb.source_key = v_key or (sb.source_key is null and v_url is not null and sb.product_url = v_url))
   order by (sb.source_key is not null) desc
   limit 1;

  if v_ex.id is not null then
    if v_ex.data_source <> p_source then return jsonb_build_object('status', 'held', 'reason', 'source_conflict'); end if;
    v_bundle := v_ex.bundle_id;
    v_sole := (select count(*) from public.store_bundles where bundle_id = v_bundle) = 1;
    update public.store_bundles sb
       set source_key = v_key, title = v_title, description = v_desc, price = v_price, stock_quantity = v_stock,
           is_available = v_avail and (v_sole or v_final = 'published'),
           sync_status = 'synced', last_synced_at = now(), product_url = coalesce(v_url, sb.product_url),
           review_note = case when v_final = 'draft' then v_note else null end, offer_titles = v_offers
     where sb.id = v_ex.id;
    if v_sole then
      update public.bundles set status = case when v_final = 'published' then 'published' else 'draft' end, is_active = (v_final <> 'declined')
       where id = v_bundle;
    end if;
  elsif v_final <> 'declined' then
    begin
      v_brand_id := case when v_brand_text is null then null else private.catalog_resolve_brand(private.bundle_norm(v_brand_text)) end;
    exception when others then
      v_brand_id := null;        -- an ambiguous brand is never guessed
    end;
    v_base := trim(both '-' from regexp_replace(
                translate(lower(v_title), 'àáâãäåèéêëìíîïòóôõöùúûüçñ', 'aaaaaaeeeeiiiiooooouuuucn'), '[^a-z0-9]+', '-', 'g'));
    if v_base = '' then v_base := 'bundle-' || substr(md5(v_key), 1, 10); end if;
    v_slug := v_base;
    while exists (select 1 from public.bundles where slug = v_slug) loop
      v_i := v_i + 1;
      if v_i > 50 then return jsonb_build_object('status', 'held', 'reason', 'slug_exhausted'); end if;
      v_slug := v_base || '-' || v_i;
    end loop;
    insert into public.bundles (brand_id, name, slug, has_extra_items, status, is_active)
    values (v_brand_id, left(v_title, 200), v_slug, true, case when v_final = 'published' then 'published' else 'draft' end, true)
    returning id into v_bundle;
    -- the merchant's contents lines, as the merchant wrote them (a size is read from the line when it has one)
    for v_piece in select btrim(x.v) from jsonb_array_elements_text(case when jsonb_typeof(p_item -> 'pieces') = 'array' then p_item -> 'pieces' else '[]'::jsonb end) as x(v) loop
      continue when v_piece = '';
      v_ml := (regexp_match(v_piece, '(\d{1,4})\s*ml', 'i'))[1]::integer;
      if v_ml is not null and v_ml not between 1 and 5000 then v_ml := null; end if;
      insert into public.bundle_items (bundle_id, item_brand, item_name, size_ml, quantity) values (v_bundle, null, left(v_piece, 200), v_ml, 1)
      on conflict do nothing;
    end loop;
    insert into public.store_bundles (store_id, bundle_id, title, description, price, currency, stock_quantity, is_available, data_source, sync_status,
                                      last_synced_at, product_url, source_key, review_note, offer_titles)
    values (p_store, v_bundle, v_title, v_desc, v_price, 'EGP', v_stock, v_avail, p_source, 'synced', now(), v_url, v_key,
            case when v_final = 'draft' then v_note else null end, v_offers);
  end if;

  return jsonb_build_object('status', case v_final when 'published' then 'bundle_published' when 'draft' then 'bundle_review' else 'bundle_declined' end);
exception when others then
  return jsonb_build_object('status', 'held', 'reason', left('error: ' || sqlerrm, 200));
end
$function$;

-- ---------------------------------------------------------------------------------------------------------------------
-- 5. The ONE entry point. Same contract as before (a perfume item is placed, waits or is refused with its reason); in addition
--    an item may carry `offers`, and an item with kind = 'bundle' goes to the bundle path above.
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
  v_note text;
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
  v_kind text;
  v_out jsonb;
  v_has_offers boolean;
  v_offers jsonb;
  v_size_id uuid;
  n_placed integer := 0;
  n_waiting integer := 0;
  n_held integer := 0;
  n_rejected integer := 0;
  n_bundles_published integer := 0;
  n_bundles_review integer := 0;
  n_bundles_declined integer := 0;
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
    v_note := null;
    v_kind := case when jsonb_typeof(v_item) = 'object' then coalesce(v_item ->> 'kind', 'perfume') else 'perfume' end;

    if v_kind = 'bundle' then
      v_out := private.catalog_receive_bundle(p_store_id, v_item, p_data_source);
      v_status := v_out ->> 'status';
      v_reason := v_out ->> 'reason';
    elsif v_kind <> 'perfume' then
      v_status := 'rejected';
      v_reason := 'kind_invalid';
    else
      v_problem := private.catalog_item_problem(v_item);
      if v_problem is null then
        v_problem := private.catalog_offers_problem(v_item -> 'offers');
      end if;
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
        v_has_offers := jsonb_typeof(v_item -> 'offers') = 'array';
        v_offers := case when v_has_offers then to_jsonb(private.catalog_offer_titles(v_item -> 'offers')) else '[]'::jsonb end;
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

          -- the merchant's offer sections of a perfume that is now placed (a perfume that waits keeps them with its waiting row)
          if v_status = 'placed' and v_has_offers then
            begin
              v_size_id := private.catalog_size_id(v_brand_id, v_name, v_size);
              if v_size_id is not null then
                perform private.catalog_apply_offers(p_store_id, v_size_id, p_data_source, private.catalog_offer_titles(v_item -> 'offers'));
              end if;
            exception when others then
              v_note := left('offers_not_saved: ' || sqlerrm, 200);
            end;
          end if;

          if v_status in ('waiting', 'held') then
            insert into public.catalog_waiting_items as w
              (store_id, data_source, brand_text, name, size_ml, gender, price, stock_quantity, is_available, product_url, status, reason, offers)
            values (p_store_id, p_data_source, v_brand, v_name, v_size, v_gender, v_price, v_stock, v_available, v_url, v_status, v_reason, v_offers)
            on conflict (store_id, brand_norm, name_norm, size_ml) do update
              set data_source = excluded.data_source, brand_text = excluded.brand_text, name = excluded.name, gender = excluded.gender,
                  price = excluded.price, stock_quantity = excluded.stock_quantity, is_available = excluded.is_available,
                  product_url = excluded.product_url, status = excluded.status, reason = excluded.reason,
                  offers = case when v_has_offers then excluded.offers else w.offers end,
                  released_at = null, last_error = null;
          else
            update public.catalog_waiting_items w
               set released_at = now(), reason = null, last_error = null
             where w.store_id = p_store_id and w.brand_norm = v_bn and w.name_norm = v_nn and w.size_ml = v_size and w.released_at is null;
          end if;
        end if;
      end if;
    end if;

    if v_status = 'placed' then n_placed := n_placed + 1;
    elsif v_status = 'waiting' then n_waiting := n_waiting + 1;
    elsif v_status = 'held' then n_held := n_held + 1;
    elsif v_status = 'bundle_published' then n_bundles_published := n_bundles_published + 1;
    elsif v_status = 'bundle_review' then n_bundles_review := n_bundles_review + 1;
    elsif v_status = 'bundle_declined' then n_bundles_declined := n_bundles_declined + 1;
    else n_rejected := n_rejected + 1;
    end if;
    v_results := v_results || jsonb_build_array(jsonb_strip_nulls(jsonb_build_object('pos', v_pos, 'status', v_status, 'reason', v_reason, 'note', v_note)));
  end loop;

  return jsonb_build_object('store_id', p_store_id, 'data_source', p_data_source, 'received', v_pos,
                            'placed', n_placed, 'waiting', n_waiting, 'held', n_held, 'rejected', n_rejected,
                            'bundles_published', n_bundles_published, 'bundles_review', n_bundles_review, 'bundles_declined', n_bundles_declined,
                            'items', v_results);
end
$function$;

-- ---------------------------------------------------------------------------------------------------------------------
-- 6. A waiting perfume is released: its offer sections are written with it
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
  v_size uuid;
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
        if jsonb_array_length(r.offers) > 0 then
          v_size := private.catalog_size_id(v_brand, r.name, r.size_ml);
          if v_size is not null then
            perform private.catalog_apply_offers(r.store_id, v_size, r.data_source, private.catalog_offer_titles(r.offers));
          end if;
        end if;
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
-- 7. The owner's answer on a doubtful product: kept once per store and product, applied now to the bundle already written, and honoured on every
--    later sync ('bundle' publishes it, 'not_bundle' hides it and the product is then sent as an ordinary perfume).
-- ---------------------------------------------------------------------------------------------------------------------
create or replace function public.catalog_record_decision(p_store_id uuid, p_source_key text, p_decision text, p_note text default null)
returns jsonb
language plpgsql
security definer
set search_path = public, private, pg_temp
as $function$
declare
  v_key text := private.catalog_source_key(p_source_key);
  v_sb record;
  v_sole boolean;
  v_applied boolean := false;
begin
  if p_store_id is null or not exists (select 1 from public.stores s where s.id = p_store_id) then
    raise exception 'unknown store' using errcode = '22023';
  end if;
  if v_key is null or char_length(v_key) > 300 then
    raise exception 'source_key is required' using errcode = '22023';
  end if;
  if p_decision is null or p_decision not in ('bundle', 'not_bundle') then
    raise exception 'decision is bundle or not_bundle' using errcode = '22023';
  end if;

  insert into public.catalog_owner_decisions (store_id, source_key, decision, note)
  values (p_store_id, v_key, p_decision, left(p_note, 500))
  on conflict (store_id, source_key) do update set decision = excluded.decision, note = excluded.note, decided_at = now();

  select sb.id, sb.bundle_id into v_sb from public.store_bundles sb where sb.store_id = p_store_id and sb.source_key = v_key;
  if v_sb.id is not null then
    v_sole := (select count(*) from public.store_bundles where bundle_id = v_sb.bundle_id) = 1;
    if v_sole then
      update public.bundles set status = case when p_decision = 'bundle' then 'published' else 'draft' end, is_active = (p_decision = 'bundle')
       where id = v_sb.bundle_id;
      v_applied := true;
    end if;
    update public.store_bundles set review_note = null where id = v_sb.id;
  end if;
  return jsonb_build_object('store_id', p_store_id, 'source_key', v_key, 'decision', p_decision, 'bundle_found', v_sb.id is not null, 'applied_now', v_applied);
end
$function$;

-- what still waits for the owner: the draft bundles nobody has decided on
create or replace function public.catalog_review_queue()
returns table (store_id uuid, store_name text, source_key text, title text, price numeric, product_url text, reasons text, waiting_since timestamptz)
language sql
stable
security definer
set search_path = public, private, pg_temp
as $function$
  select sb.store_id, s.name, sb.source_key, sb.title, sb.price, sb.product_url, sb.review_note, sb.created_at
    from public.store_bundles sb
    join public.stores s on s.id = sb.store_id
    join public.bundles b on b.id = sb.bundle_id
   where b.status = 'draft' and sb.review_note is not null and sb.source_key is not null
     and not exists (select 1 from public.catalog_owner_decisions d where d.store_id = sb.store_id and d.source_key = sb.source_key)
   order by s.name, sb.title;
$function$;

-- ---------------------------------------------------------------------------------------------------------------------
-- 8. Server-only
-- ---------------------------------------------------------------------------------------------------------------------
revoke all on function private.catalog_source_key(text) from public, anon, authenticated;
revoke all on function private.catalog_offers_problem(jsonb) from public, anon, authenticated;
revoke all on function private.catalog_offer_titles(jsonb) from public, anon, authenticated;
revoke all on function private.catalog_size_id(uuid, text, integer) from public, anon, authenticated;
revoke all on function private.catalog_apply_offers(uuid, uuid, text, text[]) from public, anon, authenticated;
revoke all on function private.catalog_bundle_problem(jsonb) from public, anon, authenticated;
revoke all on function private.catalog_receive_bundle(uuid, jsonb, text) from public, anon, authenticated;
revoke all on function public.catalog_receive_items(uuid, jsonb, text) from public, anon, authenticated;
revoke all on function public.catalog_record_decision(uuid, text, text, text) from public, anon, authenticated;
revoke all on function public.catalog_review_queue() from public, anon, authenticated;
grant execute on function public.catalog_receive_items(uuid, jsonb, text) to service_role;
grant execute on function public.catalog_record_decision(uuid, text, text, text) to service_role;
grant execute on function public.catalog_review_queue() to service_role;
