#!/usr/bin/env python3
"""Runs the whole trial pipeline (extract -> report2 -> plan) on tools/catalog-trial/fixtures (real pages that each hit a pitfall met while building the
two trial catalogs) and checks the outcome. It pins the rules in docs/catalog-ingestion.ar.md: when a rule regresses, this fails.
Run: python3 -I tools/catalog-trial/check_pitfalls.py   (also run by tests/catalog-trial-rules.test.js)."""
import json, os, subprocess, sys, tempfile

HERE = os.path.dirname(os.path.abspath(__file__))


def run(script, cwd, env):
    r = subprocess.run([sys.executable, '-I', os.path.join(HERE, script)], cwd=cwd, env=env, capture_output=True, text=True)
    if r.returncode != 0:
        sys.exit(script + ' failed:\n' + r.stdout + r.stderr)
    return r.stdout


def main():
    with tempfile.TemporaryDirectory() as tmp:
        env = dict(os.environ, CATALOG_FEEDS_DIR=os.path.join(HERE, 'fixtures'))
        run('extract.py', tmp, env)
        out = run('report2.py', tmp, env) + run('plan.py', tmp, env)
        plan = json.load(open(os.path.join(tmp, 'plan.json'), encoding='utf-8'))['products']
        waiting = json.load(open(os.path.join(tmp, 'waiting.json'), encoding='utf-8'))
    got = {(p['brand'], p['name']): {float(k): sorted((l['store'][0], l['price'], l['available']) for l in v) for k, v in p['sizes'].items()} for p in plan}

    def want(brand, name, sizes):
        assert (brand, name) in got, f'missing perfume: {brand} / {name} (have {sorted(got)})'
        assert got[(brand, name)] == sizes, f'{brand} / {name}: expected {sizes}, got {got[(brand, name)]}'

    # 1. the brand is written only in the product URL ("nebras-by-lattafa") or as «BY GISSAH»: both are evidence of a platform brand
    want('LATTAFA', 'Nebras', {100.0: [('E', 1650.0, True)]})            # name carries "Eau de Parfum" in the page header: cleaned
    want('GISSAH', 'Voila', {200.0: [('E', 4850.0, False)]})             # header says «BY GISSAH»; sold out stays listed as unavailable
    want('LATTAFA', 'Simply Oud', {100.0: [('E', 1000.0, True)]})
    # 2. a LINE name such as "Collection" is not a package: single perfumes are kept
    want('LATTAFA', 'Harlequin Cream', {75.0: [('E', 1900.0, True)]})    # "Give Me Gourmand Collection"
    want('LATTAFA', 'Mallow Madness', {75.0: [('E', 1750.0, True)]})
    want('ASSAF', 'Risk Comète', {125.0: [('E', 2450.0, True)]})         # "| Arrogate Collection" tail after the brand
    # 3. the brand's own store states conc / size / gender as structured options: ONE perfume even if the name says Incense or Luxury Collection
    want('AFNAN', 'Supremacy Incense', {100.0: [('A', 2150.0, False)]})
    want('AFNAN', 'Supremacy Gala', {90.0: [('A', 3500.0, True)]})       # "- Luxury Collection" removed from the name
    # 4. the same perfume at two stores joins one product with two prices
    want('AFNAN', '9 AM - Pour Femme', {100.0: [('A', 2200.0, True), ('E', 1650.0, True)]})
    # 5. two stores disagree on the concentration (Extrait vs Eau De Parfum): never merged, the second store's row is held back
    want('AFNAN', 'Supremacy In Oud', {100.0: [('A', 3500.0, True)], 150.0: [('A', 3550.0, True)]})
    assert 'held back (stores disagree on concentration): [(' in out, 'the concentration disagreement must be reported'
    # 6. bundles, gift sets and body sprays are never single perfumes; same-name Men/Women pages in one store are ambiguous and not guessed
    names = {n for _, n in got}
    for bad in ("The New King's Bundle", 'Yara Candy Gift Set', 'The Kingdom Men Gift Set', 'The Kingdom', 'Afnan 9am Femme Perfume Spray 250 Ml'):
        assert bad not in names, f'must not be a perfume: {bad}'
    assert 'excluded as ambiguous: [(' in out, 'the Kingdom Men/Women collision must be reported'
    assert len(got) == 10, f'expected 10 perfumes, got {len(got)}'
    # 7. a page with no real header: the first words of its description look like one ("Sapphire: Notes of Musk and Iris A fragrance that creates..."),
    #    which is a sentence, not a name. The store's own title ("SAPPHIRE by DKHOON") is used, the record is flagged, and a brand that has no card waits.
    sapphire = [r for st, r in waiting if r.get('handle') == 'sapphire']
    assert len(sapphire) == 1, 'the Sapphire page must be a waiting perfume of a brand that has no card'
    assert sapphire[0]['clean'] == 'SAPPHIRE' and sapphire[0]['waiting_brand'] == 'DKHOON', f"the title names the perfume, not the description: {sapphire[0]['clean']!r} / {sapphire[0]['waiting_brand']!r}"
    assert 'header-name-is-text' in sapphire[0].get('flags', []), 'a description taken for a name is flagged'
    print('catalog pitfalls: all rules hold (' + str(len(got)) + ' perfumes)')


if __name__ == '__main__':
    main()
