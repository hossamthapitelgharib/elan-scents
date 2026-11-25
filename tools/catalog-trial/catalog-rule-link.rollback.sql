-- Rollback of catalog_rule_link (draft, tools/catalog-trial/catalog-rule-link.sql): puts the two functions back as the waiting room migration
-- (20261121193245_catalog_waiting_room) wrote them, drops everything the link added.
-- WARNING: this loses data the link holds.
--   * the owner's answers on doubtful products (table public.catalog_owner_decisions), the offer sections kept with waiting perfumes
--     (catalog_waiting_items.offers), the merchant's product keys and review notes of the bundles (store_bundles.source_key / review_note / offer_titles)
--     and the data-source mark of catalog-written offer messages (offers.catalog_source) are dropped with their columns; take a copy first if they matter;
--   * the bundles, offer messages and perfumes already written stay as ordinary rows of their own tables and are NOT touched.
begin;

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

drop function if exists public.catalog_record_decision(uuid, text, text, text);
drop function if exists public.catalog_review_queue();
drop function if exists private.catalog_receive_bundle(uuid, jsonb, text);
drop function if exists private.catalog_bundle_problem(jsonb);
drop function if exists private.catalog_apply_offers(uuid, uuid, text, text[]);
drop function if exists private.catalog_size_id(uuid, text, integer);
drop function if exists private.catalog_offer_titles(jsonb);
drop function if exists private.catalog_offers_problem(jsonb);
drop function if exists private.catalog_source_key(text);

drop table if exists public.catalog_owner_decisions;

alter table public.catalog_waiting_items drop constraint if exists catalog_waiting_items_offers_array;
alter table public.catalog_waiting_items drop column if exists offers;

drop index if exists public.offers_catalog_title_uq;
alter table public.offers drop constraint if exists offers_catalog_source_check;
alter table public.offers drop column if exists catalog_source;

drop index if exists public.store_bundles_source_key_uq;
alter table public.store_bundles drop constraint if exists store_bundles_source_key_len;
alter table public.store_bundles drop column if exists source_key, drop column if exists review_note, drop column if exists offer_titles;

revoke all on function public.catalog_receive_items(uuid, jsonb, text) from public, anon, authenticated;
grant execute on function public.catalog_receive_items(uuid, jsonb, text) to service_role;

commit;
