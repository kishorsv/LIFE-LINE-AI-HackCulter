import React, { useMemo, useState } from 'react';
import { APIProvider, AdvancedMarker, InfoWindow, Map as GoogleMap, Pin } from '@vis.gl/react-google-maps';
import { ExternalLink, MapPin, Phone, ShieldAlert, ShieldCheck } from 'lucide-react';
import { LiveExternalAlert, SupportResource } from '../types/lifeline.ts';
import { GoogleMapsErrorOverlay, MapCameraController, useGoogleMapsStatus } from './GoogleMapsHelpers.tsx';

export interface LiveIncidentMapProps {
  mapsApiKey: string;
  center: { lat: number; lng: number };
  localityName: string;
  alerts: LiveExternalAlert[];
  supportHubs: SupportResource[];
  selectedAlertId: number | null;
  onSelectAlert: (id: number | null) => void;
}

function getPinColors(alert: LiveExternalAlert): { background: string; borderColor: string } {
  if (!alert.isActive || alert.verificationStatus === 'Resolved Incident') {
    return { background: '#10B981', borderColor: '#064E3B' };
  }
  if (alert.verificationStatus === 'Verified Incident') {
    return { background: '#E11D48', borderColor: '#FFFFFF' };
  }
  if (alert.verificationStatus === 'Awaiting Verification') {
    return { background: '#8B5CF6', borderColor: '#FFFFFF' };
  }
  if (alert.severity === 'EXTREME' || alert.severity === 'SEVERE') {
    return { background: '#EA580C', borderColor: '#FFFFFF' };
  }
  return { background: '#F59E0B', borderColor: '#0F172A' };
}

export default function LiveIncidentMap({
  mapsApiKey,
  center,
  localityName,
  alerts,
  supportHubs,
  selectedAlertId,
  onSelectAlert,
}: LiveIncidentMapProps) {
  const [selectedHub, setSelectedHub] = useState<SupportResource | null>(null);
  const { mapsAuthError, mapsQuotaExceeded, retrySeed, handleApiError, retryMaps } = useGoogleMapsStatus();

  const mappableAlerts = useMemo(
    () =>
      alerts.filter(
        (a): a is LiveExternalAlert & { latitude: number; longitude: number } =>
          a.latitude != null && a.longitude != null && Number.isFinite(a.latitude) && Number.isFinite(a.longitude)
      ),
    [alerts]
  );

  const selectedAlert = useMemo(
    () => mappableAlerts.find((a) => a.id === selectedAlertId) || null,
    [mappableAlerts, selectedAlertId]
  );

  if (!mapsApiKey) {
    // Interactive geospatial SVG radar fallback when VITE_GOOGLE_MAPS_API_KEY is not configured
    return (
      <div className="relative flex h-[420px] w-full flex-col justify-between overflow-hidden rounded-2xl border border-slate-200 dark:border-slate-800 bg-slate-950 p-4 text-slate-200">
        <div className="flex items-center justify-between gap-2 text-xs">
          <div className="flex items-center gap-2 font-semibold text-violet-300">
            <MapPin className="h-4 w-4" />
            <span>Geospatial Sector Radar — {localityName} ({center.lat.toFixed(3)}, {center.lng.toFixed(3)})</span>
          </div>
          <span className="rounded-md border border-slate-700 bg-slate-900 px-2 py-0.5 text-[11px] text-slate-400">
            Vector Fallback (Configure VITE_GOOGLE_MAPS_API_KEY for interactive Google Map)
          </span>
        </div>

        <svg viewBox="0 0 600 280" className="my-2 h-full w-full">
          <defs>
            <radialGradient id="liveRadarBg" cx="50%" cy="50%" r="55%">
              <stop offset="0%" stopColor="rgba(139, 92, 246, 0.22)" />
              <stop offset="100%" stopColor="rgba(15, 23, 42, 0.1)" />
            </radialGradient>
          </defs>
          <rect x="0" y="0" width="600" height="280" rx="14" fill="url(#liveRadarBg)" stroke="#1e293b" />
          <circle cx="300" cy="140" r="45" fill="none" stroke="#334155" strokeDasharray="4 4" />
          <circle cx="300" cy="140" r="95" fill="none" stroke="#334155" strokeDasharray="4 4" />
          <circle cx="300" cy="140" r="130" fill="none" stroke="#1e293b" />
          <line x1="300" y1="10" x2="300" y2="270" stroke="#1e293b" />
          <line x1="40" y1="140" x2="560" y2="140" stroke="#1e293b" />

          {/* Focus center */}
          <circle cx="300" cy="140" r="6" fill="#38bdf8" />
          <text x="310" y="136" fill="#bae6fd" fontSize="10" fontWeight="600">
            {localityName}
          </text>

          {/* Support hubs */}
          {supportHubs.slice(0, 12).map((hub) => {
            const dx = Math.max(-250, Math.min(250, (hub.longitude - center.lng) * 28));
            const dy = Math.max(-115, Math.min(115, -(hub.latitude - center.lat) * 28));
            return (
              <g
                key={`hub-${hub.id}`}
                transform={`translate(${300 + dx}, ${140 + dy})`}
                className="cursor-pointer"
                onClick={() => {
                  onSelectAlert(null);
                  setSelectedHub(hub);
                }}
              >
                <rect x="-4" y="-4" width="8" height="8" rx="2" fill="#0ea5e9" stroke="#ffffff" strokeWidth="1" />
              </g>
            );
          })}

          {/* Live alerts */}
          {mappableAlerts.slice(0, 30).map((alert) => {
            const dx = Math.max(-260, Math.min(260, (alert.longitude - center.lng) * 22));
            const dy = Math.max(-120, Math.min(120, -(alert.latitude - center.lat) * 22));
            const { background } = getPinColors(alert);
            return (
              <g
                key={`alert-${alert.id}`}
                transform={`translate(${300 + dx}, ${140 + dy})`}
                className="cursor-pointer"
                onClick={() => {
                  setSelectedHub(null);
                  onSelectAlert(alert.id);
                }}
              >
                <circle r={selectedAlertId === alert.id ? 8 : 5.5} fill={background} stroke="#fff" strokeWidth="1.2" />
              </g>
            );
          })}
        </svg>

        <div className="flex flex-wrap items-center justify-between gap-2 text-[11px] text-slate-400">
          <div className="flex flex-wrap items-center gap-3">
            <span className="inline-flex items-center gap-1"><span className="h-2.5 w-2.5 rounded-full bg-amber-500" /> Official Alert</span>
            <span className="inline-flex items-center gap-1"><span className="h-2.5 w-2.5 rounded-full bg-rose-600" /> Verified Incident</span>
            <span className="inline-flex items-center gap-1"><span className="h-2.5 w-2.5 rounded-full bg-violet-500" /> Awaiting Verification</span>
            <span className="inline-flex items-center gap-1"><span className="h-2.5 w-2.5 rounded-full bg-emerald-500" /> Resolved</span>
            <span className="inline-flex items-center gap-1"><span className="h-2.5 w-2.5 rounded bg-sky-500" /> Support Hub</span>
          </div>
          {selectedHub && (
            <span className="text-sky-300 font-medium">
              Hub: {selectedHub.name} ({selectedHub.phone || '112'})
            </span>
          )}
        </div>
      </div>
    );
  }

  return (
    <div className="relative h-[420px] w-full overflow-hidden rounded-2xl border border-slate-200 dark:border-slate-800 shadow-sm">
      <APIProvider key={retrySeed} apiKey={mapsApiKey} onError={handleApiError}>
        <GoogleMap
          defaultCenter={center}
          defaultZoom={mappableAlerts.length > 5 ? 6 : 11}
          mapId="DEMO_MAP_ID"
          gestureHandling="greedy"
          internalUsageAttributionIds={['gmp_mcp_codeassist_v1_aistudio']}
          style={{ width: '100%', height: '100%' }}
        >
          <MapCameraController center={center} />
          {/* Locality Focus Pin */}
          <AdvancedMarker position={center} title={localityName}>
            <Pin background="#0284C7" borderColor="#FFFFFF" glyphColor="#FFFFFF" />
          </AdvancedMarker>

          {/* Verified Support Directory Hubs */}
          {supportHubs.map((hub) => (
            <AdvancedMarker
              key={`hub-${hub.id}`}
              position={{ lat: hub.latitude, lng: hub.longitude }}
              onClick={() => {
                onSelectAlert(null);
                setSelectedHub(hub);
              }}
            >
              <Pin background="#0EA5E9" borderColor="#0F172A" glyphColor="#FFFFFF" scale={0.85} />
            </AdvancedMarker>
          ))}

          {/* Live External Disaster & Weather Alerts */}
          {mappableAlerts.map((alert) => {
            const colors = getPinColors(alert);
            return (
              <AdvancedMarker
                key={`alert-${alert.id}`}
                position={{ lat: alert.latitude, lng: alert.longitude }}
                onClick={() => {
                  setSelectedHub(null);
                  onSelectAlert(alert.id);
                }}
              >
                <Pin
                  background={colors.background}
                  borderColor={colors.borderColor}
                  glyphColor="#FFFFFF"
                  scale={selectedAlertId === alert.id ? 1.2 : 1.0}
                />
              </AdvancedMarker>
            );
          })}

          {selectedAlert && (
            <InfoWindow
              position={{ lat: selectedAlert.latitude, lng: selectedAlert.longitude }}
              onCloseClick={() => onSelectAlert(null)}
            >
              <div className="max-w-xs space-y-1.5 text-slate-900 p-1">
                <div className="flex items-center gap-1.5 text-xs font-bold">
                  <ShieldAlert className="h-3.5 w-3.5 text-rose-600 shrink-0" />
                  <span>{selectedAlert.title}</span>
                </div>
                <div className="text-[11px] font-semibold text-slate-700">
                  {selectedAlert.verificationStatus} · {selectedAlert.severity} · {selectedAlert.category}
                </div>
                <p className="text-[11px] text-slate-600 line-clamp-3">{selectedAlert.description}</p>
                <div className="text-[10px] text-slate-500">
                  Source: {selectedAlert.sourceName} · Updated {new Date(selectedAlert.lastUpdatedAt).toLocaleString()}
                </div>
                {selectedAlert.sourceUrl && (
                  <a
                    href={selectedAlert.sourceUrl}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="inline-flex items-center gap-1 text-[11px] font-semibold text-violet-700 hover:underline"
                  >
                    <span>Official Source</span>
                    <ExternalLink className="h-3 w-3" />
                  </a>
                )}
              </div>
            </InfoWindow>
          )}

          {selectedHub && (
            <InfoWindow
              position={{ lat: selectedHub.latitude, lng: selectedHub.longitude }}
              onCloseClick={() => setSelectedHub(null)}
            >
              <div className="max-w-xs space-y-1 text-slate-900 p-1">
                <div className="flex items-center gap-1.5 text-xs font-bold">
                  <ShieldCheck className="h-3.5 w-3.5 text-sky-600 shrink-0" />
                  <span>{selectedHub.name}</span>
                </div>
                <div className="text-[11px] text-slate-700">
                  {selectedHub.category} · {selectedHub.operatingHours}
                </div>
                <div className="text-[11px] text-slate-600">{selectedHub.address}</div>
                {selectedHub.phone && (
                  <div className="flex items-center gap-1 text-[11px] font-semibold text-sky-700">
                    <Phone className="h-3 w-3" />
                    <span>{selectedHub.phone} (Call to confirm live capacity)</span>
                  </div>
                )}
              </div>
            </InfoWindow>
          )}
        </GoogleMap>
      </APIProvider>
      <GoogleMapsErrorOverlay authError={mapsAuthError} quotaExceeded={mapsQuotaExceeded} onRetry={retryMaps} />
    </div>
  );
}
