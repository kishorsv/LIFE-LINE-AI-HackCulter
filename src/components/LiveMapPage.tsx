import React, { useCallback, useEffect, useRef, useState } from 'react';
import {
  APIProvider,
  AdvancedMarker,
  InfoWindow,
  Map as GoogleMap,
  Pin,
  useMap,
  useMapsLibrary,
} from '@vis.gl/react-google-maps';
import {
  Activity,
  AlertTriangle,
  Clock,
  Compass,
  ExternalLink,
  Info,
  Layers,
  LocateFixed,
  MapPin,
  Navigation,
  Phone,
  Search,
  ShieldCheck,
} from 'lucide-react';
import { useAuth } from '../contexts/AuthContext.tsx';
import { SosClusterAnalyticsResponse, SosIncidentCluster, SupportResource } from '../types/lifeline.ts';
import {
  D3GoogleMapsClusterOverlay,
  D3HourlyIncidentChart,
  D3SpatialFallbackClusterMap,
} from './D3SosClusterLayer.tsx';

interface LivePlaceResult {
  id: string;
  displayName?: { text?: string };
  formattedAddress?: string;
  location?: { latitude: number; longitude: number };
  types?: string[];
  nationalPhoneNumber?: string;
  regularOpeningHours?: { openNow?: boolean };
  googleMapsUri?: string;
}

interface MapsPolyline {
  setMap: (map: unknown | null) => void;
  setOptions: (opts: { strokeColor: string; strokeWeight: number; strokeOpacity: number }) => void;
}

interface AutocompleteSuggestionItem {
  placePrediction?: {
    text: { text: string };
    toPlace: () => {
      fetchFields: (opts: { fields: string[] }) => Promise<void>;
      displayName?: string;
      formattedAddress?: string;
      location?: { lat: () => number; lng: () => number };
    };
  };
}

interface RouteOverlayProps {
  origin: { lat: number; lng: number };
  destination: { lat: number; lng: number } | null;
  travelMode: 'WALKING' | 'DRIVING' | 'TRANSIT';
  onRouteComputed: (info: { distanceKm: string; durationMins: number } | null, errorMsg?: string) => void;
}

function SafeRouteOverlay({ origin, destination, travelMode, onRouteComputed }: RouteOverlayProps) {
  const map = useMap();
  const routesLib = useMapsLibrary('routes');
  const polylinesRef = useRef<MapsPolyline[]>([]);

  useEffect(() => {
    polylinesRef.current.forEach((p) => p.setMap(null));
    polylinesRef.current = [];

    if (!routesLib || !map || !destination) {
      onRouteComputed(null);
      return;
    }

    const request = {
      origin,
      destination,
      travelMode,
      fields: ['path', 'distanceMeters', 'durationMillis', 'viewport', 'legs'],
    };

    let active = true;
    (routesLib.Route as unknown as {
      computeRoutes: (req: unknown) => Promise<{
        routes?: Array<{
          createPolylines: () => MapsPolyline[];
          viewport?: unknown;
          distanceMeters?: number;
          durationMillis?: number;
        }>;
      }>;
    })
      .computeRoutes(request)
      .then(({ routes }) => {
        if (!active) return;
        const primary = routes?.[0];
        if (!primary) {
          onRouteComputed(null, 'No route available for this travel mode.');
          return;
        }
        const lines = primary.createPolylines();
        lines.forEach((line) => {
          line.setOptions({ strokeColor: '#8B5CF6', strokeWeight: 6, strokeOpacity: 0.9 });
          line.setMap(map);
        });
        polylinesRef.current = lines;
        if (primary.viewport) {
          (map as unknown as { fitBounds: (bounds: unknown) => void }).fitBounds(primary.viewport);
        }
        onRouteComputed({
          distanceKm: ((primary.distanceMeters ?? 0) / 1000).toFixed(2),
          durationMins: Math.max(1, Math.round((primary.durationMillis ?? 0) / 60000)),
        });
      })
      .catch((err: unknown) => {
        if (!active) return;
        const msg = err instanceof Error ? err.message : String(err);
        if (msg.includes('OVER_QUERY_LIMIT') || msg.includes('RESOURCE_EXHAUSTED') || msg.includes('429')) {
          window.dispatchEvent(new CustomEvent('gmp-quota-exceeded'));
        }
        onRouteComputed(null, 'Route preview unavailable right now.');
      });

    return () => {
      active = false;
      polylinesRef.current.forEach((p) => p.setMap(null));
      polylinesRef.current = [];
    };
  }, [routesLib, map, origin, destination, travelMode, onRouteComputed]);

  return null;
}

function AreaAutocompleteInput({
  onSelectLocation,
}: {
  onSelectLocation: (lat: number, lng: number, label: string) => void;
}) {
  const placesLib = useMapsLibrary('places');
  const [query, setQuery] = useState('');
  const [suggestions, setSuggestions] = useState<AutocompleteSuggestionItem[]>([]);
  const tokenRef = useRef<unknown | null>(null);

  useEffect(() => {
    if (!placesLib || !query.trim()) {
      setSuggestions([]);
      return;
    }
    const lib = placesLib as unknown as {
      AutocompleteSessionToken: new () => unknown;
      AutocompleteSuggestion: {
        fetchAutocompleteSuggestions: (req: { input: string; sessionToken: unknown }) => Promise<{
          suggestions?: AutocompleteSuggestionItem[];
        }>;
      };
    };
    if (!tokenRef.current) {
      tokenRef.current = new lib.AutocompleteSessionToken();
    }
    let cancelled = false;
    lib.AutocompleteSuggestion.fetchAutocompleteSuggestions({
      input: query,
      sessionToken: tokenRef.current,
    })
      .then((res) => {
        if (!cancelled) setSuggestions(res.suggestions || []);
      })
      .catch((err: unknown) => {
        const msg = err instanceof Error ? err.message : String(err);
        if (msg.includes('OVER_QUERY_LIMIT') || msg.includes('RESOURCE_EXHAUSTED')) {
          window.dispatchEvent(new CustomEvent('gmp-quota-exceeded'));
        }
      });

    return () => {
      cancelled = true;
    };
  }, [placesLib, query]);

  const pickSuggestion = async (s: AutocompleteSuggestionItem) => {
    if (!s.placePrediction) return;
    try {
      const place = s.placePrediction.toPlace();
      await place.fetchFields({ fields: ['displayName', 'formattedAddress', 'location'] });
      const loc = place.location;
      if (loc) {
        onSelectLocation(loc.lat(), loc.lng(), place.formattedAddress || place.displayName || query);
      }
      setQuery(place.formattedAddress || place.displayName || '');
      setSuggestions([]);
      tokenRef.current = null;
    } catch {
      // ignore error
    }
  };

  return (
    <div className="relative flex-1">
      <div className="relative">
        <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-slate-400" />
        <input
          type="text"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="Search city, campus, or landmark (Places Autocomplete)..."
          className="w-full rounded-xl border border-slate-300 dark:border-slate-700 bg-white dark:bg-slate-900 pl-9 pr-3 py-2 text-xs text-slate-900 dark:text-white focus:border-violet-500 focus:outline-none"
        />
      </div>
      {suggestions.length > 0 && (
        <ul className="absolute z-30 mt-1 w-full rounded-xl border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-900 shadow-xl max-h-52 overflow-y-auto">
          {suggestions.map((s, idx) => (
            <li key={idx}>
              <button
                type="button"
                onClick={() => pickSuggestion(s)}
                className="w-full px-3 py-2 text-left text-xs text-slate-800 dark:text-slate-200 hover:bg-violet-500/10"
              >
                {s.placePrediction?.text.text}
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

const CATEGORIES = [
  'All',
  'Hospital',
  'Emergency Support Center',
  'Womens Support',
  'Youth Support',
  'Shelter',
  'Counselling',
  'Government Helpline',
];

export function LiveMapPage() {
  const { mapsApiKey, profile, apiFetch, user } = useAuth();
  const [userCoords, setUserCoords] = useState<{ lat: number; lng: number }>({
    lat: profile?.lastKnownLat ?? 37.7749,
    lng: profile?.lastKnownLng ?? -122.4194,
  });
  const [locationLabel, setLocationLabel] = useState(profile?.lastLocationLabel || 'San Francisco Civic Center (Default Preview)');
  const [manualAddress, setManualAddress] = useState('');
  const [categoryFilter, setCategoryFilter] = useState('All');
  const [searchQuery, setSearchQuery] = useState('');
  const [debouncedSearchQuery, setDebouncedSearchQuery] = useState('');
  const [directory, setDirectory] = useState<SupportResource[]>([]);
  const [livePlaces, setLivePlaces] = useState<LivePlaceResult[]>([]);
  const [placesError, setPlacesError] = useState('');
  const [loadingLive, setLoadingLive] = useState(false);

  const [selectedMarker, setSelectedMarker] = useState<{
    title: string;
    subtitle: string;
    lat: number;
    lng: number;
    phone?: string;
    source: string;
    uri?: string;
  } | null>(null);

  const [routeTarget, setRouteTarget] = useState<{ lat: number; lng: number; title: string } | null>(null);
  const [travelMode, setTravelMode] = useState<'WALKING' | 'DRIVING' | 'TRANSIT'>('WALKING');
  const [routeSummary, setRouteSummary] = useState<{ distanceKm: string; durationMins: number } | null>(null);
  const [routeError, setRouteError] = useState('');

  const [showClusters, setShowClusters] = useState(true);
  const [clusterWindowDays, setClusterWindowDays] = useState<7 | 30 | 90>(30);
  const [includeSimulatedClusters, setIncludeSimulatedClusters] = useState(true);
  const [clusterData, setClusterData] = useState<SosClusterAnalyticsResponse | null>(null);
  const [clustersLoading, setClustersLoading] = useState(false);
  const [clusterError, setClusterError] = useState('');
  const [selectedCluster, setSelectedCluster] = useState<SosIncidentCluster | null>(null);

  const handleRouteResult = useCallback((info: { distanceKm: string; durationMins: number } | null, err?: string) => {
    setRouteSummary(info);
    setRouteError(err || '');
  }, []);

  useEffect(() => {
    const timer = setTimeout(() => {
      setDebouncedSearchQuery(searchQuery);
    }, 250);
    return () => clearTimeout(timer);
  }, [searchQuery]);

  useEffect(() => {
    const params = new URLSearchParams();
    if (categoryFilter !== 'All') params.set('category', categoryFilter);
    if (debouncedSearchQuery.trim()) params.set('q', debouncedSearchQuery.trim());
    fetch(`/api/support-directory?${params.toString()}`)
      .then((r) => r.json())
      .then((d: { resources?: SupportResource[] }) => setDirectory(d.resources || []))
      .catch(() => {});
  }, [categoryFilter, debouncedSearchQuery]);

  useEffect(() => {
    let active = true;
    setClustersLoading(true);
    setClusterError('');
    const params = new URLSearchParams({
      lat: String(userCoords.lat),
      lng: String(userCoords.lng),
      radiusKm: '40',
      windowDays: String(clusterWindowDays),
      includeSimulated: String(includeSimulatedClusters),
    });
    fetch(`/api/maps/sos-clusters?${params.toString()}`)
      .then(async (r) => {
        const data = (await r.json()) as SosClusterAnalyticsResponse & { error?: string };
        if (!r.ok) throw new Error(data.error || 'Failed to load SOS clusters.');
        return data;
      })
      .then((data) => {
        if (!active) return;
        setClusterData(data);
        setSelectedCluster((prev) => {
          if (prev && data.clusters.some((c) => c.id === prev.id)) {
            return data.clusters.find((c) => c.id === prev.id) || null;
          }
          return data.clusters[0] || null;
        });
      })
      .catch((err: unknown) => {
        if (!active) return;
        setClusterError(err instanceof Error ? err.message : 'Unable to load SOS cluster data.');
      })
      .finally(() => {
        if (active) setClustersLoading(false);
      });
    return () => {
      active = false;
    };
  }, [userCoords.lat, userCoords.lng, clusterWindowDays, includeSimulatedClusters]);

  const detectBrowserLocation = () => {
    if (!('geolocation' in navigator)) return;
    navigator.geolocation.getCurrentPosition(
      (pos) => {
        const { latitude, longitude } = pos.coords;
        if (
          !Number.isFinite(latitude) ||
          latitude < -90 ||
          latitude > 90 ||
          !Number.isFinite(longitude) ||
          longitude < -180 ||
          longitude > 180
        ) {
          setPlacesError('Browser returned invalid GPS coordinates. Use manual area search below.');
          return;
        }
        const coords = { lat: latitude, lng: longitude };
        setUserCoords(coords);
        setLocationLabel(`Live GPS (${coords.lat.toFixed(4)}, ${coords.lng.toFixed(4)})`);
        if (user) {
          apiFetch('/api/profile', {
            method: 'PUT',
            body: JSON.stringify({
              lastKnownLat: coords.lat,
              lastKnownLng: coords.lng,
              lastLocationLabel: `Live GPS (${coords.lat.toFixed(4)}, ${coords.lng.toFixed(4)})`,
              locationSharingConsent: true,
            }),
          }).catch(() => {});
        }
      },
      () => {
        setPlacesError('Browser location permission denied. Use manual area search below.');
      },
      { enableHighAccuracy: true, timeout: 8000 }
    );
  };

  const fetchLiveNearbyPlaces = async (lat: number, lng: number) => {
    if (!Number.isFinite(lat) || lat < -90 || lat > 90 || !Number.isFinite(lng) || lng < -180 || lng > 180) {
      setPlacesError('Invalid reference coordinates.');
      return;
    }
    setLoadingLive(true);
    setPlacesError('');
    try {
      const resp = await fetch('/api/maps/nearby-support', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          latitude: lat,
          longitude: lng,
          radiusMeters: 5000,
          includedTypes: ['hospital', 'police', 'pharmacy'],
        }),
      });
      const data = await resp.json();
      if (!resp.ok) {
        if (resp.status === 429 || data?.error?.status === 'RESOURCE_EXHAUSTED') {
          window.dispatchEvent(new CustomEvent('gmp-quota-exceeded'));
        }
        throw new Error(data?.error?.message || data?.error || 'Unable to query Google Places.');
      }
      const places = Array.isArray(data.places) ? data.places : [];
      setLivePlaces(places);
      if (places.length === 0) {
        setPlacesError('No nearby Google Places returned within 5 km. Support Directory listings below remain active.');
      }
    } catch (err) {
      setPlacesError(err instanceof Error ? err.message : 'Places lookup unavailable.');
    } finally {
      setLoadingLive(false);
    }
  };

  const handleManualGeocode = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!manualAddress.trim()) return;
    setPlacesError('');
    try {
      const resp = await fetch(`/api/maps/geocode?address=${encodeURIComponent(manualAddress.trim())}`);
      const data = await resp.json();
      if (resp.status === 429) {
        window.dispatchEvent(new CustomEvent('gmp-quota-exceeded'));
        return;
      }
      const loc = data?.results?.[0]?.geometry?.location;
      if (loc) {
        setUserCoords({ lat: loc.lat, lng: loc.lng });
        setLocationLabel(data.results[0].formatted_address || manualAddress.trim());
      } else {
        setPlacesError('Address not found. Try a city or landmark name.');
      }
    } catch {
      setPlacesError('Address lookup failed.');
    }
  };

  return (
    <div className="mx-auto max-w-7xl px-4 py-8 sm:px-6 space-y-6">
      {/* Header & Controls */}
      <div className="flex flex-wrap items-center justify-between gap-4">
        <div>
          <h1 className="font-display text-2xl font-bold text-slate-900 dark:text-white">
            Live Location Intelligence & Nearby Support
          </h1>
          <p className="text-xs text-slate-500 dark:text-slate-400">
            Active Reference: <span className="font-medium text-slate-700 dark:text-slate-200">{locationLabel}</span>
          </p>
        </div>

        <div className="flex flex-wrap items-center gap-2">
          <button
            type="button"
            onClick={detectBrowserLocation}
            className="inline-flex items-center gap-1.5 rounded-xl bg-violet-600 px-3.5 py-2 text-xs font-semibold text-white hover:bg-violet-500"
          >
            <LocateFixed className="h-4 w-4" />
            <span>Use Current GPS</span>
          </button>
          <button
            type="button"
            onClick={() => fetchLiveNearbyPlaces(userCoords.lat, userCoords.lng)}
            disabled={loadingLive}
            className="inline-flex items-center gap-1.5 rounded-xl border border-emerald-500/40 bg-emerald-500/10 px-3.5 py-2 text-xs font-semibold text-emerald-700 dark:text-emerald-300 hover:bg-emerald-500/20"
          >
            <Compass className="h-4 w-4" />
            <span>{loadingLive ? 'Scanning Places...' : 'Scan Live Google Places'}</span>
          </button>
        </div>
      </div>

      {/* D3.js Historical SOS Cluster Controls */}
      <div className="rounded-2xl border border-slate-200 dark:border-violet-500/25 bg-white dark:bg-[#0B1022] p-4 space-y-4">
        <div className="flex flex-wrap items-center justify-between gap-3 rounded-xl border border-slate-200 dark:border-slate-800 bg-slate-50 dark:bg-[#070C1A] px-3.5 py-2.5 text-xs">
          <div className="flex flex-wrap items-center gap-2.5">
            <button
              type="button"
              onClick={() => setShowClusters((v) => !v)}
              className={`inline-flex items-center gap-1.5 rounded-lg border px-3 py-1.5 font-semibold transition-colors ${
                showClusters
                  ? 'border-rose-500/50 bg-rose-500/15 text-rose-700 dark:text-rose-300'
                  : 'border-slate-300 dark:border-slate-700 bg-white dark:bg-slate-900 text-slate-600 dark:text-slate-300'
              }`}
            >
              <Layers className="h-3.5 w-3.5" />
              <span>D3 SOS Clusters: {showClusters ? 'ON' : 'OFF'}</span>
            </button>

            <div className="flex items-center gap-1 rounded-lg border border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900 p-0.5">
              {([7, 30, 90] as const).map((days) => (
                <button
                  key={days}
                  type="button"
                  onClick={() => setClusterWindowDays(days)}
                  className={`rounded-md px-2.5 py-1 font-mono text-[11px] font-semibold transition-colors ${
                    clusterWindowDays === days
                      ? 'bg-violet-600 text-white'
                      : 'text-slate-600 dark:text-slate-300 hover:bg-slate-100 dark:hover:bg-slate-800'
                  }`}
                >
                  {days}d
                </button>
              ))}
            </div>

            <label className="inline-flex cursor-pointer items-center gap-1.5 rounded-lg border border-sky-500/30 bg-sky-500/10 px-2.5 py-1.5 text-[11px] font-medium text-sky-800 dark:text-sky-200">
              <input
                type="checkbox"
                checked={includeSimulatedClusters}
                onChange={(e) => setIncludeSimulatedClusters(e.target.checked)}
                className="accent-sky-500"
              />
              <span>Include Demo Sandbox</span>
            </label>
          </div>

          <div className="flex flex-wrap items-center gap-2 text-[11px] font-mono">
            {clustersLoading ? (
              <span className="text-slate-500 dark:text-slate-400">Aggregating D3 clusters...</span>
            ) : clusterData ? (
              <>
                <span className="rounded border border-rose-500/35 bg-rose-500/10 px-2 py-0.5 text-rose-700 dark:text-rose-300">
                  Verified: {clusterData.totalVerifiedRecords}
                </span>
                <span className="rounded border border-sky-500/35 bg-sky-500/10 px-2 py-0.5 text-sky-700 dark:text-sky-300">
                  Demo: {clusterData.totalSimulatedRecords}
                </span>
                <span className="rounded border border-slate-300 dark:border-slate-700 px-2 py-0.5 text-slate-600 dark:text-slate-300">
                  Cells: {clusterData.clusters.length}
                </span>
              </>
            ) : null}
          </div>
        </div>

        {mapsApiKey ? (
          <APIProvider apiKey={mapsApiKey}>
            <div className="flex flex-wrap items-center gap-3">
              <AreaAutocompleteInput
                onSelectLocation={(lat, lng, label) => {
                  setUserCoords({ lat, lng });
                  setLocationLabel(label);
                }}
              />
              <form onSubmit={handleManualGeocode} className="flex items-center gap-2">
                <input
                  type="text"
                  value={manualAddress}
                  onChange={(e) => setManualAddress(e.target.value)}
                  placeholder="Manual address / ZIP..."
                  className="rounded-xl border border-slate-300 dark:border-slate-700 bg-white dark:bg-slate-900 px-3 py-2 text-xs"
                />
                <button
                  type="submit"
                  className="rounded-xl border border-slate-300 dark:border-slate-700 px-3 py-2 text-xs font-medium hover:border-violet-500/50"
                >
                  Set Location
                </button>
              </form>
            </div>

            {routeTarget && (
              <div className="flex flex-wrap items-center justify-between gap-3 rounded-xl border border-violet-500/35 bg-violet-500/10 px-4 py-2.5 text-xs">
                <div className="flex items-center gap-2">
                  <Navigation className="h-4 w-4 text-violet-500" />
                  <span>
                    Route to <strong>{routeTarget.title}</strong>
                    {routeSummary && (
                      <span className="ml-2 font-mono text-emerald-700 dark:text-emerald-300">
                        · {routeSummary.distanceKm} km · ~{routeSummary.durationMins} min
                      </span>
                    )}
                    {routeError && <span className="ml-2 text-rose-500">· {routeError}</span>}
                  </span>
                </div>
                <div className="flex items-center gap-2">
                  {(['WALKING', 'DRIVING', 'TRANSIT'] as const).map((m) => (
                    <button
                      key={m}
                      type="button"
                      onClick={() => setTravelMode(m)}
                      className={`rounded-lg px-2.5 py-1 font-semibold ${
                        travelMode === m ? 'bg-violet-600 text-white' : 'bg-white/60 dark:bg-slate-900 text-slate-600 dark:text-slate-300'
                      }`}
                    >
                      {m}
                    </button>
                  ))}
                  <button
                    type="button"
                    onClick={() => setRouteTarget(null)}
                    className="rounded-lg border border-slate-300 dark:border-slate-700 px-2.5 py-1"
                  >
                    Clear
                  </button>
                </div>
              </div>
            )}

            <div className="h-[460px] w-full overflow-hidden rounded-xl border border-slate-200 dark:border-slate-800">
              <GoogleMap
                center={userCoords}
                defaultZoom={13}
                mapId="DEMO_MAP_ID"
                gestureHandling="greedy"
                internalUsageAttributionIds={['gmp_mcp_codeassist_v1_aistudio']}
                style={{ width: '100%', height: '100%' }}
              >
                {/* User Position Pin */}
                <AdvancedMarker
                  position={userCoords}
                  onClick={() =>
                    setSelectedMarker({
                      title: 'Your Selected Reference Position',
                      subtitle: locationLabel,
                      lat: userCoords.lat,
                      lng: userCoords.lng,
                      source: 'User / Device Location',
                    })
                  }
                >
                  <Pin background="#E11D48" borderColor="#FFFFFF" glyphColor="#FFFFFF" />
                </AdvancedMarker>

                {/* Verified Directory Pins */}
                {directory.map((res) => (
                  <AdvancedMarker
                    key={`dir-${res.id}`}
                    position={{ lat: res.latitude, lng: res.longitude }}
                    onClick={() =>
                      setSelectedMarker({
                        title: res.name,
                        subtitle: `${res.category} · ${res.address}`,
                        lat: res.latitude,
                        lng: res.longitude,
                        phone: res.phone,
                        source: `${res.source} (${res.verificationStatus})`,
                      })
                    }
                  >
                    <Pin background="#7C3AED" borderColor="#DDD6FE" glyphColor="#FFFFFF" />
                  </AdvancedMarker>
                ))}

                {/* Live Google Places API (New) Pins */}
                {livePlaces.map((p) =>
                  p.location ? (
                    <AdvancedMarker
                      key={`live-${p.id}`}
                      position={{ lat: p.location.latitude, lng: p.location.longitude }}
                      onClick={() =>
                        setSelectedMarker({
                          title: p.displayName?.text || 'Nearby Support Place',
                          subtitle: p.formattedAddress || '',
                          lat: p.location!.latitude,
                          lng: p.location!.longitude,
                          phone: p.nationalPhoneNumber,
                          source: 'Google Places API (New)',
                          uri: p.googleMapsUri,
                        })
                      }
                    >
                      <Pin background="#10B981" borderColor="#A7F3D0" glyphColor="#FFFFFF" />
                    </AdvancedMarker>
                  ) : null
                )}

                {selectedMarker && (
                  <InfoWindow
                    position={{ lat: selectedMarker.lat, lng: selectedMarker.lng }}
                    onCloseClick={() => setSelectedMarker(null)}
                  >
                    <div className="max-w-xs p-1 text-slate-900 space-y-1.5">
                      <div className="text-sm font-bold">{selectedMarker.title}</div>
                      <div className="text-xs text-slate-600">{selectedMarker.subtitle}</div>
                      {selectedMarker.phone && <div className="text-xs font-mono">{selectedMarker.phone}</div>}
                      <div className="text-[11px] text-slate-500">Source: {selectedMarker.source}</div>
                      <div className="flex items-center gap-2 pt-1">
                        <button
                          type="button"
                          onClick={() =>
                            setRouteTarget({ lat: selectedMarker.lat, lng: selectedMarker.lng, title: selectedMarker.title })
                          }
                          className="rounded bg-violet-600 px-2.5 py-1 text-xs font-semibold text-white"
                        >
                          Compute Safe Route
                        </button>
                        {selectedMarker.uri && (
                          <a
                            href={selectedMarker.uri}
                            target="_blank"
                            rel="noopener noreferrer"
                            className="text-xs font-semibold text-violet-700 underline"
                          >
                            Google Maps
                          </a>
                        )}
                      </div>
                    </div>
                  </InfoWindow>
                )}

                <D3GoogleMapsClusterOverlay
                  clusters={clusterData?.clusters || []}
                  selectedClusterId={selectedCluster?.id ?? null}
                  onSelectCluster={setSelectedCluster}
                  visible={showClusters}
                />

                <SafeRouteOverlay
                  origin={userCoords}
                  destination={routeTarget ? { lat: routeTarget.lat, lng: routeTarget.lng } : null}
                  travelMode={travelMode}
                  onRouteComputed={handleRouteResult}
                />
              </GoogleMap>
            </div>
          </APIProvider>
        ) : (
          <div className="space-y-3">
            <D3SpatialFallbackClusterMap
              center={userCoords}
              clusters={clusterData?.clusters || []}
              resources={directory}
              selectedClusterId={selectedCluster?.id ?? null}
              showClusters={showClusters}
              onSelectCluster={setSelectedCluster}
              onSelectResource={(res) => {
                setUserCoords({ lat: res.latitude, lng: res.longitude });
                setLocationLabel(res.name);
              }}
            />
            <div className="rounded-xl border border-amber-500/35 bg-amber-500/10 px-4 py-2.5 text-xs text-amber-800 dark:text-amber-200">
              Google Maps JS API key is unavailable in this environment — interactive D3.js Mercator cluster spatial canvas
              and the full Support Directory below remain active.
            </div>
          </div>
        )}

        {(placesError || clusterError) && (
          <div className="rounded-lg border border-amber-500/35 bg-amber-500/10 px-3 py-2 text-xs text-amber-700 dark:text-amber-300">
            {placesError || clusterError}
          </div>
        )}
      </div>

      {/* Historical SOS Cluster Predictive Awareness Panel (D3.js Analytics) */}
      <div className="rounded-2xl border border-slate-200 dark:border-slate-800 bg-white dark:bg-[#0B1022] p-5 space-y-4">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div>
            <div className="inline-flex items-center gap-1.5 text-xs font-semibold uppercase tracking-wider text-rose-600 dark:text-rose-400">
              <Activity className="h-3.5 w-3.5" />
              <span>D3.js Predictive Safety Awareness Layer</span>
            </div>
            <h2 className="font-display text-lg font-bold text-slate-900 dark:text-white">
              Historical SOS Incident Clusters ({clusterWindowDays}-Day Window, 40 km Radius)
            </h2>
          </div>

          <div className="flex flex-wrap items-center gap-3 text-[11px]">
            <span className="inline-flex items-center gap-1.5 text-slate-700 dark:text-slate-300">
              <span className="h-3 w-3 rounded-full bg-rose-600 ring-2 ring-rose-400/40" />
              Verified / Community Cluster
            </span>
            <span className="inline-flex items-center gap-1.5 text-slate-700 dark:text-slate-300">
              <span className="h-3 w-3 rounded-full border border-dashed border-sky-400 bg-[#0A1633]" />
              Demo Sandbox Drill
            </span>
            <span className="inline-flex items-center gap-1.5 text-slate-700 dark:text-slate-300">
              <span className="h-3 w-3 rounded-full bg-violet-600" />
              Support Hub
            </span>
          </div>
        </div>

        <div className="grid gap-5 lg:grid-cols-2">
          {/* Selected Cluster Inspector */}
          <div className="rounded-xl border border-slate-200 dark:border-slate-800 bg-slate-50 dark:bg-[#070C1A] p-4 space-y-3">
            {selectedCluster ? (
              <>
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <div className="flex items-center gap-2">
                    <span
                      className={`rounded border px-2 py-0.5 text-[10px] font-bold uppercase ${
                        selectedCluster.dataOrigin === 'simulated'
                          ? 'border-sky-400/50 bg-sky-500/15 text-sky-700 dark:text-sky-300'
                          : selectedCluster.dataOrigin === 'mixed'
                          ? 'border-amber-500/50 bg-amber-500/15 text-amber-700 dark:text-amber-300'
                          : 'border-rose-500/50 bg-rose-500/15 text-rose-700 dark:text-rose-300'
                      }`}
                    >
                      {selectedCluster.dataOrigin === 'simulated'
                        ? 'SIMULATED DEMO CLUSTER'
                        : selectedCluster.dataOrigin === 'mixed'
                        ? 'VERIFIED + DEMO MIXED'
                        : 'VERIFIED INCIDENT CLUSTER'}
                    </span>
                    <span className="font-mono text-xs text-slate-500 dark:text-slate-400">
                      ({selectedCluster.lat.toFixed(3)}, {selectedCluster.lng.toFixed(3)})
                    </span>
                  </div>
                  <span className="font-mono text-xs font-bold text-slate-900 dark:text-white">
                    Intensity {selectedCluster.severityScore}/100
                  </span>
                </div>

                <div className="grid grid-cols-2 sm:grid-cols-4 gap-2 text-center">
                  <div className="rounded-lg border border-slate-200 dark:border-slate-800 bg-white dark:bg-[#0B1022] p-2">
                    <div className="font-mono text-base font-bold text-rose-600 dark:text-rose-400">
                      {selectedCluster.verifiedSosCount}
                    </div>
                    <div className="text-[10px] text-slate-500">Verified SOS</div>
                  </div>
                  <div className="rounded-lg border border-slate-200 dark:border-slate-800 bg-white dark:bg-[#0B1022] p-2">
                    <div className="font-mono text-base font-bold text-amber-600 dark:text-amber-400">
                      {selectedCluster.communityReportCount}
                    </div>
                    <div className="text-[10px] text-slate-500">Reports</div>
                  </div>
                  <div className="rounded-lg border border-slate-200 dark:border-slate-800 bg-white dark:bg-[#0B1022] p-2">
                    <div className="font-mono text-base font-bold text-sky-600 dark:text-sky-400">
                      {selectedCluster.simulatedCount}
                    </div>
                    <div className="text-[10px] text-slate-500">Demo Drills</div>
                  </div>
                  <div className="rounded-lg border border-slate-200 dark:border-slate-800 bg-white dark:bg-[#0B1022] p-2">
                    <div className="font-mono text-base font-bold text-slate-900 dark:text-white">
                      ~{selectedCluster.radiusMeters}m
                    </div>
                    <div className="text-[10px] text-slate-500">Awareness Cell</div>
                  </div>
                </div>

                <div className="flex flex-wrap items-center justify-between gap-2 text-xs text-slate-600 dark:text-slate-300">
                  <span>
                    Dominant Signal: <strong>{selectedCluster.dominantCategory}</strong> · High Severity:{' '}
                    <strong>{selectedCluster.highSeverityCount}</strong>
                  </span>
                  <button
                    type="button"
                    onClick={() => {
                      setUserCoords({ lat: selectedCluster.lat, lng: selectedCluster.lng });
                      setLocationLabel(`Cluster Cell (${selectedCluster.lat.toFixed(3)}, ${selectedCluster.lng.toFixed(3)})`);
                      fetchLiveNearbyPlaces(selectedCluster.lat, selectedCluster.lng);
                    }}
                    className="font-semibold text-violet-600 dark:text-violet-400 hover:underline"
                  >
                    Scan Support Near Cluster
                  </button>
                </div>
              </>
            ) : (
              <div className="flex items-start gap-2.5 py-4 text-xs text-slate-600 dark:text-slate-300">
                <Info className="h-4 w-4 shrink-0 text-slate-400 mt-0.5" />
                <span>
                  No historical SOS incidents or community safety reports were recorded within 40 km during the last{' '}
                  {clusterWindowDays} days. Select a 90d window or enable Demo Sandbox to inspect spatial clusters.
                </span>
              </div>
            )}
          </div>

          {/* D3 24h Temporal Density Chart */}
          <div className="rounded-xl border border-slate-200 dark:border-slate-800 bg-slate-50 dark:bg-[#070C1A] p-4">
            <D3HourlyIncidentChart hourlyDistribution={clusterData?.hourlyDistribution || []} />
          </div>
        </div>

        <div className="flex items-start gap-2 rounded-xl border border-slate-200 dark:border-slate-800 bg-slate-50 dark:bg-[#070C1A] px-3.5 py-2.5 text-[11px] text-slate-600 dark:text-slate-300">
          <AlertTriangle className="h-3.5 w-3.5 shrink-0 text-amber-500 mt-0.5" />
          <span>
            {clusterData?.privacyNotice ||
              'Clusters generalize coordinates to ~550m spatial cells and omit all user identifiers. Historical cluster density is an informational awareness aid only and does not guarantee corridor safety or predict crime.'}
          </span>
        </div>
      </div>

      {/* Live Google Places API (New) Results */}
      {livePlaces.length > 0 && (
        <div className="space-y-3">
          <h2 className="font-display text-lg font-bold text-slate-900 dark:text-white">
            Live Google Places Results ({livePlaces.length})
          </h2>
          <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
            {livePlaces.map((p) => (
              <div key={p.id} className="rounded-2xl border border-emerald-500/30 bg-white dark:bg-[#0B1022] p-4 space-y-2">
                <div className="flex items-start justify-between gap-2">
                  <div className="font-display text-sm font-bold text-slate-900 dark:text-white">
                    {p.displayName?.text}
                  </div>
                  {p.regularOpeningHours?.openNow !== undefined && (
                    <span className="rounded border border-emerald-500/35 bg-emerald-500/10 px-2 py-0.5 text-[10px] font-semibold text-emerald-700 dark:text-emerald-300">
                      {p.regularOpeningHours.openNow ? 'Open Now' : 'Closed'}
                    </span>
                  )}
                </div>
                <div className="text-xs text-slate-600 dark:text-slate-300">{p.formattedAddress}</div>
                {p.nationalPhoneNumber && (
                  <div className="flex items-center gap-1.5 text-xs font-mono text-slate-700 dark:text-slate-200">
                    <Phone className="h-3.5 w-3.5 text-emerald-500" />
                    <span>{p.nationalPhoneNumber}</span>
                  </div>
                )}
                <div className="flex items-center justify-between pt-2 text-[11px] text-slate-500">
                  <span>Source: Google Places API (New)</span>
                  <div className="flex items-center gap-2">
                    {p.location && (
                      <button
                        type="button"
                        onClick={() =>
                          setRouteTarget({
                            lat: p.location!.latitude,
                            lng: p.location!.longitude,
                            title: p.displayName?.text || 'Destination',
                          })
                        }
                        className="font-semibold text-violet-600 dark:text-violet-400 hover:underline"
                      >
                        Route
                      </button>
                    )}
                    {p.googleMapsUri && (
                      <a
                        href={p.googleMapsUri}
                        target="_blank"
                        rel="noopener noreferrer"
                        className="inline-flex items-center gap-1 font-semibold text-emerald-600 dark:text-emerald-400 hover:underline"
                      >
                        <span>Open</span>
                        <ExternalLink className="h-3 w-3" />
                      </a>
                    )}
                  </div>
                </div>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* Searchable Verified & Sample Support Directory */}
      <div className="space-y-4">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div>
            <h2 className="font-display text-lg font-bold text-slate-900 dark:text-white">
              Support Resources Directory
            </h2>
            <p className="text-xs text-slate-500 dark:text-slate-400">
              Every listing explicitly states its source, verification status, and last-updated timestamp.
            </p>
          </div>
          <input
            type="text"
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
            placeholder="Filter directory by name, city, or service..."
            className="w-full sm:w-72 rounded-xl border border-slate-300 dark:border-slate-700 bg-white dark:bg-slate-900 px-3 py-2 text-xs"
          />
        </div>

        <div className="flex flex-wrap gap-2">
          {CATEGORIES.map((cat) => (
            <button
              key={cat}
              type="button"
              onClick={() => setCategoryFilter(cat)}
              className={`rounded-lg border px-3 py-1.5 text-xs font-medium transition-colors ${
                categoryFilter === cat
                  ? 'border-violet-500 bg-violet-600 text-white'
                  : 'border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-900/60 text-slate-700 dark:text-slate-300'
              }`}
            >
              {cat}
            </button>
          ))}
        </div>

        <div className="grid gap-4 md:grid-cols-2 lg:grid-cols-3">
          {directory.map((r) => (
            <div
              key={r.id}
              className="rounded-2xl border border-slate-200 dark:border-slate-800 bg-white dark:bg-[#0B1022] p-5 flex flex-col justify-between gap-3"
            >
              <div className="space-y-2">
                <div className="flex items-start justify-between gap-2">
                  <span className="rounded border border-violet-500/35 bg-violet-500/10 px-2 py-0.5 text-[11px] font-semibold text-violet-700 dark:text-violet-300">
                    {r.category}
                  </span>
                  <span className="inline-flex items-center gap-1 text-[11px] font-medium text-amber-600 dark:text-amber-300">
                    <ShieldCheck className="h-3.5 w-3.5" />
                    {r.isSampleData ? 'Sample Directory Record' : r.verificationStatus}
                  </span>
                </div>
                <h3 className="font-display text-base font-bold text-slate-900 dark:text-white">{r.name}</h3>
                <div className="flex items-start gap-1.5 text-xs text-slate-600 dark:text-slate-300">
                  <MapPin className="h-3.5 w-3.5 mt-0.5 shrink-0 text-slate-400" />
                  <span>{r.address}</span>
                </div>
                <div className="flex items-center gap-1.5 text-xs text-slate-600 dark:text-slate-300">
                  <Clock className="h-3.5 w-3.5 shrink-0 text-slate-400" />
                  <span>
                    {r.operatingHours} · {r.availabilityNote}
                  </span>
                </div>
                <div className="flex items-center gap-1.5 text-xs font-mono text-slate-800 dark:text-slate-200">
                  <Phone className="h-3.5 w-3.5 text-emerald-500" />
                  <span>{r.phone}</span>
                </div>
              </div>

              <div className="border-t border-slate-200 dark:border-slate-800 pt-3 flex items-center justify-between text-[11px] text-slate-500 dark:text-slate-400">
                <span>
                  {r.source} · Updated {new Date(r.lastUpdatedAt).toLocaleDateString()}
                </span>
                <button
                  type="button"
                  onClick={() => {
                    setRouteTarget({ lat: r.latitude, lng: r.longitude, title: r.name });
                    window.scrollTo({ top: 0, behavior: 'smooth' });
                  }}
                  className="font-semibold text-violet-600 dark:text-violet-400 hover:underline"
                >
                  Show Route
                </button>
              </div>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
