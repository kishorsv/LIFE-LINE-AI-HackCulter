import { useCallback, useEffect, useRef, useState } from 'react';
import { useMap } from '@vis.gl/react-google-maps';
import { AlertTriangle, RefreshCw } from 'lucide-react';
import {
  clearMapsErrorState,
  detectMapsErrorCodeFromText,
  dispatchMapsAuthError,
  dispatchMapsQuotaExceeded,
  GoogleMapsAuthErrorDetail,
} from '../lib/googleMapsStatus.ts';

export function useGoogleMapsStatus() {
  const [mapsAuthError, setMapsAuthError] = useState<GoogleMapsAuthErrorDetail | null>(() =>
    typeof window !== 'undefined' ? window.__lifelineMapsAuthError || null : null
  );
  const [mapsQuotaExceeded, setMapsQuotaExceeded] = useState<boolean>(() =>
    typeof window !== 'undefined' ? Boolean(window.__lifelineMapsQuotaExceeded) : false
  );
  const [retrySeed, setRetrySeed] = useState(0);

  useEffect(() => {
    const onAuth = (ev: Event) => {
      const detail = (ev as CustomEvent<GoogleMapsAuthErrorDetail>).detail;
      if (detail) setMapsAuthError(detail);
    };
    const onQuota = () => setMapsQuotaExceeded(true);
    const onClear = () => {
      setMapsAuthError(null);
      setMapsQuotaExceeded(false);
    };

    window.addEventListener('gmp-auth-error', onAuth);
    window.addEventListener('gmp-quota-exceeded', onQuota);
    window.addEventListener('gmp-auth-cleared', onClear);
    return () => {
      window.removeEventListener('gmp-auth-error', onAuth);
      window.removeEventListener('gmp-quota-exceeded', onQuota);
      window.removeEventListener('gmp-auth-cleared', onClear);
    };
  }, []);

  const handleApiError = useCallback((err: unknown) => {
    const raw = err instanceof Error ? err.message : String(err || 'Google Maps API failed to load');
    if (/OverQuotaMapError|QuotaExceeded|OVER_QUERY_LIMIT|RESOURCE_EXHAUSTED/i.test(raw)) {
      dispatchMapsQuotaExceeded();
      return;
    }
    const detected = detectMapsErrorCodeFromText(raw) || 'AuthFailure';
    dispatchMapsAuthError(detected, raw);
  }, []);

  const retryMaps = useCallback(() => {
    clearMapsErrorState();
    setRetrySeed((s) => s + 1);
  }, []);

  return {
    mapsAuthError,
    mapsQuotaExceeded,
    retrySeed,
    handleApiError,
    retryMaps,
  };
}

export function MapCameraController({
  center,
  zoom,
}: {
  center: { lat: number; lng: number };
  zoom?: number;
}) {
  const map = useMap();
  const prevRef = useRef<{ lat: number; lng: number } | null>(null);

  useEffect(() => {
    if (!map) return;
    if (!Number.isFinite(center.lat) || !Number.isFinite(center.lng)) return;
    const prev = prevRef.current;
    if (!prev || Math.abs(prev.lat - center.lat) > 1e-6 || Math.abs(prev.lng - center.lng) > 1e-6) {
      if (prev && typeof (map as unknown as { panTo?: (pt: { lat: number; lng: number }) => void }).panTo === 'function') {
        (map as unknown as { panTo: (pt: { lat: number; lng: number }) => void }).panTo(center);
      } else if (typeof (map as unknown as { setCenter?: (pt: { lat: number; lng: number }) => void }).setCenter === 'function') {
        (map as unknown as { setCenter: (pt: { lat: number; lng: number }) => void }).setCenter(center);
      }
      if (typeof zoom === 'number' && typeof (map as unknown as { setZoom?: (z: number) => void }).setZoom === 'function') {
        (map as unknown as { setZoom: (z: number) => void }).setZoom(zoom);
      }
      prevRef.current = { lat: center.lat, lng: center.lng };
    }
  }, [map, center.lat, center.lng, zoom]);

  return null;
}

export function GoogleMapsErrorOverlay({
  authError,
  quotaExceeded,
  onRetry,
}: {
  authError: GoogleMapsAuthErrorDetail | null;
  quotaExceeded: boolean;
  onRetry?: () => void;
}) {
  if (!authError && !quotaExceeded) return null;
  const originPattern = authError?.origin ? `${authError.origin}/*` : 'https://your-domain.vercel.app/*';

  return (
    <div className="absolute inset-0 z-20 flex items-center justify-center bg-slate-950/90 p-5 text-slate-100 backdrop-blur-sm">
      <div className="max-w-md rounded-2xl border border-amber-500/40 bg-slate-900 p-5 shadow-2xl space-y-3 text-xs">
        <div className="flex items-start gap-2.5">
          <AlertTriangle className="h-5 w-5 shrink-0 text-amber-400" />
          <div className="space-y-1">
            <h3 className="font-display text-sm font-bold text-white">
              {quotaExceeded ? 'Google Maps API Quota Reached' : 'Google Maps API Error'}
            </h3>
            <p className="text-slate-300 leading-relaxed">
              {quotaExceeded
                ? 'Google Maps Platform usage limit or billing quota was exceeded for this key.'
                : authError?.message}
            </p>
          </div>
        </div>

        {!quotaExceeded && (
          <div className="rounded-xl border border-slate-700 bg-slate-950 p-3 text-[11px] text-slate-300 space-y-1">
            <div className="font-semibold text-amber-300">Required Google Cloud Console check:</div>
            <div>
              1. Add <code className="rounded bg-slate-800 px-1.5 py-0.5 text-emerald-300">{originPattern}</code> to{' '}
              <strong>Website restrictions (HTTP referrers)</strong> on{' '}
              <code className="text-slate-200">VITE_GOOGLE_MAPS_API_KEY</code>.
            </div>
            <div>
              2. Ensure <strong>Maps JavaScript API</strong>, <strong>Places API (New)</strong>, and{' '}
              <strong>Routes API</strong> are enabled with active billing.
            </div>
          </div>
        )}

        {onRetry && (
          <button
            type="button"
            onClick={onRetry}
            className="inline-flex items-center gap-1.5 rounded-xl bg-violet-600 px-3.5 py-2 text-xs font-semibold text-white hover:bg-violet-500"
          >
            <RefreshCw className="h-3.5 w-3.5" />
            <span>Retry Google Maps</span>
          </button>
        )}
      </div>
    </div>
  );
}
