
-- Add rain_enabled toggle to site_settings
ALTER TABLE public.site_settings
  ADD COLUMN IF NOT EXISTS rain_enabled boolean NOT NULL DEFAULT false;

-- Expose via the public view (drop + recreate to add the column)
DROP VIEW IF EXISTS public.site_settings_public;

CREATE VIEW public.site_settings_public
  WITH (security_invoker = true)
AS
  SELECT
    id,
    site_is_open,
    closure_title,
    closure_message,
    reopening_text,
    rain_enabled,
    smtp_from_name,
    smtp_from_email,
    created_at,
    updated_at
  FROM public.site_settings;

-- Grant SELECT on the new column to anon and authenticated
GRANT SELECT (rain_enabled) ON public.site_settings TO anon, authenticated;
