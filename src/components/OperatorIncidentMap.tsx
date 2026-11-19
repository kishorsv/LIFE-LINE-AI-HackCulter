import { APIProvider, AdvancedMarker, Map as GoogleMap, Pin } from '@vis.gl/react-google-maps';
import { EmergencyIncident } from '../types/lifeline.ts';
import { GoogleMapsErrorOverlay, MapCameraController, useGoogleMapsStatus } from './GoogleMapsHelpers.tsx';

export interface OperatorIncidentMapProps {
  mapsApiKey: string;
  selectedIncident: EmergencyIncident & { latitude: number; longitude: number };
  mappableIncidents: Array<EmergencyIncident & { latitude: number; longitude: number }>;
  onSelectIncident: (id: number) => void;
}

export default function OperatorIncidentMap({
  mapsApiKey,
  selectedIncident,
  mappableIncidents,
  onSelectIncident,
}: OperatorIncidentMapProps) {
  const { mapsAuthError, mapsQuotaExceeded, retrySeed, handleApiError, retryMaps } = useGoogleMapsStatus();
  const focusCenter = { lat: selectedIncident.latitude, lng: selectedIncident.longitude };

  return (
    <div className="relative h-full w-full">
      <APIProvider key={retrySeed} apiKey={mapsApiKey} onError={handleApiError}>
        <GoogleMap
          defaultCenter={focusCenter}
          defaultZoom={13}
          mapId="DEMO_MAP_ID"
          gestureHandling="greedy"
          internalUsageAttributionIds={['gmp_mcp_codeassist_v1_aistudio']}
          style={{ width: '100%', height: '100%' }}
        >
          <MapCameraController center={focusCenter} />
          {mappableIncidents.map((inc) => (
            <AdvancedMarker
              key={inc.id}
              position={{ lat: inc.latitude, lng: inc.longitude }}
              onClick={() => onSelectIncident(inc.id)}
            >
              <Pin
                background={
                  inc.id === selectedIncident.id
                    ? '#E11D48'
                    : inc.status === 'Resolved' || inc.status === 'Cancelled'
                    ? '#10B981'
                    : '#F59E0B'
                }
                borderColor={inc.id === selectedIncident.id ? '#FFFFFF' : '#0F172A'}
                glyphColor="#FFFFFF"
              />
            </AdvancedMarker>
          ))}
        </GoogleMap>
      </APIProvider>
      <GoogleMapsErrorOverlay authError={mapsAuthError} quotaExceeded={mapsQuotaExceeded} onRetry={retryMaps} />
    </div>
  );
}
