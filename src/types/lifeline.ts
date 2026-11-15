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

export type ActiveView = 'landing' | 'dashboard' | 'pulse' | 'map' | 'agents' | 'operator' | 'profile';

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
