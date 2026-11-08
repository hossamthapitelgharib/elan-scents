-- Keep products.gender as the sole storefront gender filter source.
-- Remove only legacy product_categories links whose category key is a different
-- gender. Commercial taxonomy relations are intentionally untouched.
-- The backup makes this data correction reversible without storing product text.

CREATE TABLE IF NOT EXISTS private.catalog_gender_relation_backup (
  product_id uuid NOT NULL,
  category_id uuid NOT NULL,
  category_key text NOT NULL,
  backed_up_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (product_id, category_id)
);

COMMENT ON TABLE private.catalog_gender_relation_backup IS
  'Reversible backup of product_categories links removed because their gender category conflicts with products.gender.';

INSERT INTO private.catalog_gender_relation_backup (product_id, category_id, category_key)
SELECT pc.product_id, pc.category_id, c.key
FROM public.product_categories pc
JOIN public.products p ON p.id = pc.product_id
JOIN public.categories c ON c.id = pc.category_id
WHERE p.gender IS NOT NULL
  AND c.key IN ('men', 'women', 'unisex')
  AND c.key <> p.gender
ON CONFLICT (product_id, category_id) DO NOTHING;

DELETE FROM public.product_categories pc
USING public.products p, public.categories c
WHERE p.id = pc.product_id
  AND c.id = pc.category_id
  AND p.gender IS NOT NULL
  AND c.key IN ('men', 'women', 'unisex')
  AND c.key <> p.gender;
