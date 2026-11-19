import { useEffect, useRef } from 'react';
import { APIProvider, AdvancedMarker, Map as GoogleMap, Pin, useMap } from '@vis.gl/react-google-maps';
import { SafeRouteCandidateItem } from '../types/lifeline.ts';
import { GoogleMapsErrorOverlay, MapCameraController, useGoogleMapsStatus } from './GoogleMapsHelpers.tsx';

function PulsePolylineRenderer({
  routes,
  selectedIndex,
}: {
  routes: SafeRouteCandidateItem[];
  selectedIndex: number;
}) {
  const map = useMap();
  const linesRef = useRef<Array<{ setMap: (m: unknown | null) => void }>>([]);

  useEffect(() => {
    linesRef.current.forEach((l) => l.setMap(null));
    linesRef.current = [];
    if (!map || routes.length === 0) return;
    const gMaps = (window as unknown as {
      google?: {
        maps?: {
          Polyline: new (opts: Record<string, unknown>) => { setMap: (m: unknown | null) => void };
          LatLngBounds: new () => { extend: (pt: { lat: number; lng: number }) => void };
        };
      };
    }).google?.maps;
    if (!gMaps?.Polyline || !gMaps?.LatLngBounds) return;

    const bounds = new gMaps.LatLngBounds();
    const created: Array<{ setMap: (m: unknown | null) => void }> = [];

    routes.forEach((r, idx) => {
      if (!r.path || r.path.length === 0) return;
      const isSelected = idx === selectedIndex;
      const poly = new gMaps.Polyline({
        path: r.path,
        strokeColor: isSelected ? (r.isRecommended ? '#10B981' : '#8B5CF6') : '#64748B',
        strokeOpacity: isSelected ? 0.95 : 0.45,
        strokeWeight: isSelected ? 6 : 4,
        zIndex: isSelected ? 10 : 2,
      });
      poly.setMap(map);
      created.push(poly);
      if (isSelected) {
        r.path.forEach((p) => bounds.extend(p));
      }
    });

    linesRef.current = created;
    if (typeof (map as unknown as { fitBounds?: (b: unknown) => void }).fitBounds === 'function') {
      (map as unknown as { fitBounds: (b: unknown) => void }).fitBounds(bounds);
    }

    return () => {
      linesRef.current.forEach((l) => l.setMap(null));
      linesRef.current = [];
    };
  }, [map, routes, selectedIndex]);

  return null;
}

export interface PulseSafeRouteMapProps {
  mapsApiKey: string;
  lat: number;
  lng: number;
  destLat: number;
  destLng: number;
  destLabel: string;
  routes: SafeRouteCandidateItem[];
  selectedRouteIdx: number;
}

export default function PulseSafeRouteMap({
  mapsApiKey,
  lat,
  lng,
  destLat,
  destLng,
  destLabel,
  routes,
  selectedRouteIdx,
}: PulseSafeRouteMapProps) {
  const { mapsAuthError, mapsQuotaExceeded, retrySeed, handleApiError, retryMaps } = useGoogleMapsStatus();
  const originCenter = { lat, lng };

  return (
    <div className="relative h-full w-full">
      <APIProvider key={retrySeed} apiKey={mapsApiKey} onError={handleApiError}>
        <GoogleMap
          defaultCenter={originCenter}
          defaultZoom={14}
          mapId="DEMO_MAP_ID"
          gestureHandling="greedy"
          internalUsageAttributionIds={['gmp_mcp_codeassist_v1_aistudio']}
          className="h-full w-full"
        >
          {routes.length === 0 && <MapCameraController center={originCenter} />}
          <AdvancedMarker position={originCenter} title="Origin">
            <Pin background="#8B5CF6" glyphColor="#FFFFFF" borderColor="#DDD6FE" />
          </AdvancedMarker>
          <AdvancedMarker position={{ lat: destLat, lng: destLng }} title={destLabel}>
            <Pin background="#10B981" glyphColor="#FFFFFF" borderColor="#A7F3D0" />
          </AdvancedMarker>
          <PulsePolylineRenderer routes={routes} selectedIndex={selectedRouteIdx} />
        </GoogleMap>
      </APIProvider>
      <GoogleMapsErrorOverlay authError={mapsAuthError} quotaExceeded={mapsQuotaExceeded} onRetry={retryMaps} />
    </div>
  );
}
