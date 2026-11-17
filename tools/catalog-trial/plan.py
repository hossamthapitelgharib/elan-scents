import json,collections,re,unicodedata
ok=json.load(open('importable.json',encoding='utf-8'))
def nk(s):
    s=unicodedata.normalize('NFKD',s or '').encode('ascii','ignore').decode().lower()
    s=re.sub(r"\((?:new|old)\s*batch\)",'',s)
    return re.sub(r'[^a-z0-9]+','',s)
def clean_name(r):
    n=r['name'] or r['title']
    n=n.replace('’',"'").replace('‘',"'")
    n=re.sub(r'\s+by\s+[A-Za-z0-9\' &().]+$','',n,flags=re.I)
    n=re.sub(r'\s*[-–]\s*luxury collection\b.*$','',n,flags=re.I)   # "SUPREMACY GALA - LUXURY COLLECTION" -> "SUPREMACY GALA"
    n=re.sub(r'\b\d{2,3}\s*ML\b','',n,flags=re.I)
    n=re.sub(r'\s+(?:eau\s*de\s*(?:parfum|toilette|cologne)|parfum)\s*$','',n,flags=re.I)   # "NEBRAS Eau de Parfum" -> "NEBRAS"
    return re.sub(r'\s+',' ',n).strip(' -–')
def display(n):
    if re.search(r'[a-z]',n): return n
    def w(t):
        if re.search(r'\d',t) or t in ('AM','PM'): return t
        return '-'.join(x[:1].upper()+x[1:].lower() for x in t.split('-'))
    return ' '.join(w(t) for t in n.split(' '))
def slug(s):
    s=unicodedata.normalize('NFKD',s).encode('ascii','ignore').decode().lower()
    return re.sub(r'[^a-z0-9]+','-',s).strip('-')
# exclude same-store duplicate keys (ambiguous)
key=lambda r:(r['brand'],nk(clean_name(r)),r['size_ml'])
cnt=collections.Counter((st,)+key(r) for st,r in ok)
amb={k for k,v in cnt.items() if v>1}
# same brand+name+size but the two stores state DIFFERENT concentrations (e.g. Extrait vs Eau De Parfum): not provably the same
# perfume, so the second store's row is held back instead of being merged (a duplicate card is harmless, a wrong merge is not)
concs=collections.defaultdict(set)
for st,r in ok:
    if r['conc']: concs[key(r)].add(re.sub(r'[^a-z]','',r['conc'].lower()))
conc_conflict={k for k,v in concs.items() if len(v)>1}
rows=[];excluded_amb=[];held_conc=[]
for st,r in ok:
    if (st,)+key(r) in amb: excluded_amb.append((st,r['title'])); continue
    if key(r) in conc_conflict and st!='afnan': held_conc.append((st,r['title'],r['conc'])); continue
    rows.append((st,r))
print('held back (stores disagree on concentration):',held_conc)
# products: (brand, nk(name)) -> record; prefer Afnan Egypt naming
prods={}
for st,r in sorted(rows,key=lambda x:(x[0]!='afnan')):
    k=(r['brand'],nk(clean_name(r)))
    p=prods.setdefault(k,{'brand':r['brand'],'name':display(clean_name(r)),'genders':set(),'sizes':{}})
    if r['gender']: p['genders'].add(r['gender'])
    sz=p['sizes'].setdefault(r['size_ml'],[])
    sz.append({'store':'Afnan Egypt' if st=='afnan' else 'Emarati Scents','handle':r['handle'],'price':r['price'],'available':r['available'],'compare_at':r['compare_at']})
gconf=[k for k,p in prods.items() if len(p['genders'])>1]
used=set()
for k,p in prods.items():
    base=slug(p['brand']+' '+p['name']); s=base; i=2
    while s in used: s=f'{base}-{i}'; i+=1
    used.add(s); p['slug']=s; p['gender']=(sorted(p['genders'])[0] if len(p['genders'])==1 else None); p['genders']=sorted(p['genders'])
listings=[(p['brand'],p['name'],sz,l) for p in prods.values() for sz,ls in p['sizes'].items() for l in ls]
print('excluded as ambiguous:',excluded_amb)
print('perfumes (products):',len(prods),' sizes:',sum(len(p['sizes']) for p in prods.values()),' store listings:',len(listings))
print('listings per store:',collections.Counter(l['store'] for *_,l in listings))
print('available/sold out:',collections.Counter((l['store'],l['available']) for *_,l in listings))
print('products per brand:',sorted(collections.Counter(p['brand'] for p in prods.values()).items()))
print('gender conflicts (set to unknown):',len(gconf),[prods[k]['name'] for k in gconf][:8])
print('products without any gender:',sum(1 for p in prods.values() if not p['genders']))
shared=[p for p in prods.values() if any(len({l['store'] for l in ls})>1 for ls in p['sizes'].values())]
print('perfumes in both stores:',len(shared))
vis=[p for p in prods.values() if any(l['available'] for ls in p['sizes'].values() for l in ls)]
print('perfumes visible (at least one available listing):',len(vis))
print('sample names:',[p['name'] for p in list(prods.values())[:12]],[p['name'] for p in list(prods.values())[200:208]])
print('multi-size products:',sum(1 for p in prods.values() if len(p['sizes'])>1),[(p['name'],sorted(p['sizes'])) for p in prods.values() if len(p['sizes'])>1][:6])
json.dump({'products':[{**p,'sizes':{str(k):v for k,v in p['sizes'].items()}} for p in prods.values()]},open('plan.json','w',encoding='utf-8'),ensure_ascii=False)
# cheapest comparison for the shared ones
for p in shared[:10]:
    for sz,ls in p['sizes'].items():
        if len({l['store'] for l in ls})>1: print('  ',p['name'],sz,[(l['store'][:6],l['price'],l['available']) for l in ls])
