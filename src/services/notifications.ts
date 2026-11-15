import { createNotification, DeliveryState, logDeliveryAttempt } from '../db/repository.ts';

// Per-user sliding window rate limiter for notifications (max 10 dispatches per minute)
const rateBuckets = new Map<number, number[]>();

export function resetNotificationRateLimits() {
  rateBuckets.clear();
}

export function checkNotificationRateLimit(userId: number): boolean {
  const now = Date.now();
  const windowMs = 60_000;
  const timestamps = (rateBuckets.get(userId) || []).filter((t) => now - t < windowMs);
  if (timestamps.length >= 10) return false;
  timestamps.push(now);
  rateBuckets.set(userId, timestamps);
  return true;
}

function encodeGmailMessage(to: string, subject: string, body: string): string {
  const lines = [
    `To: ${to}`,
    'Content-Type: text/plain; charset="UTF-8"',
    'MIME-Version: 1.0',
    `Subject: ${subject}`,
    '',
    body,
  ];
  return Buffer.from(lines.join('\r\n')).toString('base64url');
}

async function sendWithRetry(
  fn: () => Promise<string>,
  maxAttempts = 2
): Promise<{ ok: boolean; id?: string; error?: string; attempts: number }> {
  let attempts = 0;
  let lastError = '';
  while (attempts < maxAttempts) {
    attempts++;
    try {
      const id = await fn();
      return { ok: true, id, attempts };
    } catch (err) {
      lastError = err instanceof Error ? err.message : String(err);
      if (attempts < maxAttempts) {
        await new Promise((r) => setTimeout(r, 300 * attempts));
      }
    }
  }
  return { ok: false, error: lastError, attempts };
}

export interface DeliveryAttemptResult {
  recipient: string;
  channel: string;
  status: 'delivered' | 'failed' | 'provider_not_configured' | 'simulated' | 'submitted';
  provider: string;
  error?: string;
}

export interface DispatchSummary {
  overallDeliveryState: DeliveryState;
  operatorRecorded: boolean;
  externalConfirmedCount: number;
  externalFailedCount: number;
  externalUnconfiguredCount: number;
  truthfulMessage: string;
  deliveryResults: DeliveryAttemptResult[];
}

export async function dispatchEmergencyNotifications(input: {
  senderUserId: number;
  incidentId: number;
  incidentTitle: string;
  locationLabel: string;
  latitude: number | null;
  longitude: number | null;
  isSimulated: boolean;
  contacts: Array<{ id: number; name: string; email: string; phone: string; notifyEmail: boolean; notifySms: boolean }>;
  googleAccessToken?: string;
  operatorUserIds?: number[];
  onRealtimeNotify?: (userId: number, payload: Record<string, unknown>) => void;
  fetchImpl?: typeof fetch;
}): Promise<DispatchSummary> {
  if (!checkNotificationRateLimit(input.senderUserId)) {
    throw new Error('Notification rate limit exceeded. Please wait briefly before re-sending.');
  }

  const doFetch = input.fetchImpl || fetch;
  const mapCoordsUrl =
    input.latitude != null && input.longitude != null
      ? `https://www.google.com/maps/search/?api=1&query=${input.latitude},${input.longitude}`
      : 'Coordinates unavailable';

  const deliveryResults: DeliveryAttemptResult[] = [];

  // 1. Notify Trusted Contacts first so the in-app confirmation accurately reflects real provider results
  let externalConfirmedCount = 0;
  let externalFailedCount = 0;
  let externalUnconfiguredCount = 0;

  for (const contact of input.contacts) {
    if (contact.notifyEmail && contact.email) {
      if (input.isSimulated) {
        await logDeliveryAttempt({
          incidentId: input.incidentId,
          recipient: contact.email,
          channel: 'email',
          provider: 'demo_sandbox',
          status: 'simulated',
          attemptCount: 1,
        });
        deliveryResults.push({
          recipient: contact.email,
          channel: 'email',
          status: 'simulated',
          provider: 'demo_sandbox',
        });
      } else if (input.googleAccessToken) {
        const subject = `[LIFE-LINE AI SOS] Urgent Safety Alert for Check-In`;
        const body = `A LIFE-LINE AI SOS alert was triggered.\n\nIncident: ${input.incidentTitle}\nLocation: ${input.locationLabel}\nMap Link: ${mapCoordsUrl}\n\nNote: This is an automated safety notification from a trusted user. Please try reaching them directly or contact local emergency services if warranted.`;
        const raw = encodeGmailMessage(contact.email, subject, body);
        const result = await sendWithRetry(async () => {
          const resp = await doFetch('https://gmail.googleapis.com/gmail/v1/users/me/messages/send', {
            method: 'POST',
            headers: {
              Authorization: `Bearer ${input.googleAccessToken}`,
              'Content-Type': 'application/json',
            },
            body: JSON.stringify({ raw }),
            signal: AbortSignal.timeout(8000),
          });
          if (!resp.ok) throw new Error(`Gmail API HTTP ${resp.status}`);
          const data = (await resp.json()) as { id?: string };
          if (!data.id) throw new Error('Gmail API did not return message confirmation ID.');
          return data.id;
        });
        const status = result.ok ? 'delivered' : 'failed';
        if (result.ok) externalConfirmedCount++;
        else externalFailedCount++;
        await logDeliveryAttempt({
          incidentId: input.incidentId,
          recipient: contact.email,
          channel: 'email',
          provider: 'gmail_workspace',
          status,
          attemptCount: result.attempts,
          errorMessage: result.error,
          externalMessageId: result.id,
        });
        deliveryResults.push({
          recipient: contact.email,
          channel: 'email',
          status,
          provider: 'gmail_workspace',
          error: result.error,
        });
      } else if (process.env.RESEND_API_KEY) {
        const result = await sendWithRetry(async () => {
          const resp = await doFetch('https://api.resend.com/emails', {
            method: 'POST',
            headers: {
              Authorization: `Bearer ${process.env.RESEND_API_KEY}`,
              'Content-Type': 'application/json',
            },
            body: JSON.stringify({
              from: process.env.RESEND_FROM_EMAIL || 'LIFE-LINE AI <alerts@lifeline-ai.app>',
              to: [contact.email],
              subject: `[LIFE-LINE AI SOS] Safety Check-In Needed`,
              text: `SOS Incident #${input.incidentId}: ${input.incidentTitle}\nLocation: ${input.locationLabel}\nMap: ${mapCoordsUrl}`,
            }),
            signal: AbortSignal.timeout(8000),
          });
          if (!resp.ok) throw new Error(`Resend HTTP ${resp.status}`);
          const data = (await resp.json()) as { id?: string };
          if (!data.id) throw new Error('Resend API did not confirm message ID.');
          return data.id;
        });
        const status = result.ok ? 'delivered' : 'failed';
        if (result.ok) externalConfirmedCount++;
        else externalFailedCount++;
        await logDeliveryAttempt({
          incidentId: input.incidentId,
          recipient: contact.email,
          channel: 'email',
          provider: 'resend',
          status,
          attemptCount: result.attempts,
          errorMessage: result.error,
          externalMessageId: result.id,
        });
        deliveryResults.push({
          recipient: contact.email,
          channel: 'email',
          status,
          provider: 'resend',
          error: result.error,
        });
      } else {
        externalUnconfiguredCount++;
        await logDeliveryAttempt({
          incidentId: input.incidentId,
          recipient: contact.email,
          channel: 'email',
          provider: 'unconfigured',
          status: 'provider_not_configured',
          attemptCount: 1,
          errorMessage: 'No email provider active (connect Google Workspace Gmail or configure RESEND_API_KEY).',
        });
        deliveryResults.push({
          recipient: contact.email,
          channel: 'email',
          status: 'provider_not_configured',
          provider: 'unconfigured',
        });
      }
    }

    if (contact.notifySms && contact.phone) {
      if (input.isSimulated) {
        await logDeliveryAttempt({
          incidentId: input.incidentId,
          recipient: contact.phone,
          channel: 'sms',
          provider: 'demo_sandbox',
          status: 'simulated',
          attemptCount: 1,
        });
        deliveryResults.push({
          recipient: contact.phone,
          channel: 'sms',
          status: 'simulated',
          provider: 'demo_sandbox',
        });
      } else if (process.env.TWILIO_ACCOUNT_SID && process.env.TWILIO_AUTH_TOKEN && process.env.TWILIO_FROM_NUMBER) {
        const sid = process.env.TWILIO_ACCOUNT_SID;
        const token = process.env.TWILIO_AUTH_TOKEN;
        const from = process.env.TWILIO_FROM_NUMBER;
        const result = await sendWithRetry(async () => {
          const params = new URLSearchParams({
            To: contact.phone,
            From: from,
            Body: `LIFE-LINE AI SOS: ${input.incidentTitle} at ${input.locationLabel}. ${mapCoordsUrl}`,
          });
          const resp = await doFetch(`https://api.twilio.com/2010-04-01/Accounts/${sid}/Messages.json`, {
            method: 'POST',
            headers: {
              Authorization: `Basic ${Buffer.from(`${sid}:${token}`).toString('base64')}`,
              'Content-Type': 'application/x-www-form-urlencoded',
            },
            body: params.toString(),
            signal: AbortSignal.timeout(8000),
          });
          if (!resp.ok) throw new Error(`Twilio HTTP ${resp.status}`);
          const data = (await resp.json()) as { sid?: string };
          if (!data.sid) throw new Error('Twilio API did not confirm message SID.');
          return data.sid;
        });
        const status = result.ok ? 'delivered' : 'failed';
        if (result.ok) externalConfirmedCount++;
        else externalFailedCount++;
        await logDeliveryAttempt({
          incidentId: input.incidentId,
          recipient: contact.phone,
          channel: 'sms',
          provider: 'twilio',
          status,
          attemptCount: result.attempts,
          errorMessage: result.error,
          externalMessageId: result.id,
        });
        deliveryResults.push({
          recipient: contact.phone,
          channel: 'sms',
          status,
          provider: 'twilio',
          error: result.error,
        });
      } else {
        externalUnconfiguredCount++;
        await logDeliveryAttempt({
          incidentId: input.incidentId,
          recipient: contact.phone,
          channel: 'sms',
          provider: 'unconfigured',
          status: 'provider_not_configured',
          attemptCount: 1,
          errorMessage: 'Configure TWILIO_* environment variables to enable SMS delivery.',
        });
        deliveryResults.push({
          recipient: contact.phone,
          channel: 'sms',
          status: 'provider_not_configured',
          provider: 'unconfigured',
        });
      }
    }
  }

  // 2. Notify authorized operators in-app
  const operatorIds = input.operatorUserIds ?? [];
  for (const opId of operatorIds) {
    const opNotifId = await createNotification({
      userId: opId,
      incidentId: input.incidentId,
      channel: 'in_app',
      title: input.isSimulated ? `[SIMULATED] SOS #${input.incidentId}` : `Urgent SOS #${input.incidentId}`,
      message: `${input.incidentTitle} · Location: ${input.locationLabel}`,
      category: 'operator_alert',
      isSimulated: input.isSimulated,
    });
    input.onRealtimeNotify?.(opId, { type: 'notification:new', id: opNotifId });
  }

  // 3. Determine accurate delivery status & truthful message
  let overallDeliveryState: DeliveryState = 'submitted';
  let truthfulMessage = '';

  if (input.isSimulated) {
    overallDeliveryState = 'delivered';
    truthfulMessage = `Simulated Incident #${input.incidentId} recorded at ${input.locationLabel}. Demo sandbox alert logged (no external SMS/email sent).`;
  } else if (externalConfirmedCount > 0 && externalFailedCount === 0) {
    overallDeliveryState = 'delivered';
    truthfulMessage = `Incident #${input.incidentId} submitted to platform operators. Provider confirmed delivery to ${externalConfirmedCount} contact channel(s).`;
  } else if (externalConfirmedCount > 0 && externalFailedCount > 0) {
    overallDeliveryState = 'delivered';
    truthfulMessage = `Incident #${input.incidentId} submitted to platform operators. ${externalConfirmedCount} contact channel(s) confirmed delivered, ${externalFailedCount} failed.`;
  } else if (externalFailedCount > 0) {
    overallDeliveryState = 'failed';
    truthfulMessage = `Incident #${input.incidentId} recorded for platform operators, but external contact delivery failed (${externalFailedCount} error(s)). Call contacts or local emergency services directly.`;
  } else if (externalUnconfiguredCount > 0) {
    overallDeliveryState = 'submitted';
    truthfulMessage = `Incident #${input.incidentId} submitted to platform operators. External contact delivery could not be sent because no email/SMS provider is configured.`;
  } else {
    overallDeliveryState = 'submitted';
    truthfulMessage = `Incident #${input.incidentId} submitted to platform operators. No trusted contacts with active email/SMS channels configured.`;
  }

  // 4. In-app confirmation notification to user (reflecting truthful status)
  const userNotifId = await createNotification({
    userId: input.senderUserId,
    incidentId: input.incidentId,
    channel: 'in_app',
    title: input.isSimulated
      ? 'Simulated SOS Recorded (Demo)'
      : overallDeliveryState === 'delivered'
        ? 'SOS Submitted & Contact Delivery Confirmed'
        : overallDeliveryState === 'failed'
          ? 'SOS Recorded — External Contact Delivery Failed'
          : 'SOS Submitted to Operator Desk (External Delivery Unconfigured)',
    message: truthfulMessage,
    category: 'sos',
    isSimulated: input.isSimulated,
  });
  input.onRealtimeNotify?.(input.senderUserId, { type: 'notification:new', id: userNotifId });

  return {
    overallDeliveryState,
    operatorRecorded: operatorIds.length > 0,
    externalConfirmedCount,
    externalFailedCount,
    externalUnconfiguredCount,
    truthfulMessage,
    deliveryResults,
  };
}
