import {
  LiveExternalAlert,
  MysuruWeatherIntel,
  SafetyGapBreakdown,
  SafetyReportItem,
  SupportResource,
} from '../types/lifeline.ts';
import { haversineDistanceKm } from './pulse.ts';

export const SAFETY_GAP_DISCLAIMER =
  'Minutes-to-Safety Gap Score (SGS) is a deterministic informational decision-support metric. Hospital bed capacity and ambulance availability are NOT auto-verified — always call 112 / 108 or the facility directly before dispatch.';

export interface SafetyGapScenarioOverrides {
  scenarioLabel?: string;
  blockedHubIds?: number[];
  simulatedRainMmPerHr?: number;
  simulatedTempC?: number;
  extraDemandFactor?: number;
}

export function computeSafetyGapScore(input: {
  localityName: string;
  latitude: number;
  longitude: number;
  alerts: LiveExternalAlert[];
  communityReports: SafetyReportItem[];
  weather: MysuruWeatherIntel;
  supportHubs: SupportResource[];
  sourcesAvailableCount?: number;
  scenario?: SafetyGapScenarioOverrides;
}): SafetyGapBreakdown {
  const evaluatedAt = new Date().toISOString();
  const origin = { lat: input.latitude, lng: input.longitude };
  const blockedIds = new Set(input.scenario?.blockedHubIds || []);

  // 1. Hazard Severity (H) strictly from verified official/observed alerts + near-term forecast + non-simulated reports
  const nearbyAlerts = input.alerts.filter((a) => {
    if (!a.isActive) return false;
    if (a.latitude == null || a.longitude == null) {
      return a.locationLabel.toLowerCase().includes(input.localityName.toLowerCase());
    }
    return haversineDistanceKm(origin, { lat: a.latitude, lng: a.longitude }) <= 55;
  });

  const nearbyReports = input.communityReports.filter((r) => {
    if (r.isSimulated) return false;
    return haversineDistanceKm(origin, { lat: r.latitude, lng: r.longitude }) <= 15;
  });

  let hazardH = 0;
  const evidenceSources: SafetyGapBreakdown['evidenceSources'] = [];

  for (const a of nearbyAlerts) {
    const weight =
      a.severity === 'EXTREME'
        ? 45
        : a.severity === 'SEVERE'
        ? 32
        : a.severity === 'MODERATE'
        ? 20
        : 10;
    hazardH += weight;
    evidenceSources.push({
      label: a.sourceName,
      signalKind: a.signalType === 'observation' ? 'observation' : a.signalType === 'forecast' ? 'forecast' : 'official_alert',
      timestamp: a.lastUpdatedAt,
      detail: `${a.severity}: ${a.title}`,
    });
  }

  for (const r of nearbyReports.slice(0, 5)) {
    hazardH += r.severity === 'HIGH' ? 14 : r.severity === 'MODERATE' ? 8 : 4;
    evidenceSources.push({
      label: `Community Report (${r.verificationStatus})`,
      signalKind: 'community_report',
      timestamp: r.createdAt,
      detail: `${r.category} near ${r.locationLabel}`,
    });
  }

  const effectiveRain =
    input.scenario?.simulatedRainMmPerHr ??
    Math.max(
      input.weather.precipitationMm ?? 0,
      ...(input.weather.horizons.slice(0, 2).map((h) => h.precipitationMm ?? 0))
    );
  const effectiveTemp =
    input.scenario?.simulatedTempC ??
    Math.max(
      input.weather.apparentTemperatureC ?? input.weather.temperatureC ?? 25,
      ...(input.weather.horizons.slice(0, 2).map((h) => h.apparentTemperatureC ?? h.temperatureC ?? 25))
    );

  if (input.weather.available) {
    evidenceSources.push({
      label: input.weather.source,
      signalKind: 'observation',
      timestamp: input.weather.retrievedAt,
      detail: `${input.weather.temperatureC ?? '--'}°C (feels ${input.weather.apparentTemperatureC ?? '--'}°C), rain ${input.weather.precipitationMm ?? 0} mm/h, ${input.weather.weatherLabel}`,
    });
  }
  if (effectiveRain >= 15) hazardH += 22;
  else if (effectiveRain >= 5) hazardH += 10;
  if (effectiveTemp >= 40) hazardH += 18;
  else if (effectiveTemp >= 37) hazardH += 8;

  hazardH = Math.min(100, Math.round(hazardH));

  // 2. Vulnerability Exposure (V): heat index, night visibility, rain-slip risk, surge factor
  let vulnV = 8;
  if (input.weather.available) {
    if (effectiveTemp >= 40) vulnV += 36;
    else if (effectiveTemp >= 36) vulnV += 22;
    else if (effectiveTemp >= 32) vulnV += 10;

    if (input.weather.isDay === false) vulnV += 18;
    if (effectiveRain >= 10) vulnV += 22;
    else if (effectiveRain >= 2) vulnV += 10;
    if (input.weather.visibilityMeters != null && input.weather.visibilityMeters < 2000) vulnV += 15;
  }
  if (input.scenario?.extraDemandFactor && input.scenario.extraDemandFactor > 1) {
    vulnV += Math.min(30, Math.round((input.scenario.extraDemandFactor - 1) * 25));
  }
  vulnV = Math.min(100, Math.round(vulnV));

  // 3. Accessibility Gap (A) & Nearest Support Hub
  const activeHubs = input.supportHubs
    .filter((h) => !blockedIds.has(h.id))
    .map((h) => ({
      hub: h,
      distanceKm: haversineDistanceKm(origin, { lat: h.latitude, lng: h.longitude }),
    }))
    .sort((a, b) => a.distanceKm - b.distanceKm);

  const nearest = activeHubs[0] || null;
  // Weather-adjusted emergency travel speed (~26 km/h urban normal, 17 km/h during heavy rain)
  const avgSpeedKmh = effectiveRain >= 10 ? 17 : 26;
  const estimatedMinutesToNearestHub = nearest
    ? Math.max(2, Math.round((nearest.distanceKm / avgSpeedKmh) * 60 + 2))
    : null;

  let accessA = 100;
  if (nearest) {
    if (nearest.distanceKm <= 2.5) accessA = 12;
    else if (nearest.distanceKm <= 6) accessA = 26;
    else if (nearest.distanceKm <= 12) accessA = 45;
    else if (nearest.distanceKm <= 25) accessA = 70;
    else accessA = 90;

    if (!nearest.hub.is24Hours) accessA = Math.min(100, accessA + 12);
    if (effectiveRain >= 15) accessA = Math.min(100, accessA + 15);
  }

  // 4. Resource Coverage Gap (R)
  const hubsWithin15Km = activeHubs.filter((x) => x.distanceKm <= 15);
  const categoriesPresent = new Set(hubsWithin15Km.map((x) => x.hub.category));
  const missingResources: string[] = [];

  if (!categoriesPresent.has('Hospital')) {
    missingResources.push('24/7 Emergency Medical / Trauma Hub within 15 km');
  }
  if (!categoriesPresent.has('Police')) {
    missingResources.push('Verified Police / ERSS-112 Dispatch Desk within 15 km');
  }
  if (!categoriesPresent.has('Shelter') && !categoriesPresent.has('Crisis Support')) {
    missingResources.push('Safe Shelter / Cooling or Crisis Center within 15 km');
  }
  if (effectiveTemp >= 38) {
    missingResources.push('Mobile Hydration / Cooling Points for outdoor commuters (heatwave precaution)');
  }
  if (effectiveRain >= 15) {
    missingResources.push('High-ground Transit & Drainage Diversion Advisory');
  }
  if (blockedIds.size > 0) {
    missingResources.push(`${blockedIds.size} facility offline in What-If simulation — alternate routing required`);
  }

  const resourceR = Math.min(
    100,
    Math.max(10, 82 - Math.min(4, categoriesPresent.size) * 16 - Math.min(3, hubsWithin15Km.length) * 4 + blockedIds.size * 15)
  );

  // 5. Data Freshness & Confidence (C)
  let freshnessC = 35;
  if (input.weather.available) freshnessC += 35;
  if ((input.sourcesAvailableCount ?? 1) >= 2) freshnessC += 25;
  if (activeHubs.length > 0) freshnessC += 5;
  freshnessC = Math.min(100, freshnessC);

  const insufficientData = !input.weather.available && input.alerts.length === 0 && (input.sourcesAvailableCount ?? 0) === 0;
  const safetyGapScore = insufficientData
    ? 0
    : Math.min(100, Math.max(0, Math.round(0.32 * hazardH + 0.22 * vulnV + 0.24 * accessA + 0.22 * resourceR)));

  let riskBand: SafetyGapBreakdown['riskBand'] = 'LOW';
  if (insufficientData) riskBand = 'INSUFFICIENT_DATA';
  else if (safetyGapScore >= 72) riskBand = 'CRITICAL';
  else if (safetyGapScore >= 50) riskBand = 'HIGH';
  else if (safetyGapScore >= 28) riskBand = 'MODERATE';

  const recommendedPreventiveActions: string[] = [];
  if (nearbyAlerts.length > 0) {
    recommendedPreventiveActions.push(
      `Review ${nearbyAlerts.length} active official alert(s) and confirm human responder readiness before field deployment.`
    );
  } else {
    recommendedPreventiveActions.push(
      `No active official alerts in ${input.localityName}; keep continuous monitoring active.`
    );
  }
  if (nearest) {
    recommendedPreventiveActions.push(
      `Nearest directory hub: ${nearest.hub.name} (~${estimatedMinutesToNearestHub} min / ${nearest.distanceKm.toFixed(1)} km). Call ${nearest.hub.phone || '112'} to verify live capacity.`
    );
  }
  if (effectiveTemp >= 36) {
    recommendedPreventiveActions.push('Pre-position hydration advisories and prioritize shaded transit corridors during peak heat.');
  }
  if (effectiveRain >= 10) {
    recommendedPreventiveActions.push('Monitor low-lying corridors and alert 24/7 emergency responders for potential flood diversions.');
  }

  return {
    localityName: input.localityName,
    latitude: input.latitude,
    longitude: input.longitude,
    evaluatedAt,
    safetyGapScore,
    riskBand,
    isInformationalOnly: true,
    disclaimer: SAFETY_GAP_DISCLAIMER,
    components: {
      hazardSeverityH: hazardH,
      vulnerabilityExposureV: vulnV,
      accessibilityGapA: accessA,
      resourceGapR: resourceR,
      dataFreshnessC: freshnessC,
    },
    missingResources,
    estimatedMinutesToNearestHub,
    nearestSupportHub: nearest
      ? {
          id: nearest.hub.id,
          name: nearest.hub.name,
          category: nearest.hub.category,
          distanceKm: Number(nearest.distanceKm.toFixed(2)),
          phone: nearest.hub.phone,
          is24Hours: nearest.hub.is24Hours,
          capacityNote: 'Live bed/shelter capacity requires direct phone verification (not auto-reported).',
        }
      : null,
    recommendedPreventiveActions,
    evidenceSources,
  };
}

export function runDeterministicWhatIfScenario(input: {
  scenarioType: 'hospital_offline' | 'corridor_flooded' | 'heatwave_peak' | 'multi_locality_surge';
  baseline: SafetyGapBreakdown;
  localityName: string;
  latitude: number;
  longitude: number;
  alerts: LiveExternalAlert[];
  communityReports: SafetyReportItem[];
  weather: MysuruWeatherIntel;
  supportHubs: SupportResource[];
  blockedHubId?: number;
}) {
  const overrides: SafetyGapScenarioOverrides = {};
  let title = '';
  if (input.scenarioType === 'hospital_offline') {
    const targetId = input.blockedHubId ?? input.baseline.nearestSupportHub?.id;
    overrides.blockedHubIds = targetId ? [targetId] : [];
    title = 'What-If: Nearest Medical / Support Hub Offline or At Capacity';
  } else if (input.scenarioType === 'corridor_flooded') {
    overrides.simulatedRainMmPerHr = 28;
    title = 'What-If: Heavy Rainfall (28 mm/h) & Flooded Transit Corridor';
  } else if (input.scenarioType === 'heatwave_peak') {
    overrides.simulatedTempC = 43;
    title = 'What-If: Peak Urban Heatwave (43°C Apparent Temperature)';
  } else {
    overrides.extraDemandFactor = 2.0;
    overrides.simulatedRainMmPerHr = 18;
    title = 'What-If: Simultaneous Multi-Locality Surge (2x Demand + Rain)';
  }

  const simulated = computeSafetyGapScore({
    localityName: input.localityName,
    latitude: input.latitude,
    longitude: input.longitude,
    alerts: input.alerts,
    communityReports: input.communityReports,
    weather: input.weather,
    supportHubs: input.supportHubs,
    sourcesAvailableCount: 2,
    scenario: overrides,
  });

  const scoreDelta = simulated.safetyGapScore - input.baseline.safetyGapScore;
  const minutesDelta =
    simulated.estimatedMinutesToNearestHub != null && input.baseline.estimatedMinutesToNearestHub != null
      ? simulated.estimatedMinutesToNearestHub - input.baseline.estimatedMinutesToNearestHub
      : null;

  return {
    scenarioType: input.scenarioType,
    title,
    isSimulation: true,
    baselineScore: input.baseline.safetyGapScore,
    simulatedScore: simulated.safetyGapScore,
    scoreDelta,
    baselineMinutes: input.baseline.estimatedMinutesToNearestHub,
    simulatedMinutes: simulated.estimatedMinutesToNearestHub,
    minutesDelta,
    alternateHub: simulated.nearestSupportHub,
    simulatedBreakdown: simulated,
  };
}
