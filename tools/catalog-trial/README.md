# Trial catalogs of Afnan Egypt and Emarati Scents (built 16-17 Nov 2026)

The executable record of how the two trial catalogs were built from the stores' PUBLIC pages, kept as the model for every problem met when real stores are
linked. The rules and the owner's definitions are in `docs/catalog-ingestion.ar.md`; `check_pitfalls.py` pins them (run by `tests/catalog-trial-rules.test.js`).

Run order, in an empty working folder (the scripts read and write the current folder; `CATALOG_FEEDS_DIR` is the folder of the stores' `products.json` pages
`afnan-egypt-page-1.json`, `emarati-scents-page-1..N.json`, fetched from a GitHub runner because the workspace network cannot reach the stores):

    CATALOG_FEEDS_DIR=feeds python3 -I extract.py     # rules -> extracted.json (nothing is written to any database)
    python3 -I report2.py                              # accepted / rejected with the reason -> importable.json (read the rejected list!)
    python3 -I plan.py                                 # merge the two stores into products, sizes and listings -> plan.json
    CATALOG_BRANDS="Ateej,REEF" python3 -I gen_receive.py rollback   # the perfumes, through the ONE entry point public.catalog_receive_items (dry run: ends in ROLLBACK,
                                                       # its error text is the report); then `commit` for the real load. plan.json = brands that have a card, waiting.json =
                                                       # brands that have none (they wait and appear by themselves when the card is created). Needs the migration
                                                       # 20261121193245_catalog_waiting_room. Everything carries data_source = 'trial_catalog'.
    python3 -I gen_bundles.py rollback                 # bundles and offers loader, first as a dry run that ends in ROLLBACK
                                                       # (the bundle pieces are plain text, the title and the FULL description are the store's own, read from
                                                       #  CATALOG_FEEDS_DIR; needs the migration 20261119112905_catalog_bundles_standalone)

Everything loaded carries `data_source = 'trial_catalog'` and is removed in one step (see `docs/handoff.ar.md`). Trial rows never enter a real order.

The automatic offer / bundle rule (owner, 23 Nov 2026) is `lib/catalog-classify.js`; its dry run on the stores' public pages and sections, which writes nothing:

    CATALOG_FEEDS_DIR=feeds CATALOG_SECTIONS_DIR=sections node tools/catalog-trial/classify-run.js [afnan-egypt] [emarati-scents]
                                                       # sections whose name carries an offer / bundle word, the offers found, the bundles (sure / doubtful) with the reason

`gen_bundles.py` still carries the hand-picked lists `B` and `B2` that loaded the 23 bundles of 17-22 Nov; they are history, the rule replaces them.
