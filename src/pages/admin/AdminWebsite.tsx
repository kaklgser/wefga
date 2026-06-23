import { useEffect, useState } from 'react';
import { CloudRain, Eye, EyeOff, Mail, Power, Save, Send } from 'lucide-react';
import SiteClosedOverlay from '../../components/SiteClosedOverlay';
import { useToast } from '../../components/Toast';
import { useSiteSettings } from '../../hooks/useSiteSettings';
import { MISSING_SITE_SETTINGS_MESSAGE, defaultOpenSiteSettings, isMissingSiteSettingsSchemaError, SITE_SETTINGS_MIGRATION_PATH } from '../../lib/siteSettings';
import { supabase } from '../../lib/supabase';
import type { SiteSettings } from '../../types';

interface SiteSettingsForm {
  site_is_open: boolean;
  closure_title: string;
  closure_message: string;
  reopening_text: string;
  rain_enabled: boolean;
}

interface SmtpForm {
  smtp_host: string;
  smtp_port: string;
  smtp_user: string;
  smtp_pass: string;
  smtp_from_email: string;
  smtp_from_name: string;
}

function buildForm(settings: SiteSettings | null): SiteSettingsForm {
  return {
    site_is_open: settings?.site_is_open ?? true,
    closure_title: settings?.closure_title || 'We are currently closed',
    closure_message: settings?.closure_message || 'Ordering is temporarily unavailable right now.',
    reopening_text: settings?.reopening_text || 'We will open at 11:00 AM',
    rain_enabled: settings?.rain_enabled ?? false,
  };
}

function buildSmtpForm(settings: SiteSettings | null): SmtpForm {
  return {
    smtp_host: settings?.smtp_host || '',
    smtp_port: String(settings?.smtp_port || 587),
    smtp_user: settings?.smtp_user || '',
    smtp_pass: '',
    smtp_from_email: settings?.smtp_from_email || '',
    smtp_from_name: settings?.smtp_from_name || 'The Supreme Waffle',
  };
}

export default function AdminWebsite() {
  const { settings, loading, schemaMissing, refreshSettings } = useSiteSettings();
  const { showToast } = useToast();
  const [form, setForm] = useState<SiteSettingsForm>(() => buildForm(null));
  const [smtpForm, setSmtpForm] = useState<SmtpForm>(() => buildSmtpForm(null));
  const [saving, setSaving] = useState(false);
  const [savingSmtp, setSavingSmtp] = useState(false);
  const [testingEmail, setTestingEmail] = useState(false);
  const [showPassword, setShowPassword] = useState(false);
  const [testEmail, setTestEmail] = useState('');

  useEffect(() => {
    setForm(buildForm(settings));
    setSmtpForm(buildSmtpForm(settings));
  }, [settings]);

  async function saveSettings() {
    if (schemaMissing) {
      showToast(MISSING_SITE_SETTINGS_MESSAGE, 'error');
      return;
    }

    setSaving(true);

    const payload = {
      id: true,
      site_is_open: form.site_is_open,
      closure_title: form.closure_title.trim() || 'We are currently closed',
      closure_message: form.closure_message.trim() || 'Ordering is temporarily unavailable right now.',
      reopening_text: form.reopening_text.trim() || 'We will open again soon.',
      rain_enabled: form.rain_enabled,
      updated_at: new Date().toISOString(),
    };

    const { error } = await supabase.from('site_settings').upsert(payload, { onConflict: 'id' });

    if (error) {
      setSaving(false);
      showToast(
        isMissingSiteSettingsSchemaError(error)
          ? MISSING_SITE_SETTINGS_MESSAGE
          : error.message || 'Failed to save website settings',
        'error'
      );
      return;
    }

    await refreshSettings();
    setSaving(false);
    showToast(form.site_is_open ? 'Website is live' : 'Website switched off');
  }

  async function saveSmtpSettings() {
    if (schemaMissing) {
      showToast(MISSING_SITE_SETTINGS_MESSAGE, 'error');
      return;
    }

    setSavingSmtp(true);

    const { error } = await supabase.rpc('save_smtp_settings', {
      p_smtp_host: smtpForm.smtp_host.trim(),
      p_smtp_port: parseInt(smtpForm.smtp_port, 10) || 587,
      p_smtp_user: smtpForm.smtp_user.trim(),
      p_smtp_pass: smtpForm.smtp_pass || null,
      p_smtp_from_email: smtpForm.smtp_from_email.trim() || smtpForm.smtp_user.trim(),
      p_smtp_from_name: smtpForm.smtp_from_name.trim() || 'The Supreme Waffle',
    });

    if (error) {
      setSavingSmtp(false);
      showToast(error.message || 'Failed to save SMTP settings', 'error');
      return;
    }

    await refreshSettings();
    setSavingSmtp(false);
    showToast('SMTP settings saved');
  }

  async function sendTestEmail() {
    const recipient = testEmail.trim();
    if (!recipient) {
      showToast('Enter a test email address', 'error');
      return;
    }

    setTestingEmail(true);

    try {
      const { data: sessionData } = await supabase.auth.getSession();
      const accessToken = sessionData.session?.access_token;

      if (!accessToken) {
        showToast('Please sign in again to send a test email', 'error');
        return;
      }

      const apiUrl = `${import.meta.env.VITE_SUPABASE_URL}/functions/v1/send-test-email`;
      const response = await fetch(apiUrl, {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${accessToken}`,
          'apikey': import.meta.env.VITE_SUPABASE_ANON_KEY,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ to: recipient }),
      });

      const result = await response.json();

      if (result.success) {
        showToast(`Test email sent to ${recipient}`);
      } else {
        showToast(result.error || 'Failed to send test email', 'error');
      }
    } catch {
      showToast('Failed to reach test email service', 'error');
    } finally {
      setTestingEmail(false);
    }
  }

  if (loading && !settings) {
    return (
      <div className="animate-pulse">
        <div className="h-8 bg-brand-surface rounded w-40 mb-4" />
        <div className="h-56 bg-brand-surface rounded-xl" />
      </div>
    );
  }

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-extrabold text-white">Website Status</h1>
        <p className="text-sm text-brand-text-dim mt-1">Turn the customer website on or off and control the closure overlay text.</p>
      </div>

      {schemaMissing && (
        <div className="rounded-xl border border-amber-500/30 bg-amber-500/10 p-4">
          <p className="text-sm font-semibold text-amber-300">Website settings table is missing in the current database.</p>
          <p className="text-sm text-amber-200/90 mt-1">
            Apply <span className="font-mono">{SITE_SETTINGS_MIGRATION_PATH}</span> and reload this page.
          </p>
        </div>
      )}

      <div className="grid grid-cols-1 xl:grid-cols-[minmax(0,1fr)_420px] gap-6">
        <div className="bg-brand-surface rounded-xl border border-brand-border p-5 space-y-5">
          {/* Open / Closed toggle */}
          <div className="flex items-center justify-between gap-4 rounded-xl border border-brand-border bg-brand-bg/40 p-4">
            <div>
              <p className="text-xs uppercase tracking-[0.22em] text-brand-text-dim mb-1">Customer Website</p>
              <h2 className="text-lg font-bold text-white">{form.site_is_open ? 'Open' : 'Closed'}</h2>
              <p className="text-sm text-brand-text-muted">
                {form.site_is_open
                  ? 'Customers can browse and place orders.'
                  : 'Customers will see a full-screen closure overlay.'}
              </p>
            </div>

            <button
              type="button"
              onClick={() => setForm((current) => ({ ...current, site_is_open: !current.site_is_open }))}
              className={`inline-flex items-center gap-2 rounded-full px-4 py-2 text-sm font-bold transition-colors ${
                form.site_is_open
                  ? 'bg-emerald-500/15 text-emerald-400 border border-emerald-500/30'
                  : 'bg-red-500/15 text-red-400 border border-red-500/30'
              }`}
            >
              <Power size={16} />
              {form.site_is_open ? 'Turn Off' : 'Turn On'}
            </button>
          </div>

          {/* Rain effect toggle */}
          <div className="flex items-center justify-between gap-4 rounded-xl border border-brand-border bg-brand-bg/40 p-4">
            <div className="flex items-center gap-3">
              <div className={`w-9 h-9 rounded-xl flex items-center justify-center ${form.rain_enabled ? 'bg-sky-500/15 border border-sky-500/30' : 'bg-brand-surface border border-brand-border'}`}>
                <CloudRain size={18} className={form.rain_enabled ? 'text-sky-400' : 'text-brand-text-dim'} />
              </div>
              <div>
                <p className="text-sm font-bold text-white">Falling Rain Effect</p>
                <p className="text-xs text-brand-text-muted">Animate rain drops across the customer website</p>
              </div>
            </div>

            <button
              type="button"
              onClick={() => setForm((current) => ({ ...current, rain_enabled: !current.rain_enabled }))}
              className={`relative inline-flex h-6 w-11 shrink-0 rounded-full border-2 transition-colors focus:outline-none ${
                form.rain_enabled ? 'bg-sky-500 border-sky-500' : 'bg-brand-border border-brand-border'
              }`}
              role="switch"
              aria-checked={form.rain_enabled}
            >
              <span
                className={`inline-block h-4 w-4 mt-0.5 rounded-full bg-white shadow transition-transform ${
                  form.rain_enabled ? 'translate-x-5' : 'translate-x-0.5'
                }`}
              />
            </button>
          </div>

          {/* Closure text fields */}
          <div className="space-y-3">
            <div>
              <label className="block text-sm font-semibold text-white mb-2">Overlay Title</label>
              <input
                value={form.closure_title}
                onChange={(e) => setForm((current) => ({ ...current, closure_title: e.target.value }))}
                className="input-field"
                placeholder="We are currently closed"
              />
            </div>

            <div>
              <label className="block text-sm font-semibold text-white mb-2">Overlay Message</label>
              <textarea
                value={form.closure_message}
                onChange={(e) => setForm((current) => ({ ...current, closure_message: e.target.value }))}
                className="input-field resize-none"
                rows={4}
                placeholder="Ordering is temporarily unavailable right now."
              />
            </div>

            <div>
              <label className="block text-sm font-semibold text-white mb-2">Opening Note</label>
              <input
                value={form.reopening_text}
                onChange={(e) => setForm((current) => ({ ...current, reopening_text: e.target.value }))}
                className="input-field"
                placeholder="We will open at 11:00 AM"
              />
            </div>
          </div>

          <button
            type="button"
            onClick={() => void saveSettings()}
            disabled={saving || schemaMissing}
            className="btn-primary text-sm px-4 py-2 flex items-center gap-2"
          >
            <Save size={14} />
            {schemaMissing ? 'Migration Required' : saving ? 'Saving...' : 'Save Website Settings'}
          </button>
        </div>

        {/* Overlay preview */}
        <div className="bg-brand-surface rounded-xl border border-brand-border p-5">
          <p className="text-xs uppercase tracking-[0.22em] text-brand-text-dim mb-3">Overlay Preview</p>
          <div className="relative min-h-[580px] rounded-2xl overflow-hidden bg-brand-bg border border-brand-border">
            <div className="absolute inset-0 opacity-40 bg-[radial-gradient(circle_at_top,_rgba(216,178,78,0.18),_transparent_55%)]" />
            <div className="absolute inset-0 p-4">
              <div className="h-12 rounded-xl bg-brand-surface border border-brand-border mb-3" />
              <div className="grid grid-cols-2 gap-3">
                <div className="h-36 rounded-xl bg-brand-surface border border-brand-border" />
                <div className="h-36 rounded-xl bg-brand-surface border border-brand-border" />
              </div>
            </div>

            {!form.site_is_open && (
              <SiteClosedOverlay
                contained
                settings={{
                  ...defaultOpenSiteSettings,
                  ...settings,
                  id: true,
                  site_is_open: form.site_is_open,
                  closure_title: form.closure_title.trim() || 'We are currently closed',
                  closure_message: form.closure_message.trim() || 'Ordering is temporarily unavailable right now.',
                  reopening_text: form.reopening_text.trim() || 'We will open again soon.',
                  rain_enabled: form.rain_enabled,
                  created_at: settings?.created_at || defaultOpenSiteSettings.created_at,
                  updated_at: settings?.updated_at || defaultOpenSiteSettings.updated_at,
                }}
              />
            )}
          </div>
        </div>
      </div>

      {/* SMTP section */}
      <div className="mt-8">
        <h1 className="text-2xl font-extrabold text-white">Email Settings (SMTP)</h1>
        <p className="text-sm text-brand-text-dim mt-1">Configure the SMTP server used for sending order receipts and notifications to customers.</p>
      </div>

      <div className="bg-brand-surface rounded-xl border border-brand-border p-5 space-y-5">
        <div className="flex items-center gap-3 rounded-xl border border-brand-border bg-brand-bg/40 p-4">
          <div className="flex items-center justify-center w-10 h-10 rounded-full bg-amber-500/15 border border-amber-500/30">
            <Mail size={18} className="text-amber-400" />
          </div>
          <div>
            <h2 className="text-sm font-bold text-white">SMTP Provider</h2>
            <p className="text-xs text-brand-text-muted">
              {smtpForm.smtp_host
                ? `${smtpForm.smtp_host}:${smtpForm.smtp_port} (${smtpForm.smtp_user || 'no user'})`
                : 'Not configured -- emails will not be sent'}
            </p>
          </div>
        </div>

        <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
          <div>
            <label className="block text-sm font-semibold text-white mb-2">SMTP Host</label>
            <input
              value={smtpForm.smtp_host}
              onChange={(e) => setSmtpForm((c) => ({ ...c, smtp_host: e.target.value }))}
              className="input-field"
              placeholder="smtp.hostinger.com"
            />
          </div>

          <div>
            <label className="block text-sm font-semibold text-white mb-2">Port</label>
            <input
              value={smtpForm.smtp_port}
              onChange={(e) => setSmtpForm((c) => ({ ...c, smtp_port: e.target.value }))}
              className="input-field"
              placeholder="587"
              type="number"
            />
          </div>

          <div>
            <label className="block text-sm font-semibold text-white mb-2">Username</label>
            <input
              value={smtpForm.smtp_user}
              onChange={(e) => setSmtpForm((c) => ({ ...c, smtp_user: e.target.value }))}
              className="input-field"
              placeholder="noreply@thesupremewaffle.com"
            />
          </div>

          <div>
            <label className="block text-sm font-semibold text-white mb-2">Password</label>
            <div className="relative">
              <input
                value={smtpForm.smtp_pass}
                onChange={(e) => setSmtpForm((c) => ({ ...c, smtp_pass: e.target.value }))}
                className="input-field pr-10"
                placeholder={settings?.smtp_host ? '(unchanged)' : 'Enter SMTP password'}
                type={showPassword ? 'text' : 'password'}
              />
              <button
                type="button"
                onClick={() => setShowPassword(!showPassword)}
                className="absolute right-3 top-1/2 -translate-y-1/2 text-brand-text-dim hover:text-white transition-colors"
              >
                {showPassword ? <EyeOff size={16} /> : <Eye size={16} />}
              </button>
            </div>
          </div>

          <div>
            <label className="block text-sm font-semibold text-white mb-2">From Email</label>
            <input
              value={smtpForm.smtp_from_email}
              onChange={(e) => setSmtpForm((c) => ({ ...c, smtp_from_email: e.target.value }))}
              className="input-field"
              placeholder="noreply@thesupremewaffle.com"
            />
            <p className="text-xs text-brand-text-dim mt-1">Defaults to username if left empty</p>
          </div>

          <div>
            <label className="block text-sm font-semibold text-white mb-2">From Name</label>
            <input
              value={smtpForm.smtp_from_name}
              onChange={(e) => setSmtpForm((c) => ({ ...c, smtp_from_name: e.target.value }))}
              className="input-field"
              placeholder="The Supreme Waffle"
            />
          </div>
        </div>

        <div className="flex flex-wrap items-center gap-3">
          <button
            type="button"
            onClick={() => void saveSmtpSettings()}
            disabled={savingSmtp || schemaMissing}
            className="btn-primary text-sm px-4 py-2 flex items-center gap-2"
          >
            <Save size={14} />
            {savingSmtp ? 'Saving...' : 'Save SMTP Settings'}
          </button>

          <div className="flex items-center gap-2">
            <input
              value={testEmail}
              onChange={(e) => setTestEmail(e.target.value)}
              className="input-field text-sm w-56"
              placeholder="Test email address"
              type="email"
            />
            <button
              type="button"
              onClick={() => void sendTestEmail()}
              disabled={testingEmail || !smtpForm.smtp_host}
              className="btn-secondary text-sm px-4 py-2 flex items-center gap-2 whitespace-nowrap"
            >
              <Send size={14} />
              {testingEmail ? 'Sending...' : 'Send Test'}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
