import json,collections,re,unicodedata
d=json.load(open('extracted.json',encoding='utf-8'))
def nk(s):
    s=unicodedata.normalize('NFKD',s or '').encode('ascii','ignore').decode().lower()
    s=re.sub(r"\((?:new|old)\s*batch\)",'',s)
    return re.sub(r'[^a-z0-9]+','',s)
def clean_name(r):
    n=r['name'] or r['title']
    n=re.sub(r'\s+by\s+[A-Za-z0-9\' &().]+$','',n,flags=re.I)
    n=re.sub(r'\s*[-–]\s*luxury collection\b.*$','',n,flags=re.I)   # "SUPREMACY GALA - LUXURY COLLECTION" -> "SUPREMACY GALA"
    n=re.sub(r'\b\d{2,3}\s*ML\b','',n,flags=re.I)
    n=re.sub(r'\s+(?:eau\s*de\s*(?:parfum|toilette|cologne)|parfum)\s*$','',n,flags=re.I)   # "NEBRAS Eau de Parfum" -> "NEBRAS"
    return re.sub(r'\s+',' ',n).strip(' -–')
# A brand the extractor could not match to a platform card still goes to the platform when the page itself names it plainly (the page header or the
# title says "... by X"): the platform decides (public.catalog_receive_items): the perfume WAITS in the waiting room until a card for X exists.
# Anything that is not plainly a brand name (a concentration word, a co-brand "A x B", a stray token) is refused instead of waiting forever.
JUNK_BRAND={'concentrated','oil','oil &','oriental','perfume','parfum','eau de parfum','attar','gift','set','collection'}
def waiting_brand(r):
    b=re.sub(r'\s+',' ',(r.get('brand_raw') or '')).strip(' -–.&')
    if r.get('brand_src') not in ('header','title') or not (3<=len(b)<=40): return None
    if b.lower() in JUNK_BRAND or re.search(r'[×]|\s[xX]\s|\d',b) or not re.fullmatch(r"[^\W\d_][\w' &.\-]*",b): return None
    return b
ok=[];wait=[];why=collections.Counter();rej=[]
for st in ('afnan','emarati'):
    for r in d[st]:
        r['clean']=clean_name(r)
        reasons=[]
        if r['kind']!='perfume': reasons.append('not a plain perfume ('+r['kind']+')')
        if not r['size_ml']: reasons.append('no size')
        if 'size-conflict' in r['flags']: reasons.append('size conflict')
        if 'brand-conflict' in r['flags']: reasons.append('brand conflict')
        if not r['price'] or r['price']<=0: reasons.append('no price')
        if not r['brand']:
            wb=waiting_brand(r)
            if wb and not reasons:
                r['waiting_brand']=wb; wait.append((st,r)); continue
            reasons.insert(1 if reasons[:1] and reasons[0].startswith('not a plain') else 0,'brand not on platform / unknown')
        if reasons:
            for x in reasons: why[(st,x)]+=1
            rej.append((st,r['title'],reasons))
        else: ok.append((st,r))
print('importable:',collections.Counter(st for st,_ in ok))
print('waiting for a brand card that does not exist yet:',len(wait),sorted(collections.Counter(r['waiting_brand'].upper() for _,r in wait).items(),key=lambda x:-x[1])[:25])
print('rejected reasons:'); [print('  ',k,v) for k,v in sorted(why.items())]
# per brand
print('importable per brand/store:',sorted(collections.Counter((st,r['brand']) for st,r in ok).items()))
# identity keys
key=lambda r:(r['brand'],nk(r['clean']),r['size_ml'])
byk=collections.defaultdict(list)
for st,r in ok: byk[key(r)].append((st,r))
dup_in_store=[(k,v) for k,v in byk.items() if len({id(x[1]) for x in v})>len(v) or collections.Counter(x[0] for x in v).most_common(1)[0][1]>1]
print('keys total',len(byk),' same-store duplicates (would break unique rule):',len(dup_in_store))
for k,v in dup_in_store[:12]: print('  DUP',k,[(s,x['title'],x['conc'],x['price']) for s,x in v])
both=[(k,v) for k,v in byk.items() if len({x[0] for x in v})>1]
print('perfumes sold by BOTH stores (same brand+name+size):',len(both))
for k,v in both[:15]: print('  ',k,[(s,x['title'],x['price']) for s,x in v])
# name collisions with different concentration inside same store (same brand+name, different size or conc)
bn=collections.defaultdict(set)
for st,r in ok: bn[(r['brand'],nk(r['clean']))].add((st,r['conc'],r['size_ml']))
multi=[(k,v) for k,v in bn.items() if len({(c) for _,c,_ in v})>1]
print('same brand+name with different concentration:',len(multi)); [print('  ',k,sorted(v,key=str)) for k,v in multi[:10]]
json.dump([(s,r) for s,r in ok],open('importable.json','w',encoding='utf-8'),ensure_ascii=False)
json.dump([(s,r) for s,r in wait],open('waiting.json','w',encoding='utf-8'),ensure_ascii=False)
# examples of rejected for no brand
import random; random.seed(2)
print('--- sample rejected unknown-brand titles:',[t for s,t,rs in rej if any('unknown' in x for x in rs)][:12])
print('--- sample bundle/set:',[t for s,t,rs in rej if any('bundle' in x for x in rs)][:14])
