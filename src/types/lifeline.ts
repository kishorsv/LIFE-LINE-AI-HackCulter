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
    byCategory: { name: string; count: number }[];
  };
  demoStats: {
    total: number;
    active: number;
    resolved: number;
    avgAckSeconds: number | null;
    byCategory: { name: string; count: number }[];
  };
  resourceDistribution: { category: string; count: number }[];
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

export type ActiveView = 'landing' | 'dashboard' | 'map' | 'agents' | 'operator' | 'profile';

export interface WorkspaceConfirmPayload {
  actionType: 'gmail_send' | 'calendar_checkin' | 'sheets_export' | 'docs_safety_plan' | 'drive_backup' | 'tasks_create';
  title: string;
  description: string;
  details: string[];
  onConfirm: () => Promise<void>;
}
