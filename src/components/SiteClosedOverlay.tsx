import { useEffect } from 'react';
import { Clock9 } from 'lucide-react';
import RainEffect from './RainEffect';
import type { SiteSettings } from '../types';

export default function SiteClosedOverlay({
  settings,
  contained = false,
}: {
  settings: SiteSettings;
  contained?: boolean;
}) {
  useEffect(() => {
    if (contained) return;
    const prev = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    return () => {
      document.body.style.overflow = prev;
    };
  }, [contained]);

  return (
    <div className={`${contained ? 'absolute' : 'fixed'} inset-0 z-[80] bg-brand-overlay/95 backdrop-blur-md flex flex-col`}>
      {/* Atmospheric rain inside overlay — respects rain_enabled setting */}
      {settings.rain_enabled && <RainEffect contained />}

      {/* Top announcement banner */}
      <div className="relative z-10 w-full bg-red-950/80 border-b border-red-500/30 px-4 py-3 text-center shrink-0">
        <p className="text-sm font-bold text-red-200 leading-snug">
          {settings.closure_message || 'We are currently closed. Please check back later.'}
        </p>
      </div>

      {/* Centred closure card */}
      <div className="relative z-10 flex-1 flex items-center justify-center p-5">
        <div className="w-full max-w-md rounded-3xl border border-brand-gold/20 bg-brand-surface shadow-elevated p-6 text-center">
          <div className="mx-auto mb-4 w-14 h-14 rounded-2xl bg-brand-gold/15 flex items-center justify-center">
            <Clock9 size={28} className="text-brand-gold" />
          </div>
          <p className="text-[11px] font-bold tracking-[0.28em] text-brand-gold uppercase mb-3">Website Closed</p>
          <h2 className="text-2xl font-extrabold text-white tracking-tight mb-2">{settings.closure_title}</h2>
          <p className="text-sm text-brand-text-muted leading-relaxed mb-4">{settings.closure_message}</p>
          <div className="rounded-2xl border border-brand-gold/20 bg-brand-gold/10 px-4 py-3">
            <p className="text-xs uppercase tracking-[0.22em] text-brand-gold-muted mb-1">Opening Note</p>
            <p className="text-base font-bold text-brand-gold">{settings.reopening_text}</p>
          </div>
        </div>
      </div>
    </div>
  );
}
