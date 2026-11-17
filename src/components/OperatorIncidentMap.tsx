import { APIProvider, AdvancedMarker, Map as GoogleMap, Pin } from '@vis.gl/react-google-maps';
import { EmergencyIncident } from '../types/lifeline.ts';

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
  return (
    <APIProvider apiKey={mapsApiKey}>
      <GoogleMap
        center={{ lat: selectedIncident.latitude, lng: selectedIncident.longitude }}
        defaultZoom={13}
        mapId="DEMO_MAP_ID"
        internalUsageAttributionIds={['gmp_mcp_codeassist_v1_aistudio']}
        style={{ width: '100%', height: '100%' }}
      >
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
  );
}
