# Trial catalogs of Afnan Egypt and Emarati Scents (built 16-17 Nov 2026)

The executable record of how the two trial catalogs were built from the stores' PUBLIC pages, kept as the model for every problem met when real stores are
linked. The rules and the owner's definitions are in `docs/catalog-ingestion.ar.md`; `check_pitfalls.py` pins them (run by `tests/catalog-trial-rules.test.js`).

Run order, in an empty working folder (the scripts read and write the current folder; `CATALOG_FEEDS_DIR` is the folder of the stores' `products.json` pages
`afnan-egypt-page-1.json`, `emarati-scents-page-1..N.json`, fetched from a GitHub runner because the workspace network cannot reach the stores):

    CATALOG_FEEDS_DIR=feeds python3 -I extract.py     # rules -> extracted.json (nothing is written to any database)
    python3 -I report2.py                              # accepted / rejected with the reason -> importable.json (read the rejected list!)
    python3 -I plan.py                                 # merge the two stores into products, sizes and listings -> plan.json
    python3 -I gen_sql2.py 120                         # idempotent atomic loader chunks load_chunk_N.sql (data_source = 'trial_catalog')
    python3 -I gen_bundles.py rollback                 # bundles and offers loader, first as a dry run that ends in ROLLBACK

Everything loaded carries `data_source = 'trial_catalog'` and is removed in one step (see `docs/handoff.ar.md`). Trial rows never enter a real order.
