import json,re,sys
d=json.load(open('plan.json',encoding='utf-8'))['products']
code={'Afnan Egypt':'A','Emarati Scents':'E'}
out=[]
for p in d:
    simple=re.sub(r'[^a-z0-9]+','-',(p['brand']+' '+p['name']).lower()).strip('-')
    sizes=[]
    for k,ls in p['sizes'].items():
        ml=int(float(k)); assert ml==float(k)
        sizes.append([ml,[[code[l['store']],l['price'],1 if l['available'] else 0,l['handle']] for l in ls]])
    out.append([p['brand'],p['name'],p['gender'] or '',p['slug'] if p['slug']!=simple else '',sizes])
def block(items):
    j=json.dumps(items,ensure_ascii=False,separators=(',',':'))
    assert '$json$' not in j
    ns=sum(len(p[4]) for p in items); nl=sum(len(s[1]) for p in items for s in p[4])
    return f"""begin;
do $load$
declare j jsonb := $json${j}$json$::jsonb; p jsonb; s jsonb; l jsonb; v_brand uuid; v_prod uuid; v_size uuid; v_store uuid; v_slug text; np int:=0; ns int:=0; nl int:=0;
begin
  for p in select * from jsonb_array_elements(j) loop
    select id into v_brand from public.brands where name = p->>0;
    if v_brand is null then raise exception 'unknown brand %', p->>0; end if;
    v_slug := coalesce(nullif(p->>3,''), trim(both '-' from regexp_replace(lower((p->>0)||' '||(p->>1)), '[^a-z0-9]+', '-', 'g')));
    insert into public.products(brand_id, name, slug, gender, status, is_active)
      values (v_brand, p->>1, v_slug, nullif(p->>2,''), 'published', true)
      on conflict (slug) do update set name = excluded.name returning id into v_prod;
    np := np+1;
    for s in select * from jsonb_array_elements(p->4) loop
      insert into public.product_sizes(product_id, size_ml, size_label) values (v_prod, (s->>0)::int, (s->>0)||'ml')
        on conflict (product_id, size_label) do update set size_ml = excluded.size_ml returning id into v_size;
      ns := ns+1;
      for l in select * from jsonb_array_elements(s->1) loop
        select id into v_store from public.stores where name = case l->>0 when 'A' then 'Afnan Egypt' else 'Emarati Scents' end;
        if v_store is null then raise exception 'unknown store %', l->>0; end if;
        insert into public.store_products(store_id, product_size_id, price, stock_quantity, is_available, currency, data_source, sync_status, last_synced_at, product_url)
          values (v_store, v_size, (l->>1)::numeric, case when (l->>2)='1' then 10 else 0 end, (l->>2)='1', 'EGP', 'trial_catalog', 'synced', now(),
                  case l->>0 when 'A' then 'https://egypt.afnan.com/products/' else 'https://emaratiscents.com/products/' end || (l->>3))
        on conflict (store_id, product_size_id) do update set price = excluded.price, stock_quantity = excluded.stock_quantity, is_available = excluded.is_available, last_synced_at = now(), product_url = excluded.product_url
          where store_products.data_source = 'trial_catalog';
        nl := nl+1;
      end loop;
    end loop;
  end loop;
  if np <> {len(items)} or ns <> {ns} or nl <> {nl} then raise exception 'unexpected counts % % %', np, ns, nl; end if;
end $load$;
commit;
select count(*) filter (where data_source='trial_catalog') as trial_rows, count(*) as all_rows from public.store_products;"""
n=int(sys.argv[1])
for i in range(0,len(out),n):
    sql=block(out[i:i+n]); open(f'load_chunk_{i//n+1}.sql','w',encoding='utf-8').write(sql)
    print('chunk',i//n+1,len(out[i:i+n]),'products',len(sql),'bytes')
