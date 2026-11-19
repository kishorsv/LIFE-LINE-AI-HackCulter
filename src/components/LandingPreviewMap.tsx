import { APIProvider, AdvancedMarker, Map as GoogleMap, Pin } from '@vis.gl/react-google-maps';
import { GoogleMapsErrorOverlay, useGoogleMapsStatus } from './GoogleMapsHelpers.tsx';

interface LandingPreviewMapProps {
  apiKey: string;
}

export function LandingPreviewMap({ apiKey }: LandingPreviewMapProps) {
  const { mapsAuthError, mapsQuotaExceeded, retrySeed, handleApiError, retryMaps } = useGoogleMapsStatus();

  return (
    <div className="relative h-full w-full min-h-[420px] sm:min-h-[470px]">
      <APIProvider key={retrySeed} apiKey={apiKey} onError={handleApiError}>
        <GoogleMap
          defaultCenter={{ lat: 37.7749, lng: -122.4194 }}
          defaultZoom={13}
          mapId="DEMO_MAP_ID"
          colorScheme="DARK"
          gestureHandling="cooperative"
          internalUsageAttributionIds={['gmp_mcp_codeassist_v1_aistudio']}
          disableDefaultUI={false}
          className="h-full w-full min-h-[420px] sm:min-h-[470px]"
        >
          <AdvancedMarker position={{ lat: 37.7819, lng: -122.4126 }} title="Youth Support Hub">
            <Pin background="#0EA5E9" borderColor="#FFFFFF" glyphColor="#FFFFFF" />
          </AdvancedMarker>
          <AdvancedMarker position={{ lat: 37.7656, lng: -122.4218 }} title="Safe Haven Support Hub">
            <Pin background="#10B981" borderColor="#FFFFFF" glyphColor="#FFFFFF" />
          </AdvancedMarker>
          <AdvancedMarker position={{ lat: 37.7749, lng: -122.4194 }} title="Origin Corridor">
            <Pin background="#E11D48" borderColor="#FFFFFF" glyphColor="#FFFFFF" />
          </AdvancedMarker>
        </GoogleMap>
      </APIProvider>
      <GoogleMapsErrorOverlay authError={mapsAuthError} quotaExceeded={mapsQuotaExceeded} onRetry={retryMaps} />
    </div>
  );
}
