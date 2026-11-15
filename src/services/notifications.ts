import { createNotification, logDeliveryAttempt } from '../db/repository.ts';

// Simple per-user sliding window rate limiter for notifications (max 10 dispatches per minute)
const rateBuckets = new Map<number, number[]>();

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

async function sendWithRetry(fn: () => Promise<string>, maxAttempts = 2): Promise<{ ok: boolean; id?: string; error?: string; attempts: number }> {
  let attempts = 0;
  let lastError = '';
  while (attempts < maxAttempts) {
    attempts++;
    try {
      const id = await fn();
      return { ok: true, id, attempts };
    } catch (err) {
      lastError = err instanceof Error ? err.message : String(err);
      await new Promise((r) => setTimeout(r, 400 * attempts));
    }
  }
  return { ok: false, error: lastError, attempts };
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
}) {
  if (!checkNotificationRateLimit(input.senderUserId)) {
    throw new Error('Notification rate limit exceeded. Please wait briefly before re-sending.');
  }

  const mapCoordsUrl =
    input.latitude != null && input.longitude != null
      ? `https://www.google.com/maps/search/?api=1&query=${input.latitude},${input.longitude}`
      : 'Coordinates unavailable';

  const deliveryResults: Array<{ recipient: string; channel: string; status: string; provider: string }> = [];

  // 1. In-app confirmation notification to user
  const userNotifId = await createNotification({
    userId: input.senderUserId,
    incidentId: input.incidentId,
    channel: 'in_app',
    title: input.isSimulated ? 'Simulated SOS Dispatched (Demo)' : 'Emergency Alert Sent',
    message: `Incident #${input.incidentId} recorded at ${input.locationLabel}. Trusted contacts and platform operators notified.`,
    category: 'sos',
    isSimulated: input.isSimulated,
  });
  input.onRealtimeNotify?.(input.senderUserId, { type: 'notification:new', id: userNotifId });

  // 2. Notify operators in-app
  for (const opId of input.operatorUserIds ?? []) {
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

  // 3. Notify Trusted Contacts
  for (const contact of input.contacts) {
    if (contact.notifyEmail && contact.email) {
      if (input.isSimulated) {
        await logDeliveryAttempt({
          notificationId: userNotifId,
          incidentId: input.incidentId,
          recipient: contact.email,
          channel: 'email',
          provider: 'demo_sandbox',
          status: 'simulated',
          attemptCount: 1,
        });
        deliveryResults.push({ recipient: contact.email, channel: 'email', status: 'simulated', provider: 'demo_sandbox' });
      } else if (input.googleAccessToken) {
        const subject = `[LIFE-LINE AI SOS] Urgent Safety Alert for Check-In`;
        const body = `A LIFE-LINE AI SOS alert was triggered.\n\nIncident: ${input.incidentTitle}\nLocation: ${input.locationLabel}\nMap Link: ${mapCoordsUrl}\n\nNote: This is an automated safety notification from a trusted user. Please try reaching them directly or contact local emergency services if warranted.`;
        const raw = encodeGmailMessage(contact.email, subject, body);
        const result = await sendWithRetry(async () => {
          const resp = await fetch('https://gmail.googleapis.com/gmail/v1/users/me/messages/send', {
            method: 'POST',
            headers: {
              Authorization: `Bearer ${input.googleAccessToken}`,
              'Content-Type': 'application/json',
            },
            body: JSON.stringify({ raw }),
          });
          if (!resp.ok) throw new Error(`Gmail API ${resp.status}`);
          const data = (await resp.json()) as { id?: string };
          return data.id || 'gmail-sent';
        });
        await logDeliveryAttempt({
          notificationId: userNotifId,
          incidentId: input.incidentId,
          recipient: contact.email,
          channel: 'email',
          provider: 'gmail_workspace',
          status: result.ok ? 'sent' : 'failed',
          attemptCount: result.attempts,
          errorMessage: result.error,
          externalMessageId: result.id,
        });
        deliveryResults.push({
          recipient: contact.email,
          channel: 'email',
          status: result.ok ? 'sent' : 'failed',
          provider: 'gmail_workspace',
        });
      } else if (process.env.RESEND_API_KEY) {
        const result = await sendWithRetry(async () => {
          const resp = await fetch('https://api.resend.com/emails', {
            method: 'POST',
            headers: {
              Authorization: `Bearer ${process.env.RESEND_API_KEY}`,
              'Content-Type': 'application/json',
            },
            body: JSON.stringify({
              from: 'LIFE-LINE AI <alerts@lifeline-ai.app>',
              to: [contact.email],
              subject: `[LIFE-LINE AI SOS] Safety Check-In Needed`,
              text: `SOS Incident #${input.incidentId}: ${input.incidentTitle}\nLocation: ${input.locationLabel}\nMap: ${mapCoordsUrl}`,
            }),
          });
          if (!resp.ok) throw new Error(`Resend ${resp.status}`);
          const data = (await resp.json()) as { id?: string };
          return data.id || 'resend-sent';
        });
        await logDeliveryAttempt({
          notificationId: userNotifId,
          incidentId: input.incidentId,
          recipient: contact.email,
          channel: 'email',
          provider: 'resend',
          status: result.ok ? 'sent' : 'failed',
          attemptCount: result.attempts,
          errorMessage: result.error,
          externalMessageId: result.id,
        });
        deliveryResults.push({
          recipient: contact.email,
          channel: 'email',
          status: result.ok ? 'sent' : 'failed',
          provider: 'resend',
        });
      } else {
        await logDeliveryAttempt({
          notificationId: userNotifId,
          incidentId: input.incidentId,
          recipient: contact.email,
          channel: 'email',
          provider: 'in_app_fallback',
          status: 'provider_not_configured',
          attemptCount: 1,
          errorMessage: 'Connect Google Workspace Gmail or configure RESEND_API_KEY for external email delivery.',
        });
        deliveryResults.push({
          recipient: contact.email,
          channel: 'email',
          status: 'provider_not_configured',
          provider: 'in_app_fallback',
        });
      }
    }

    if (contact.notifySms && contact.phone) {
      if (input.isSimulated) {
        await logDeliveryAttempt({
          notificationId: userNotifId,
          incidentId: input.incidentId,
          recipient: contact.phone,
          channel: 'sms',
          provider: 'demo_sandbox',
          status: 'simulated',
          attemptCount: 1,
        });
        deliveryResults.push({ recipient: contact.phone, channel: 'sms', status: 'simulated', provider: 'demo_sandbox' });
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
          const resp = await fetch(`https://api.twilio.com/2010-04-01/Accounts/${sid}/Messages.json`, {
            method: 'POST',
            headers: {
              Authorization: `Basic ${Buffer.from(`${sid}:${token}`).toString('base64')}`,
              'Content-Type': 'application/x-www-form-urlencoded',
            },
            body: params.toString(),
          });
          if (!resp.ok) throw new Error(`Twilio ${resp.status}`);
          const data = (await resp.json()) as { sid?: string };
          return data.sid || 'twilio-sent';
        });
        await logDeliveryAttempt({
          notificationId: userNotifId,
          incidentId: input.incidentId,
          recipient: contact.phone,
          channel: 'sms',
          provider: 'twilio',
          status: result.ok ? 'sent' : 'failed',
          attemptCount: result.attempts,
          errorMessage: result.error,
          externalMessageId: result.id,
        });
        deliveryResults.push({
          recipient: contact.phone,
          channel: 'sms',
          status: result.ok ? 'sent' : 'failed',
          provider: 'twilio',
        });
      } else {
        await logDeliveryAttempt({
          notificationId: userNotifId,
          incidentId: input.incidentId,
          recipient: contact.phone,
          channel: 'sms',
          provider: 'unconfigured',
          status: 'provider_not_configured',
          attemptCount: 1,
          errorMessage: 'Configure TWILIO_* env vars to enable real SMS dispatch.',
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

  return deliveryResults;
}
