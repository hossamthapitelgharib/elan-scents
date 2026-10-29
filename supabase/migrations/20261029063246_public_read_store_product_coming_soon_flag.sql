-- The storefront reads the "coming soon" flag of store products so the home section "Coming soon" can list them.
-- Column-level grant only (the table keeps no table-wide read for anon); the rows a visitor can see are still decided by RLS.
GRANT SELECT (is_coming_soon) ON TABLE public.store_products TO anon, authenticated;
