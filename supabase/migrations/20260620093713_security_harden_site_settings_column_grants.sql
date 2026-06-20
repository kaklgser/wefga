
-- ──────────────────────────────────────────────────────────
-- Fix smtp_pass + mappls_rest_key exposure on site_settings
--
-- The table has a broad GRANT ALL ... TO anon, authenticated.
-- Column-level REVOKEs only work when grants were given at
-- column level. Strategy: revoke table-level SELECT/INSERT/UPDATE,
-- then re-grant only the safe columns.
-- ──────────────────────────────────────────────────────────

-- Revoke all broad grants from anon on site_settings
REVOKE ALL ON public.site_settings FROM anon;

-- Re-grant only the public/non-sensitive columns to anon (SELECT only)
GRANT SELECT (id, site_is_open, closure_title, closure_message, reopening_text, created_at, updated_at)
  ON public.site_settings TO anon;

-- Revoke all broad grants from authenticated on site_settings
REVOKE ALL ON public.site_settings FROM authenticated;

-- Re-grant safe columns to authenticated (SELECT only for most, admins use SECURITY DEFINER functions)
GRANT SELECT (id, site_is_open, closure_title, closure_message, reopening_text,
              smtp_host, smtp_port, smtp_user, smtp_from_email, smtp_from_name,
              created_at, updated_at)
  ON public.site_settings TO authenticated;
