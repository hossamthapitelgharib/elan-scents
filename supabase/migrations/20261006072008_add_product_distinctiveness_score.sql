ALTER TABLE public.product_stats
  ADD COLUMN IF NOT EXISTS distinctiveness_score NUMERIC(5, 2);

DO $migration$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_constraint
    WHERE conname = 'product_stats_distinctiveness_score_check'
      AND conrelid = 'public.product_stats'::regclass
  ) THEN
    ALTER TABLE public.product_stats
      ADD CONSTRAINT product_stats_distinctiveness_score_check
      CHECK (
        distinctiveness_score IS NULL
        OR distinctiveness_score BETWEEN 0 AND 100
      );
  END IF;
END
$migration$;

COMMENT ON COLUMN public.product_stats.distinctiveness_score IS
  'Verified editorial distinctiveness signal from 0 to 100; NULL until trustworthy source data is provided.';