export interface GeoPoint {
  lat: number;
  lng: number;
}

export interface WeatherSnapshot {
  available: boolean;
  source: string;
  retrievedAt: string;
  temperatureC?: number | null;
  precipitationMm?: number | null;
  rainMm?: number | null;
  windSpeedKmh?: number | null;
  weatherCode?: number | null;
  weatherLabel?: string;
  isDay?: boolean | null;
  visibilityMeters?: number | null;
  precipitationProbability?: number | null;
  reason?: string;
}

export interface PredictiveRiskEvidence {
  factor: string;
  category: 'incidents' | 'community_reports' | 'weather' | 'time_lighting' | 'support_proximity';
  impact: 'elevates_risk' | 'mitigates_risk' | 'neutral' | 'unavailable';
  detail: string;
  source: string;
  timestamp: string;
}

export interface PredictiveRiskResult {
  riskLevel: 'LOW' | 'MODERATE' | 'ELEVATED' | 'INSUFFICIENT_DATA';
  riskScore: number;
  confidence: number;
  locationLabel: string;
  latitude: number;
  longitude: number;
  evaluatedAt: string;
  summary: string;
  evidence: PredictiveRiskEvidence[];
  counts: {
    verifiedNearbyIncidents: number;
    simulatedIncidentsExcluded: number;
    communityReportsCount: number;
    nearbySupportHubs: number;
    open24hSupportHubs: number;
  };
  weather: WeatherSnapshot;
  mitigationGuidance: string[];
}

export interface SafeRouteCandidate {
  routeIndex: number;
  summary: string;
  distanceMeters: number;
  durationSeconds: number;
  durationLabel: string;
  encodedPolyline: string;
  path: GeoPoint[];
  routeLabels: string[];
  warnings: string[];
  safetyScore: number;
  riskLevel: 'LOW' | 'MODERATE' | 'ELEVATED';
  nearbyIncidentsCount: number;
  nearbyReportsCount: number;
  nearbySupportHubsCount: number;
  reasons: string[];
  isRecommended: boolean;
}

export interface SafeRouteResponse {
  available: boolean;
  source: string;
  travelMode: 'WALK' | 'DRIVE' | 'TRANSIT' | 'BICYCLE';
  retrievedAt: string;
  weather: WeatherSnapshot;
  routes: SafeRouteCandidate[];
  error?: string;
}

const MAPS_ATTRIBUTION_ID = 'gmp_mcp_codeassist_v1_aistudio';

export function haversineDistanceKm(a: GeoPoint, b: GeoPoint): number {
  const toRad = (deg: number) => (deg * Math.PI) / 180;
  const R = 6371;
  const dLat = toRad(b.lat - a.lat);
  const dLng = toRad(b.lng - a.lng);
  const sinLat = Math.sin(dLat / 2);
  const sinLng = Math.sin(dLng / 2);
  const h = sinLat * sinLat + Math.cos(toRad(a.lat)) * Math.cos(toRad(b.lat)) * sinLng * sinLng;
  return 2 * R * Math.atan2(Math.sqrt(h), Math.sqrt(1 - h));
}

// Standard Google Encoded Polyline Algorithm decoder
export function decodePolyline(encoded: string): GeoPoint[] {
  if (!encoded) return [];
  const points: GeoPoint[] = [];
  let index = 0;
  let lat = 0;
  let lng = 0;

  while (index < encoded.length) {
    let shift = 0;
    let result = 0;
    let byte: number;
    do {
      byte = encoded.charCodeAt(index++) - 63;
      result |= (byte & 0x1f) << shift;
      shift += 5;
    } while (byte >= 0x20 && index < encoded.length);
    const dLat = result & 1 ? ~(result >> 1) : result >> 1;
    lat += dLat;

    shift = 0;
    result = 0;
    do {
      byte = encoded.charCodeAt(index++) - 63;
      result |= (byte & 0x1f) << shift;
      shift += 5;
    } while (byte >= 0x20 && index < encoded.length);
    const dLng = result & 1 ? ~(result >> 1) : result >> 1;
    lng += dLng;

    points.push({ lat: lat / 1e5, lng: lng / 1e5 });
  }
  return points;
}

export function minDistanceToPolylineKm(point: GeoPoint, path: GeoPoint[]): number {
  if (path.length === 0) return Infinity;
  let minKm = Infinity;
  // Sample path efficiently if very dense
  const step = path.length > 250 ? Math.ceil(path.length / 250) : 1;
  for (let i = 0; i < path.length; i += step) {
    const dist = haversineDistanceKm(point, path[i]);
    if (dist < minKm) minKm = dist;
  }
  const lastDist = haversineDistanceKm(point, path[path.length - 1]);
  return Math.min(minKm, lastDist);
}

export function describeWmoWeatherCode(code: number | null | undefined): string {
  if (code == null) return 'Unknown conditions';
  if (code === 0) return 'Clear sky';
  if (code <= 3) return 'Partly cloudy / overcast';
  if (code === 45 || code === 48) return 'Fog / reduced visibility';
  if (code >= 51 && code <= 57) return 'Drizzle';
  if (code >= 61 && code <= 67) return 'Rain';
  if (code >= 71 && code <= 77) return 'Snow / wintry precipitation';
  if (code >= 80 && code <= 82) return 'Rain showers';
  if (code >= 95) return 'Thunderstorm advisory';
  return `Weather condition code ${code}`;
}

export async function fetchOpenMeteoWeather(
  lat: number,
  lng: number,
  fetchImpl: typeof fetch = fetch
): Promise<WeatherSnapshot> {
  const retrievedAt = new Date().toISOString();
  const url =
    `https://api.open-meteo.com/v1/forecast?latitude=${encodeURIComponent(lat.toFixed(5))}` +
    `&longitude=${encodeURIComponent(lng.toFixed(5))}` +
    `&current=temperature_2m,precipitation,rain,weather_code,wind_speed_10m,is_day` +
    `&hourly=visibility,precipitation_probability&forecast_days=1&timezone=auto`;

  try {
    const resp = await fetchImpl(url, {
      method: 'GET',
      signal: AbortSignal.timeout(5000),
    });
    if (!resp.ok) {
      return {
        available: false,
        source: 'Open-Meteo Live Weather API',
        retrievedAt,
        reason: `Open-Meteo returned HTTP ${resp.status}.`,
      };
    }
    const data = (await resp.json()) as {
      current?: {
        temperature_2m?: number;
        precipitation?: number;
        rain?: number;
        weather_code?: number;
        wind_speed_10m?: number;
        is_day?: number;
      };
      hourly?: {
        visibility?: number[];
        precipitation_probability?: number[];
      };
    };

    if (!data.current) {
      return {
        available: false,
        source: 'Open-Meteo Live Weather API',
        retrievedAt,
        reason: 'Open-Meteo response did not include current weather conditions.',
      };
    }

    const code = data.current.weather_code ?? null;
    const visibilityMeters = Array.isArray(data.hourly?.visibility) && data.hourly!.visibility.length > 0
      ? Number(data.hourly!.visibility[0])
      : null;
    const precipProb =
      Array.isArray(data.hourly?.precipitation_probability) && data.hourly!.precipitation_probability.length > 0
        ? Number(data.hourly!.precipitation_probability[0])
        : null;

    return {
      available: true,
      source: 'Open-Meteo Live Weather API',
      retrievedAt,
      temperatureC: data.current.temperature_2m ?? null,
      precipitationMm: data.current.precipitation ?? null,
      rainMm: data.current.rain ?? null,
      windSpeedKmh: data.current.wind_speed_10m ?? null,
      weatherCode: code,
      weatherLabel: describeWmoWeatherCode(code),
      isDay: data.current.is_day === 1 ? true : data.current.is_day === 0 ? false : null,
      visibilityMeters: visibilityMeters != null && Number.isFinite(visibilityMeters) ? visibilityMeters : null,
      precipitationProbability: precipProb != null && Number.isFinite(precipProb) ? precipProb : null,
    };
  } catch (err) {
    return {
      available: false,
      source: 'Open-Meteo Live Weather API',
      retrievedAt,
      reason: err instanceof Error ? `Weather telemetry unreachable: ${err.message}` : 'Weather telemetry unreachable.',
    };
  }
}

export interface NearbyIncidentInput {
  id: number;
  category: string;
  priority: string;
  status: string;
  latitude: number | null;
  longitude: number | null;
  isSimulated: boolean;
  createdAt: string;
}

export interface NearbyReportInput {
  id: number;
  category: string;
  severity: string;
  latitude: number;
  longitude: number;
  verificationStatus: string;
  isSimulated: boolean;
  createdAt: string;
}

export interface NearbySupportHubInput {
  id: number;
  name: string;
  category: string;
  latitude: number;
  longitude: number;
  is24Hours: boolean;
}

export function computePredictiveRisk(input: {
  latitude: number;
  longitude: number;
  locationLabel?: string;
  radiusKm?: number;
  weather: WeatherSnapshot;
  incidents: NearbyIncidentInput[];
  reports: NearbyReportInput[];
  supportHubs: NearbySupportHubInput[];
}): PredictiveRiskResult {
  const evaluatedAt = new Date().toISOString();
  const radiusKm = input.radiusKm ?? 3.5;
  const center = { lat: input.latitude, lng: input.longitude };

  const liveIncidents = input.incidents.filter(
    (inc) =>
      !inc.isSimulated &&
      inc.latitude != null &&
      inc.longitude != null &&
      haversineDistanceKm(center, { lat: inc.latitude, lng: inc.longitude }) <= radiusKm
  );
  const simulatedExcluded = input.incidents.filter((inc) => inc.isSimulated).length;

  const liveReports = input.reports.filter(
    (rep) => !rep.isSimulated && haversineDistanceKm(center, { lat: rep.latitude, lng: rep.longitude }) <= radiusKm
  );

  const nearbyHubs = input.supportHubs.filter(
    (h) => haversineDistanceKm(center, { lat: h.latitude, lng: h.longitude }) <= radiusKm
  );
  const open24hHubs = nearbyHubs.filter((h) => h.is24Hours);

  const evidence: PredictiveRiskEvidence[] = [];
  let rawScore = 15; // baseline ambient caution score

  // 1. Verified non-simulated SOS incidents
  if (liveIncidents.length > 0) {
    const activeCount = liveIncidents.filter((i) => i.status !== 'Resolved' && i.status !== 'Cancelled').length;
    const pts = Math.min(45, activeCount * 18 + (liveIncidents.length - activeCount) * 7);
    rawScore += pts;
    evidence.push({
      factor: 'Recent Verified SOS Incidents',
      category: 'incidents',
      impact: 'elevates_risk',
      detail: `${liveIncidents.length} non-simulated incident(s) (${activeCount} active) recorded within ${radiusKm} km.`,
      source: 'LIFE-LINE Verified Incident Database',
      timestamp: liveIncidents[0].createdAt,
    });
  } else {
    evidence.push({
      factor: 'Incident Database Check',
      category: 'incidents',
      impact: 'neutral',
      detail: `Zero verified non-simulated SOS incidents within ${radiusKm} km (${simulatedExcluded} demo/simulated incident(s) excluded).`,
      source: 'LIFE-LINE Verified Incident Database',
      timestamp: evaluatedAt,
    });
  }

  // 2. Privacy-conscious community safety reports
  if (liveReports.length > 0) {
    const highCount = liveReports.filter((r) => r.severity === 'HIGH').length;
    const modCount = liveReports.filter((r) => r.severity === 'MODERATE').length;
    const lowCount = liveReports.length - highCount - modCount;
    const pts = Math.min(35, highCount * 15 + modCount * 9 + lowCount * 4);
    rawScore += pts;
    evidence.push({
      factor: 'Community Safety & Lighting Reports',
      category: 'community_reports',
      impact: 'elevates_risk',
      detail: `${liveReports.length} community hazard report(s) within ${radiusKm} km (HIGH: ${highCount}, MODERATE: ${modCount}).`,
      source: 'LIFE-LINE Privacy-Conscious Safety Reports',
      timestamp: liveReports[0].createdAt,
    });
  } else {
    evidence.push({
      factor: 'Community Safety Reports',
      category: 'community_reports',
      impact: 'neutral',
      detail: `No recent non-simulated community safety reports within ${radiusKm} km.`,
      source: 'LIFE-LINE Privacy-Conscious Safety Reports',
      timestamp: evaluatedAt,
    });
  }

  // 3. Live Open-Meteo Weather & Visibility telemetry
  if (input.weather.available) {
    let weatherPts = 0;
    const weatherNotes: string[] = [];
    if ((input.weather.visibilityMeters ?? 10000) < 2500) {
      weatherPts += 15;
      weatherNotes.push(`low visibility (${Math.round(input.weather.visibilityMeters!)} m)`);
    }
    if ((input.weather.rainMm ?? 0) > 1 || (input.weather.precipitationMm ?? 0) > 1 || (input.weather.weatherCode ?? 0) >= 61) {
      weatherPts += 12;
      weatherNotes.push(`${input.weather.weatherLabel || 'rain/precipitation'}`);
    }
    if ((input.weather.windSpeedKmh ?? 0) >= 35) {
      weatherPts += 8;
      weatherNotes.push(`high wind (${input.weather.windSpeedKmh} km/h)`);
    }
    if (input.weather.isDay === false) {
      weatherPts += 10;
      evidence.push({
        factor: 'Nighttime / Low-Light Travel Window',
        category: 'time_lighting',
        impact: 'elevates_risk',
        detail: 'Local solar cycle reports nighttime conditions; well-lit main corridors are advised.',
        source: 'Open-Meteo Local Daylight Telemetry',
        timestamp: input.weather.retrievedAt,
      });
    }
    rawScore += weatherPts;
    evidence.push({
      factor: 'Live Weather & Visibility',
      category: 'weather',
      impact: weatherPts > 0 ? 'elevates_risk' : 'neutral',
      detail:
        weatherNotes.length > 0
          ? `Weather conditions (${weatherNotes.join(', ')}, ${input.weather.temperatureC ?? '?'}°C) may affect transit visibility.`
          : `Clear / mild conditions (${input.weather.weatherLabel}, ${input.weather.temperatureC ?? '?'}°C, wind ${input.weather.windSpeedKmh ?? '?'} km/h).`,
      source: input.weather.source,
      timestamp: input.weather.retrievedAt,
    });
  } else {
    evidence.push({
      factor: 'Live Weather Telemetry',
      category: 'weather',
      impact: 'unavailable',
      detail: input.weather.reason || 'Weather telemetry unavailable; environmental factors could not be verified.',
      source: input.weather.source,
      timestamp: input.weather.retrievedAt,
    });
  }

  // 4. Verified / Directory Safe Havens & 24/7 Support Hubs
  if (open24hHubs.length > 0) {
    rawScore -= Math.min(12, open24hHubs.length * 4);
    evidence.push({
      factor: '24/7 Safe Haven & Support Proximity',
      category: 'support_proximity',
      impact: 'mitigates_risk',
      detail: `${open24hHubs.length} 24/7 support or medical location(s) (${nearbyHubs.length} total directory hubs) within ${radiusKm} km.`,
      source: 'LIFE-LINE Support Directory',
      timestamp: evaluatedAt,
    });
  }

  const boundedScore = Math.max(0, Math.min(100, Math.round(rawScore)));

  // Confidence strictly reflects actual signal availability — never fabricated!
  let confidence = 0.25;
  if (input.weather.available) confidence += 0.3;
  if (nearbyHubs.length > 0) confidence += 0.15;
  if (liveIncidents.length > 0 || liveReports.length > 0) confidence += 0.22;
  else confidence += 0.1; // verified zero-incident query still carries modest confidence
  confidence = Number(Math.min(0.92, confidence).toFixed(2));

  // CRITICAL guardrail: Never declare an area dangerous or HIGH risk without verified incident/report or severe weather evidence
  const hasRealRiskSignals = liveIncidents.length > 0 || liveReports.length > 0 || input.weather.available;
  let riskLevel: PredictiveRiskResult['riskLevel'] = 'LOW';
  if (!hasRealRiskSignals) {
    riskLevel = 'INSUFFICIENT_DATA';
  } else if (boundedScore >= 60 && (liveIncidents.length > 0 || liveReports.length > 0)) {
    riskLevel = 'ELEVATED';
  } else if (boundedScore >= 35) {
    riskLevel = 'MODERATE';
  } else {
    riskLevel = 'LOW';
  }

  const locationLabel = input.locationLabel || `${input.latitude.toFixed(4)}, ${input.longitude.toFixed(4)}`;
  const summary =
    riskLevel === 'INSUFFICIENT_DATA'
      ? `Insufficient verified telemetry for ${locationLabel}. No verified local incidents found in the database and live weather telemetry is offline.`
      : riskLevel === 'ELEVATED'
        ? `Elevated caution advisory for ${locationLabel} based on ${liveIncidents.length} verified incident(s), ${liveReports.length} safety report(s), and current environmental telemetry.`
        : riskLevel === 'MODERATE'
          ? `Moderate awareness advised near ${locationLabel}; review environmental and timing factors below before traveling.`
          : `Low observed risk indicators near ${locationLabel} based on zero verified nearby emergencies and current environmental checks.`;

  const mitigationGuidance = [
    'Use well-lit main avenues and active transit stops; confirm live venue hours before walking alone.',
    'Start a LIFE-LINE PULSE shared journey with automatic check-in reminders so trusted contacts track safe arrival.',
    ...(open24hHubs.length > 0
      ? [`Nearest 24/7 directory support hub: ${open24hHubs[0].name} (${open24hHubs[0].category}).`]
      : ['Run Live Google Places Search on the Map tab to confirm open 24/7 hospitals or transit stations nearby.']),
  ];

  return {
    riskLevel,
    riskScore: riskLevel === 'INSUFFICIENT_DATA' ? 0 : boundedScore,
    confidence,
    locationLabel,
    latitude: input.latitude,
    longitude: input.longitude,
    evaluatedAt,
    summary,
    evidence,
    counts: {
      verifiedNearbyIncidents: liveIncidents.length,
      simulatedIncidentsExcluded: simulatedExcluded,
      communityReportsCount: liveReports.length,
      nearbySupportHubs: nearbyHubs.length,
      open24hSupportHubs: open24hHubs.length,
    },
    weather: input.weather,
    mitigationGuidance,
  };
}

function parseDurationSeconds(durationStr?: string): number {
  if (!durationStr) return 0;
  const match = /^(\d+(?:\.\d+)?)s$/.exec(durationStr.trim());
  return match ? Math.round(Number(match[1])) : 0;
}

function formatDuration(seconds: number): string {
  if (seconds < 60) return `${seconds} sec`;
  const mins = Math.round(seconds / 60);
  if (mins < 60) return `${mins} min`;
  const hrs = Math.floor(mins / 60);
  const rem = mins % 60;
  return rem > 0 ? `${hrs} hr ${rem} min` : `${hrs} hr`;
}

export async function computeSafeRoutesWithGoogle(
  input: {
    origin: GeoPoint;
    destination: GeoPoint;
    travelMode: 'WALK' | 'DRIVE' | 'TRANSIT' | 'BICYCLE';
  },
  mapsApiKey: string,
  contextData: {
    weather: WeatherSnapshot;
    incidents: NearbyIncidentInput[];
    reports: NearbyReportInput[];
    supportHubs: NearbySupportHubInput[];
  },
  fetchImpl: typeof fetch = fetch
): Promise<SafeRouteResponse> {
  const retrievedAt = new Date().toISOString();

  if (!mapsApiKey) {
    return {
      available: false,
      source: 'Google Maps Routes API v2',
      travelMode: input.travelMode,
      retrievedAt,
      weather: contextData.weather,
      routes: [],
      error: 'Google Maps Routes API key is not configured on the server.',
    };
  }

  const requestBody: Record<string, unknown> = {
    origin: {
      location: { latLng: { latitude: input.origin.lat, longitude: input.origin.lng } },
    },
    destination: {
      location: { latLng: { latitude: input.destination.lat, longitude: input.destination.lng } },
    },
    travelMode: input.travelMode,
    computeAlternativeRoutes: input.travelMode !== 'TRANSIT',
    units: 'METRIC',
  };

  if (input.travelMode === 'DRIVE') {
    requestBody.routingPreference = 'TRAFFIC_AWARE';
  }

  try {
    const resp = await fetchImpl('https://routes.googleapis.com/directions/v2:computeRoutes', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Goog-Api-Key': mapsApiKey,
        'X-Goog-Maps-Solution-ID': MAPS_ATTRIBUTION_ID,
        'X-Goog-FieldMask':
          'routes.distanceMeters,routes.duration,routes.polyline.encodedPolyline,routes.routeLabels,routes.description,routes.warnings',
      },
      body: JSON.stringify(requestBody),
      signal: AbortSignal.timeout(9000),
    });

    const data = (await resp.json().catch(() => ({}))) as {
      routes?: Array<{
        distanceMeters?: number;
        duration?: string;
        polyline?: { encodedPolyline?: string };
        routeLabels?: string[];
        description?: string;
        warnings?: string[];
      }>;
      error?: { status?: string; message?: string };
    };

    if (!resp.ok) {
      return {
        available: false,
        source: 'Google Maps Routes API v2',
        travelMode: input.travelMode,
        retrievedAt,
        weather: contextData.weather,
        routes: [],
        error: data?.error?.message || `Google Routes API returned HTTP ${resp.status}.`,
      };
    }

    const rawRoutes = data.routes || [];
    if (rawRoutes.length === 0) {
      return {
        available: false,
        source: 'Google Maps Routes API v2',
        travelMode: input.travelMode,
        retrievedAt,
        weather: contextData.weather,
        routes: [],
        error: 'Google Routes API returned no drivable/walkable routes between those coordinates.',
      };
    }

    const liveIncidents = contextData.incidents.filter((i) => !i.isSimulated && i.latitude != null && i.longitude != null);
    const liveReports = contextData.reports.filter((r) => !r.isSimulated);

    const candidates: SafeRouteCandidate[] = rawRoutes.map((route, idx) => {
      const encodedPolyline = route.polyline?.encodedPolyline || '';
      const path = decodePolyline(encodedPolyline);
      const effectivePath = path.length > 0 ? path : [input.origin, input.destination];

      const incidentsNearRoute = liveIncidents.filter(
        (i) => minDistanceToPolylineKm({ lat: i.latitude!, lng: i.longitude! }, effectivePath) <= 0.65
      );
      const reportsNearRoute = liveReports.filter(
        (r) => minDistanceToPolylineKm({ lat: r.latitude, lng: r.longitude }, effectivePath) <= 0.65
      );
      const hubsNearRoute = contextData.supportHubs.filter(
        (h) => minDistanceToPolylineKm({ lat: h.latitude, lng: h.longitude }, effectivePath) <= 0.85
      );
      const open24hNearRoute = hubsNearRoute.filter((h) => h.is24Hours);

      let safetyScore = 88;
      safetyScore -= incidentsNearRoute.length * 16;
      safetyScore -= reportsNearRoute.length * 10;
      safetyScore += Math.min(10, open24hNearRoute.length * 4);
      if (contextData.weather.available && (contextData.weather.rainMm ?? 0) > 1 && input.travelMode === 'WALK') {
        safetyScore -= 6;
      }
      if (contextData.weather.available && contextData.weather.isDay === false && input.travelMode === 'WALK') {
        safetyScore -= 6;
      }
      safetyScore = Math.max(10, Math.min(99, Math.round(safetyScore)));

      const durationSeconds = parseDurationSeconds(route.duration);
      const distanceMeters = Number(route.distanceMeters || 0);
      const reasons: string[] = [];
      if (incidentsNearRoute.length === 0) {
        reasons.push('0 verified SOS incidents within 650m of corridor.');
      } else {
        reasons.push(`${incidentsNearRoute.length} verified SOS incident(s) within 650m — extra caution advised.`);
      }
      if (reportsNearRoute.length > 0) {
        reasons.push(`${reportsNearRoute.length} community hazard/lighting report(s) along this path.`);
      }
      if (open24hNearRoute.length > 0) {
        reasons.push(`${open24hNearRoute.length} 24/7 support hub(s) accessible within 850m.`);
      }
      if (contextData.weather.available) {
        reasons.push(`Weather check: ${contextData.weather.weatherLabel}, ${contextData.weather.temperatureC ?? '?'}°C.`);
      }

      const riskLevel: SafeRouteCandidate['riskLevel'] =
        safetyScore >= 75 ? 'LOW' : safetyScore >= 50 ? 'MODERATE' : 'ELEVATED';

      return {
        routeIndex: idx,
        summary: route.description?.trim() || `Route Option ${idx + 1}`,
        distanceMeters,
        durationSeconds,
        durationLabel: formatDuration(durationSeconds),
        encodedPolyline,
        path: effectivePath,
        routeLabels: route.routeLabels || [],
        warnings: route.warnings || [],
        safetyScore,
        riskLevel,
        nearbyIncidentsCount: incidentsNearRoute.length,
        nearbyReportsCount: reportsNearRoute.length,
        nearbySupportHubsCount: hubsNearRoute.length,
        reasons,
        isRecommended: false,
      };
    });

    // Rank highest safety score first, tie-breaking on shorter travel time
    let bestIdx = 0;
    for (let i = 1; i < candidates.length; i++) {
      if (
        candidates[i].safetyScore > candidates[bestIdx].safetyScore ||
        (candidates[i].safetyScore === candidates[bestIdx].safetyScore &&
          candidates[i].durationSeconds < candidates[bestIdx].durationSeconds)
      ) {
        bestIdx = i;
      }
    }
    candidates[bestIdx].isRecommended = true;

    return {
      available: true,
      source: 'Google Maps Routes API v2',
      travelMode: input.travelMode,
      retrievedAt,
      weather: contextData.weather,
      routes: candidates,
    };
  } catch (err) {
    return {
      available: false,
      source: 'Google Maps Routes API v2',
      travelMode: input.travelMode,
      retrievedAt,
      weather: contextData.weather,
      routes: [],
      error: err instanceof Error ? `Google Routes request failed: ${err.message}` : 'Google Routes request failed.',
    };
  }
}

export interface SosClusterPointSummary {
  id: string;
  lat: number;
  lng: number;
  totalCount: number;
  verifiedSosCount: number;
  communityReportCount: number;
  simulatedCount: number;
  highSeverityCount: number;
  dominantCategory: string;
  latestAt: string;
  radiusMeters: number;
  dataOrigin: 'verified' | 'simulated' | 'mixed';
  severityScore: number;
}

export interface SosClusterBuildResult {
  evaluatedAt: string;
  windowDays: number;
  radiusKm: number;
  center: { lat: number; lng: number } | null;
  totalVerifiedRecords: number;
  totalSimulatedRecords: number;
  clusters: SosClusterPointSummary[];
  hourlyDistribution: Array<{ hour: number; verifiedCount: number; simulatedCount: number }>;
  privacyNotice: string;
}

export function buildSosIncidentClusters(input: {
  incidents: NearbyIncidentInput[];
  reports: NearbyReportInput[];
  centerLat?: number;
  centerLng?: number;
  radiusKm?: number;
  windowDays?: number;
  includeSimulated?: boolean;
}): SosClusterBuildResult {
  const evaluatedAt = new Date().toISOString();
  const windowDays = Math.min(365, Math.max(1, Math.round(input.windowDays ?? 30)));
  const radiusKm = Math.min(250, Math.max(1, input.radiusKm ?? 30));
  const includeSimulated = input.includeSimulated ?? true;
  const hasCenter =
    typeof input.centerLat === 'number' &&
    Number.isFinite(input.centerLat) &&
    typeof input.centerLng === 'number' &&
    Number.isFinite(input.centerLng);
  const center = hasCenter ? { lat: input.centerLat!, lng: input.centerLng! } : null;
  const cutoffMs = Date.now() - windowDays * 24 * 60 * 60 * 1000;

  interface RawSpatialSignal {
    lat: number;
    lng: number;
    category: string;
    isHighSeverity: boolean;
    isSimulated: boolean;
    kind: 'sos' | 'report';
    createdAt: string;
  }

  const signals: RawSpatialSignal[] = [];

  for (const inc of input.incidents) {
    if (inc.status === 'Cancelled') continue;
    if (inc.latitude == null || inc.longitude == null) continue;
    if (!Number.isFinite(inc.latitude) || !Number.isFinite(inc.longitude)) continue;
    const ts = Date.parse(inc.createdAt);
    if (Number.isFinite(ts) && ts < cutoffMs) continue;
    if (center && haversineDistanceKm(center, { lat: inc.latitude, lng: inc.longitude }) > radiusKm) continue;
    signals.push({
      lat: inc.latitude,
      lng: inc.longitude,
      category: inc.category || 'Personal Safety',
      isHighSeverity: inc.priority === 'CRITICAL' || inc.priority === 'HIGH',
      isSimulated: Boolean(inc.isSimulated),
      kind: 'sos',
      createdAt: inc.createdAt,
    });
  }

  for (const rep of input.reports) {
    if (!Number.isFinite(rep.latitude) || !Number.isFinite(rep.longitude)) continue;
    const ts = Date.parse(rep.createdAt);
    if (Number.isFinite(ts) && ts < cutoffMs) continue;
    if (center && haversineDistanceKm(center, { lat: rep.latitude, lng: rep.longitude }) > radiusKm) continue;
    signals.push({
      lat: rep.latitude,
      lng: rep.longitude,
      category: rep.category || 'Safety Report',
      isHighSeverity: rep.severity === 'HIGH',
      isSimulated: Boolean(rep.isSimulated),
      kind: 'report',
      createdAt: rep.createdAt,
    });
  }

  const hourly = Array.from({ length: 24 }, (_, hour) => ({
    hour,
    verifiedCount: 0,
    simulatedCount: 0,
  }));

  let totalVerifiedRecords = 0;
  let totalSimulatedRecords = 0;

  // Spatial bucket grid (~550m grid cells) for privacy-safe clustering
  const GRID_STEP = 0.0055;
  const buckets: Record<
    string,
    {
      latSum: number;
      lngSum: number;
      items: RawSpatialSignal[];
      catCounts: Record<string, number>;
    }
  > = {};

  for (const s of signals) {
    if (s.isSimulated) {
      totalSimulatedRecords += 1;
      if (!includeSimulated) continue;
    } else {
      totalVerifiedRecords += 1;
    }

    const parsed = new Date(s.createdAt);
    if (!Number.isNaN(parsed.getTime())) {
      const hr = parsed.getUTCHours();
      if (s.isSimulated) hourly[hr].simulatedCount += 1;
      else hourly[hr].verifiedCount += 1;
    }

    const qLat = Math.round(s.lat / GRID_STEP) * GRID_STEP;
    const qLng = Math.round(s.lng / GRID_STEP) * GRID_STEP;
    const key = `cell_${qLat.toFixed(3)}_${qLng.toFixed(3)}`;
    if (!buckets[key]) {
      buckets[key] = { latSum: 0, lngSum: 0, items: [], catCounts: {} };
    }
    const b = buckets[key];
    b.latSum += s.lat;
    b.lngSum += s.lng;
    b.items.push(s);
    b.catCounts[s.category] = (b.catCounts[s.category] || 0) + 1;
  }

  const clusters: SosClusterPointSummary[] = Object.entries(buckets).map(([id, b]) => {
    const count = b.items.length;
    // Generalize centroid to 3 decimal places (~110m minimum privacy anonymization)
    const centroidLat = Number((b.latSum / count).toFixed(3));
    const centroidLng = Number((b.lngSum / count).toFixed(3));

    let verifiedSosCount = 0;
    let communityReportCount = 0;
    let simulatedCount = 0;
    let highSeverityCount = 0;
    let latestAt = b.items[0].createdAt;
    let maxDistKm = 0.25;

    for (const item of b.items) {
      if (item.isSimulated) simulatedCount += 1;
      else if (item.kind === 'sos') verifiedSosCount += 1;
      else communityReportCount += 1;

      if (item.isHighSeverity) highSeverityCount += 1;
      if (Date.parse(item.createdAt) > Date.parse(latestAt)) latestAt = item.createdAt;

      const dKm = haversineDistanceKm({ lat: centroidLat, lng: centroidLng }, { lat: item.lat, lng: item.lng });
      if (dKm > maxDistKm) maxDistKm = dKm;
    }

    const dominantCategory =
      Object.entries(b.catCounts).sort((a, bCat) => bCat[1] - a[1])[0]?.[0] || 'Personal Safety';

    const verifiedTotal = verifiedSosCount + communityReportCount;
    const dataOrigin: SosClusterPointSummary['dataOrigin'] =
      verifiedTotal > 0 && simulatedCount > 0
        ? 'mixed'
        : verifiedTotal > 0
        ? 'verified'
        : 'simulated';

    const severityScore = Math.min(
      100,
      Math.round(verifiedSosCount * 24 + communityReportCount * 14 + highSeverityCount * 15 + simulatedCount * 10)
    );

    return {
      id,
      lat: centroidLat,
      lng: centroidLng,
      totalCount: count,
      verifiedSosCount,
      communityReportCount,
      simulatedCount,
      highSeverityCount,
      dominantCategory,
      latestAt,
      radiusMeters: Math.round(Math.min(1200, Math.max(220, maxDistKm * 1000 + 180))),
      dataOrigin,
      severityScore,
    };
  });

  clusters.sort((a, b) => b.totalCount - a.totalCount || b.severityScore - a.severityScore);

  return {
    evaluatedAt,
    windowDays,
    radiusKm,
    center,
    totalVerifiedRecords,
    totalSimulatedRecords,
    clusters,
    hourlyDistribution: hourly,
    privacyNotice:
      'Clusters generalize coordinates to ~550m spatial cells and omit all user identifiers. Historical cluster density is an informational awareness aid only and does not guarantee corridor safety or predict crime.',
  };
}

