#!/usr/bin/env python3
"""Dry-run extraction of the two stores' PUBLIC product pages. Writes nothing to any database.
Every record keeps WHERE each fact came from, so a doubtful one can be rejected instead of guessed."""
import json, glob, re, html, collections, sys, unicodedata, os

# folder holding the stores' public products.json pages (afnan-egypt-page-1.json, emarati-scents-page-1..N.json); the output files are written to the current folder
F = os.environ.get('CATALOG_FEEDS_DIR', 'feeds') .rstrip('/') + '/'

# The brands that exist on the platform (public_brands, 18 cards on 2026-11-21) and the spellings stores use for them. The platform itself decides
# (the waiting room, public.catalog_receive_items): this list only helps the extractor find which words of a page name the brand.
PLATFORM_BRANDS = {
    'AFNAN': ['afnan', 'afnan perfumes', 'afnan perfumes egypt'],
    'AMOUAGE': ['amouage'],
    'ARABIYAT PRESTIGE': ['arabiyat prestige', 'arabiyat'],
    'ARMAF': ['armaf'],
    'ASSAF': ['assaf'],
    'FRENCH AVENUE': ['french avenue'],
    'GISSAH': ['gissah'],
    'LATTAFA': ['lattafa', 'lattafa perfumes'],
    'Maison Alhambra': ['maison alhambra', 'alhambra'],
    'RASASI': ['rasasi'],
    # the eight cards the owner created on 2026-11-18 (they had no perfumes until the waiting room)
    'Ateej': ['ateej'],
    'KHADLAJ PERFUMES': ['khadlaj', 'khadlaj perfumes'],
    'LAVERNE': ['laverne'],
    'OMANLUXURY': ['oman luxury', 'omanluxury'],
    'ÓSMA': ['osma', 'ósma'],
    'REEF': ['reef'],
    'SEDRA': ['sedra'],
    'SWISS ARABIAN': ['swiss arabian', 'swiss arabian perfumes'],
}
ALIAS = {a: b for b, al in PLATFORM_BRANDS.items() for a in al}

CONC_WORDS = r"(?:eau\s*de\s*(?:parfum|toilette|cologne)|(?:exceptional\s+|concentrated\s+)?extrait(?:\s*de\s*parfum)?|essence\s+de\s+parfum|concentrated\s+(?:perfume|eau\s*de\s*parfum)|parfum|perfume\s*oil|perfume|attar|cologne|elixir(?:\s+de\s+parfum)?)"
CONC_ONLY = re.compile(r"^(?P<c>" + CONC_WORDS + r")$", re.I)
CONC_BRAND = re.compile(r"^(?P<b>[A-Za-z][A-Za-z' &.]*?)\s+(?P<c>" + CONC_WORDS + r")$", re.I)
SIZE = re.compile(r'^(?P<n>\d+(?:\.\d+)?)\s*(?P<u>ml|gm|g)$', re.I)
HEADER_NAME_MAX = 60   # a header "name" longer than this is a description, not a perfume name (see where it is used)
GENDER = re.compile(r'^(?:for\s+)?(?P<g>men|man|women|woman|unisex|pour\s+homme|pour\s+femme|him|her)(?:\s+by\s+(?P<b>.+))?$', re.I)
BYONLY = re.compile(r'^by\s+(?P<b>.+)$', re.I)
GENDER_MAP = {'men': 'men', 'man': 'men', 'pour homme': 'men', 'him': 'men', 'women': 'women', 'woman': 'women',
              'pour femme': 'women', 'her': 'women', 'unisex': 'unisex'}
NOT_PERFUME = re.compile(r'\b(bundle|set|gift|box|duo|trio|collection|sample|discovery|incense|bakhoor|bakhour|mabkhara|burner|oil|attar|serum|deodorant|deodrant|mist|hair|body|powder|\+|candle|diffuser|pcs|pieces|spray|perfum spray)\b|\+', re.I)


def flat(h):
    t = html.unescape(re.sub(r'<[^>]+>', ' ', h or ''))
    t = unicodedata.normalize('NFKC', t)
    return re.sub(r'\s+', ' ', t).strip()


def norm_key(s):
    s = unicodedata.normalize('NFKD', s or '').encode('ascii', 'ignore').decode()
    return re.sub(r'[^a-z0-9]+', '', s.lower())


def brand_of(raw):
    """Returns (platform_brand_or_None, cleaned_raw)."""
    if not raw:
        return None, None
    r = re.sub(r'\s+', ' ', raw).strip(' -–.')
    r = re.sub(r'^by\s+', '', r, flags=re.I)   # "BY GISSAH"
    r = re.sub(r'\s*(perfumes|perfume|fragrances|fragrance)$', '', r, flags=re.I).strip()
    return ALIAS.get(r.lower()) or ALIAS.get(re.sub(r'\s*\(.*\)$', '', r).lower()), r


def parse_header(text):
    """First segment of an Emarati description: NAME – [BRAND ]CONC – SIZE – GENDER [By BRAND] ━━ / DESCRIPTION / CONTENTS."""
    seg = re.split(r'━|\bDESCRIPTION\b|\bCONTENTS\b', text[:400])[0].strip()
    parts = [p.strip() for p in re.split(r'\s[–—-]\s', seg) if p.strip()]
    if len(parts) < 2:
        return None
    out = {'name': parts[0], 'conc': None, 'size': None, 'unit': None, 'gender': None, 'brand_raw': None, 'seg': seg}
    for p in parts[1:]:
        p = re.sub(r'\s*\([^)]*\)', '', p).strip()   # "LATTAFA (Give Me Gourmand Collection) Eau de Parfum" -> "LATTAFA Eau de Parfum"
        p = re.sub(r'\s*\|.*$', '', p).strip()          # "Women By ASSAF | Arrogate Collection" -> "Women By ASSAF"
        if not p:
            continue
        m = SIZE.match(p)
        if m:
            out['size'], out['unit'] = float(m['n']), m['u'].lower(); continue
        m = CONC_ONLY.match(p) or CONC_BRAND.match(p)
        if m:
            out['conc'] = re.sub(r'\s+', ' ', m['c']).title()
            b = m.groupdict().get('b')
            if b: out['brand_raw'] = out['brand_raw'] or b
            continue
        m = GENDER.match(p)
        if m:
            out['gender'] = GENDER_MAP[re.sub(r'\s+', ' ', m['g'].lower())]
            if m['b']: out['brand_raw'] = out['brand_raw'] or m['b']
            continue
        m = BYONLY.match(p)
        if m:
            out['brand_raw'] = out['brand_raw'] or m['b']; continue
        if re.fullmatch(r"[A-Za-z' &().]{3,40}", p) and p.isupper() and not out['brand_raw'] and not p.startswith('BY '):
            out['brand_raw'] = p  # "MAYAR CHERRY INTENSE – LATTAFA"
    return out


def title_brand(title):
    m = re.search(r'\bby\s+([A-Za-z0-9\' &().]+?)\s*$', title, re.I)
    return m.group(1).strip() if m else None


def sentence_brand(text):
    """"<Name> by <Brand> is ..." only for the known platform brands (no guessing of unknown ones)."""
    for alias, b in ALIAS.items():
        if re.search(r'\bby\s+' + re.escape(alias) + r'\b(?!\s*\w*\s*(?:by)\b)', text[:700], re.I):
            return b
    return None


def money(v):
    return None if v in (None, '') else round(float(v), 2)


def emarati(p):
    v = p['variants'][0]
    body = flat(p['body_html'])
    title = p['title'].strip()
    h = parse_header(body)
    rec = {'store': 'Emarati Scents', 'handle': p['handle'], 'title': title, 'price': money(v['price']),
           'compare_at': money(v.get('compare_at_price')), 'available': bool(v['available']), 'sku': v.get('sku') or None,
           'brand': None, 'brand_raw': None, 'brand_src': None, 'size_ml': None, 'size_src': None, 'gender': None,
           'conc': None, 'name': None, 'barcode': None, 'kind': 'perfume', 'flags': []}
    # --- brand
    cands = []
    if h and h['brand_raw']:
        b, raw = brand_of(h['brand_raw']); cands.append(('header', b, raw))
    tb = title_brand(title)
    if tb:
        b, raw = brand_of(tb); cands.append(('title', b, raw))
    sb = sentence_brand(body)
    if sb:
        cands.append(('sentence', sb, sb))
    hm = re.search(r'-by-([a-z0-9-]+?)(?:-\d+)?$', p['handle'])
    if hm:
        hb, hraw = brand_of(hm.group(1).replace('-', ' '))
        if hb:
            cands.append(('handle', hb, hraw))
    if cands:
        # the first source that names a PLATFORM brand wins; a source that names some other brand stays first (and conflicts are flagged)
        src, b, raw = next((c for c in cands if c[1]), cands[0])
        if cands[0][1] is None and cands[0][2] and b and cands[0][2].lower() != raw.lower():
            rec['flags'].append('brand-conflict')
        rec['brand'], rec['brand_raw'], rec['brand_src'] = b, raw, src
        known = {c[1] for c in cands if c[1]}
        if len(known) > 1: rec['flags'].append('brand-conflict')
    # --- size
    sz = []
    if h and h['size'] and h['unit'] == 'ml': sz.append(('header', h['size']))
    if h and h['unit'] in ('gm', 'g'): rec['flags'].append('weight-not-ml')
    m = re.search(r'\bSIZE\s*:\s*(\d+(?:\.\d+)?)\s*ML', body, re.I)
    if m: sz.append(('size-line', float(m.group(1))))
    m = re.search(r'\b(\d{2,3})\s*ML\b', title, re.I)
    if m: sz.append(('title', float(m.group(1))))
    if sz:
        vals = {s[1] for s in sz}
        rec['size_ml'], rec['size_src'] = sz[0][1], '+'.join(s[0] for s in sz)
        if len(vals) > 1: rec['flags'].append('size-conflict')
    # --- gender, conc, name, barcode
    if h:
        rec['gender'] = h['gender']; rec['conc'] = h['conc']
        # A page whose description has no real header makes the first words of the description look like one: the "name" is then a sentence
        # ("Sapphire: Notes of Musk and Iris A fragrance that creates memories..."). Measured on the first two feeds: the longest genuine header
        # name is 59 characters, while 13 of 425 are descriptions of 100 to 379. Such a text is not a name: the store's own product title is used.
        if len(h['name']) <= HEADER_NAME_MAX:
            rec['name'] = h['name']
        else:
            rec['flags'].append('header-name-is-text')
    else:
        m = re.search(r'Men\s*/\s*Women\s*:\s*(\w+)', body, re.I)
        if m and m.group(1).lower() in GENDER_MAP: rec['gender'] = GENDER_MAP[m.group(1).lower()]
    m = re.search(r'BARCODE\s*:\s*([\d ]{8,16})', body, re.I)
    if m: rec['barcode'] = re.sub(r'\s+', '', m.group(1))
    # --- kind
    t = title
    hseg = (h or {}).get('seg', '')
    words = {w.lower() for w in re.findall(NOT_PERFUME.pattern, t + ' ' + hseg, re.I) if isinstance(w, str)}
    hits = {m.group(0).lower() for m in NOT_PERFUME.finditer(t + ' ' + hseg)}
    only_collection = hits == {'collection'}
    single_edp = bool(h and h['size'] and h['unit'] == 'ml' and h['conc'] and re.search(r'parfum|toilette|cologne|extrait', h['conc'], re.I))
    has_list = bool(re.search(r'INCLUDES|WHAT.S INSIDE|CONTENTS|\d\s*[x×]\s*\d|\b\d+\s*(?:pcs|pieces|pc)\b', body[:900], re.I))
    if only_collection and single_edp and not has_list:
        rec['flags'].append('collection-name-only')   # "Give Me Gourmand Collection" is a line name, not a package
    elif NOT_PERFUME.search(t) or NOT_PERFUME.search(hseg) or (h and h['conc'] and re.search(r'oil|attar', h['conc'], re.I)):
        rec['kind'] = 'bundle-or-set' if re.search(r'bundle|set|gift|box|duo|trio|collection|pcs|\+', t + ' ' + hseg, re.I) else 'not-a-plain-perfume'
    if not h and not re.search(r'\bperfume|fragrance|eau\b', body[:400], re.I) and not rec['size_ml']:
        rec['flags'].append('no-structure')
    return rec


def afnan(p):
    v = p['variants'][0]
    opts = [o for o in (v.get('option1'), v.get('option2'), v.get('option3')) if o]
    conc = size = gender = None
    for o in opts:
        o = o.strip()
        m = SIZE.match(o.replace('ML', 'ml').replace(' ml', 'ml'))
        if re.fullmatch(r'\d+(?:\.\d+)?\s*ml', o, re.I): size = float(re.match(r'\d+(?:\.\d+)?', o).group())
        elif re.search(r'eau|extrait|parfum|perfume|elixir', o, re.I): conc = o
        elif re.search(r'homme|femme|unisex|men|women', o, re.I):
            gender = GENDER_MAP.get(re.sub(r'^pour\s+', 'pour ', o.lower()).strip(), None) or ('men' if re.search(r'homme|\bmen', o, re.I) else 'women' if re.search(r'femme|women', o, re.I) else 'unisex')
    title = p['title'].strip()
    rec = {'store': 'Afnan Egypt', 'handle': p['handle'], 'title': title, 'price': money(v['price']), 'compare_at': money(v.get('compare_at_price')),
           'available': bool(v['available']), 'sku': v.get('sku') or None, 'brand': 'AFNAN', 'brand_raw': p['vendor'].strip(), 'brand_src': 'store-is-the-brand',
           'size_ml': size, 'size_src': 'variant-option' if size else None, 'gender': gender, 'conc': conc, 'name': title, 'barcode': None,
           'kind': 'perfume', 'flags': []}
    if not size: rec['flags'].append('no-size')
    # the brand's own store states conc / size / gender as structured variant options: when they say "Eau/Extrait De Parfum / 90 ML",
    # the page is ONE perfume even if its name carries a word such as "Collection" or "Incense" (Supremacy Incense, Luxury Collection)
    structured = bool(conc and size and re.search(r'eau\s*de|extrait|elixir|^parfum$', conc, re.I) and not re.search(r'spray|oil|attar', conc, re.I))
    if structured:
        if NOT_PERFUME.search(title): rec['flags'].append('name-has-set-word-but-structured-single')
    elif NOT_PERFUME.search(title): rec['kind'] = 'bundle-or-set'
    return rec


def load(prefix):
    out = []
    for f in sorted(glob.glob(F + prefix + '-page-*.json')):
        out += json.load(open(f, encoding='utf-8'))['products']
    return out


if __name__ == '__main__':
    A = [afnan(p) for p in load('afnan-egypt')]
    E = [emarati(p) for p in load('emarati-scents')]
    json.dump({'afnan': A, 'emarati': E}, open('extracted.json', 'w', encoding='utf-8'), ensure_ascii=False, indent=1)
    print('afnan', len(A), 'emarati', len(E))
