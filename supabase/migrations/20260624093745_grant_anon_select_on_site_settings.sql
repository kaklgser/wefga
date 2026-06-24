-- The anon role has an RLS SELECT policy on site_settings (anon_read_public_site_settings)
-- but was never granted column-level SELECT privileges on the table itself.
-- Without this GRANT, the view and direct queries both return nothing to unauthenticated customers,
-- causing the site-closed overlay and rain effect to never appear on the customer website.
GRANT SELECT ON public.site_settings TO anon;
