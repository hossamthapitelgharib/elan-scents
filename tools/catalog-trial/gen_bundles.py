#!/usr/bin/env python3
"""Bundles and offer messages loader of the trial catalog (Emarati Scents bundles, Afnan Egypt "11/11 Sale"). Writes bundles_<mode>.sql.
Run: python3 -I gen_bundles.py rollback   (dry run: the whole load, the anonymous view counts, then ROLLBACK)
     python3 -I gen_bundles.py commit     (the same load, committed: only after the owner's approval)

The owner's rules (2026-11-17), docs/catalog-ingestion.ar.md:
  * a bundle stands on its own: its pieces are written EXACTLY as the store lists them (brand, name, size, quantity) as plain text, with NO link to the
    perfume catalog (a size may exist only inside the offer; a perfume the platform does not show never hides a bundle);
  * the bundle shows the store's OWN title and its FULL description (store_bundles.title / .description), never a platform-written one;
  * two stores' bundles are one bundle only when their pieces are the same (the composition key reads pieces only, never a word of the text).
The store's words come from the stores' own pages: CATALOG_FEEDS_DIR (default feeds/feeds) holds emarati-scents-page-N.json.
Loaded rows carry data_source = 'trial_catalog' and are removed in one step. Needs the migration 20261119112905_catalog_bundles_standalone."""
import glob, html, json, os, re, sys

mode = sys.argv[1] if len(sys.argv) > 1 else ''
assert mode in ('rollback', 'commit'), 'usage: gen_bundles.py rollback|commit'
FEEDS = os.environ.get('CATALOG_FEEDS_DIR', 'feeds/feeds')
OFFERS = os.environ.get('CATALOG_OFFERS_DIR', 'offers/offers')

# [platform name, slug, platform brand or '', has_extra_items, [[brand, perfume, ml, qty], ...], store price, store product handle]
# The pieces are the store's own wording of what the bundle holds. A bundle with extra pieces (deodorant, gift box...) keeps only its main perfume here
# and is flagged has_extra_items: it never gets a composition key, so it is never merged with another store's bundle.
B = [
    ["The New King's Bundle", "the-new-kings-bundle", "", False, [["ARABIYAT PRESTIGE", "Marwa Extrait", 60, 1], ["AFNAN", "Supremacy Collector's Edition", 100, 1]], 4350, "the-new-kings-bundle"],
    ["Fresh Rush Bundle", "fresh-rush-bundle", "", False, [["RASASI", "Hawas Ice", 100, 1], ["ARABIYAT PRESTIGE", "Marwa", 100, 1]], 3400, "fresh-rush-bundle"],
    ["Angham Duo Bundle", "angham-duo-bundle", "LATTAFA", False, [["LATTAFA", "Angham", 100, 1], ["LATTAFA", "Angham Second Song", 100, 1]], 2400, "angham-duo-budnle"],
    ["Zeina's Allure Bundle", "zeinas-allure-bundle", "LATTAFA", False, [["LATTAFA", "Opulent Dubai", 100, 1], ["LATTAFA", "Nebras", 100, 1], ["LATTAFA", "Ameerat Al Arab", 100, 1]], 3000, "new-zeinas-bundle"],
    ["Jamila's Bundle", "jamilas-bundle", "", False, [["LATTAFA", "Petra Viola", 100, 1], ["LATTAFA", "Ajwad Pink To Pink Creamy Elixir", 60, 1], ["Maison Alhambra", "Delilah Viola", 100, 1]], 4000, "jamilas-bundle"],
    ["Yara Candy Gift Set", "yara-candy-gift-set", "LATTAFA", True, [["LATTAFA", "Yara Candy", 100, 1]], 1900, "yara-candy-gift-set"],
    ["Nebras Gift Set", "nebras-gift-set", "LATTAFA", True, [["LATTAFA", "Nebras", 100, 1]], 2250, "nebras-gift-set"],
    ["Teriaq Gift Set", "teriaq-gift-set", "LATTAFA", True, [["LATTAFA", "Teriaq", 100, 1]], 2350, "teriaq-gift-set"],
]


def text(h):
    """The store's HTML description as plain text, nothing added and nothing dropped except markup: line breaks and bullets are kept."""
    h = re.sub(r'(?is)<\s*(script|style)\b.*?</\s*\1\s*>', '', h or '')   # code is not the store's words
    h = re.sub(r'(?i)<\s*br\b[^>]*>', '\n', h)              # <br data-start="12" ...> too: the store pages carry attributes
    h = re.sub(r'(?i)</?\s*(ul|ol)\b[^>]*>', '\n', h)
    h = re.sub(r'(?i)</\s*(p|div|li|h[1-6]|tr|table)\s*>', '\n', h)
    h = re.sub(r'(?i)<\s*li\b[^>]*>', '• ', h)
    h = re.sub(r'<[^>]+>', '', h)
    h = html.unescape(h).replace('\xa0', ' ')
    lines, blank = [], 0
    for ln in (x.strip() for x in h.split('\n')):
        if not ln:
            blank += 1
            if blank <= 1 and lines:
                lines.append('')
            continue
        blank = 0
        lines.append(ln)
    return '\n'.join(lines).strip()


feed = {}
for f in sorted(glob.glob(os.path.join(FEEDS, 'emarati-scents-page-*.json'))):
    d = json.load(open(f, encoding='utf-8'))
    for p in (d['products'] if isinstance(d, dict) else d):
        feed[p['handle']] = p

bundles = []
for name, slug, brand, extra, pieces, price, handle in B:
    page = feed.get(handle)
    assert page, f'the store page of {handle} is not in {FEEDS}'
    title, description = (page['title'] or '').strip(), text(page.get('body_html'))
    assert 1 <= len(title) <= 300, f'{handle}: the store title is {len(title)} characters'
    assert len(description) <= 20000, f'{handle}: the store description is {len(description)} characters'
    bundles.append({'name': name, 'slug': slug, 'brand': brand, 'extra': extra, 'pieces': pieces, 'price': price, 'handle': handle,
                    'title': title, 'description': description})

sale = json.load(open(os.path.join(OFFERS, 'afnan-egypt-col-11-11-sale.json'), encoding='utf-8'))
sale = sale if isinstance(sale, list) else sale.get('products', sale)
handles = [x['handle'] for x in sale]
npieces = sum(len(b['pieces']) for b in bundles)
nkeyed = sum(1 for b in bundles if not b['extra'])
j = json.dumps(bundles, ensure_ascii=False, separators=(',', ':'))
h = json.dumps(handles, separators=(',', ':'))
assert '$json$' not in j and '$json$' not in h
sql = f"""begin;
do $t$
declare j jsonb := $json${j}$json$::jsonb; sale jsonb := $json${h}$json$::jsonb;
  b jsonb; it jsonb; v_bundle uuid; v_brand uuid; v_emarati uuid; v_afnan uuid; nb int:=0; ni int:=0; nsb int:=0; no int:=0; n int;
begin
  select id into v_emarati from public.stores where name='Emarati Scents';
  select id into v_afnan from public.stores where name='Afnan Egypt';
  if v_emarati is null or v_afnan is null then raise exception 'store missing'; end if;
  for b in select * from jsonb_array_elements(j) loop
    v_brand := null;
    if b->>'brand' <> '' then select id into v_brand from public.brands where name = b->>'brand'; if v_brand is null then raise exception 'unknown brand %', b->>'brand'; end if; end if;
    insert into public.bundles(brand_id,name,slug,has_extra_items,status,is_active)
      values (v_brand, b->>'name', b->>'slug', (b->>'extra')::boolean, 'published', true)
      on conflict (slug) do update set name=excluded.name, brand_id=excluded.brand_id, has_extra_items=excluded.has_extra_items returning id into v_bundle;
    nb := nb+1;
    -- the pieces, as text, exactly as the store lists them: no lookup in the perfume catalog
    for it in select * from jsonb_array_elements(b->'pieces') loop
      insert into public.bundle_items(bundle_id,item_brand,item_name,size_ml,quantity) values (v_bundle, it->>0, it->>1, (it->>2)::int, (it->>3)::int)
        on conflict (bundle_id, private.bundle_norm(item_brand), private.bundle_norm(item_name), coalesce(size_ml,0)) do update set quantity = excluded.quantity;
      ni := ni+1;
    end loop;
    -- the store's own title and full description travel with its offer
    insert into public.store_bundles(store_id,bundle_id,title,description,price,currency,stock_quantity,is_available,data_source,sync_status,last_synced_at,product_url)
      values (v_emarati, v_bundle, b->>'title', nullif(b->>'description',''), (b->>'price')::numeric, 'EGP', 10, true, 'trial_catalog', 'synced', now(), 'https://emaratiscents.com/products/'||(b->>'handle'))
      on conflict (store_id,bundle_id) do update set title=excluded.title, description=excluded.description, price=excluded.price, stock_quantity=excluded.stock_quantity, is_available=excluded.is_available, last_synced_at=now(), product_url=excluded.product_url
        where store_bundles.data_source='trial_catalog';
    nsb := nsb+1;
  end loop;
  if nb<>{len(bundles)} or ni<>{npieces} or nsb<>{len(bundles)} then raise exception 'bundle counts % % %', nb, ni, nsb; end if;
  select count(*) into n from public.bundles where composition_key is not null; if n<>{nkeyed} then raise exception 'keyed bundles %', n; end if;
  select count(*) into n from public.bundle_items; if n<>{npieces} then raise exception 'pieces in the table % (expected {npieces}): an old piece was left behind', n; end if;
  -- Afnan's own page "11/11 Sale": the store itself announces an occasion offer on each perfume listed in it (an OFFER message, no price is touched)
  insert into public.offers(store_id, product_size_id, title, kind, is_active)
    select v_afnan, sp.product_size_id, '11/11 Sale', 'offer', true
      from jsonb_array_elements_text(sale) h join public.store_products sp on sp.store_id=v_afnan and sp.product_url = 'https://egypt.afnan.com/products/'||h
     where sp.data_source='trial_catalog'
       and not exists (select 1 from public.offers o where o.store_id=v_afnan and o.product_size_id=sp.product_size_id and o.title='11/11 Sale');
  get diagnostics no = row_count;
  raise notice 'offer rows %', no;
end $t$;
set local role anon;
select (select count(*) from public.public_bundles) as anon_bundles,
       (select count(*) from public.public_bundle_items) as anon_pieces,
       (select count(*) from public.catalog_platform_bundle_offers) as anon_platform_bundle_offers,
       (select count(*) from public.catalog_platform_bundle_offers where title is not null and description is not null) as with_store_text,
       (select min(price) from public.catalog_platform_bundle_offers) as cheapest, (select max(price) from public.catalog_platform_bundle_offers) as dearest,
       (select count(*) from public.catalog_offer_messages where title='11/11 Sale') as anon_1111_offers;
{ 'rollback;' if mode == 'rollback' else 'commit;' }
"""
open(f'bundles_{mode}.sql', 'w', encoding='utf-8').write(sql)
print(mode, len(sql), 'bytes', 'bundles', len(bundles), 'pieces', npieces, 'keyed', nkeyed, 'sale handles', len(handles))
for b in bundles:
    print(' ', b['handle'], '|', b['title'], '|', len(b['description']), 'chars')
