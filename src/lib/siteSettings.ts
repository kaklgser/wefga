import type { SiteSettings } from '../types';

export const SITE_SETTINGS_MIGRATION_PATH = 'supabase/migrations/20260321153000_add_site_settings_and_closure_gate.sql';
export const MISSING_SITE_SETTINGS_MESSAGE = `Website settings are not enabled in this database yet. Apply ${SITE_SETTINGS_MIGRATION_PATH}.`;

export const defaultOpenSiteSettings: SiteSettings = {
  id: true,
  site_is_open: true,
  closure_title: 'We are currently closed',
  closure_message: 'Ordering is temporarily unavailable right now.',
  reopening_text: 'We will open at 11:00 AM',
  rain_enabled: false,
  smtp_host: '',
  smtp_port: 587,
  smtp_user: '',
  smtp_from_email: '',
  smtp_from_name: 'The Supreme Waffle',
  created_at: new Date(0).toISOString(),
  updated_at: new Date(0).toISOString(),
};

export function isMissingSiteSettingsSchemaError(error: { code?: string | null; message?: string | null } | null | undefined) {
  return error?.code === 'PGRST205' || error?.message?.includes("public.site_settings") || error?.message?.includes("site_settings_public");
}
