export type UserRole =
  | 'regular_user'
  | 'emergency_operator'
  | 'support_organization'
  | 'administrator';

export interface AppUser {
  id: number;
  uid: string;
  email: string;
  displayName: string;
  role: UserRole;
  emailVerified: boolean;
  isDemoAccount: boolean;
  createdAt: string;
}

export interface UserProfileData {
  fullName: string;
  phone: string;
  avatarUrl: string;
  emergencyNotes: string;
  medicalNotes: string;
  bloodType: string;
  preferredLanguage: string;
  safetyStatus: string;
  lastKnownLat: number | null;
  lastKnownLng: number | null;
  lastLocationLabel: string;
  locationSharingConsent: boolean;
}

export interface UserPreferencesData {
  theme: 'dark' | 'light';
  enableEmailAlerts: boolean;
  enableSmsAlerts: boolean;
  enableInAppAlerts: boolean;
  locationConsentMode: string;
  dataRetentionDays: number;
  demoModeEnabled: boolean;
}

export interface TrustedContact {
  id: number;
  userId: number;
  name: string;
  relationship: string;
  email: string;
  phone: string;
  notifyEmail: boolean;
  notifySms: boolean;
  notifyWhatsapp: boolean;
  priorityOrder: number;
  isVerified: boolean;
  source: string;
}

export interface IncidentUpdateItem {
  id: number;
  authorRole: string;
  authorName: string;
  previousStatus: string;
  newStatus: string;
  note: string;
  isInternal?: boolean;
  createdAt: string;
}

export interface DeliveryLogItem {
  id: number;
  recipient: string;
  channel: string;
  provider: string;
  status: string;
  attemptCount: number;
  errorMessage: string;
  sentAt: string | null;
  createdAt: string;
}

export type IncidentDeliveryStatus = 'queued' | 'submitted' | 'delivered' | 'failed';

export interface EmergencyIncident {
  id: number;
  userId: number;
  reporterName: string;
  reporterEmail: string;
  title: string;
  description: string;
  category: string;
  status: 'SOS Activated' | 'Alert Sent' | 'Acknowledged' | 'Assistance in Progress' | 'Resolved' | 'Cancelled';
  deliveryStatus?: IncidentDeliveryStatus;
  priority: 'CRITICAL' | 'HIGH' | 'MEDIUM' | 'LOW';
  latitude: number | null;
  longitude: number | null;
  locationLabel: string;
  locationAccuracyMeters: number | null;
  isSimulated: boolean;
  acknowledgedByUserId: number | null;
  operatorName: string | null;
  acknowledgedAt: string | null;
  resolvedAt: string | null;
  createdAt: string;
  updatedAt: string;
  updates: IncidentUpdateItem[];
  deliveryLogs: DeliveryLogItem[];
}

export interface SupportResource {
  id: number;
  name: string;
  category: string;
  phone: string;
  website: string;
  email: string;
  verificationStatus: string;
  source: string;
  isSampleData: boolean;
  address: string;
  city: string;
  region: string;
  latitude: number;
  longitude: number;
  operatingHours: string;
  is24Hours: boolean;
  availabilityNote: string;
  lastUpdatedAt: string;
}

export interface NotificationItem {
  id: number;
  incidentId: number | null;
  channel: string;
  title: string;
  message: string;
  category: string;
  isRead: boolean;
  isSimulated: boolean;
  createdAt: string;
}

export interface AiRecommendationItem {
  id: number;
  agentName: string;
  title: string;
  recommendationText: string;
  category: string;
  confidence: number;
  sourceCitation: string;
  actionRequiredAuth: boolean;
  isCompleted: boolean;
  createdAt: string;
}

export interface AnalyticsSummary {
  liveStats: {
    total: number;
    active: number;
    resolved: number;
    avgAckSeconds: number | null;
    avgResolutionSeconds?: number | null;
    byCategory: { name: string; count: number }[];
  };
  demoStats: {
    total: number;
    active: number;
    resolved: number;
    avgAckSeconds: number | null;
    avgResolutionSeconds?: number | null;
    byCategory: { name: string; count: number }[];
  };
  resourceDistribution: { category: string; count: number }[];
  responders?: {
    available: number;
    responding: number;
    offDuty: number;
  };
}

export interface ResponderInfo {
  id: number;
  displayName: string;
  email: string;
  role: UserRole;
  responderStatus: 'Available' | 'Responding' | 'Off Duty';
  responderUpdatedAt: string;
  activeAssignedCount: number;
}

export interface PulseWeatherSnapshot {
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

export interface PredictiveRiskAssessment {
  riskLevel: 'LOW' | 'MODERATE' | 'ELEVATED' | 'INSUFFICIENT_DATA';
  riskScore: number;
  confidence: number;
  locationLabel: string;
  latitude: number;
  longitude: number;
  evaluatedAt: string;
  summary: string;
  evidence: Array<{
    factor: string;
    category: string;
    impact: 'elevates_risk' | 'mitigates_risk' | 'neutral' | 'unavailable';
    detail: string;
    source: string;
    timestamp: string;
  }>;
  counts: {
    verifiedNearbyIncidents: number;
    simulatedIncidentsExcluded: number;
    communityReportsCount: number;
    nearbySupportHubs: number;
    open24hSupportHubs: number;
  };
  weather: PulseWeatherSnapshot;
  mitigationGuidance: string[];
}

export interface SafeRouteCandidateItem {
  routeIndex: number;
  summary: string;
  distanceMeters: number;
  durationSeconds: number;
  durationLabel: string;
  encodedPolyline: string;
  path: Array<{ lat: number; lng: number }>;
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

export interface SafetyJourneyItem {
  id: number;
  userId: number;
  originLabel: string;
  originLat: number;
  originLng: number;
  destinationLabel: string;
  destinationLat: number;
  destinationLng: number;
  travelMode: string;
  selectedRouteSummary: string;
  routeRiskLevel: string;
  shareToken: string;
  sharedWithContacts: Array<{ id?: number; name: string; email?: string }>;
  checkInIntervalMinutes: number;
  expectedArrivalAt: string;
  nextCheckInDueAt: string;
  lastCheckInAt: string | null;
  arrivedAt: string | null;
  status: 'Active' | 'Arrived Safe' | 'Escalated' | 'Cancelled';
  isSimulated: boolean;
  createdAt: string;
  updatedAt: string;
}

export interface SafetyReportItem {
  id: number;
  category: string;
  severity: 'LOW' | 'MODERATE' | 'HIGH';
  description: string;
  latitude: number;
  longitude: number;
  locationLabel: string;
  isAnonymous: boolean;
  verificationStatus: string;
  isSimulated: boolean;
  createdAt: string;
  reporterLabel: string;
}

export interface AuditLogEntry {
  id: number;
  actorEmail: string;
  actorRole: string;
  action: string;
  resourceType: string;
  resourceId: string;
  details: Record<string, unknown>;
  createdAt: string;
}

export type AppLanguage = 'en' | 'kn';

export type ActiveView = 'landing' | 'dashboard' | 'incidents' | 'pulse' | 'map' | 'agents' | 'operator' | 'profile';

export type LiveIncidentVerificationStatus =
  | 'Official Alert'
  | 'Awaiting Verification'
  | 'Verified Incident'
  | 'Resolved Incident';

export type LiveAlertSeverity = 'EXTREME' | 'SEVERE' | 'MODERATE' | 'MINOR' | 'ADVISORY';

export type LiveAlertCategory =
  | 'Cyclone'
  | 'Flooding'
  | 'Heavy Rainfall'
  | 'Thunderstorm & Lightning'
  | 'Heatwave'
  | 'Fire'
  | 'Earthquake'
  | 'Road Disruption'
  | 'Water Supply Emergency'
  | 'Other Verified Emergency';

export interface LiveExternalAlert {
  id: number;
  externalKey: string;
  sourceId: string;
  sourceName: string;
  sourceUrl: string;
  category: LiveAlertCategory | string;
  title: string;
  description: string;
  instruction: string;
  severity: LiveAlertSeverity;
  severityColor: string;
  certainty: string;
  verificationStatus: LiveIncidentVerificationStatus;
  signalType: 'official_alert' | 'observation' | 'forecast' | 'community_report';
  locationLabel: string;
  stateName: string;
  districtName: string;
  latitude: number | null;
  longitude: number | null;
  areaCoveredSqKm: number | null;
  language: string;
  firstReportedAt: string;
  effectiveFrom: string | null;
  expiresAt: string | null;
  lastUpdatedAt: string;
  isActive: boolean;
}

export interface LiveFeedSyncRun {
  sourceId: string;
  sourceName: string;
  sourceKind: 'official_cap' | 'meteorology' | 'geophysical' | 'satellite_fire';
  endpointUrl: string;
  status: 'healthy' | 'degraded' | 'offline' | 'unconfigured';
  pollIntervalSeconds: number;
  lastAttemptAt: string | null;
  lastSuccessAt: string | null;
  lastError: string;
  recordsFetched: number;
  recordsActive: number;
  latencyMs: number;
  isStale: boolean;
}

export interface LiveWeatherForecastPoint {
  timeIso: string;
  horizonLabel: string;
  temperatureC: number | null;
  apparentTemperatureC: number | null;
  precipitationMm: number | null;
  precipitationProbability: number | null;
  windSpeedKmh: number | null;
  weatherCode: number | null;
  weatherLabel: string;
}

export interface MysuruWeatherIntel {
  available: boolean;
  city: string;
  state: string;
  latitude: number;
  longitude: number;
  source: string;
  retrievedAt: string;
  temperatureC: number | null;
  apparentTemperatureC: number | null;
  humidityPercent: number | null;
  precipitationMm: number | null;
  rainMm: number | null;
  windSpeedKmh: number | null;
  weatherCode: number | null;
  weatherLabel: string;
  visibilityMeters: number | null;
  isDay: boolean | null;
  reason?: string;
  horizons: LiveWeatherForecastPoint[];
}

export interface SafetyGapBreakdown {
  localityName: string;
  latitude: number;
  longitude: number;
  evaluatedAt: string;
  safetyGapScore: number;
  riskBand: 'LOW' | 'MODERATE' | 'HIGH' | 'CRITICAL' | 'INSUFFICIENT_DATA';
  isInformationalOnly: true;
  disclaimer: string;
  components: {
    hazardSeverityH: number;
    vulnerabilityExposureV: number;
    accessibilityGapA: number;
    resourceGapR: number;
    dataFreshnessC: number;
  };
  missingResources: string[];
  estimatedMinutesToNearestHub: number | null;
  nearestSupportHub: {
    id: number;
    name: string;
    category: string;
    distanceKm: number;
    phone: string;
    is24Hours: boolean;
    capacityNote: string;
  } | null;
  recommendedPreventiveActions: string[];
  evidenceSources: Array<{
    label: string;
    signalKind: 'observation' | 'official_alert' | 'forecast' | 'community_report';
    timestamp: string;
    detail: string;
  }>;
}

export interface LiveIncidentsFeedResponse {
  evaluatedAt: string;
  region: string;
  hasActiveLocalIncidents: boolean;
  zeroStateMessage: string;
  alerts: LiveExternalAlert[];
  communityReports: SafetyReportItem[];
  sources: LiveFeedSyncRun[];
  weather: MysuruWeatherIntel;
  safetyGap: SafetyGapBreakdown;
}

export interface WorkspaceConfirmPayload {
  actionType: 'gmail_send' | 'calendar_checkin' | 'sheets_export' | 'docs_safety_plan' | 'drive_backup' | 'tasks_create';
  title: string;
  description: string;
  details: string[];
  onConfirm: () => Promise<void>;
}

export interface SosIncidentCluster {
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

export interface SosClusterHourlyBucket {
  hour: number;
  verifiedCount: number;
  simulatedCount: number;
}

export interface SosClusterAnalyticsResponse {
  evaluatedAt: string;
  windowDays: number;
  radiusKm: number;
  center: { lat: number; lng: number } | null;
  totalVerifiedRecords: number;
  totalSimulatedRecords: number;
  clusters: SosIncidentCluster[];
  hourlyDistribution: SosClusterHourlyBucket[];
  privacyNotice: string;
}

export interface MonitoringSnapshot {
  timestamp: string;
  uptimeSeconds: number;
  nodeVersion: string;
  process: {
    rssMb: number;
    heapUsedMb: number;
    heapTotalMb: number;
    cpuPercent: number;
    eventLoopLagMs: number;
  };
  http: {
    inFlight: number;
    totalRequests: number;
    rpsLast60s: number;
    error5xxCount: number;
    errorRatePercent: number;
    rateLimited429Count: number;
    overload503Count: number;
    avgLatencyMs: number;
    p50LatencyMs: number;
    p95LatencyMs: number;
    p99LatencyMs: number;
  };
  database: {
    dialect: string;
    ok: boolean;
    healthLatencyMs: number;
    avgQueryLatencyMs: number;
    p95QueryLatencyMs: number;
    slowQueryCount: number;
    slowestQueryMs: number;
    pool: {
      totalCount: number;
      idleCount: number;
      waitingCount: number;
      maxConnections: number;
    };
  };
  webVitals: {
    sampleCount: number;
    lcpP75Ms: number;
    inpP75Ms: number;
    clsP75: number;
    ttfbP75Ms: number;
    lastReportedAt: string | null;
  };
  websockets: {
    realtimeActive: number;
    liveVoiceActive: number;
    maxRealtimeCapacity: number;
    maxLiveCapacity: number;
    rateLimitedMessages: number;
    pubsubMode: 'redis' | 'local';
  };
  cacheAndQueue: {
    backend: 'redis' | 'memory';
    redisConnected: boolean;
    cacheHits: number;
    cacheMisses: number;
    cacheHitRatePercent: number;
    queueDepth: number;
    activeWorkers: number;
    completedJobs: number;
    failedJobs: number;
    retriedJobs: number;
  };
  ai: {
    configured: boolean;
    circuitState: 'closed' | 'open' | 'half-open';
    inFlight: number;
    maxConcurrency: number;
    totalCalls: number;
    fallbackCalls: number;
    quotaExceededCount: number;
    avgLatencyMs: number;
  };
  sos: {
    totalCreated: number;
    deduplicatedCount: number;
    externalConfirmed: number;
    externalFailed: number;
    lastDeliveryAt: string | null;
  };
  alerts: Array<{
    id: string;
    severity: 'warning' | 'critical';
    title: string;
    message: string;
    value: string;
    threshold: string;
    triggeredAt: string;
  }>;
}

