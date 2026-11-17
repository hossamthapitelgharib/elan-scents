import json,sys
mode=sys.argv[1]  # rollback | commit
# [name, slug, brand-or-'' , has_extra, [[brand,perfume,ml,qty],...], price, store handle]
B=[
 ["The New King's Bundle","the-new-kings-bundle","",False,[["ARABIYAT PRESTIGE","Marwa Extrait",60,1],["AFNAN","Supremacy Collector's Edition",100,1]],4350,"the-new-kings-bundle"],
 ["Fresh Rush Bundle","fresh-rush-bundle","",False,[["RASASI","Hawas Ice",100,1],["ARABIYAT PRESTIGE","Marwa",100,1]],3400,"fresh-rush-bundle"],
 ["Angham Duo Bundle","angham-duo-bundle","LATTAFA",False,[["LATTAFA","Angham",100,1],["LATTAFA","Angham Second Song",100,1]],2400,"angham-duo-budnle"],
 ["Zeina's Allure Bundle","zeinas-allure-bundle","LATTAFA",False,[["LATTAFA","Opulent Dubai",100,1],["LATTAFA","Nebras",100,1],["LATTAFA","Ameerat Al Arab",100,1]],3000,"new-zeinas-bundle"],
 ["Jamila's Bundle","jamilas-bundle","",False,[["LATTAFA","Petra Viola",100,1],["LATTAFA","Ajwad Pink To Pink Creamy Elixir",60,1],["Maison Alhambra","Delilah Viola",100,1]],4000,"jamilas-bundle"],
 ["Yara Candy Gift Set","yara-candy-gift-set","LATTAFA",True,[["LATTAFA","Yara Candy",100,1]],1900,"yara-candy-gift-set"],
 ["Nebras Gift Set","nebras-gift-set","LATTAFA",True,[["LATTAFA","Nebras",100,1]],2250,"nebras-gift-set"],
 ["Teriaq Gift Set","teriaq-gift-set","LATTAFA",True,[["LATTAFA","Teriaq",100,1]],2350,"teriaq-gift-set"],
]
sale=json.load(open('offers/offers/afnan-egypt-col-11-11-sale.json',encoding='utf-8'))
sale=sale if isinstance(sale,list) else sale.get('products',sale)
handles=[x['handle'] for x in sale]
nitems=sum(len(b[4]) for b in B); nkeyed=sum(1 for b in B if not b[3])
j=json.dumps(B,ensure_ascii=False,separators=(',',':')); h=json.dumps(handles,separators=(',',':'))
assert '$json$' not in j
sql=f"""begin;
do $t$
declare j jsonb := $json${j}$json$::jsonb; sale jsonb := $json${h}$json$::jsonb;
  b jsonb; it jsonb; v_bundle uuid; v_brand uuid; v_size uuid; v_emarati uuid; v_afnan uuid; nb int:=0; ni int:=0; nsb int:=0; no int:=0; n int;
begin
  select id into v_emarati from public.stores where name='Emarati Scents';
  select id into v_afnan from public.stores where name='Afnan Egypt';
  if v_emarati is null or v_afnan is null then raise exception 'store missing'; end if;
  for b in select * from jsonb_array_elements(j) loop
    v_brand := null;
    if b->>2 <> '' then select id into v_brand from public.brands where name = b->>2; if v_brand is null then raise exception 'unknown brand %', b->>2; end if; end if;
    insert into public.bundles(brand_id,name,slug,has_extra_items,status,is_active)
      values (v_brand, b->>0, b->>1, (b->>3)::boolean, 'published', true)
      on conflict (slug) do update set name=excluded.name, brand_id=excluded.brand_id, has_extra_items=excluded.has_extra_items returning id into v_bundle;
    nb := nb+1;
    for it in select * from jsonb_array_elements(b->4) loop
      select ps.id into v_size from public.product_sizes ps join public.products p on p.id=ps.product_id join public.brands br on br.id=p.brand_id
        where br.name = it->>0 and p.name = it->>1 and ps.size_ml = (it->>2)::int;
      if v_size is null then raise exception 'item not found: % % %', it->>0, it->>1, it->>2; end if;
      insert into public.bundle_items(bundle_id,product_size_id,quantity) values (v_bundle, v_size, (it->>3)::int)
        on conflict (bundle_id,product_size_id) do update set quantity = excluded.quantity;
      ni := ni+1;
    end loop;
    insert into public.store_bundles(store_id,bundle_id,price,currency,stock_quantity,is_available,data_source,sync_status,last_synced_at,product_url)
      values (v_emarati, v_bundle, (b->>5)::numeric, 'EGP', 10, true, 'trial_catalog', 'synced', now(), 'https://emaratiscents.com/products/'||(b->>6))
      on conflict (store_id,bundle_id) do update set price=excluded.price, stock_quantity=excluded.stock_quantity, is_available=excluded.is_available, last_synced_at=now(), product_url=excluded.product_url
        where store_bundles.data_source='trial_catalog';
    nsb := nsb+1;
  end loop;
  if nb<>{len(B)} or ni<>{nitems} or nsb<>{len(B)} then raise exception 'bundle counts % % %', nb, ni, nsb; end if;
  select count(*) into n from public.bundles where composition_key is not null; if n<>{nkeyed} then raise exception 'keyed bundles %', n; end if;
  -- Afnan's own page "11/11 Sale": the store itself announces an occasion offer on each perfume listed in it (an OFFER message, no price is touched)
  insert into public.offers(store_id, product_size_id, title, kind, is_active)
    select v_afnan, sp.product_size_id, '11/11 Sale', 'offer', true
      from jsonb_array_elements_text(sale) h join public.store_products sp on sp.store_id=v_afnan and sp.product_url = 'https://egypt.afnan.com/products/'||h
     where sp.data_source='trial_catalog'
       and not exists (select 1 from public.offers o where o.store_id=v_afnan and o.product_size_id=sp.product_size_id and o.title='11/11 Sale');
  get diagnostics no = row_count;
  raise notice 'discount rows %', no;
end $t$;
set local role anon;
select (select count(*) from public.public_bundles) as anon_bundles,
       (select count(*) from public.public_bundle_items) as anon_items,
       (select count(*) from public.catalog_platform_bundle_offers) as anon_platform_bundle_offers,
       (select min(price) from public.catalog_platform_bundle_offers) as cheapest, (select max(price) from public.catalog_platform_bundle_offers) as dearest,
       (select count(*) from public.catalog_offer_messages where title='11/11 Sale') as anon_1111_offers;
{ 'rollback;' if mode=='rollback' else 'commit;' }
"""
open(f'bundles_{mode}.sql','w',encoding='utf-8').write(sql)
print(mode,len(sql),'bytes','bundles',len(B),'items',nitems,'keyed',nkeyed,'sale handles',len(handles))
