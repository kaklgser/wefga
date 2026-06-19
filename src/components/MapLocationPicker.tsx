import { useState, useEffect, useRef, useCallback } from 'react';
import { createPortal } from 'react-dom';
import {
  ArrowLeft, MapPin, Navigation, Search, Loader2, X, Home, Layers,
  Plus, Minus, Building2, Hash, Landmark, AlertCircle, CheckCircle2,
  ChevronRight, StickyNote,
} from 'lucide-react';
import { DARK_MAP_STYLE, getGoogleMapsKey, getGoogleMapsLoader } from '../lib/googlemaps';
import type { MapConfirmData } from '../types';

// ─── Constants ────────────────────────────────────────────────────────────────
const DEFAULT_LAT = 16.4724;
const DEFAULT_LNG = 80.6516;
const DEFAULT_ZOOM = 16;
const FLY_ZOOM    = 17;
const TILE_PREF_KEY = 'mapTilePreference';
const DELIVERY_RADIUS_KM = 15;
const RESTAURANT_LAT = 16.4724;
const RESTAURANT_LNG = 80.6516;

type TileMode = 'street' | 'satellite';
type Step = 'map' | 'details';

// ─── Types ────────────────────────────────────────────────────────────────────
interface SearchSuggestion {
  label: string;
  sublabel: string;
  placeId: string;
}

interface Props {
  initialLat: number | null;
  initialLng: number | null;
  onConfirm: (data: MapConfirmData) => void;
  onClose: () => void;
}

// ─── Helpers ─────────────────────────────────────────────────────────────────
function haversineKm(lat1: number, lng1: number, lat2: number, lng2: number): number {
  const R = 6371;
  const dLat = ((lat2 - lat1) * Math.PI) / 180;
  const dLng = ((lng2 - lng1) * Math.PI) / 180;
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos((lat1 * Math.PI) / 180) * Math.cos((lat2 * Math.PI) / 180) * Math.sin(dLng / 2) ** 2;
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

function calcConfidence(house: string, building: string, landmark: string, pinMoved: boolean): number {
  let score = 0;
  if (house.trim()) score += 40;
  if (building.trim()) score += 20;
  if (landmark.trim()) score += 20;
  if (pinMoved) score += 20;
  return score;
}

function parseGoogleComponents(components: google.maps.GeocoderAddressComponent[]) {
  const get = (type: string) =>
    components.find((c) => c.types.includes(type))?.long_name || '';
  const area =
    get('sublocality_level_1') ||
    get('sublocality') ||
    get('neighborhood') ||
    get('locality') ||
    '';
  const pincode = get('postal_code').replace(/\s/g, '');
  return { area, pincode };
}

// ─── Component ────────────────────────────────────────────────────────────────
export default function MapLocationPicker({ initialLat, initialLng, onConfirm, onClose }: Props) {
  const mapContainerRef  = useRef<HTMLDivElement>(null);
  const searchWrapperRef = useRef<HTMLDivElement>(null);
  const detailInputRef   = useRef<HTMLInputElement>(null);
  const mapRef           = useRef<google.maps.Map | null>(null);
  const placesServiceRef = useRef<google.maps.places.PlacesService | null>(null);
  const geocoderRef      = useRef<google.maps.Geocoder | null>(null);
  const resolveDebounceRef = useRef<ReturnType<typeof setTimeout>>();
  const searchDebounceRef  = useRef<ReturnType<typeof setTimeout>>();

  // ── Step ─────────────────────────────────────────────────────────────────
  const [step, setStep] = useState<Step>('map');
  const [mapsLoaded, setMapsLoaded] = useState(false);
  const [mapsError, setMapsError] = useState(false);

  // ── Map state ────────────────────────────────────────────────────────────
  const [centerLat, setCenterLat] = useState(initialLat ?? DEFAULT_LAT);
  const [centerLng, setCenterLng] = useState(initialLng ?? DEFAULT_LNG);
  const [pinManuallyMoved, setPinManuallyMoved] = useState(false);
  const [detectedGpsLat, setDetectedGpsLat] = useState<number | null>(null);
  const [detectedGpsLng, setDetectedGpsLng] = useState<number | null>(null);
  const [tileMode, setTileMode] = useState<TileMode>(() => {
    if (typeof window === 'undefined') return 'street';
    return window.localStorage.getItem(TILE_PREF_KEY) === 'satellite' ? 'satellite' : 'street';
  });

  // ── Reverse geocode state ─────────────────────────────────────────────────
  const [resolving, setResolving]             = useState(true);
  const [areaName, setAreaName]               = useState('');
  const [fullAddress, setFullAddress]         = useState('');
  const [detectedPincode, setDetectedPincode] = useState('');
  const [outOfRange, setOutOfRange]           = useState(false);

  // ── Search state ──────────────────────────────────────────────────────────
  const [searchQuery, setSearchQuery]     = useState('');
  const [searchResults, setSearchResults] = useState<SearchSuggestion[]>([]);
  const [searching, setSearching]         = useState(false);
  const [showResults, setShowResults]     = useState(false);
  const [noResults, setNoResults]         = useState(false);
  const [locating, setLocating]           = useState(false);

  // ── Details step ─────────────────────────────────────────────────────────
  const [houseNumber, setHouseNumber]               = useState('');
  const [buildingName, setBuildingName]             = useState('');
  const [floorNumber, setFloorNumber]               = useState('');
  const [landmark, setLandmark]                     = useState('');
  const [deliveryInstructions, setDeliveryInstructions] = useState('');
  const [manualPincode, setManualPincode]           = useState('');
  const [houseError, setHouseError]                 = useState(false);
  const [pincodeError, setPincodeError]             = useState(false);

  const confidenceScore = calcConfidence(houseNumber, buildingName, landmark, pinManuallyMoved);
  const finalPincode = detectedPincode || manualPincode.replace(/\D/g, '').slice(0, 6);
  const needsPincodeInput = step === 'details' && !resolving && !detectedPincode;

  // ── Reverse geocode ───────────────────────────────────────────────────────
  const reverseGeocode = useCallback((lat: number, lng: number) => {
    if (!geocoderRef.current) return;
    setResolving(true);
    setOutOfRange(haversineKm(RESTAURANT_LAT, RESTAURANT_LNG, lat, lng) > DELIVERY_RADIUS_KM);

    geocoderRef.current.geocode(
      { location: { lat, lng }, region: 'IN' },
      (results, status) => {
        if (status === 'OK' && results && results[0]) {
          const { area, pincode } = parseGoogleComponents(results[0].address_components);
          setAreaName(area);
          setFullAddress(results[0].formatted_address);
          setDetectedPincode(pincode.length === 6 ? pincode : '');
        } else {
          setAreaName('');
          setFullAddress('');
          setDetectedPincode('');
        }
        setResolving(false);
      },
    );
  }, []);

  // ── Google Maps init ──────────────────────────────────────────────────────
  useEffect(() => {
    let cancelled = false;

    void getGoogleMapsKey().then((key) => {
      if (cancelled) return;
      if (!key) { setMapsError(true); return; }

      void getGoogleMapsLoader(key)
        .load()
        .then(() => {
          if (cancelled || !mapContainerRef.current) return;

        const map = new window.google.maps.Map(mapContainerRef.current, {
          center       : { lat: initialLat ?? DEFAULT_LAT, lng: initialLng ?? DEFAULT_LNG },
          zoom         : DEFAULT_ZOOM,
          mapTypeId    : tileMode === 'satellite' ? 'satellite' : 'roadmap',
          styles       : tileMode === 'street' ? DARK_MAP_STYLE : undefined,
          disableDefaultUI: true,
          gestureHandling : 'greedy',
          clickableIcons  : false,
        });

        mapRef.current = map;
        geocoderRef.current = new window.google.maps.Geocoder();
        placesServiceRef.current = new window.google.maps.places.PlacesService(map);

        map.addListener('drag', () => setPinManuallyMoved(true));

        map.addListener('idle', () => {
          const c = map.getCenter();
          if (!c) return;
          const lat = c.lat();
          const lng = c.lng();
          setCenterLat(lat);
          setCenterLng(lng);
          if (resolveDebounceRef.current) clearTimeout(resolveDebounceRef.current);
          resolveDebounceRef.current = setTimeout(() => reverseGeocode(lat, lng), 600);
        });

        setMapsLoaded(true);
        reverseGeocode(initialLat ?? DEFAULT_LAT, initialLng ?? DEFAULT_LNG);
      })
      .catch(() => setMapsError(true));
    });

    return () => {
      cancelled = true;
      if (resolveDebounceRef.current) clearTimeout(resolveDebounceRef.current);
      if (searchDebounceRef.current)  clearTimeout(searchDebounceRef.current);
      mapRef.current = null;
    };
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  // ── Tile mode toggle ─────────────────────────────────────────────────────
  useEffect(() => {
    if (!mapRef.current) return;
    if (tileMode === 'satellite') {
      mapRef.current.setMapTypeId('satellite');
      mapRef.current.setOptions({ styles: [] });
    } else {
      mapRef.current.setMapTypeId('roadmap');
      mapRef.current.setOptions({ styles: DARK_MAP_STYLE });
    }
    if (typeof window !== 'undefined') window.localStorage.setItem(TILE_PREF_KEY, tileMode);
  }, [tileMode]);

  // ── Click-outside search ─────────────────────────────────────────────────
  useEffect(() => {
    function handler(e: MouseEvent) {
      if (searchWrapperRef.current && !searchWrapperRef.current.contains(e.target as Node)) {
        setShowResults(false);
      }
    }
    document.addEventListener('mousedown', handler);
    return () => document.removeEventListener('mousedown', handler);
  }, []);

  // ── Fly to ───────────────────────────────────────────────────────────────
  function flyTo(lat: number, lng: number) {
    if (!mapRef.current) return;
    mapRef.current.panTo({ lat, lng });
    mapRef.current.setZoom(FLY_ZOOM);
  }

  // ── GPS ──────────────────────────────────────────────────────────────────
  function detectLocation() {
    if (!navigator.geolocation) return;
    setLocating(true);
    navigator.geolocation.getCurrentPosition(
      (pos) => {
        const { latitude: lat, longitude: lng } = pos.coords;
        setDetectedGpsLat(lat);
        setDetectedGpsLng(lng);
        setCenterLat(lat);
        setCenterLng(lng);
        flyTo(lat, lng);
        setLocating(false);
      },
      () => setLocating(false),
      { enableHighAccuracy: true, timeout: 10000 },
    );
  }

  // ── Search ───────────────────────────────────────────────────────────────
  function doSearch(q: string) {
    if (!mapsLoaded || q.trim().length < 2) { setSearchResults([]); setNoResults(false); return; }
    setSearching(true);
    setNoResults(false);

    const service = new window.google.maps.places.AutocompleteService();
    service.getPlacePredictions(
      {
        input                 : q,
        componentRestrictions : { country: 'IN' },
        locationBias          : { center: { lat: centerLat, lng: centerLng }, radius: 50000 },
      },
      (predictions, status) => {
        setSearching(false);
        if (
          status !== window.google.maps.places.PlacesServiceStatus.OK ||
          !predictions ||
          predictions.length === 0
        ) {
          setSearchResults([]);
          setShowResults(false);
          setNoResults(true);
          return;
        }
        setSearchResults(
          predictions.map((p) => ({
            label   : p.structured_formatting.main_text,
            sublabel: p.structured_formatting.secondary_text || '',
            placeId : p.place_id,
          })),
        );
        setShowResults(true);
        setNoResults(false);
      },
    );
  }

  function handleSearchChange(value: string) {
    setSearchQuery(value);
    if (!value.trim()) { setSearchResults([]); setShowResults(false); setNoResults(false); }
    if (searchDebounceRef.current) clearTimeout(searchDebounceRef.current);
    searchDebounceRef.current = setTimeout(() => doSearch(value), 300);
  }

  function selectSearchResult(r: SearchSuggestion) {
    setSearchQuery('');
    setSearchResults([]);
    setShowResults(false);
    setNoResults(false);

    if (!placesServiceRef.current) return;
    placesServiceRef.current.getDetails(
      { placeId: r.placeId, fields: ['geometry'] },
      (place, status) => {
        if (
          status === window.google.maps.places.PlacesServiceStatus.OK &&
          place?.geometry?.location
        ) {
          const lat = place.geometry.location.lat();
          const lng = place.geometry.location.lng();
          flyTo(lat, lng);
        }
      },
    );
  }

  // ── Proceed to details ───────────────────────────────────────────────────
  function proceedToDetails() {
    setStep('details');
    setTimeout(() => detailInputRef.current?.focus(), 150);
  }

  // ── Final confirm ─────────────────────────────────────────────────────────
  function handleConfirm() {
    let valid = true;
    if (!houseNumber.trim()) { setHouseError(true); valid = false; }
    if (finalPincode.length !== 6) { setPincodeError(true); valid = false; }
    if (!valid) return;

    const baseAddress = fullAddress || areaName || '';
    const parts = [
      houseNumber.trim(),
      buildingName.trim(),
      floorNumber.trim() ? `Floor ${floorNumber.trim()}` : '',
      baseAddress,
    ].filter(Boolean);

    onConfirm({
      address             : parts.join(', '),
      pincode             : finalPincode,
      lat                 : centerLat,
      lng                 : centerLng,
      houseNumber         : houseNumber.trim(),
      buildingName        : buildingName.trim(),
      floorNumber         : floorNumber.trim(),
      landmark            : landmark.trim(),
      deliveryInstructions: deliveryInstructions.trim(),
      detectedGpsLat,
      detectedGpsLng,
      confidenceScore,
      pinManuallyMoved,
    });
  }

  if (typeof document === 'undefined') return null;

  // ── No API key fallback ───────────────────────────────────────────────────
  if (mapsError) {
    return createPortal(
      <div className="fixed inset-0 z-[200] flex flex-col items-center justify-center bg-brand-surface px-6 gap-4">
        <MapPin size={36} className="text-brand-gold" strokeWidth={1.8} />
        <p className="text-white font-bold text-[16px] text-center">Map unavailable</p>
        <p className="text-brand-text-dim text-[13px] text-center leading-relaxed">
          The map service is not configured. Please enter your address manually.
        </p>
        <button onClick={onClose} className="btn-primary px-8 py-3 rounded-xl text-[14px] font-bold">Go back</button>
      </div>,
      document.body,
    );
  }

  // ─── Render ───────────────────────────────────────────────────────────────
  return createPortal(
    <div className="fixed inset-0 z-[200] flex flex-col" style={{ background: '#0f1117' }}>

      {/* ── Step indicator ── */}
      <div className="flex-shrink-0 bg-brand-surface border-b border-brand-border px-4 py-2 flex items-center gap-2">
        <StepDot n={1} active={step === 'map'} done={step === 'details'} label="Pin location" />
        <div className="flex-1 h-px bg-brand-border" />
        <StepDot n={2} active={step === 'details'} done={false} label="Address details" />
      </div>

      {/* ── Header ── */}
      <div className="flex-shrink-0 bg-brand-surface border-b border-brand-border">
        <div className="flex items-center gap-3 px-4 pt-3 pb-2">
          <button
            onClick={step === 'details' ? () => setStep('map') : onClose}
            className="p-2 -ml-2 rounded-xl hover:bg-brand-surface-light transition-colors text-white"
          >
            <ArrowLeft size={20} strokeWidth={2.2} />
          </button>
          <h2 className="text-[15px] font-bold text-white flex-1">
            {step === 'map' ? 'Set delivery location' : 'Add address details'}
          </h2>
          {step === 'map' && (
            <button
              onClick={detectLocation}
              disabled={locating}
              className="flex items-center gap-1.5 px-3 py-1.5 bg-brand-gold/10 border border-brand-gold/20 rounded-lg text-brand-gold text-[12px] font-bold hover:bg-brand-gold/15 transition-all disabled:opacity-50"
            >
              {locating ? <Loader2 size={13} className="animate-spin" /> : <Navigation size={13} strokeWidth={2.2} />}
              <span>My location</span>
            </button>
          )}
        </div>

        {/* Search bar — map step only */}
        {step === 'map' && (
          <div ref={searchWrapperRef} className="relative px-4 pb-3">
            <Search size={15} strokeWidth={2.2} className="absolute left-7 top-1/2 -translate-y-1/2 text-brand-text-dim pointer-events-none" />
            <input
              type="text"
              placeholder="Search area, street, landmark..."
              value={searchQuery}
              onChange={(e) => handleSearchChange(e.target.value)}
              onFocus={() => searchResults.length > 0 && setShowResults(true)}
              className="input-field pl-9 pr-9 text-[14px] w-full"
            />
            {searching
              ? <Loader2 size={15} className="absolute right-7 top-1/2 -translate-y-1/2 text-brand-text-dim animate-spin pointer-events-none" />
              : searchQuery && (
                <button
                  type="button"
                  onClick={() => { setSearchQuery(''); setSearchResults([]); setShowResults(false); setNoResults(false); }}
                  className="absolute right-7 top-1/2 -translate-y-1/2 text-brand-text-dim hover:text-white transition-colors"
                >
                  <X size={15} strokeWidth={2.2} />
                </button>
              )}

            {(showResults && searchResults.length > 0) || noResults ? (
              <div className="absolute left-4 right-4 top-full mt-0.5 bg-brand-surface border border-brand-border rounded-xl shadow-elevated z-10 max-h-64 overflow-y-auto">
                {noResults ? (
                  <div className="px-4 py-4 text-center">
                    <p className="text-[13px] text-brand-text-dim font-semibold">No results found</p>
                    <p className="text-[11px] text-brand-text-dim/60 mt-1 leading-snug">
                      Try a different spelling or use<br />
                      <span className="text-brand-gold font-bold">Satellite</span> view to spot your building.
                    </p>
                  </div>
                ) : (
                  searchResults.map((r, i) => (
                    <button
                      key={i}
                      type="button"
                      onClick={() => selectSearchResult(r)}
                      className="w-full text-left px-4 py-3 hover:bg-brand-surface-light transition-colors border-b border-brand-border last:border-0 flex items-start gap-3"
                    >
                      <MapPin size={14} strokeWidth={2.2} className="text-brand-gold flex-shrink-0 mt-1" />
                      <div className="min-w-0">
                        <p className="text-[13px] text-white font-semibold leading-snug truncate">{r.label}</p>
                        {r.sublabel && <p className="text-[11px] text-brand-text-dim leading-snug truncate mt-0.5">{r.sublabel}</p>}
                      </div>
                    </button>
                  ))
                )}
              </div>
            ) : null}
          </div>
        )}
      </div>

      {/* ── Map (always mounted, hidden on details step) ── */}
      <div className={`relative min-h-0 ${step === 'map' ? 'flex-1' : 'h-0 overflow-hidden'}`}>
        {/* Map container */}
        <div ref={mapContainerRef} className="absolute inset-0" style={{ background: '#0f1117' }}>
          {!mapsLoaded && (
            <div className="absolute inset-0 flex items-center justify-center gap-2 text-brand-text-dim text-[13px]">
              <Loader2 size={16} className="animate-spin text-brand-gold" />
              <span>Loading map...</span>
            </div>
          )}
        </div>

        {/* Fixed centre pin */}
        <div className="absolute pointer-events-none flex flex-col items-center" style={{ zIndex: 9999, left: '50%', top: '50%', transform: 'translate(-50%, -100%)' }}>
          <div style={{ width: 46, height: 46, borderRadius: '50%', background: '#D8B24E', border: '3px solid #ffffff', display: 'flex', alignItems: 'center', justifyContent: 'center', boxShadow: '0 6px 28px rgba(216,178,78,0.65), 0 2px 8px rgba(0,0,0,0.4)' }}>
            <MapPin size={22} color="#0f1117" strokeWidth={2.8} />
          </div>
          <div style={{ width: 3, height: 14, background: '#D8B24E', borderRadius: '0 0 3px 3px' }} />
          <div style={{ width: 10, height: 4, borderRadius: '50%', background: 'rgba(0,0,0,0.25)', marginTop: 1 }} />
        </div>

        {/* Drag hint */}
        <div className="absolute top-3 left-1/2 -translate-x-1/2 pointer-events-none" style={{ zIndex: 9999 }}>
          <div className="rounded-full px-3.5 py-1.5 text-[11px] font-semibold text-white/90" style={{ background: 'rgba(0,0,0,0.55)', backdropFilter: 'blur(6px)' }}>
            {pinManuallyMoved ? 'Pin moved ✓ — drag to fine-tune' : 'Move the pin to your exact entrance'}
          </div>
        </div>

        {/* Out-of-range warning */}
        {outOfRange && (
          <div className="absolute bottom-44 left-4 right-4 pointer-events-none" style={{ zIndex: 9999 }}>
            <div className="rounded-xl px-4 py-3 flex items-center gap-2" style={{ background: 'rgba(239,68,68,0.92)', backdropFilter: 'blur(8px)' }}>
              <AlertCircle size={16} className="text-white flex-shrink-0" />
              <p className="text-white text-[12px] font-bold">Sorry, this address is outside our delivery area.</p>
            </div>
          </div>
        )}

        {/* Map / Satellite toggle */}
        <button
          type="button"
          onClick={() => setTileMode((m) => (m === 'street' ? 'satellite' : 'street'))}
          className="absolute top-3 right-3 flex items-center gap-1.5 px-3 py-2 rounded-xl text-[12px] font-bold text-white shadow-elevated hover:scale-105 active:scale-95 transition-transform"
          style={{ zIndex: 9999, background: 'rgba(15,17,23,0.85)', backdropFilter: 'blur(8px)', border: '1px solid rgba(216,178,78,0.35)' }}
        >
          <Layers size={14} strokeWidth={2.2} className="text-brand-gold" />
          <span>{tileMode === 'street' ? 'Satellite' : 'Map'}</span>
        </button>

        {/* Zoom buttons */}
        <div className="absolute bottom-36 right-3 flex flex-col gap-1" style={{ zIndex: 9999 }}>
          <button type="button" onClick={() => mapRef.current?.setZoom((mapRef.current.getZoom() ?? DEFAULT_ZOOM) + 1)} className="w-9 h-9 flex items-center justify-center rounded-xl text-white hover:scale-105 active:scale-95 transition-transform" style={{ background: 'rgba(15,17,23,0.85)', backdropFilter: 'blur(8px)', border: '1px solid rgba(255,255,255,0.15)' }}>
            <Plus size={16} strokeWidth={2.5} />
          </button>
          <button type="button" onClick={() => mapRef.current?.setZoom((mapRef.current.getZoom() ?? DEFAULT_ZOOM) - 1)} className="w-9 h-9 flex items-center justify-center rounded-xl text-white hover:scale-105 active:scale-95 transition-transform" style={{ background: 'rgba(15,17,23,0.85)', backdropFilter: 'blur(8px)', border: '1px solid rgba(255,255,255,0.15)' }}>
            <Minus size={16} strokeWidth={2.5} />
          </button>
        </div>
      </div>

      {/* ── Map step bottom sheet ── */}
      {step === 'map' && (
        <div className="flex-shrink-0 bg-brand-surface border-t border-brand-border px-4 pt-4 pb-6 space-y-3">
          <div className="flex items-start gap-3 min-h-[44px]">
            <div className="w-9 h-9 rounded-full flex-shrink-0 flex items-center justify-center mt-0.5" style={{ background: 'rgba(216,178,78,0.12)' }}>
              <MapPin size={16} className="text-brand-gold" strokeWidth={2.2} />
            </div>
            <div className="flex-1 min-w-0">
              {resolving ? (
                <div className="flex items-center gap-2 text-brand-text-dim text-[13px]">
                  <Loader2 size={13} className="animate-spin" />
                  <span>Locating address...</span>
                </div>
              ) : (
                <>
                  <p className="text-[15px] font-bold text-white leading-tight">{areaName || 'Move map to set location'}</p>
                  {fullAddress && <p className="text-[12px] text-brand-text-muted leading-snug mt-0.5 line-clamp-2">{fullAddress}</p>}
                  {detectedPincode && (
                    <span className="inline-block mt-1 text-[11px] font-semibold text-brand-text-dim bg-brand-surface-light px-2 py-0.5 rounded-md">{detectedPincode}</span>
                  )}
                </>
              )}
            </div>
          </div>

          <button
            onClick={proceedToDetails}
            disabled={resolving || outOfRange || (!areaName && !fullAddress)}
            className="btn-primary w-full rounded-xl py-3.5 text-[15px] font-black flex items-center justify-center gap-2 disabled:opacity-40 disabled:cursor-not-allowed"
          >
            <span>Add address details</span>
            <ChevronRight size={17} strokeWidth={2.5} />
          </button>
        </div>
      )}

      {/* ── Details step ── */}
      {step === 'details' && (
        <div className="flex-1 overflow-y-auto bg-brand-surface">
          <div className="px-4 pt-4 pb-6 space-y-4">
            {/* Area summary */}
            <div className="flex items-center gap-3 bg-brand-surface-light rounded-xl px-4 py-3 border border-brand-border">
              <MapPin size={15} className="text-brand-gold flex-shrink-0" strokeWidth={2.2} />
              <div className="flex-1 min-w-0">
                <p className="text-[13px] font-semibold text-white truncate">{areaName || fullAddress || 'Selected location'}</p>
                {detectedPincode && <p className="text-[11px] text-brand-text-dim">{detectedPincode}</p>}
              </div>
              <button onClick={() => setStep('map')} className="text-brand-gold text-[12px] font-bold hover:text-brand-gold/80 flex-shrink-0">Change</button>
            </div>

            {/* House / Flat (required) */}
            <div className="space-y-1.5">
              <label className="flex items-center gap-1.5 text-[12px] font-bold text-white">
                <Hash size={12} strokeWidth={2.5} className="text-brand-gold" />
                House / Flat no.
                <span className="text-red-400 text-[13px] leading-none">*</span>
              </label>
              <input
                ref={detailInputRef}
                type="text"
                placeholder="e.g. 4B, Door no. 23"
                value={houseNumber}
                onChange={(e) => { setHouseNumber(e.target.value); if (e.target.value.trim()) setHouseError(false); }}
                className={`input-field text-[14px] ${houseError ? 'border-red-500/60 focus:border-red-500' : ''}`}
              />
              {houseError && <p className="text-[12px] text-red-400 font-semibold">Enter your house / flat number</p>}
            </div>

            {/* Building Name */}
            <div className="space-y-1.5">
              <label className="flex items-center gap-1.5 text-[12px] font-bold text-white">
                <Building2 size={12} strokeWidth={2.5} className="text-brand-gold" />
                Apartment / Building name
              </label>
              <input
                type="text"
                placeholder="e.g. Sri Sai Residency"
                value={buildingName}
                onChange={(e) => setBuildingName(e.target.value)}
                className="input-field text-[14px]"
              />
            </div>

            {/* Floor */}
            <div className="space-y-1.5">
              <label className="flex items-center gap-1.5 text-[12px] font-bold text-white">
                <Home size={12} strokeWidth={2.5} className="text-brand-gold" />
                Floor number
              </label>
              <input
                type="text"
                inputMode="numeric"
                placeholder="e.g. 3"
                value={floorNumber}
                onChange={(e) => setFloorNumber(e.target.value)}
                className="input-field text-[14px]"
              />
            </div>

            {/* Landmark */}
            <div className="space-y-1.5">
              <label className="flex items-center gap-1.5 text-[12px] font-bold text-white">
                <Landmark size={12} strokeWidth={2.5} className="text-brand-gold" />
                Landmark
              </label>
              <input
                type="text"
                placeholder="e.g. Near SBI ATM, opposite school"
                value={landmark}
                onChange={(e) => setLandmark(e.target.value)}
                className="input-field text-[14px]"
              />
            </div>

            {/* Delivery instructions */}
            <div className="space-y-1.5">
              <label className="flex items-center gap-1.5 text-[12px] font-bold text-white">
                <StickyNote size={12} strokeWidth={2.5} className="text-brand-gold" />
                Delivery instructions
                <span className="text-brand-text-dim font-normal">(optional)</span>
              </label>
              <textarea
                rows={2}
                placeholder="e.g. Ring bell twice, leave at door..."
                value={deliveryInstructions}
                onChange={(e) => setDeliveryInstructions(e.target.value)}
                className="input-field text-[14px] resize-none leading-relaxed"
              />
            </div>

            {/* Pincode fallback */}
            {needsPincodeInput && (
              <div className="space-y-1">
                <input
                  type="text"
                  inputMode="numeric"
                  placeholder="Enter 6-digit pincode *"
                  value={manualPincode}
                  onChange={(e) => { setManualPincode(e.target.value.replace(/\D/g, '').slice(0, 6)); setPincodeError(false); }}
                  className={`input-field text-[14px] ${pincodeError ? 'border-red-500/60 focus:border-red-500' : ''}`}
                />
                {pincodeError && <p className="text-[12px] text-red-400 font-semibold">Enter a valid 6-digit pincode</p>}
              </div>
            )}

            {/* Confidence */}
            <ConfidenceBar score={confidenceScore} />

            {/* Confirm */}
            <button
              onClick={handleConfirm}
              className="btn-primary w-full rounded-xl py-3.5 text-[15px] font-black flex items-center justify-center gap-2"
            >
              <CheckCircle2 size={17} strokeWidth={2.5} />
              <span>Confirm address</span>
            </button>
          </div>
        </div>
      )}
    </div>,
    document.body,
  );
}

// ── Sub-components ────────────────────────────────────────────────────────────
function StepDot({ n, active, done, label }: { n: number; active: boolean; done: boolean; label: string }) {
  return (
    <div className="flex items-center gap-1.5">
      <div className={`w-5 h-5 rounded-full flex items-center justify-center text-[10px] font-black transition-colors ${done ? 'bg-emerald-500 text-white' : active ? 'bg-brand-gold text-brand-bg' : 'bg-brand-border text-brand-text-dim'}`}>
        {done ? <CheckCircle2 size={12} strokeWidth={3} /> : n}
      </div>
      <span className={`text-[11px] font-semibold ${active ? 'text-white' : 'text-brand-text-dim'}`}>{label}</span>
    </div>
  );
}

function ConfidenceBar({ score }: { score: number }) {
  const low = score < 60;
  return (
    <div className="space-y-1.5">
      <div className="flex items-center justify-between">
        <span className="text-[11px] font-bold text-brand-text-dim">Address confidence</span>
        <span className={`text-[11px] font-bold ${low ? 'text-amber-400' : 'text-emerald-400'}`}>{score}%</span>
      </div>
      <div className="h-1.5 bg-brand-border rounded-full overflow-hidden">
        <div className={`h-full rounded-full transition-all duration-300 ${low ? 'bg-amber-500' : 'bg-emerald-500'}`} style={{ width: `${score}%` }} />
      </div>
      {low && (
        <p className="text-[11px] text-amber-400 flex items-center gap-1 leading-snug">
          <AlertCircle size={11} strokeWidth={2.5} />
          Add more details to help the delivery partner find you
        </p>
      )}
    </div>
  );
}
