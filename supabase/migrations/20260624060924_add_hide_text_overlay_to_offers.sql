ALTER TABLE public.offers
  ADD COLUMN IF NOT EXISTS hide_text_overlay boolean NOT NULL DEFAULT false;
