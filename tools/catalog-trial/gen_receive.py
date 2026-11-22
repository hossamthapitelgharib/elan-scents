#!/usr/bin/env python3
"""Builds the SQL that hands the trial stores' perfumes to the platform through the ONE entry point public.catalog_receive_items
(migration catalog_waiting_room). Nothing here decides where a perfume goes: the platform does. A perfume whose brand card exists is placed
(product, size, the store's offer); one whose brand card does not exist WAITS in the waiting room and appears by itself the moment a card for
that brand is created. The real store sync will call the very same function with the store's structured fields, so what is built here is not redone
at linking time.

  python3 -I gen_receive.py rollback    # dry run: loads, then ENDS WITH AN INTENTIONAL ERROR whose text is the report (nothing is kept)
  python3 -I gen_receive.py commit      # the same load, committed, then a report read from the real tables

Reads plan.json (perfumes of brands that have a card, merged between the stores by plan.py) and waiting.json (perfumes of brands that have none,
from report2.py) in the current folder. Writes receive_<mode>.sql.
  CATALOG_BRANDS   comma-separated platform brand names to send from plan.json (default: all of them); waiting perfumes are always sent unless
  CATALOG_WAITING=0.
Every row carries data_source = 'trial_catalog' and is removed with one statement (see docs/handoff.ar.md)."""
import collections, json, os, re, sys, unicodedata

mode = sys.argv[1] if len(sys.argv) > 1 else 'rollback'
assert mode in ('rollback', 'commit'), 'mode is rollback or commit'
STORES = {'Afnan Egypt': 'https://egypt.afnan.com/products/', 'Emarati Scents': 'https://emaratiscents.com/products/'}
ORDER = ['Afnan Egypt', 'Emarati Scents']          # the brand's own store first: its spelling of a name is the one that is kept
only = [b.strip() for b in os.environ.get('CATALOG_BRANDS', '').split(',') if b.strip()]
with_waiting = os.environ.get('CATALOG_WAITING', '1') != '0'


def nk(s):
    s = unicodedata.normalize('NFKD', s or '').encode('ascii', 'ignore').decode().lower()
    return re.sub(r'[^a-z0-9]+', '', re.sub(r"\((?:new|old)\s*batch\)", '', s))


items = {s: [] for s in STORES}                    # [brand, name, size_ml, price, stock, gender, handle]
for p in json.load(open('plan.json', encoding='utf-8'))['products']:
    if only and p['brand'] not in only:
        continue
    for k, ls in p['sizes'].items():
        for l in ls:
            items[l['store']].append([p['brand'], p['name'], int(float(k)), l['price'], 10 if l['available'] else 0, p['gender'] or '', l['handle']])

waiting_dupes = []
if with_waiting:
    rows = [(st, r) for st, r in json.load(open('waiting.json', encoding='utf-8'))]
    key = lambda st, r: (st, nk(r['waiting_brand']), nk(r['clean']), int(r['size_ml']))
    count = collections.Counter(key(st, r) for st, r in rows)
    for st, r in rows:
        if count[key(st, r)] > 1:                  # two pages of one store with the same brand, name and size: ambiguous, never guessed
            waiting_dupes.append((st, r['title']))
            continue
        name = r['clean'].replace('’', "'").replace('‘', "'")
        store = 'Afnan Egypt' if st == 'afnan' else 'Emarati Scents'
        items[store].append([r['waiting_brand'], name, int(r['size_ml']), r['price'], 10 if r['available'] else 0, r['gender'] or '', r['handle']])

blobs = []
for i, store in enumerate(ORDER, 1):
    j = json.dumps(items[store], ensure_ascii=False, separators=(',', ':'))
    assert f'$j{i}$' not in j
    blobs.append((i, store, j, len(items[store])))
total = sum(b[3] for b in blobs)

values = ',\n    '.join(f"({i}, {store!r}, {STORES[store]!r}, ${'j' + str(i)}${j}${'j' + str(i)}$::jsonb)" for i, store, j, _ in blobs)
sql = f"""begin;
create temp table recv_log (store text, brand text, name text, size_ml integer, status text, reason text);
create temp table recv_before as select now() as ts,
  (select count(*) from public.products) as products, (select count(*) from public.store_products) as offers,
  (select count(*) from public.public_products) as visible;
do $load$
declare
  v_store uuid; v_res jsonb; v_items jsonb; r record; v_off integer; v_n integer;
begin
  for r in select * from (values
    {values}
  ) as t(ord, store, base, compact) order by ord loop
    select id into v_store from public.stores where name = r.store;
    if v_store is null then raise exception 'unknown store %', r.store; end if;
    v_n := jsonb_array_length(r.compact);
    v_off := 0;
    while v_off < v_n loop
      select jsonb_agg(jsonb_build_object('brand', e ->> 0, 'name', e ->> 1, 'size_ml', (e ->> 2)::integer, 'price', (e ->> 3)::numeric,
                                          'stock_quantity', (e ->> 4)::integer, 'gender', nullif(e ->> 5, ''), 'product_url', r.base || (e ->> 6)) order by o)
        into v_items
        from jsonb_array_elements(r.compact) with ordinality as x(e, o) where o > v_off and o <= v_off + 500;
      v_res := public.catalog_receive_items(v_store, v_items, 'trial_catalog');
      if (v_res ->> 'rejected')::integer > 0 then
        raise exception 'the loader sent a refused item: %', (
          select jsonb_agg(jsonb_build_object('store', r.store, 'brand', v_items -> ((i ->> 'pos')::integer - 1) ->> 'brand',
                                              'name', left(v_items -> ((i ->> 'pos')::integer - 1) ->> 'name', 80), 'reason', i ->> 'reason'))
            from jsonb_array_elements(v_res -> 'items') as i where i ->> 'status' = 'rejected');
      end if;
      insert into recv_log
        select r.store, v_items -> (x.pos - 1) ->> 'brand', v_items -> (x.pos - 1) ->> 'name', (v_items -> (x.pos - 1) ->> 'size_ml')::integer, x.status, x.reason
          from jsonb_to_recordset(v_res -> 'items') as x(pos integer, status text, reason text);
      v_off := v_off + 500;
    end loop;
  end loop;
end $load$;
"""
demo = os.environ.get('CATALOG_DEMO_BRAND', '').strip()      # dry run only: create this brand card inside the rolled-back transaction and see its waiting perfumes appear
extra_visible = """,
  'visible_before', (select visible from recv_before), 'visible_after', (select count(*) from public.public_products),
  'visible_by_brand', (select coalesce(jsonb_object_agg(brand, n), '{}'::jsonb) from recv_vis)"""
if demo and mode == 'rollback':
    extra_visible += """,
  'demo_brand_card', %s, 'demo_waiting_before', (select n from recv_demo_before), 'demo_products_after', (select count(*) from public.products p join public.brands b on b.id = p.brand_id where b.slug = 'demo-card-brand'),
  'demo_visible_to_visitor', (select n from recv_demo_vis), 'demo_waiting_left', (select count(*) from public.catalog_waiting_items where brand_norm = private.bundle_norm(%s) and released_at is null)""" % ("'" + demo.replace("'", "''") + "'", "'" + demo.replace("'", "''") + "'")
report = """select jsonb_build_object(
  'sent', (select count(*) from recv_log),
  'by_status', (select jsonb_object_agg(status, n) from (select status, count(*) n from recv_log group by 1) s),
  'held_or_refused', (select coalesce(jsonb_agg(jsonb_build_object('store', store, 'brand', brand, 'name', name, 'size', size_ml, 'reason', reason)), '[]'::jsonb) from recv_log where status in ('held', 'rejected')),
  'products_before', (select products from recv_before), 'products_after', (select count(*) from public.products),
  'offers_before', (select offers from recv_before), 'offers_after', (select count(*) from public.store_products),
  'new_products_by_brand', (select coalesce(jsonb_object_agg(brand, n), '{}'::jsonb)
                              from (select b.name as brand, count(*) n from public.products p join public.brands b on b.id = p.brand_id
                                     where p.created_at >= (select ts from recv_before) group by 1) s),
  'waiting_total', (select count(*) from public.catalog_waiting_items where released_at is null and status = 'waiting'),
  'waiting_by_brand', (select coalesce(jsonb_agg(jsonb_build_object('brand', brand, 'perfumes', n) order by n desc, brand), '[]'::jsonb)
                         from (select upper(min(brand_text)) as brand, count(*) n from public.catalog_waiting_items
                                where released_at is null and status = 'waiting' group by brand_norm) s)"""
if mode == 'rollback':
    if demo:
        q = "'" + demo.replace("'", "''") + "'"
        sql += f"""
create temp table recv_demo_before as select count(*) as n from public.catalog_waiting_items where brand_norm = private.bundle_norm({q}) and released_at is null;
insert into public.brands (name, slug) values ({q}, 'demo-card-brand');
set local role anon;
create temp table recv_demo_vis as select count(*) as n from public.public_products where brand_slug = 'demo-card-brand';
reset role;
"""
    sql += """
set local role anon;
create temp table recv_vis as select b.name as brand, count(*) as n from public.public_products pp join public.brands b on b.id = pp.brand_id group by 1;
reset role;
do $r$
begin
  raise exception 'DRYRUN_REPORT %', (""" + report + extra_visible + """))::text;
end $r$;
"""
else:
    sql += "commit;\n" + report + ");\n"
open(f'receive_{mode}.sql', 'w', encoding='utf-8').write(sql)
print(mode, 'items sent:', {b[1]: b[3] for b in blobs}, 'total', total, 'bytes', len(sql))
if waiting_dupes:
    print('waiting perfumes held back (two pages of one store, same brand + name + size):', waiting_dupes)
