import { relations } from 'drizzle-orm';
import {
  boolean,
  doublePrecision,
  index,
  integer,
  jsonb,
  pgTable,
  serial,
  text,
  timestamp,
  uniqueIndex,
} from 'drizzle-orm/pg-core';

// 0. schema_migrations
export const schemaMigrations = pgTable('schema_migrations', {
  version: text('version').primaryKey(),
  appliedAt: timestamp('applied_at').defaultNow().notNull(),
});

// 1. users
export const users = pgTable(
  'users',
  {
    id: serial('id').primaryKey(),
    uid: text('uid').notNull().unique(),
    email: text('email').notNull(),
    displayName: text('display_name').notNull().default(''),
    role: text('role').notNull().default('regular_user'),
    passwordHash: text('password_hash').notNull().default(''),
    emailVerified: boolean('email_verified').notNull().default(false),
    verificationCodeHash: text('verification_code_hash').notNull().default(''),
    verificationCodeExpiresAt: timestamp('verification_code_expires_at'),
    verificationAttempts: integer('verification_attempts').notNull().default(0),
    resetCodeHash: text('reset_code_hash').notNull().default(''),
    resetCodeExpiresAt: timestamp('reset_code_expires_at'),
    resetAttempts: integer('reset_attempts').notNull().default(0),
    isDemoAccount: boolean('is_demo_account').notNull().default(false),
    responderStatus: text('responder_status').notNull().default('Available'),
    responderUpdatedAt: timestamp('responder_updated_at').defaultNow().notNull(),
    createdAt: timestamp('created_at').defaultNow().notNull(),
    updatedAt: timestamp('updated_at').defaultNow().notNull(),
  },
  (table) => [index('users_email_idx').on(table.email)]
);

// 2. user_profiles
export const userProfiles = pgTable('user_profiles', {
  id: serial('id').primaryKey(),
  userId: integer('user_id')
    .references(() => users.id, { onDelete: 'cascade' })
    .notNull()
    .unique(),
  fullName: text('full_name').notNull().default(''),
  phone: text('phone').notNull().default(''),
  avatarUrl: text('avatar_url').notNull().default(''),
  emergencyNotes: text('emergency_notes').notNull().default(''),
  medicalNotes: text('medical_notes').notNull().default(''),
  bloodType: text('blood_type').notNull().default(''),
  preferredLanguage: text('preferred_language').notNull().default('en'),
  safetyStatus: text('safety_status').notNull().default('Safe'),
  lastKnownLat: doublePrecision('last_known_lat'),
  lastKnownLng: doublePrecision('last_known_lng'),
  lastLocationLabel: text('last_location_label').notNull().default(''),
  locationSharingConsent: boolean('location_sharing_consent').notNull().default(false),
  createdAt: timestamp('created_at').defaultNow().notNull(),
  updatedAt: timestamp('updated_at').defaultNow().notNull(),
});

// 3. trusted_contacts
export const trustedContacts = pgTable(
  'trusted_contacts',
  {
    id: serial('id').primaryKey(),
    userId: integer('user_id')
      .references(() => users.id, { onDelete: 'cascade' })
      .notNull(),
    name: text('name').notNull(),
    relationship: text('relationship').notNull().default('Trusted Contact'),
    email: text('email').notNull().default(''),
    phone: text('phone').notNull().default(''),
    notifyEmail: boolean('notify_email').notNull().default(true),
    notifySms: boolean('notify_sms').notNull().default(false),
    notifyWhatsapp: boolean('notify_whatsapp').notNull().default(false),
    priorityOrder: integer('priority_order').notNull().default(1),
    isVerified: boolean('is_verified').notNull().default(false),
    source: text('source').notNull().default('manual'),
    createdAt: timestamp('created_at').defaultNow().notNull(),
    updatedAt: timestamp('updated_at').defaultNow().notNull(),
  },
  (table) => [index('trusted_contacts_user_idx').on(table.userId)]
);

// 4. emergency_incidents
export const emergencyIncidents = pgTable(
  'emergency_incidents',
  {
    id: serial('id').primaryKey(),
    userId: integer('user_id')
      .references(() => users.id, { onDelete: 'cascade' })
      .notNull(),
    idempotencyKey: text('idempotency_key'),
    clientQueuedAt: timestamp('client_queued_at'),
    deliveryStatus: text('delivery_status').notNull().default('submitted'),
    title: text('title').notNull(),
    description: text('description').notNull().default(''),
    category: text('category').notNull().default('Personal Safety'),
    status: text('status').notNull().default('SOS Activated'),
    priority: text('priority').notNull().default('HIGH'),
    latitude: doublePrecision('latitude'),
    longitude: doublePrecision('longitude'),
    locationLabel: text('location_label').notNull().default('Location pending'),
    locationAccuracyMeters: integer('location_accuracy_meters'),
    isSimulated: boolean('is_simulated').notNull().default(false),
    acknowledgedByUserId: integer('acknowledged_by_user_id').references(() => users.id, {
      onDelete: 'set null',
    }),
    acknowledgedAt: timestamp('acknowledged_at'),
    resolvedAt: timestamp('resolved_at'),
    createdAt: timestamp('created_at').defaultNow().notNull(),
    updatedAt: timestamp('updated_at').defaultNow().notNull(),
  },
  (table) => [
    index('incidents_user_idx').on(table.userId),
    index('incidents_status_idx').on(table.status),
    index('incidents_created_idx').on(table.createdAt),
    index('incidents_user_created_idx').on(table.userId, table.createdAt),
    index('incidents_sim_status_created_idx').on(table.isSimulated, table.status, table.createdAt),
    uniqueIndex('incidents_user_idempotency_idx').on(table.userId, table.idempotencyKey),
  ]
);

// 5. incident_updates
export const incidentUpdates = pgTable(
  'incident_updates',
  {
    id: serial('id').primaryKey(),
    incidentId: integer('incident_id')
      .references(() => emergencyIncidents.id, { onDelete: 'cascade' })
      .notNull(),
    authorUserId: integer('author_user_id').references(() => users.id, { onDelete: 'set null' }),
    authorRole: text('author_role').notNull().default('system'),
    previousStatus: text('previous_status').notNull().default(''),
    newStatus: text('new_status').notNull(),
    note: text('note').notNull().default(''),
    isInternal: boolean('is_internal').notNull().default(false),
    createdAt: timestamp('created_at').defaultNow().notNull(),
  },
  (table) => [index('incident_updates_incident_idx').on(table.incidentId)]
);

// 6. incident_assignments
export const incidentAssignments = pgTable(
  'incident_assignments',
  {
    id: serial('id').primaryKey(),
    incidentId: integer('incident_id')
      .references(() => emergencyIncidents.id, { onDelete: 'cascade' })
      .notNull(),
    operatorUserId: integer('operator_user_id')
      .references(() => users.id, { onDelete: 'cascade' })
      .notNull(),
    assignedByUserId: integer('assigned_by_user_id').references(() => users.id, {
      onDelete: 'set null',
    }),
    status: text('status').notNull().default('active'),
    assignedAt: timestamp('assigned_at').defaultNow().notNull(),
    completedAt: timestamp('completed_at'),
  },
  (table) => [index('incident_assignments_incident_idx').on(table.incidentId)]
);

// 7. support_organizations
export const supportOrganizations = pgTable('support_organizations', {
  id: serial('id').primaryKey(),
  name: text('name').notNull(),
  category: text('category').notNull(),
  phone: text('phone').notNull().default(''),
  website: text('website').notNull().default(''),
  email: text('email').notNull().default(''),
  verificationStatus: text('verification_status').notNull().default('Sample Directory'),
  source: text('source').notNull().default('LIFE-LINE Verified Demo Registry'),
  isSampleData: boolean('is_sample_data').notNull().default(true),
  lastVerifiedAt: timestamp('last_verified_at').defaultNow().notNull(),
  createdAt: timestamp('created_at').defaultNow().notNull(),
  updatedAt: timestamp('updated_at').defaultNow().notNull(),
});

// 8. support_locations
export const supportLocations = pgTable(
  'support_locations',
  {
    id: serial('id').primaryKey(),
    organizationId: integer('organization_id')
      .references(() => supportOrganizations.id, { onDelete: 'cascade' })
      .notNull(),
    address: text('address').notNull(),
    city: text('city').notNull().default(''),
    region: text('region').notNull().default(''),
    latitude: doublePrecision('latitude').notNull(),
    longitude: doublePrecision('longitude').notNull(),
    operatingHours: text('operating_hours').notNull().default('24/7'),
    is24Hours: boolean('is_24_hours').notNull().default(true),
    availabilityNote: text('availability_note').notNull().default('Confirm availability by phone'),
    googlePlaceId: text('google_place_id').notNull().default(''),
    lastUpdatedAt: timestamp('last_updated_at').defaultNow().notNull(),
    createdAt: timestamp('created_at').defaultNow().notNull(),
  },
  (table) => [index('support_locations_org_idx').on(table.organizationId)]
);

// 9. notifications
export const notifications = pgTable(
  'notifications',
  {
    id: serial('id').primaryKey(),
    userId: integer('user_id')
      .references(() => users.id, { onDelete: 'cascade' })
      .notNull(),
    incidentId: integer('incident_id').references(() => emergencyIncidents.id, {
      onDelete: 'set null',
    }),
    channel: text('channel').notNull().default('in_app'),
    title: text('title').notNull(),
    message: text('message').notNull(),
    category: text('category').notNull().default('safety'),
    isRead: boolean('is_read').notNull().default(false),
    isSimulated: boolean('is_simulated').notNull().default(false),
    createdAt: timestamp('created_at').defaultNow().notNull(),
  },
  (table) => [
    index('notifications_user_idx').on(table.userId),
    index('notifications_user_read_created_idx').on(table.userId, table.isRead, table.createdAt),
  ]
);

// 10. notification_delivery_logs
export const notificationDeliveryLogs = pgTable(
  'notification_delivery_logs',
  {
    id: serial('id').primaryKey(),
    notificationId: integer('notification_id').references(() => notifications.id, {
      onDelete: 'set null',
    }),
    incidentId: integer('incident_id').references(() => emergencyIncidents.id, {
      onDelete: 'cascade',
    }),
    recipient: text('recipient').notNull(),
    channel: text('channel').notNull(),
    provider: text('provider').notNull().default('internal'),
    status: text('status').notNull().default('queued'),
    attemptCount: integer('attempt_count').notNull().default(1),
    errorMessage: text('error_message').notNull().default(''),
    externalMessageId: text('external_message_id').notNull().default(''),
    sentAt: timestamp('sent_at'),
    createdAt: timestamp('created_at').defaultNow().notNull(),
  },
  (table) => [index('delivery_logs_incident_idx').on(table.incidentId)]
);

// 11. ai_assessments
export const aiAssessments = pgTable(
  'ai_assessments',
  {
    id: serial('id').primaryKey(),
    incidentId: integer('incident_id').references(() => emergencyIncidents.id, {
      onDelete: 'cascade',
    }),
    userId: integer('user_id')
      .references(() => users.id, { onDelete: 'cascade' })
      .notNull(),
    agentName: text('agent_name').notNull(),
    modelUsed: text('model_used').notNull().default('gemini-4-hydrogen'),
    inputSummary: text('input_summary').notNull(),
    urgencyLevel: text('urgency_level').notNull().default('MEDIUM'),
    classification: text('classification').notNull().default('General Safety'),
    assignedPriority: text('assigned_priority').notNull().default('MEDIUM'),
    confidenceScore: doublePrecision('confidence_score').notNull().default(0.75),
    rationale: text('rationale').notNull(),
    missingInfoQuestions: jsonb('missing_info_questions').$type<string[]>().notNull().default([]),
    uncertaintyNotes: text('uncertainty_notes').notNull().default(''),
    escalateToHuman: boolean('escalate_to_human').notNull().default(false),
    rawStructuredOutput: jsonb('raw_structured_output').$type<Record<string, unknown>>().notNull().default({}),
    createdAt: timestamp('created_at').defaultNow().notNull(),
  },
  (table) => [index('ai_assessments_user_idx').on(table.userId)]
);

// 12. ai_recommendations
export const aiRecommendations = pgTable(
  'ai_recommendations',
  {
    id: serial('id').primaryKey(),
    assessmentId: integer('assessment_id').references(() => aiAssessments.id, {
      onDelete: 'cascade',
    }),
    userId: integer('user_id')
      .references(() => users.id, { onDelete: 'cascade' })
      .notNull(),
    incidentId: integer('incident_id').references(() => emergencyIncidents.id, {
      onDelete: 'set null',
    }),
    agentName: text('agent_name').notNull(),
    title: text('title').notNull(),
    recommendationText: text('recommendation_text').notNull(),
    category: text('category').notNull().default('Practical Safety'),
    confidence: doublePrecision('confidence').notNull().default(0.8),
    sourceCitation: text('source_citation').notNull().default('LIFE-LINE Safety Protocol'),
    actionRequiredAuth: boolean('action_required_auth').notNull().default(false),
    isCompleted: boolean('is_completed').notNull().default(false),
    createdAt: timestamp('created_at').defaultNow().notNull(),
  },
  (table) => [index('ai_recommendations_user_idx').on(table.userId)]
);

// 13. audit_logs
export const auditLogs = pgTable(
  'audit_logs',
  {
    id: serial('id').primaryKey(),
    actorUserId: integer('actor_user_id').references(() => users.id, { onDelete: 'set null' }),
    actorEmail: text('actor_email').notNull().default('system'),
    actorRole: text('actor_role').notNull().default('system'),
    action: text('action').notNull(),
    resourceType: text('resource_type').notNull(),
    resourceId: text('resource_id').notNull().default(''),
    details: jsonb('details').$type<Record<string, unknown>>().notNull().default({}),
    ipAddress: text('ip_address').notNull().default(''),
    createdAt: timestamp('created_at').defaultNow().notNull(),
  },
  (table) => [index('audit_logs_created_idx').on(table.createdAt)]
);

// 14. user_preferences
export const userPreferences = pgTable('user_preferences', {
  id: serial('id').primaryKey(),
  userId: integer('user_id')
    .references(() => users.id, { onDelete: 'cascade' })
    .notNull()
    .unique(),
  theme: text('theme').notNull().default('dark'),
  enableEmailAlerts: boolean('enable_email_alerts').notNull().default(true),
  enableSmsAlerts: boolean('enable_sms_alerts').notNull().default(false),
  enableInAppAlerts: boolean('enable_in_app_alerts').notNull().default(true),
  locationConsentMode: text('location_consent_mode').notNull().default('sos_only'),
  dataRetentionDays: integer('data_retention_days').notNull().default(90),
  demoModeEnabled: boolean('demo_mode_enabled').notNull().default(false),
  updatedAt: timestamp('updated_at').defaultNow().notNull(),
});

// 15. safety_journeys (LIFE-LINE PULSE SafeRoute & Journey Sharing)
export const safetyJourneys = pgTable(
  'safety_journeys',
  {
    id: serial('id').primaryKey(),
    userId: integer('user_id')
      .references(() => users.id, { onDelete: 'cascade' })
      .notNull(),
    originLabel: text('origin_label').notNull(),
    originLat: doublePrecision('origin_lat').notNull(),
    originLng: doublePrecision('origin_lng').notNull(),
    destinationLabel: text('destination_label').notNull(),
    destinationLat: doublePrecision('destination_lat').notNull(),
    destinationLng: doublePrecision('destination_lng').notNull(),
    travelMode: text('travel_mode').notNull().default('WALK'),
    selectedRouteSummary: text('selected_route_summary').notNull().default(''),
    routeRiskLevel: text('route_risk_level').notNull().default('LOW'),
    shareToken: text('share_token').notNull(),
    sharedWithContacts: jsonb('shared_with_contacts')
      .$type<Array<{ id?: number; name: string; email?: string }>>()
      .notNull()
      .default([]),
    checkInIntervalMinutes: integer('check_in_interval_minutes').notNull().default(15),
    expectedArrivalAt: timestamp('expected_arrival_at').notNull(),
    nextCheckInDueAt: timestamp('next_check_in_due_at').notNull(),
    lastCheckInAt: timestamp('last_check_in_at'),
    arrivedAt: timestamp('arrived_at'),
    status: text('status').notNull().default('Active'),
    isSimulated: boolean('is_simulated').notNull().default(false),
    createdAt: timestamp('created_at').defaultNow().notNull(),
    updatedAt: timestamp('updated_at').defaultNow().notNull(),
  },
  (table) => [
    index('safety_journeys_user_idx').on(table.userId),
    index('safety_journeys_status_idx').on(table.status),
  ]
);

// 16. safety_reports (Privacy-conscious safety observations for Predictive Risk Intelligence)
export const safetyReports = pgTable(
  'safety_reports',
  {
    id: serial('id').primaryKey(),
    userId: integer('user_id').references(() => users.id, { onDelete: 'set null' }),
    category: text('category').notNull(),
    severity: text('severity').notNull().default('MODERATE'),
    description: text('description').notNull(),
    latitude: doublePrecision('latitude').notNull(),
    longitude: doublePrecision('longitude').notNull(),
    locationLabel: text('location_label').notNull(),
    isAnonymous: boolean('is_anonymous').notNull().default(true),
    verificationStatus: text('verification_status').notNull().default('User Submitted'),
    isSimulated: boolean('is_simulated').notNull().default(false),
    createdAt: timestamp('created_at').defaultNow().notNull(),
  },
  (table) => [
    index('safety_reports_created_idx').on(table.createdAt),
    index('safety_reports_coords_idx').on(table.latitude, table.longitude),
    index('safety_reports_sim_created_idx').on(table.isSimulated, table.createdAt),
  ]
);

// 17. system_runtime_config (Shared CSPRNG cluster configuration)
export const systemRuntimeConfig = pgTable('system_runtime_config', {
  key: text('key').primaryKey(),
  value: text('value').notNull(),
  updatedAt: timestamp('updated_at').defaultNow().notNull(),
});

// 18. realtime_events (Persistent cross-instance WebSocket replay log)
export const realtimeEvents = pgTable(
  'realtime_events',
  {
    id: serial('id').primaryKey(),
    eventId: text('event_id').notNull().unique(),
    targetUserId: integer('target_user_id'),
    includeOperators: boolean('include_operators').notNull().default(false),
    userPayload: jsonb('user_payload').$type<Record<string, unknown>>().notNull(),
    operatorPayload: jsonb('operator_payload').$type<Record<string, unknown>>().notNull(),
    createdAt: timestamp('created_at').defaultNow().notNull(),
  },
  (table) => [index('realtime_events_target_idx').on(table.targetUserId, table.id)]
);

// 19. live_external_alerts (Standardized NDMA SACHET, IMD CAP, USGS & NASA FIRMS live alerts)
export const liveExternalAlerts = pgTable(
  'live_external_alerts',
  {
    id: serial('id').primaryKey(),
    externalKey: text('external_key').notNull().unique(),
    sourceId: text('source_id').notNull(),
    sourceName: text('source_name').notNull(),
    sourceUrl: text('source_url').notNull().default(''),
    category: text('category').notNull(),
    title: text('title').notNull(),
    description: text('description').notNull().default(''),
    instruction: text('instruction').notNull().default(''),
    severity: text('severity').notNull().default('MODERATE'),
    severityColor: text('severity_color').notNull().default('amber'),
    certainty: text('certainty').notNull().default('Observed'),
    verificationStatus: text('verification_status').notNull().default('Official Alert'),
    signalType: text('signal_type').notNull().default('official_alert'),
    locationLabel: text('location_label').notNull(),
    stateName: text('state_name').notNull().default(''),
    districtName: text('district_name').notNull().default(''),
    latitude: doublePrecision('latitude'),
    longitude: doublePrecision('longitude'),
    areaCoveredSqKm: doublePrecision('area_covered_sq_km'),
    language: text('language').notNull().default('en'),
    firstReportedAt: timestamp('first_reported_at').defaultNow().notNull(),
    effectiveFrom: timestamp('effective_from'),
    expiresAt: timestamp('expires_at'),
    lastUpdatedAt: timestamp('last_updated_at').defaultNow().notNull(),
    isActive: boolean('is_active').notNull().default(true),
    rawPayload: jsonb('raw_payload').$type<Record<string, unknown>>().notNull().default({}),
    createdAt: timestamp('created_at').defaultNow().notNull(),
    updatedAt: timestamp('updated_at').defaultNow().notNull(),
  },
  (table) => [
    index('live_alerts_active_updated_idx').on(table.isActive, table.lastUpdatedAt),
    index('live_alerts_state_district_idx').on(table.stateName, table.districtName),
    index('live_alerts_source_idx').on(table.sourceId, table.isActive),
  ]
);

// 20. live_feed_sync_runs (Connectivity, cooldowns & freshness telemetry per live feed source)
export const liveFeedSyncRuns = pgTable('live_feed_sync_runs', {
  sourceId: text('source_id').primaryKey(),
  sourceName: text('source_name').notNull(),
  sourceKind: text('source_kind').notNull().default('official_cap'),
  endpointUrl: text('endpoint_url').notNull(),
  status: text('status').notNull().default('offline'),
  pollIntervalSeconds: integer('poll_interval_seconds').notNull().default(180),
  lastAttemptAt: timestamp('last_attempt_at'),
  lastSuccessAt: timestamp('last_success_at'),
  lastError: text('last_error').notNull().default(''),
  recordsFetched: integer('records_fetched').notNull().default(0),
  recordsActive: integer('records_active').notNull().default(0),
  latencyMs: integer('latency_ms').notNull().default(0),
  updatedAt: timestamp('updated_at').defaultNow().notNull(),
});

// Drizzle Relations
export const usersRelations = relations(users, ({ one, many }) => ({
  profile: one(userProfiles, { fields: [users.id], references: [userProfiles.userId] }),
  preferences: one(userPreferences, { fields: [users.id], references: [userPreferences.userId] }),
  trustedContacts: many(trustedContacts),
  incidents: many(emergencyIncidents),
  notifications: many(notifications),
  aiAssessments: many(aiAssessments),
}));

export const emergencyIncidentsRelations = relations(emergencyIncidents, ({ one, many }) => ({
  reporter: one(users, { fields: [emergencyIncidents.userId], references: [users.id] }),
  updates: many(incidentUpdates),
  assignments: many(incidentAssignments),
  deliveryLogs: many(notificationDeliveryLogs),
  assessments: many(aiAssessments),
}));

export const supportOrganizationsRelations = relations(supportOrganizations, ({ many }) => ({
  locations: many(supportLocations),
}));

export const supportLocationsRelations = relations(supportLocations, ({ one }) => ({
  organization: one(supportOrganizations, {
    fields: [supportLocations.organizationId],
    references: [supportOrganizations.id],
  }),
}));
