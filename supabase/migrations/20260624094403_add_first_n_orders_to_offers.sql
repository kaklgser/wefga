-- Add first_n_orders column to offers table.
-- When set (e.g. 1 = first order only, 2 = first two orders), the offer is
-- only applicable to a user whose total completed-or-active order count is
-- less than this value. NULL means no restriction (applies to all orders).
ALTER TABLE public.offers
  ADD COLUMN IF NOT EXISTS first_n_orders integer DEFAULT NULL;
