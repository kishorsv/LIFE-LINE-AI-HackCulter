import { UpsertLiveExternalAlertInput } from '../db/repository.ts';
import {
  LiveAlertCategory,
  LiveAlertSeverity,
  LiveWeatherForecastPoint,
  MysuruWeatherIntel,
} from '../types/lifeline.ts';
import { cacheQueue } from './cacheQueue.ts';
import { describeWmoWeatherCode } from './pulse.ts';

export interface IndiaDistrictCentroid {
  name: string;
  state: string;
  lat: number;
  lng: number;
  aliases: string[];
}

export const INDIA_DISTRICT_CENTROIDS: IndiaDistrictCentroid[] = [
  { name: 'Mysuru', state: 'Karnataka', lat: 12.2958, lng: 76.6394, aliases: ['mysuru', 'mysore'] },
  { name: 'Bengaluru', state: 'Karnataka', lat: 12.9716, lng: 77.5946, aliases: ['bengaluru', 'bangalore', 'bengaluru urban'] },
  { name: 'Bengaluru Rural', state: 'Karnataka', lat: 13.2846, lng: 77.5956, aliases: ['bengaluru rural', 'bangalore rural'] },
  { name: 'Mandya', state: 'Karnataka', lat: 12.5218, lng: 76.8951, aliases: ['mandya'] },
  { name: 'Chamarajanagar', state: 'Karnataka', lat: 11.9261, lng: 76.9437, aliases: ['chamarajanagar', 'chamarajanagara'] },
  { name: 'Kodagu', state: 'Karnataka', lat: 12.4244, lng: 75.7382, aliases: ['kodagu', 'coorg', 'madikeri'] },
  { name: 'Hassan', state: 'Karnataka', lat: 13.0033, lng: 76.1004, aliases: ['hassan'] },
  { name: 'Mangaluru', state: 'Karnataka', lat: 12.9141, lng: 74.856, aliases: ['mangaluru', 'mangalore', 'dakshina kannada'] },
  { name: 'Udupi', state: 'Karnataka', lat: 13.3409, lng: 74.7421, aliases: ['udupi'] },
  { name: 'Uttara Kannada', state: 'Karnataka', lat: 14.8, lng: 74.13, aliases: ['uttara kannada', 'karwar'] },
  { name: 'Shivamogga', state: 'Karnataka', lat: 13.9299, lng: 75.5681, aliases: ['shivamogga', 'shimoga'] },
  { name: 'Chikkamagaluru', state: 'Karnataka', lat: 13.3161, lng: 75.772, aliases: ['chikkamagaluru', 'chikmagalur'] },
  { name: 'Tumakuru', state: 'Karnataka', lat: 13.3379, lng: 77.1173, aliases: ['tumakuru', 'tumkur'] },
  { name: 'Kolar', state: 'Karnataka', lat: 13.1362, lng: 78.1291, aliases: ['kolar'] },
  { name: 'Chikkaballapur', state: 'Karnataka', lat: 13.4355, lng: 77.7315, aliases: ['chikkaballapur', 'chikkaballapura'] },
  { name: 'Ramanagara', state: 'Karnataka', lat: 12.715, lng: 77.2814, aliases: ['ramanagara'] },
  { name: 'Davanagere', state: 'Karnataka', lat: 14.4644, lng: 75.9218, aliases: ['davanagere'] },
  { name: 'Chitradurga', state: 'Karnataka', lat: 14.2251, lng: 76.398, aliases: ['chitradurga'] },
  { name: 'Ballari', state: 'Karnataka', lat: 15.1394, lng: 76.9214, aliases: ['ballari', 'bellary', 'vijayanagara'] },
  { name: 'Belagavi', state: 'Karnataka', lat: 15.8497, lng: 74.4977, aliases: ['belagavi', 'belgaum'] },
  { name: 'Dharwad', state: 'Karnataka', lat: 15.4589, lng: 75.0078, aliases: ['dharwad', 'hubballi', 'hubli'] },
  { name: 'Kalaburagi', state: 'Karnataka', lat: 17.3297, lng: 76.8343, aliases: ['kalaburagi', 'gulbarga'] },
  { name: 'Bidar', state: 'Karnataka', lat: 17.9104, lng: 77.5199, aliases: ['bidar'] },
  { name: 'Raichur', state: 'Karnataka', lat: 16.212, lng: 77.3439, aliases: ['raichur'] },
  { name: 'Vijayapura', state: 'Karnataka', lat: 16.8302, lng: 75.71, aliases: ['vijayapura', 'bijapur'] },
  { name: 'Bagalkote', state: 'Karnataka', lat: 16.1691, lng: 75.6615, aliases: ['bagalkote', 'bagalkot'] },
  { name: 'Koppal', state: 'Karnataka', lat: 15.3505, lng: 76.1548, aliases: ['koppal'] },
  { name: 'Gadag', state: 'Karnataka', lat: 15.4315, lng: 75.6355, aliases: ['gadag'] },
  { name: 'Haveri', state: 'Karnataka', lat: 14.7951, lng: 75.3991, aliases: ['haveri'] },
  { name: 'Yadgir', state: 'Karnataka', lat: 16.77, lng: 77.1376, aliases: ['yadgir'] },
  { name: 'Chennai', state: 'Tamil Nadu', lat: 13.0827, lng: 80.2707, aliases: ['chennai'] },
  { name: 'Coimbatore', state: 'Tamil Nadu', lat: 11.0168, lng: 76.9558, aliases: ['coimbatore'] },
  { name: 'Kochi', state: 'Kerala', lat: 9.9312, lng: 76.2673, aliases: ['kochi', 'ernakulam'] },
  { name: 'Wayanad', state: 'Kerala', lat: 11.6854, lng: 76.132, aliases: ['wayanad'] },
  { name: 'Hyderabad', state: 'Telangana', lat: 17.385, lng: 78.4867, aliases: ['hyderabad'] },
  { name: 'Visakhapatnam', state: 'Andhra Pradesh', lat: 17.6868, lng: 83.2185, aliases: ['visakhapatnam', 'vizag'] },
  { name: 'Mumbai', state: 'Maharashtra', lat: 19.076, lng: 72.8777, aliases: ['mumbai'] },
  { name: 'Pune', state: 'Maharashtra', lat: 18.5204, lng: 73.8567, aliases: ['pune'] },
  { name: 'Delhi', state: 'Delhi', lat: 28.6139, lng: 77.209, aliases: ['delhi', 'new delhi'] },
  { name: 'Kolkata', state: 'West Bengal', lat: 22.5726, lng: 88.3639, aliases: ['kolkata'] },
  { name: 'Bhubaneswar', state: 'Odisha', lat: 20.2961, lng: 85.8245, aliases: ['bhubaneswar'] },
  { name: 'Guwahati', state: 'Assam', lat: 26.1445, lng: 91.7362, aliases: ['guwahati'] },
];

export const INDIA_STATE_CENTROIDS: Record<string, { lat: number; lng: number }> = {
  Karnataka: { lat: 15.3173, lng: 75.7139 },
  'Andhra Pradesh': { lat: 15.9129, lng: 79.74 },
  Telangana: { lat: 18.1124, lng: 79.0193 },
  'Tamil Nadu': { lat: 11.1271, lng: 78.6569 },
  Kerala: { lat: 10.8505, lng: 76.2711 },
  Maharashtra: { lat: 19.7515, lng: 75.7139 },
  Odisha: { lat: 20.9517, lng: 85.0985 },
  'West Bengal': { lat: 22.9868, lng: 87.855 },
  Jharkhand: { lat: 23.6102, lng: 85.2799 },
  Bihar: { lat: 25.0961, lng: 85.3131 },
  Assam: { lat: 26.2006, lng: 92.9376 },
  Gujarat: { lat: 22.2587, lng: 71.1924 },
  Rajasthan: { lat: 27.0238, lng: 74.2179 },
  'Uttar Pradesh': { lat: 26.8467, lng: 80.9462 },
  'Madhya Pradesh': { lat: 22.9734, lng: 78.6569 },
  'Himachal Pradesh': { lat: 31.1048, lng: 77.1734 },
  Uttarakhand: { lat: 30.0668, lng: 79.0193 },
  Delhi: { lat: 28.7041, lng: 77.1025 },
};

export function resolveIndiaDistrictCoordinates(text: string): {
  lat: number;
  lng: number;
  stateName: string;
  districtName: string;
  isDistrictCentroidFallback: boolean;
} | null {
  const lower = (text || '').toLowerCase();
  if (!lower) return null;

  for (const item of INDIA_DISTRICT_CENTROIDS) {
    if (item.aliases.some((alias) => lower.includes(alias))) {
      return {
        lat: item.lat,
        lng: item.lng,
        stateName: item.state,
        districtName: item.name,
        isDistrictCentroidFallback: true,
      };
    }
  }

  for (const [stateName, coords] of Object.entries(INDIA_STATE_CENTROIDS)) {
    if (lower.includes(stateName.toLowerCase())) {
      return {
        lat: coords.lat,
        lng: coords.lng,
        stateName,
        districtName: '',
        isDistrictCentroidFallback: true,
      };
    }
  }
  return null;
}

/**
 * NDMA SACHET emits timestamps such as "Wed Nov 18 17:10:00 IST 2026".
 * Node/V8 Date.parse on Linux may return NaN or mis-read "IST"; normalize IST to +0530.
 */
export function parseSachetTimestamp(raw: string | undefined | null): string | null {
  if (!raw || typeof raw !== 'string') return null;
  const trimmed = raw.trim();
  if (!trimmed) return null;

  // Handle "Wed Nov 18 17:10:00 IST 2026" -> move +0530 cleanly or replace IST with +0530
  const istMatch = trimmed.match(
    /^(?:[A-Za-z]{3},\s*|[A-Za-z]{3}\s+)?([A-Za-z]{3})\s+(\d{1,2})\s+(\d{2}:\d{2}:\d{2})\s+IST\s+(\d{4})$/i
  );
  if (istMatch) {
    const normalized = `${istMatch[2]} ${istMatch[1]} ${istMatch[4]} ${istMatch[3]} +0530`;
    const ms = Date.parse(normalized);
    if (Number.isFinite(ms)) return new Date(ms).toISOString();
  }

  const normalized = trimmed.replace(/\bIST\b/gi, '+0530');
  const ms = Date.parse(normalized);
  if (Number.isFinite(ms)) return new Date(ms).toISOString();
  return null;
}

/**
 * NDMA SACHET `centroid` is ordered "longitude,latitude" (e.g. "82.541112,18.044453").
 */
export function parseSachetCentroidLngLat(
  rawCentroid: string | undefined | null
): { lat: number; lng: number } | null {
  if (!rawCentroid || typeof rawCentroid !== 'string') return null;
  const parts = rawCentroid
    .split(',')
    .map((p) => Number(p.trim()))
    .filter((n) => Number.isFinite(n));
  if (parts.length < 2) return null;

  const [lng, lat] = parts;
  if (lat < -90 || lat > 90 || lng < -180 || lng > 180) return null;
  if (lat === 0 && lng === 0) return null;
  return { lat, lng };
}

export function mapDisasterCategory(rawType: string, textContext = ''): LiveAlertCategory {
  const hay = `${rawType} ${textContext}`.toLowerCase();
  if (hay.includes('cyclone') || hay.includes('depression') || hay.includes('gale')) return 'Cyclone';
  if (hay.includes('flood') || hay.includes('inundat') || hay.includes('waterlogging')) return 'Flooding';
  if (hay.includes('heavy rain') || hay.includes('very heavy rain') || hay.includes('rainfall')) return 'Heavy Rainfall';
  if (hay.includes('thunderstorm') || hay.includes('lightning') || hay.includes('squall')) {
    return 'Thunderstorm & Lightning';
  }
  if (hay.includes('heatwave') || hay.includes('heat wave') || hay.includes('extreme heat')) return 'Heatwave';
  if (hay.includes('fire') || hay.includes('forest fire') || hay.includes('wildfire') || hay.includes('thermal')) {
    return 'Fire';
  }
  if (hay.includes('earthquake') || hay.includes('seismic') || hay.includes('tremor')) return 'Earthquake';
  if (hay.includes('landslide') || hay.includes('road') || hay.includes('highway') || hay.includes('traffic')) {
    return 'Road Disruption';
  }
  if (hay.includes('water supply') || hay.includes('drinking water')) return 'Water Supply Emergency';
  return 'Other Verified Emergency';
}

export function mapSeverity(
  rawSeverity: string | undefined,
  rawColor?: string
): { severity: LiveAlertSeverity; color: string } {
  const sev = (rawSeverity || '').trim().toUpperCase();
  const col = (rawColor || '').trim().toLowerCase();
  if (sev === 'EXTREME' || sev === 'RED' || col === 'red') {
    return { severity: 'EXTREME', color: 'red' };
  }
  if (sev === 'SEVERE' || sev === 'ORANGE' || sev === 'ALERT' || col === 'orange') {
    return { severity: 'SEVERE', color: 'orange' };
  }
  if (sev === 'MODERATE' || sev === 'WATCH' || sev === 'YELLOW' || col === 'yellow' || col === 'amber') {
    return { severity: 'MODERATE', color: 'amber' };
  }
  if (sev === 'MINOR') {
    return { severity: 'MINOR', color: 'sky' };
  }
  return { severity: 'ADVISORY', color: col || 'slate' };
}

function decodeXmlEntities(input: string): string {
  return input
    .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;|&apos;/g, "'")
    .trim();
}

function extractXmlTag(block: string, tagName: string): string {
  const escaped = tagName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const match = block.match(new RegExp(`<(?:[a-z0-9_-]+:)?${escaped}(?:\\s[^>]*)?>([\\s\\S]*?)<\\/(?:[a-z0-9_-]+:)?${escaped}>`, 'i'));
  return match ? decodeXmlEntities(match[1]) : '';
}

export interface NdmaSachetJsonItem {
  identifier?: string | number;
  severity?: string;
  effective_start_time?: string;
  effective_end_time?: string;
  disaster_type?: string;
  area_description?: string;
  severity_level?: string;
  actual_lang?: string;
  warning_message?: string;
  severity_color?: string;
  centroid?: string;
  alert_source?: string;
  area_covered?: string | number;
}

export function parseNdmaSachetJsonAlerts(items: NdmaSachetJsonItem[], nowMs = Date.now()): UpsertLiveExternalAlertInput[] {
  const results: UpsertLiveExternalAlertInput[] = [];
  for (const item of items) {
    const idStr = String(item.identifier || '').trim();
    if (!idStr) continue;

    const parsedCentroid = parseSachetCentroidLngLat(item.centroid);
    const locationText = String(item.area_description || '').trim() || 'India';
    const fallbackGeo = resolveIndiaDistrictCoordinates(`${locationText} ${item.alert_source || ''}`);

    const latitude = parsedCentroid ? parsedCentroid.lat : fallbackGeo?.lat ?? null;
    const longitude = parsedCentroid ? parsedCentroid.lng : fallbackGeo?.lng ?? null;

    const effectiveFrom = parseSachetTimestamp(item.effective_start_time);
    const expiresAt = parseSachetTimestamp(item.effective_end_time);
    const nowIso = new Date(nowMs).toISOString();
    const expired = Boolean(expiresAt && Date.parse(expiresAt) <= nowMs);

    const category = mapDisasterCategory(String(item.disaster_type || ''), String(item.warning_message || ''));
    const { severity, color } = mapSeverity(item.severity_level || item.severity, item.severity_color);
    const sourceLabel = String(item.alert_source || '').trim();
    const areaSqKm = item.area_covered != null && Number.isFinite(Number(item.area_covered))
      ? Number(item.area_covered)
      : null;

    const warningMessage = String(item.warning_message || '').trim() || `${item.disaster_type || 'Alert'} issued for ${locationText}`;
    const title = `${item.disaster_type || category}: ${locationText}`.slice(0, 220);

    results.push({
      externalKey: `ndma-sachet:${idStr}`,
      sourceId: 'ndma-sachet-all',
      sourceName: sourceLabel ? `NDMA SACHET (${sourceLabel})` : 'NDMA SACHET',
      sourceUrl: `https://sachet.ndma.gov.in/cap_public_website/FetchXMLFile?identifier=${encodeURIComponent(idStr)}`,
      category,
      title,
      description: warningMessage,
      instruction: 'Follow official NDMA/SDMA/IMD instructions and avoid hazard-prone routes.',
      severity,
      severityColor: color,
      certainty: expired ? 'Past' : 'Observed',
      verificationStatus: expired ? 'Resolved Incident' : 'Official Alert',
      signalType: 'official_alert',
      locationLabel: locationText,
      stateName: fallbackGeo?.stateName || (sourceLabel.includes('SDMA') ? sourceLabel.replace(/\s*SDMA/i, '').trim() : ''),
      districtName: fallbackGeo?.districtName || '',
      latitude,
      longitude,
      areaCoveredSqKm: areaSqKm,
      language: String(item.actual_lang || 'en').slice(0, 12) || 'en',
      firstReportedAt: effectiveFrom || nowIso,
      effectiveFrom,
      expiresAt,
      lastUpdatedAt: nowIso,
      isActive: !expired,
      rawPayload: item as unknown as Record<string, unknown>,
    });
  }
  return results;
}

export async function fetchNdmaSachetAlerts(fetchImpl: typeof fetch = fetch): Promise<{
  alerts: UpsertLiveExternalAlertInput[];
  recordsFetched: number;
  endpointUrl: string;
}> {
  const endpointUrl = 'https://sachet.ndma.gov.in/cap_public_website/FetchAllAlertDetails';
  const resp = await fetchImpl(endpointUrl, {
    method: 'GET',
    headers: { Accept: 'application/json' },
    signal: AbortSignal.timeout(9000),
  });
  if (!resp.ok) {
    throw new Error(`NDMA SACHET API returned HTTP ${resp.status}`);
  }
  const raw = (await resp.json()) as unknown;
  const arr = Array.isArray(raw) ? (raw as NdmaSachetJsonItem[]) : [];
  const alerts = parseNdmaSachetJsonAlerts(arr);
  return { alerts, recordsFetched: arr.length, endpointUrl };
}

export interface RssFeedItem {
  guid: string;
  title: string;
  description: string;
  author: string;
  pubDate: string;
  link: string;
}

export function parseRssItems(xml: string): RssFeedItem[] {
  const items: RssFeedItem[] = [];
  const matches = xml.matchAll(/<item\b[^>]*>([\s\S]*?)<\/item>/gi);
  for (const m of matches) {
    const block = m[1];
    const guid = extractXmlTag(block, 'guid');
    const title = extractXmlTag(block, 'title');
    const description = extractXmlTag(block, 'description');
    const author = extractXmlTag(block, 'author');
    const pubDate = extractXmlTag(block, 'pubDate');
    const link = extractXmlTag(block, 'link');
    if (guid || link || title) {
      items.push({ guid, title, description, author, pubDate, link });
    }
  }
  return items;
}

export interface ParsedCapAlert {
  identifier: string;
  sender: string;
  sent: string;
  event: string;
  severity: string;
  certainty: string;
  effective: string;
  onset: string;
  expires: string;
  senderName: string;
  headline: string;
  description: string;
  instruction: string;
  areaDesc: string;
  polygonCentroid: { lat: number; lng: number } | null;
}

export function parseCapPolygonCentroid(polygonText: string): { lat: number; lng: number } | null {
  if (!polygonText) return null;
  const pairs = polygonText
    .trim()
    .split(/\s+/)
    .map((pair) => {
      const [latStr, lngStr] = pair.split(',');
      const lat = Number(latStr);
      const lng = Number(lngStr);
      return Number.isFinite(lat) && Number.isFinite(lng) && Math.abs(lat) <= 90 && Math.abs(lng) <= 180
        ? { lat, lng }
        : null;
    })
    .filter((p): p is { lat: number; lng: number } => Boolean(p));

  if (pairs.length === 0) return null;
  const lat = pairs.reduce((s, p) => s + p.lat, 0) / pairs.length;
  const lng = pairs.reduce((s, p) => s + p.lng, 0) / pairs.length;
  return { lat: Number(lat.toFixed(5)), lng: Number(lng.toFixed(5)) };
}

export function parseCapXml(xml: string): ParsedCapAlert {
  const polygonRaw = extractXmlTag(xml, 'polygon');
  return {
    identifier: extractXmlTag(xml, 'identifier'),
    sender: extractXmlTag(xml, 'sender'),
    sent: extractXmlTag(xml, 'sent'),
    event: extractXmlTag(xml, 'event'),
    severity: extractXmlTag(xml, 'severity'),
    certainty: extractXmlTag(xml, 'certainty'),
    effective: extractXmlTag(xml, 'effective'),
    onset: extractXmlTag(xml, 'onset'),
    expires: extractXmlTag(xml, 'expires'),
    senderName: extractXmlTag(xml, 'senderName'),
    headline: extractXmlTag(xml, 'headline'),
    description: extractXmlTag(xml, 'description'),
    instruction: extractXmlTag(xml, 'instruction'),
    areaDesc: extractXmlTag(xml, 'areaDesc'),
    polygonCentroid: parseCapPolygonCentroid(polygonRaw),
  };
}

export async function fetchNdmaKarnatakaRssAndCap(
  fetchImpl: typeof fetch = fetch,
  nowMs = Date.now()
): Promise<{
  alerts: UpsertLiveExternalAlertInput[];
  recordsFetched: number;
  endpointUrl: string;
}> {
  const endpointUrl = 'https://sachet.ndma.gov.in/cap_public_website/rss/rss_karnataka.xml';
  const rssResp = await fetchImpl(endpointUrl, {
    method: 'GET',
    headers: { Accept: 'application/xml, text/xml' },
    signal: AbortSignal.timeout(9000),
  });
  if (!rssResp.ok) {
    throw new Error(`NDMA Karnataka RSS returned HTTP ${rssResp.status}`);
  }
  const rssXml = await rssResp.text();
  const rssItems = parseRssItems(rssXml);
  const topItems = rssItems.slice(0, 6);

  const alerts: UpsertLiveExternalAlertInput[] = [];
  for (const item of topItems) {
    let cap: ParsedCapAlert | null = null;
    if (item.link) {
      try {
        const capResp = await fetchImpl(item.link, {
          method: 'GET',
          headers: { Accept: 'application/xml, text/xml' },
          signal: AbortSignal.timeout(6000),
        });
        if (capResp.ok) {
          const capXml = await capResp.text();
          cap = parseCapXml(capXml);
        }
      } catch {
        // Use RSS metadata if individual CAP XML fails
      }
    }

    const idFromGuid = (cap?.identifier || item.guid || item.link).replace(/^.*identifier=/, '').trim() || item.title;
    const areaDesc = cap?.areaDesc || item.title;
    const geo = resolveIndiaDistrictCoordinates(`${areaDesc} ${item.title} ${cap?.description || ''} Karnataka`);
    const coords = cap?.polygonCentroid || (geo ? { lat: geo.lat, lng: geo.lng } : INDIA_STATE_CENTROIDS.Karnataka);

    const effectiveFrom =
      parseSachetTimestamp(cap?.effective) ||
      parseSachetTimestamp(cap?.onset) ||
      parseSachetTimestamp(item.pubDate) ||
      new Date(nowMs).toISOString();
    const expiresAt = parseSachetTimestamp(cap?.expires);
    const expired = Boolean(expiresAt && Date.parse(expiresAt) <= nowMs);

    const headline = cap?.headline || item.title || item.description;
    const description = cap?.description || item.description || headline;
    const { severity, color } = mapSeverity(cap?.severity || (expired ? 'MINOR' : 'MODERATE'));
    const category = mapDisasterCategory(cap?.event || item.title, description);

    const authorLabel = cap?.senderName || (item.author.includes('IMD Bengaluru') ? 'IMD Bengaluru' : item.author || 'Karnataka SDMA / IMD');

    alerts.push({
      externalKey: `ndma-karnataka-cap:${idFromGuid}`,
      sourceId: 'ndma-sachet-karnataka-imd',
      sourceName: `NDMA SACHET Karnataka (${authorLabel})`,
      sourceUrl: item.link || endpointUrl,
      category,
      title: headline.slice(0, 220),
      description:
        !cap?.polygonCentroid && geo?.isDistrictCentroidFallback
          ? `${description} [District centroid mapping: ${geo.districtName || 'Karnataka'}]`
          : description,
      instruction: cap?.instruction || 'Monitor IMD Bengaluru & Karnataka SDMA advisories.',
      severity,
      severityColor: color,
      certainty: cap?.certainty || (expired ? 'Past' : 'Likely'),
      verificationStatus: expired ? 'Resolved Incident' : 'Official Alert',
      signalType: 'official_alert',
      locationLabel: areaDesc || 'Karnataka',
      stateName: 'Karnataka',
      districtName: geo?.districtName || '',
      latitude: coords.lat,
      longitude: coords.lng,
      areaCoveredSqKm: null,
      language: 'en',
      firstReportedAt: effectiveFrom,
      effectiveFrom,
      expiresAt,
      lastUpdatedAt: new Date(nowMs).toISOString(),
      isActive: !expired,
      rawPayload: { rss: item, cap },
    });
  }

  return { alerts, recordsFetched: rssItems.length, endpointUrl };
}

export async function fetchMysuruAndCityWeather(
  lat = 12.2958,
  lng = 76.6394,
  city = 'Mysuru',
  state = 'Karnataka',
  fetchImpl: typeof fetch = fetch
): Promise<MysuruWeatherIntel> {
  const retrievedAt = new Date().toISOString();
  const cacheKey = `live_incidents:weather:${lat.toFixed(2)}:${lng.toFixed(2)}`;
  if (fetchImpl === fetch) {
    const cached = await cacheQueue.getCachedJson<MysuruWeatherIntel>(cacheKey);
    if (cached) return cached;
  }

  const url =
    `https://api.open-meteo.com/v1/forecast?latitude=${encodeURIComponent(lat.toFixed(4))}` +
    `&longitude=${encodeURIComponent(lng.toFixed(4))}` +
    `&current=temperature_2m,apparent_temperature,relative_humidity_2m,precipitation,rain,weather_code,wind_speed_10m,is_day` +
    `&hourly=temperature_2m,apparent_temperature,precipitation,precipitation_probability,wind_speed_10m,weather_code,visibility` +
    `&forecast_days=2&timezone=auto`;

  try {
    const resp = await fetchImpl(url, {
      method: 'GET',
      signal: AbortSignal.timeout(5000),
    });
    if (!resp.ok) {
      return {
        available: false,
        city,
        state,
        latitude: lat,
        longitude: lng,
        source: 'Open-Meteo Meteorology API',
        retrievedAt,
        temperatureC: null,
        apparentTemperatureC: null,
        humidityPercent: null,
        precipitationMm: null,
        rainMm: null,
        windSpeedKmh: null,
        weatherCode: null,
        weatherLabel: 'Unavailable',
        visibilityMeters: null,
        isDay: null,
        reason: `Open-Meteo returned HTTP ${resp.status}`,
        horizons: [],
      };
    }

    const data = (await resp.json()) as {
      current?: {
        time?: string;
        temperature_2m?: number;
        apparent_temperature?: number;
        relative_humidity_2m?: number;
        precipitation?: number;
        rain?: number;
        weather_code?: number;
        wind_speed_10m?: number;
        is_day?: number;
      };
      hourly?: {
        time?: string[];
        temperature_2m?: number[];
        apparent_temperature?: number[];
        precipitation?: number[];
        precipitation_probability?: number[];
        wind_speed_10m?: number[];
        weather_code?: number[];
        visibility?: number[];
      };
    };

    const times = data.hourly?.time || [];
    const currentPrefix = (data.current?.time || '').slice(0, 13);
    const foundIdx = currentPrefix ? times.findIndex((t) => t.startsWith(currentPrefix)) : -1;
    const baseIdx = foundIdx >= 0 ? foundIdx : 0;

    const targetOffsets = [
      { offset: 1, label: '+1h' },
      { offset: 2, label: '+2h' },
      { offset: 6, label: '+6h' },
      { offset: 12, label: '+12h' },
      { offset: 24, label: '+24h' },
    ];

    const horizons: LiveWeatherForecastPoint[] = [];
    for (const { offset, label } of targetOffsets) {
      const idx = baseIdx + offset;
      if (idx < times.length) {
        const wCode = data.hourly?.weather_code?.[idx] ?? null;
        horizons.push({
          timeIso: times[idx],
          horizonLabel: label,
          temperatureC: data.hourly?.temperature_2m?.[idx] ?? null,
          apparentTemperatureC: data.hourly?.apparent_temperature?.[idx] ?? null,
          precipitationMm: data.hourly?.precipitation?.[idx] ?? null,
          precipitationProbability: data.hourly?.precipitation_probability?.[idx] ?? null,
          windSpeedKmh: data.hourly?.wind_speed_10m?.[idx] ?? null,
          weatherCode: wCode,
          weatherLabel: describeWmoWeatherCode(wCode),
        });
      }
    }

    const code = data.current?.weather_code ?? null;
    const visibility = data.hourly?.visibility?.[baseIdx] ?? null;
    const result: MysuruWeatherIntel = {
      available: Boolean(data.current),
      city,
      state,
      latitude: lat,
      longitude: lng,
      source: 'Open-Meteo Live & 24h Forecast API',
      retrievedAt,
      temperatureC: data.current?.temperature_2m ?? null,
      apparentTemperatureC: data.current?.apparent_temperature ?? null,
      humidityPercent: data.current?.relative_humidity_2m ?? null,
      precipitationMm: data.current?.precipitation ?? null,
      rainMm: data.current?.rain ?? null,
      windSpeedKmh: data.current?.wind_speed_10m ?? null,
      weatherCode: code,
      weatherLabel: describeWmoWeatherCode(code),
      visibilityMeters: visibility != null && Number.isFinite(visibility) ? Number(visibility) : null,
      isDay: data.current?.is_day === 1 ? true : data.current?.is_day === 0 ? false : null,
      horizons,
    };

    if (fetchImpl === fetch && result.available) {
      await cacheQueue.setCachedJson(cacheKey, result, 180);
    }
    return result;
  } catch (err) {
    return {
      available: false,
      city,
      state,
      latitude: lat,
      longitude: lng,
      source: 'Open-Meteo Meteorology API',
      retrievedAt,
      temperatureC: null,
      apparentTemperatureC: null,
      humidityPercent: null,
      precipitationMm: null,
      rainMm: null,
      windSpeedKmh: null,
      weatherCode: null,
      weatherLabel: 'Unavailable',
      visibilityMeters: null,
      isDay: null,
      reason: err instanceof Error ? err.message : 'Weather feed unreachable',
      horizons: [],
    };
  }
}

export function deriveThresholdWeatherAlerts(weather: MysuruWeatherIntel): UpsertLiveExternalAlertInput[] {
  if (!weather.available) return [];
  const alerts: UpsertLiveExternalAlertInput[] = [];
  const nowIso = new Date().toISOString();
  const expiresIso = new Date(Date.now() + 3 * 60 * 60 * 1000).toISOString();
  const dateStamp = nowIso.slice(0, 13);

  const maxTemp = Math.max(
    weather.temperatureC ?? -99,
    ...weather.horizons.slice(0, 3).map((h) => h.temperatureC ?? -99)
  );
  const maxApparent = Math.max(
    weather.apparentTemperatureC ?? -99,
    ...weather.horizons.slice(0, 3).map((h) => h.apparentTemperatureC ?? -99)
  );
  const maxRain = Math.max(
    weather.precipitationMm ?? 0,
    ...weather.horizons.slice(0, 3).map((h) => h.precipitationMm ?? 0)
  );
  const maxWind = Math.max(
    weather.windSpeedKmh ?? 0,
    ...weather.horizons.slice(0, 3).map((h) => h.windSpeedKmh ?? 0)
  );

  if (maxTemp >= 40 || maxApparent >= 42) {
    alerts.push({
      externalKey: `openmeteo-heat:${weather.city.toLowerCase()}:${dateStamp}`,
      sourceId: 'open-meteo-mysuru',
      sourceName: 'Open-Meteo Threshold Monitor',
      sourceUrl: 'https://open-meteo.com/',
      category: 'Heatwave',
      title: `Heat Threshold Exceeded in ${weather.city} (${maxTemp.toFixed(1)}°C / Feels ${maxApparent.toFixed(1)}°C)`,
      description: `Observed/near-term forecast temperature in ${weather.city}, ${weather.state} crosses extreme heat threshold.`,
      instruction: 'Avoid midday exposure, hydrate with ORS/water, and check on elderly/vulnerable residents.',
      severity: maxApparent >= 45 ? 'SEVERE' : 'MODERATE',
      severityColor: maxApparent >= 45 ? 'orange' : 'amber',
      certainty: 'Observed / Near-Term Forecast',
      verificationStatus: 'Official Alert',
      signalType: 'forecast',
      locationLabel: `${weather.city}, ${weather.state}`,
      stateName: weather.state,
      districtName: weather.city,
      latitude: weather.latitude,
      longitude: weather.longitude,
      firstReportedAt: nowIso,
      effectiveFrom: nowIso,
      expiresAt: expiresIso,
      lastUpdatedAt: nowIso,
      isActive: true,
    });
  }

  if (maxRain >= 15) {
    alerts.push({
      externalKey: `openmeteo-rain:${weather.city.toLowerCase()}:${dateStamp}`,
      sourceId: 'open-meteo-mysuru',
      sourceName: 'Open-Meteo Threshold Monitor',
      sourceUrl: 'https://open-meteo.com/',
      category: 'Heavy Rainfall',
      title: `Heavy Rainfall Threshold in ${weather.city} (${maxRain.toFixed(1)} mm/hr)`,
      description: `Observed/near-term precipitation rate in ${weather.city}, ${weather.state} reaches >=15 mm/hr.`,
      instruction: 'Avoid low-lying underpasses and waterlogged corridors; monitor drainage conditions.',
      severity: maxRain >= 30 ? 'SEVERE' : 'MODERATE',
      severityColor: maxRain >= 30 ? 'orange' : 'amber',
      certainty: 'Observed / Near-Term Forecast',
      verificationStatus: 'Official Alert',
      signalType: 'forecast',
      locationLabel: `${weather.city}, ${weather.state}`,
      stateName: weather.state,
      districtName: weather.city,
      latitude: weather.latitude,
      longitude: weather.longitude,
      firstReportedAt: nowIso,
      effectiveFrom: nowIso,
      expiresAt: expiresIso,
      lastUpdatedAt: nowIso,
      isActive: true,
    });
  }

  if (maxWind >= 65 || (weather.weatherCode != null && weather.weatherCode >= 95)) {
    alerts.push({
      externalKey: `openmeteo-storm:${weather.city.toLowerCase()}:${dateStamp}`,
      sourceId: 'open-meteo-mysuru',
      sourceName: 'Open-Meteo Threshold Monitor',
      sourceUrl: 'https://open-meteo.com/',
      category: 'Thunderstorm & Lightning',
      title: `Thunderstorm / High Wind Threshold in ${weather.city} (${maxWind.toFixed(0)} km/h)`,
      description: `Weather telemetry detects thunderstorm code or gusts >=65 km/h near ${weather.city}.`,
      instruction: 'Seek sturdy indoor shelter away from trees and overhead power lines.',
      severity: 'MODERATE',
      severityColor: 'amber',
      certainty: 'Observed',
      verificationStatus: 'Official Alert',
      signalType: 'observation',
      locationLabel: `${weather.city}, ${weather.state}`,
      stateName: weather.state,
      districtName: weather.city,
      latitude: weather.latitude,
      longitude: weather.longitude,
      firstReportedAt: nowIso,
      effectiveFrom: nowIso,
      expiresAt: expiresIso,
      lastUpdatedAt: nowIso,
      isActive: true,
    });
  }

  return alerts;
}

export async function fetchUsgsEarthquakes(fetchImpl: typeof fetch = fetch): Promise<{
  alerts: UpsertLiveExternalAlertInput[];
  recordsFetched: number;
  endpointUrl: string;
}> {
  const endpointUrl = 'https://earthquake.usgs.gov/earthquakes/feed/v1.0/summary/2.5_day.geojson';
  const resp = await fetchImpl(endpointUrl, {
    method: 'GET',
    headers: { Accept: 'application/json' },
    signal: AbortSignal.timeout(8000),
  });
  if (!resp.ok) {
    throw new Error(`USGS Earthquake feed returned HTTP ${resp.status}`);
  }
  const geojson = (await resp.json()) as {
    features?: Array<{
      id?: string;
      properties?: {
        mag?: number;
        place?: string;
        time?: number;
        updated?: number;
        url?: string;
        title?: string;
      };
      geometry?: {
        coordinates?: [number, number, number];
      };
    }>;
  };
  const features = Array.isArray(geojson.features) ? geojson.features : [];
  const alerts: UpsertLiveExternalAlertInput[] = [];

  for (const f of features) {
    const coords = f.geometry?.coordinates;
    if (!coords || coords.length < 2) continue;
    const [lng, lat, depthKm = 10] = coords;
    // India & immediate seismic boundary (5..38 N, 66..99 E)
    if (lat < 5 || lat > 38 || lng < 66 || lng > 99) continue;
    const mag = Number(f.properties?.mag ?? 0);
    if (!Number.isFinite(mag) || mag < 3.5) continue;

    const reportedIso = f.properties?.time ? new Date(f.properties.time).toISOString() : new Date().toISOString();
    const updatedIso = f.properties?.updated ? new Date(f.properties.updated).toISOString() : reportedIso;
    const place = String(f.properties?.place || 'India Region');
    const severity: LiveAlertSeverity = mag >= 6 ? 'EXTREME' : mag >= 5 ? 'SEVERE' : 'MODERATE';

    alerts.push({
      externalKey: `usgs-eq:${f.id || `${lat}:${lng}:${f.properties?.time}`}`,
      sourceId: 'usgs-earthquake-india',
      sourceName: 'USGS Earthquake Hazards Program',
      sourceUrl: f.properties?.url || endpointUrl,
      category: 'Earthquake',
      title: f.properties?.title || `M${mag.toFixed(1)} Earthquake — ${place}`,
      description: `Magnitude ${mag.toFixed(1)} seismic event at depth ${Number(depthKm).toFixed(1)} km near ${place}.`,
      instruction: 'Check structural safety, stay clear of damaged buildings, and prepare for aftershocks.',
      severity,
      severityColor: severity === 'EXTREME' ? 'red' : severity === 'SEVERE' ? 'orange' : 'amber',
      certainty: 'Observed',
      verificationStatus: 'Official Alert',
      signalType: 'observation',
      locationLabel: place,
      stateName: resolveIndiaDistrictCoordinates(place)?.stateName || 'India',
      districtName: resolveIndiaDistrictCoordinates(place)?.districtName || '',
      latitude: lat,
      longitude: lng,
      firstReportedAt: reportedIso,
      effectiveFrom: reportedIso,
      expiresAt: new Date(Date.parse(reportedIso) + 24 * 60 * 60 * 1000).toISOString(),
      lastUpdatedAt: updatedIso,
      isActive: true,
      rawPayload: f as unknown as Record<string, unknown>,
    });
  }

  return { alerts, recordsFetched: features.length, endpointUrl };
}

export async function fetchNasaFirmsFires(fetchImpl: typeof fetch = fetch): Promise<{
  configured: boolean;
  alerts: UpsertLiveExternalAlertInput[];
  recordsFetched: number;
  endpointUrl: string;
  note?: string;
}> {
  const key = (process.env.NASA_FIRMS_MAP_KEY || '').trim();
  const baseEndpoint = 'https://firms.modaps.eosdis.nasa.gov/api/area/';
  if (!key || key === 'MY_NASA_FIRMS_MAP_KEY') {
    return {
      configured: false,
      alerts: [],
      recordsFetched: 0,
      endpointUrl: baseEndpoint,
      note: 'NASA FIRMS MAP_KEY not configured (optional: set NASA_FIRMS_MAP_KEY in Secrets to enable live VIIRS satellite thermal detections).',
    };
  }

  const endpointUrl = `https://firms.modaps.eosdis.nasa.gov/api/area/csv/${encodeURIComponent(key)}/VIIRS_SNPP_NRT/68,6,98,37/1`;
  const resp = await fetchImpl(endpointUrl, {
    method: 'GET',
    signal: AbortSignal.timeout(9000),
  });
  if (!resp.ok) {
    throw new Error(`NASA FIRMS returned HTTP ${resp.status}`);
  }
  const csv = await resp.text();
  const lines = csv.trim().split(/\r?\n/);
  if (lines.length < 2) {
    return { configured: true, alerts: [], recordsFetched: 0, endpointUrl: baseEndpoint };
  }

  const headers = lines[0].split(',').map((h) => h.trim().toLowerCase());
  const latIdx = headers.indexOf('latitude');
  const lngIdx = headers.indexOf('longitude');
  const frpIdx = headers.indexOf('frp');
  const confIdx = headers.indexOf('confidence');
  const dateIdx = headers.indexOf('acq_date');
  const timeIdx = headers.indexOf('acq_time');

  const alerts: UpsertLiveExternalAlertInput[] = [];
  for (let i = 1; i < lines.length && alerts.length < 20; i++) {
    const cols = lines[i].split(',');
    const lat = Number(cols[latIdx]);
    const lng = Number(cols[lngIdx]);
    const conf = (cols[confIdx] || '').trim().toLowerCase();
    const frp = Number(cols[frpIdx] || 0);
    if (!Number.isFinite(lat) || !Number.isFinite(lng)) continue;
    // Prioritize Karnataka or high-confidence / high-FRP fires
    const inKarnataka = lat >= 11.5 && lat <= 18.6 && lng >= 74 && lng <= 78.6;
    if (!inKarnataka && conf !== 'h' && frp < 25) continue;

    const acqDate = (cols[dateIdx] || new Date().toISOString().slice(0, 10)).trim();
    const acqTime = (cols[timeIdx] || '0000').trim().padStart(4, '0');
    const tsIso = `${acqDate}T${acqTime.slice(0, 2)}:${acqTime.slice(2, 4)}:00Z`;

    alerts.push({
      externalKey: `nasa-firms:${lat.toFixed(3)}:${lng.toFixed(3)}:${acqDate}`,
      sourceId: 'nasa-firms-india',
      sourceName: 'NASA FIRMS (VIIRS Satellite)',
      sourceUrl: 'https://firms.modaps.eosdis.nasa.gov/map/',
      category: 'Fire',
      title: `Satellite Thermal Anomaly (${inKarnataka ? 'Karnataka' : 'India'}, FRP ${frp.toFixed(1)} MW)`,
      description: `VIIRS satellite detected high-confidence thermal anomaly at ${lat.toFixed(4)}, ${lng.toFixed(4)} with Fire Radiative Power ${frp.toFixed(1)} MW.`,
      instruction: 'Verify locally before dispatch; avoid smoke-affected forest/highway corridors.',
      severity: frp >= 50 ? 'SEVERE' : 'MODERATE',
      severityColor: frp >= 50 ? 'orange' : 'amber',
      certainty: 'Observed',
      verificationStatus: 'Awaiting Verification',
      signalType: 'observation',
      locationLabel: `${lat.toFixed(3)}, ${lng.toFixed(3)}`,
      stateName: inKarnataka ? 'Karnataka' : 'India',
      districtName: '',
      latitude: lat,
      longitude: lng,
      firstReportedAt: tsIso,
      effectiveFrom: tsIso,
      expiresAt: new Date(Date.now() + 18 * 60 * 60 * 1000).toISOString(),
      lastUpdatedAt: new Date().toISOString(),
      isActive: true,
    });
  }

  return { configured: true, alerts, recordsFetched: lines.length - 1, endpointUrl: baseEndpoint };
}
