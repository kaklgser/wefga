-- Add per-order-type targeting columns (default true = applies to everyone)
ALTER TABLE public.offers
  ADD COLUMN IF NOT EXISTS applies_to_delivery boolean NOT NULL DEFAULT true,
  ADD COLUMN IF NOT EXISTS applies_to_takeaway boolean NOT NULL DEFAULT true,
  ADD COLUMN IF NOT EXISTS applies_to_dine_in  boolean NOT NULL DEFAULT true,
  ADD COLUMN IF NOT EXISTS show_on_offers_page  boolean NOT NULL DEFAULT true;

-- Migrate existing delivery_only rows: if flagged delivery-only, disable the other two types
UPDATE public.offers
SET
  applies_to_takeaway = false,
  applies_to_dine_in  = false
WHERE delivery_only = true;

-- Drop the now-superseded column
ALTER TABLE public.offers
  DROP COLUMN IF EXISTS delivery_only;
