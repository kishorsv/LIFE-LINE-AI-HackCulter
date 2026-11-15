// Client-side Google Workspace API helpers using the in-memory OAuth Bearer access token.
// Every mutating action MUST be confirmed via WorkspaceConfirmModal before invocation.

function toBase64Url(input: string): string {
  const bytes = new TextEncoder().encode(input);
  let binary = '';
  for (let i = 0; i < bytes.length; i++) {
    binary += String.fromCharCode(bytes[i]);
  }
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

export interface ImportedGoogleContact {
  name: string;
  email: string;
  phone: string;
}

export async function importGoogleContacts(accessToken: string): Promise<ImportedGoogleContact[]> {
  const resp = await fetch(
    'https://people.googleapis.com/v1/people/me/connections?personFields=names,emailAddresses,phoneNumbers&pageSize=25',
    {
      headers: { Authorization: `Bearer ${accessToken}` },
    }
  );
  if (!resp.ok) {
    throw new Error(`Google Contacts returned status ${resp.status}. Please reconnect Google Workspace.`);
  }
  const data = (await resp.json()) as {
    connections?: Array<{
      names?: Array<{ displayName?: string }>;
      emailAddresses?: Array<{ value?: string }>;
      phoneNumbers?: Array<{ value?: string }>;
    }>;
  };
  return (data.connections || [])
    .map((c) => ({
      name: c.names?.[0]?.displayName || '',
      email: c.emailAddresses?.[0]?.value || '',
      phone: c.phoneNumbers?.[0]?.value || '',
    }))
    .filter((c) => c.name && (c.email || c.phone));
}

export async function fetchRecentSafetyEmails(accessToken: string): Promise<Array<{ id: string; snippet: string }>> {
  const listResp = await fetch(
    'https://gmail.googleapis.com/gmail/v1/users/me/messages?maxResults=5&q=' + encodeURIComponent('LIFE-LINE OR safety OR emergency'),
    { headers: { Authorization: `Bearer ${accessToken}` } }
  );
  if (!listResp.ok) throw new Error(`Gmail read returned ${listResp.status}`);
  const listData = (await listResp.json()) as { messages?: Array<{ id: string }> };
  const items: Array<{ id: string; snippet: string }> = [];
  for (const m of (listData.messages || []).slice(0, 4)) {
    const msgResp = await fetch(`https://gmail.googleapis.com/gmail/v1/users/me/messages/${m.id}?format=minimal`, {
      headers: { Authorization: `Bearer ${accessToken}` },
    });
    if (msgResp.ok) {
      const msg = (await msgResp.json()) as { id: string; snippet?: string };
      items.push({ id: msg.id, snippet: msg.snippet || '' });
    }
  }
  return items;
}

export async function sendEmergencyGmail(
  accessToken: string,
  to: string,
  subject: string,
  body: string
): Promise<{ id: string }> {
  const mime = [
    `To: ${to}`,
    'Content-Type: text/plain; charset="UTF-8"',
    'MIME-Version: 1.0',
    `Subject: ${subject}`,
    '',
    body,
  ].join('\r\n');

  const resp = await fetch('https://gmail.googleapis.com/gmail/v1/users/me/messages/send', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${accessToken}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ raw: toBase64Url(mime) }),
  });
  if (!resp.ok) throw new Error(`Gmail send failed (${resp.status}).`);
  return (await resp.json()) as { id: string };
}

export async function scheduleSafetyCheckInCalendar(
  accessToken: string,
  summary: string,
  description: string,
  minutesFromNow = 30
): Promise<{ htmlLink?: string; id: string }> {
  const start = new Date(Date.now() + minutesFromNow * 60_000);
  const end = new Date(start.getTime() + 15 * 60_000);
  const resp = await fetch('https://www.googleapis.com/calendar/v3/calendars/primary/events', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${accessToken}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      summary,
      description,
      start: { dateTime: start.toISOString() },
      end: { dateTime: end.toISOString() },
    }),
  });
  if (!resp.ok) throw new Error(`Google Calendar event creation failed (${resp.status}).`);
  return (await resp.json()) as { htmlLink?: string; id: string };
}

export async function exportIncidentSheet(
  accessToken: string,
  rows: Array<Array<string | number>>
): Promise<{ spreadsheetUrl: string }> {
  const createResp = await fetch('https://sheets.googleapis.com/v4/spreadsheets', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${accessToken}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      properties: { title: `LIFE-LINE AI Safety Log (${new Date().toISOString().slice(0, 10)})` },
    }),
  });
  if (!createResp.ok) throw new Error(`Google Sheets creation failed (${createResp.status}).`);
  const sheet = (await createResp.json()) as { spreadsheetId: string; spreadsheetUrl: string };

  await fetch(
    `https://sheets.googleapis.com/v4/spreadsheets/${sheet.spreadsheetId}/values/A1:append?valueInputOption=USER_ENTERED`,
    {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${accessToken}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ values: rows }),
    }
  );
  return { spreadsheetUrl: sheet.spreadsheetUrl };
}

export async function createSafetyPlanDoc(
  accessToken: string,
  title: string,
  content: string
): Promise<{ documentId: string; url: string }> {
  const resp = await fetch('https://docs.googleapis.com/v1/documents', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${accessToken}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ title }),
  });
  if (!resp.ok) throw new Error(`Google Docs creation failed (${resp.status}).`);
  const doc = (await resp.json()) as { documentId: string };

  await fetch(`https://docs.googleapis.com/v1/documents/${doc.documentId}:batchUpdate`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${accessToken}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      requests: [{ insertText: { location: { index: 1 }, text: content } }],
    }),
  });

  return {
    documentId: doc.documentId,
    url: `https://docs.google.com/document/d/${doc.documentId}/edit`,
  };
}

export async function saveReportToDrive(
  accessToken: string,
  fileName: string,
  jsonContent: string
): Promise<{ id: string }> {
  const boundary = 'lifeline_ai_boundary_9921';
  const metadata = JSON.stringify({ name: fileName, mimeType: 'application/json' });
  const body =
    `--${boundary}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n${metadata}\r\n` +
    `--${boundary}\r\nContent-Type: application/json\r\n\r\n${jsonContent}\r\n--${boundary}--`;

  const resp = await fetch('https://www.googleapis.com/upload/drive/v3/files?uploadType=multipart', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${accessToken}`,
      'Content-Type': `multipart/related; boundary=${boundary}`,
    },
    body,
  });
  if (!resp.ok) throw new Error(`Google Drive upload failed (${resp.status}).`);
  return (await resp.json()) as { id: string };
}

export async function createSafetyActionTask(
  accessToken: string,
  title: string,
  notes: string
): Promise<{ id: string }> {
  const resp = await fetch('https://tasks.googleapis.com/tasks/v1/lists/@default/tasks', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${accessToken}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ title, notes }),
  });
  if (!resp.ok) throw new Error(`Google Tasks creation failed (${resp.status}).`);
  return (await resp.json()) as { id: string };
}
