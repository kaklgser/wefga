
-- Restore INSERT and UPDATE grants on site_settings for authenticated users.
-- The existing RLS policies (Admins can insert/update site_settings) already
-- restrict writes to admins only — column grants just control which columns
-- are accessible, but we still need the table-level privilege for writes.

GRANT INSERT, UPDATE ON public.site_settings TO authenticated;
