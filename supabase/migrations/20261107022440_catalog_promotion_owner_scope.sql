-- Public promotion badges must be scoped to the store that owns the canonical catalog offer.
-- The public_read RLS policy continues to restrict rows to active offers for active stores.
-- Expose only the public store identifier; never expose discount values or offer descriptions.
GRANT SELECT (store_id) ON TABLE public.offers TO anon, authenticated;
