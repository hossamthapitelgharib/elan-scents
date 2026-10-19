ALTER TABLE public.store_order_request_items
  ADD CONSTRAINT store_order_request_items_id_request_unique UNIQUE (id, request_id);

ALTER TABLE public.store_order_item_adjustments
  ADD CONSTRAINT store_order_item_adjustments_item_request_fkey
  FOREIGN KEY (request_item_id, request_id)
  REFERENCES public.store_order_request_items (id, request_id)
  ON DELETE CASCADE;

CREATE OR REPLACE FUNCTION public.validate_store_order_item_adjustment()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public', 'pg_temp'
AS $function$
declare
  v_ordered_quantity integer;
  v_completed_quantity integer;
begin
  SELECT quantity INTO v_ordered_quantity
  FROM public.store_order_request_items
  WHERE id = NEW.request_item_id AND request_id = NEW.request_id
  FOR UPDATE;

  IF v_ordered_quantity IS NULL THEN
    RAISE EXCEPTION 'Order item does not belong to the specified request';
  END IF;

  IF NEW.status = 'completed' THEN
    SELECT COALESCE(SUM(quantity), 0)::integer INTO v_completed_quantity
    FROM public.store_order_item_adjustments
    WHERE request_item_id = NEW.request_item_id
      AND status = 'completed'
      AND id <> COALESCE(NEW.id, '00000000-0000-0000-0000-000000000000'::uuid);

    IF v_completed_quantity + NEW.quantity > v_ordered_quantity THEN
      RAISE EXCEPTION 'Completed adjustment quantity exceeds ordered quantity';
    END IF;
  END IF;

  IF NEW.processed_at IS NULL AND NEW.status = 'completed' THEN
    NEW.processed_at := now();
  END IF;
  NEW.updated_at := now();
  RETURN NEW;
end;
$function$;

DROP TRIGGER IF EXISTS validate_store_order_item_adjustment_trigger
  ON public.store_order_item_adjustments;
CREATE TRIGGER validate_store_order_item_adjustment_trigger
BEFORE INSERT OR UPDATE ON public.store_order_item_adjustments
FOR EACH ROW EXECUTE FUNCTION public.validate_store_order_item_adjustment();
