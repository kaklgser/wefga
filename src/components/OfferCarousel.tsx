import { useCallback, useEffect, useRef, useState, type TouchEvent } from 'react';
import { Link } from 'react-router-dom';
import { ChevronLeft, ChevronRight } from 'lucide-react';
import { AnimatePresence, motion } from 'motion/react';
import { getOfferBadgeLabel, getOfferCtaHref, getOfferCtaText, getOfferDisplayDescription, getOfferRewardLabel } from '../lib/offers';
import { normalizeImageUrl } from '../lib/images';
import type { MenuItem, Offer } from '../types';

export type OfferCarouselAction =
  | { kind: 'link'; to: string }
  | { kind: 'button'; onClick: () => void };

type OfferCarouselProps = {
  offers: Offer[];
  categorySlugById?: Record<string, string>;
  menuItemsById?: Record<string, Pick<MenuItem, 'id' | 'category_id'>>;
  resolveAction?: (href: string, offer: Offer) => OfferCarouselAction;
  className?: string;
  heightClassName?: string;
  autoPlayMs?: number;
};

function defaultResolveAction(href: string): OfferCarouselAction {
  return { kind: 'link', to: href };
}

export default function OfferCarousel({
  offers,
  categorySlugById = {},
  menuItemsById = {},
  resolveAction,
  className,
  heightClassName = 'h-[240px] sm:h-[268px] lg:h-[308px]',
  autoPlayMs = 4000,
}: OfferCarouselProps) {
  const [activeIndex, setActiveIndex] = useState(0);
  const [failedImageUrls, setFailedImageUrls] = useState<Record<string, true>>({});
  const [isPaused, setIsPaused] = useState(false);
  const bannerTimer = useRef<ReturnType<typeof setInterval>>();
  const touchStartX = useRef<number | null>(null);

  const advance = useCallback((delta: number) => {
    setActiveIndex((current) => {
      if (offers.length === 0) return 0;
      return (current + delta + offers.length) % offers.length;
    });
  }, [offers.length]);

  const goTo = useCallback((index: number) => {
    setActiveIndex(() => {
      if (offers.length === 0) return 0;
      return ((index % offers.length) + offers.length) % offers.length;
    });
  }, [offers.length]);

  useEffect(() => {
    setActiveIndex((current) => {
      if (offers.length === 0) return 0;
      return current % offers.length;
    });
  }, [offers.length]);

  useEffect(() => {
    if (bannerTimer.current) clearInterval(bannerTimer.current);
    if (offers.length <= 1 || isPaused) return;

    bannerTimer.current = setInterval(() => {
      advance(1);
    }, autoPlayMs);

    return () => {
      if (bannerTimer.current) clearInterval(bannerTimer.current);
    };
  }, [advance, autoPlayMs, isPaused, offers.length]);

  const activeOffer = offers[activeIndex] || null;
  if (!activeOffer) {
    return null;
  }

  const activeBannerDescription = getOfferDisplayDescription(activeOffer);
  const activeBannerReward = getOfferRewardLabel(activeOffer);
  const activeBannerCtaText = getOfferCtaText(activeOffer);
  const activeBannerCtaHref = getOfferCtaHref(activeOffer, { categorySlugById, menuItemsById });
  const activeBannerAction = resolveAction
    ? resolveAction(activeBannerCtaHref, activeOffer)
    : defaultResolveAction(activeBannerCtaHref);
  const requestedBannerBackgroundImage = normalizeImageUrl(activeOffer.background_image_url, '') || null;
  const activeBannerBackgroundImage = requestedBannerBackgroundImage && !failedImageUrls[requestedBannerBackgroundImage]
    ? requestedBannerBackgroundImage
    : null;

  // Poster mode: no text overlay when admin checked hide_text_overlay or left all text fields blank
  const hasBannerText = !activeOffer.hide_text_overlay && !!(
    activeOffer.title?.trim() ||
    activeOffer.display_badge?.trim() ||
    activeBannerDescription ||
    activeBannerReward ||
    activeOffer.cta_text?.trim()
  );

  function markImageFailed(url: string) {
    setFailedImageUrls((current) => (current[url] ? current : { ...current, [url]: true }));
  }

  function handleTouchStart(event: TouchEvent<HTMLDivElement>) {
    touchStartX.current = event.changedTouches[0]?.clientX ?? null;
    setIsPaused(true);
  }

  function handleTouchEnd(event: TouchEvent<HTMLDivElement>) {
    const startX = touchStartX.current;
    touchStartX.current = null;
    setIsPaused(false);

    if (startX === null) {
      return;
    }

    const deltaX = (event.changedTouches[0]?.clientX ?? startX) - startX;
    if (Math.abs(deltaX) < 42) {
      return;
    }

    advance(deltaX > 0 ? -1 : 1);
  }

  return (
    <div
      className={className}
      onMouseEnter={() => setIsPaused(true)}
      onMouseLeave={() => setIsPaused(false)}
    >
      <div
        className={`relative overflow-hidden rounded-[24px] border border-brand-border bg-brand-surface ${heightClassName}`}
        role="region"
        aria-roledescription="carousel"
        aria-label="Offers carousel"
        onTouchStart={handleTouchStart}
        onTouchEnd={handleTouchEnd}
      >
        <AnimatePresence mode="popLayout" initial={false}>
          <motion.div
            key={activeOffer.id}
            initial={{ opacity: 0, x: 60 }}
            animate={{ opacity: 1, x: 0 }}
            exit={{ opacity: 0, x: -60 }}
            transition={{ duration: 0.45, ease: [0.16, 1, 0.3, 1] }}
            className="absolute inset-0"
            aria-live="polite"
          >
            {activeBannerBackgroundImage && (
              <>
                <img
                  src={activeBannerBackgroundImage}
                  alt={activeOffer.title || 'Offer'}
                  loading="eager"
                  fetchPriority="high"
                  width={1600}
                  height={900}
                  className="absolute inset-0 h-full w-full object-cover object-[76%_center] sm:object-center"
                  onError={() => markImageFailed(activeBannerBackgroundImage)}
                />
                {hasBannerText && (
                  <div className="absolute inset-0 bg-[linear-gradient(90deg,rgba(8,11,7,0.97)_0%,rgba(8,11,7,0.92)_34%,rgba(8,11,7,0.56)_58%,rgba(8,11,7,0.14)_100%)] sm:bg-[linear-gradient(90deg,rgba(8,11,7,0.96)_0%,rgba(8,11,7,0.84)_20%,rgba(8,11,7,0.54)_42%,rgba(8,11,7,0.2)_68%,rgba(8,11,7,0.08)_100%)]" />
                )}
                <div className="absolute inset-0 bg-[linear-gradient(180deg,rgba(8,11,7,0.12)_0%,rgba(8,11,7,0.04)_42%,rgba(8,11,7,0.28)_100%)]" />
                <div className="absolute inset-0 shadow-[inset_0_1px_0_rgba(255,255,255,0.04),inset_0_-40px_72px_rgba(0,0,0,0.2)]" />
              </>
            )}
            {!activeBannerBackgroundImage && (
              <>
                <div className="absolute inset-0 bg-gradient-to-r from-brand-surface via-brand-surface-light to-brand-gold/10" />
                <div className="absolute inset-0 bg-[radial-gradient(circle_at_top_left,_rgba(216,178,78,0.18),_transparent_34%),radial-gradient(circle_at_75%_18%,_rgba(255,255,255,0.05),_transparent_22%),linear-gradient(180deg,rgba(255,255,255,0.02),transparent_45%)]" />
              </>
            )}
            {hasBannerText && (
              <div className="relative flex h-full items-end px-4 py-4 sm:items-center sm:px-7 sm:py-6 lg:px-10 lg:py-7">
                <div className={activeBannerBackgroundImage ? 'max-w-[54%] sm:max-w-[340px] lg:max-w-[410px]' : 'max-w-xl'}>
                  {(activeOffer.display_badge?.trim() || activeOffer.title?.trim()) && (
                    <motion.span
                      initial={{ opacity: 0, y: 8 }}
                      animate={{ opacity: 1, y: 0 }}
                      transition={{ delay: 0.1, duration: 0.35 }}
                      className="mb-2 inline-block rounded-md border border-brand-gold/15 bg-brand-gold/18 px-2 py-1 text-[10px] font-bold tracking-wide text-brand-gold sm:px-2.5 sm:text-[12px]"
                    >
                      {getOfferBadgeLabel(activeOffer)}
                    </motion.span>
                  )}
                  {activeOffer.title?.trim() && (
                    <motion.h2
                      initial={{ opacity: 0, y: 10 }}
                      animate={{ opacity: 1, y: 0 }}
                      transition={{ delay: 0.15, duration: 0.4 }}
                      className="mb-1.5 text-[18px] font-extrabold leading-[1.02] text-white drop-shadow-[0_4px_18px_rgba(0,0,0,0.28)] sm:text-[30px] lg:text-[34px]"
                    >
                      {activeOffer.title}
                    </motion.h2>
                  )}
                  {activeBannerDescription && (
                    <motion.p
                      initial={{ opacity: 0, y: 10 }}
                      animate={{ opacity: 1, y: 0 }}
                      transition={{ delay: 0.2, duration: 0.4 }}
                      className="mb-2.5 whitespace-pre-line text-[11.5px] font-medium leading-[1.28] text-white/84 drop-shadow-[0_3px_10px_rgba(0,0,0,0.24)] sm:mb-3 sm:text-[14px] sm:leading-snug lg:text-[15px]"
                    >
                      {activeBannerDescription}
                    </motion.p>
                  )}
                  {activeBannerReward && (
                    <motion.span
                      initial={{ opacity: 0, scale: 0.9 }}
                      animate={{ opacity: 1, scale: 1 }}
                      transition={{ delay: 0.25, duration: 0.35 }}
                      className="inline-block text-[16px] font-black tracking-tight text-brand-gold drop-shadow-[0_4px_14px_rgba(0,0,0,0.26)] sm:text-[24px] lg:text-[28px]"
                    >
                      {activeBannerReward}
                    </motion.span>
                  )}
                  <motion.div
                    initial={{ opacity: 0, y: 10 }}
                    animate={{ opacity: 1, y: 0 }}
                    transition={{ delay: 0.3, duration: 0.35 }}
                    className="mt-3 sm:mt-4"
                  >
                    {activeBannerAction.kind === 'button' ? (
                      <button
                        type="button"
                        onClick={activeBannerAction.onClick}
                        className="inline-flex w-fit items-center gap-1.5 rounded-xl bg-brand-gold px-4 py-2 text-[13px] font-bold text-brand-bg shadow-[0_14px_30px_rgba(216,178,78,0.18)] transition-all hover:-translate-y-0.5 hover:brightness-110 sm:px-5 sm:py-2.5 sm:text-[14px]"
                      >
                        {activeBannerCtaText}
                      </button>
                    ) : (
                      <Link
                        to={activeBannerAction.to}
                        className="inline-flex w-fit items-center gap-1.5 rounded-xl bg-brand-gold px-4 py-2 text-[13px] font-bold text-brand-bg shadow-[0_14px_30px_rgba(216,178,78,0.18)] transition-all hover:-translate-y-0.5 hover:brightness-110 sm:px-5 sm:py-2.5 sm:text-[14px]"
                      >
                        {activeBannerCtaText}
                      </Link>
                    )}
                  </motion.div>
                </div>
              </div>
            )}
          </motion.div>
        </AnimatePresence>

        {offers.length > 1 && (
          <>
            <button
              type="button"
              onClick={() => advance(-1)}
              className="absolute left-3 top-1/2 z-10 hidden h-10 w-10 -translate-y-1/2 items-center justify-center rounded-full border border-white/12 bg-brand-bg/70 text-white backdrop-blur-xl transition-all hover:border-brand-gold/40 hover:text-brand-gold sm:flex"
              aria-label="Show previous offer"
            >
              <ChevronLeft size={18} strokeWidth={2.5} />
            </button>
            <button
              type="button"
              onClick={() => advance(1)}
              className="absolute right-3 top-1/2 z-10 hidden h-10 w-10 -translate-y-1/2 items-center justify-center rounded-full border border-white/12 bg-brand-bg/70 text-white backdrop-blur-xl transition-all hover:border-brand-gold/40 hover:text-brand-gold sm:flex"
              aria-label="Show next offer"
            >
              <ChevronRight size={18} strokeWidth={2.5} />
            </button>
            <div className="absolute bottom-2 left-1/2 z-10 flex -translate-x-1/2 gap-1.5">
              {offers.map((offer, index) => (
                <button
                  key={offer.id}
                  type="button"
                  onClick={() => goTo(index)}
                  className={`h-[3px] rounded-full transition-all duration-300 ${
                    index === activeIndex ? 'w-6 bg-brand-gold' : 'w-2 bg-brand-text/25'
                  }`}
                  aria-label={`Show offer ${index + 1}`}
                />
              ))}
            </div>
          </>
        )}
      </div>
    </div>
  );
}
