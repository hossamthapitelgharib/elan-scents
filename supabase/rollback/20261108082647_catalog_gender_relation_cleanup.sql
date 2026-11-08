-- Restore only the legacy gender-category links backed up by the forward migration.
INSERT INTO public.product_categories (product_id, category_id)
SELECT product_id, category_id
FROM private.catalog_gender_relation_backup
ON CONFLICT (product_id, category_id) DO NOTHING;
