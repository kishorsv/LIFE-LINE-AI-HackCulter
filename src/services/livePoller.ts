import {
  listLiveExternalAlerts,
  listLiveFeedSyncRuns,
  markStaleSourceAlertsResolved,
  UpsertLiveExternalAlertInput,
  upsertLiveExternalAlerts,
  upsertLiveFeedSyncRun,
} from '../db/repository.ts';
import { LiveExternalAlert, LiveFeedSyncRun } from '../types/lifeline.ts';
import { cacheQueue } from './cacheQueue.ts';
import {
  deriveThresholdWeatherAlerts,
  fetchMysuruAndCityWeather,
  fetchNasaFirmsFires,
  fetchNdmaKarnatakaRssAndCap,
  fetchNdmaSachetAlerts,
  fetchUsgsEarthquakes,
} from './liveFeeds.ts';

export interface PollRunSummary {
  startedAt: string;
  finishedAt: string;
  insertedCount: number;
  updatedCount: number;
  resolvedCount: number;
  newActiveAlerts: LiveExternalAlert[];
  sources: LiveFeedSyncRun[];
}

type OnNewAlertsCallback = (newAlerts: LiveExternalAlert[]) => void;

let pollTimer: ReturnType<typeof setInterval> | null = null;
let inFlightPoll: Promise<PollRunSummary> | null = null;
let lastPollAtMs = 0;

export async function pollAllLiveSources(options?: {
  force?: boolean;
  fetchImpl?: typeof fetch;
  onNewAlerts?: OnNewAlertsCallback;
  minIntervalMs?: number;
}): Promise<PollRunSummary> {
  const minIntervalMs = options?.minIntervalMs ?? 120_000;
  if (!options?.force && Date.now() - lastPollAtMs < minIntervalMs && options?.fetchImpl === undefined) {
    const existingSources = await listLiveFeedSyncRuns();
    const nowIso = new Date().toISOString();
    return {
      startedAt: nowIso,
      finishedAt: nowIso,
      insertedCount: 0,
      updatedCount: 0,
      resolvedCount: 0,
      newActiveAlerts: [],
      sources: existingSources,
    };
  }

  if (inFlightPoll && options?.fetchImpl === undefined) {
    return inFlightPoll;
  }

  const exec = async (): Promise<PollRunSummary> => {
    const startedAt = new Date().toISOString();
    const fetchImpl = options?.fetchImpl ?? fetch;
    let insertedCount = 0;
    let updatedCount = 0;
    let resolvedCount = 0;
    const allNewActive: LiveExternalAlert[] = [];

    const recordSourceResult = async (
      sourceId: string,
      sourceName: string,
      sourceKind: LiveFeedSyncRun['sourceKind'],
      endpointUrl: string,
      pollIntervalSeconds: number,
      fn: () => Promise<{ alerts: UpsertLiveExternalAlertInput[]; recordsFetched: number; unconfigured?: boolean; note?: string }>
    ) => {
      const t0 = Date.now();
      const attemptIso = new Date().toISOString();
      try {
        const res = await fn();
        const latencyMs = Date.now() - t0;

        if (res.unconfigured) {
          await upsertLiveFeedSyncRun({
            sourceId,
            sourceName,
            sourceKind,
            endpointUrl,
            status: 'unconfigured',
            pollIntervalSeconds,
            lastAttemptAt: attemptIso,
            lastError: res.note || 'API key not configured',
            recordsFetched: 0,
            recordsActive: 0,
            latencyMs,
          });
          return;
        }

        const upserted = await upsertLiveExternalAlerts(res.alerts);
        const activeKeys = res.alerts.filter((a) => a.isActive).map((a) => a.externalKey);
        const resolved = await markStaleSourceAlertsResolved(sourceId, activeKeys);

        insertedCount += upserted.insertedCount;
        updatedCount += upserted.updatedCount;
        resolvedCount += resolved;
        allNewActive.push(...upserted.newActiveAlerts);

        await upsertLiveFeedSyncRun({
          sourceId,
          sourceName,
          sourceKind,
          endpointUrl,
          status: 'healthy',
          pollIntervalSeconds,
          lastAttemptAt: attemptIso,
          lastSuccessAt: new Date().toISOString(),
          lastError: res.note || '',
          recordsFetched: res.recordsFetched,
          recordsActive: activeKeys.length,
          latencyMs,
        });
      } catch (err) {
        const latencyMs = Date.now() - t0;
        const msg = err instanceof Error ? err.message : String(err);
        await upsertLiveFeedSyncRun({
          sourceId,
          sourceName,
          sourceKind,
          endpointUrl,
          status: 'degraded',
          pollIntervalSeconds,
          lastAttemptAt: attemptIso,
          lastError: msg.slice(0, 400),
          recordsFetched: 0,
          recordsActive: 0,
          latencyMs,
        });
      }
    };

    await Promise.all([
      recordSourceResult(
        'ndma-sachet-all',
        'NDMA SACHET National CAP Alerts',
        'official_cap',
        'https://sachet.ndma.gov.in/cap_public_website/FetchAllAlertDetails',
        180,
        () => fetchNdmaSachetAlerts(fetchImpl)
      ),
      recordSourceResult(
        'ndma-sachet-karnataka-imd',
        'NDMA SACHET Karnataka / IMD Bengaluru CAP',
        'official_cap',
        'https://sachet.ndma.gov.in/cap_public_website/rss/rss_karnataka.xml',
        180,
        () => fetchNdmaKarnatakaRssAndCap(fetchImpl)
      ),
      recordSourceResult(
        'open-meteo-mysuru',
        'Open-Meteo Mysuru Meteorology & 24h Forecast',
        'meteorology',
        'https://api.open-meteo.com/v1/forecast',
        180,
        async () => {
          const weather = await fetchMysuruAndCityWeather(12.2958, 76.6394, 'Mysuru', 'Karnataka', fetchImpl);
          if (!weather.available) {
            throw new Error(weather.reason || 'Open-Meteo unavailable');
          }
          const thresholdAlerts = deriveThresholdWeatherAlerts(weather);
          return {
            alerts: thresholdAlerts,
            recordsFetched: 1 + weather.horizons.length,
          };
        }
      ),
      recordSourceResult(
        'usgs-earthquake-india',
        'USGS Earthquake Feed (India Region M>=3.5)',
        'geophysical',
        'https://earthquake.usgs.gov/earthquakes/feed/v1.0/summary/2.5_day.geojson',
        300,
        () => fetchUsgsEarthquakes(fetchImpl)
      ),
      recordSourceResult(
        'nasa-firms-india',
        'NASA FIRMS Satellite Active Fire (VIIRS)',
        'satellite_fire',
        'https://firms.modaps.eosdis.nasa.gov/api/area/',
        300,
        async () => {
          const res = await fetchNasaFirmsFires(fetchImpl);
          return {
            alerts: res.alerts,
            recordsFetched: res.recordsFetched,
            unconfigured: !res.configured,
            note: res.note,
          };
        }
      ),
    ]);

    // Record direct IMD endpoint transparency status (optional IMD_API_ENDPOINT if whitelisted)
    const customImdUrl = (process.env.IMD_API_ENDPOINT || '').trim();
    if (!customImdUrl) {
      await upsertLiveFeedSyncRun({
        sourceId: 'imd-direct-api',
        sourceName: 'IMD Direct API (via NDMA CAP Fallback Active)',
        sourceKind: 'meteorology',
        endpointUrl: 'https://mausam.imd.gov.in/api/nowcastapi.php',
        status: 'unconfigured',
        pollIntervalSeconds: 300,
        lastAttemptAt: startedAt,
        lastError:
          'Direct mausam.imd.gov.in requires server IP whitelisting; IMD Bengaluru official warnings are actively ingested via NDMA SACHET Karnataka CAP RSS.',
        recordsFetched: 0,
        recordsActive: 0,
        latencyMs: 0,
      });
    }

    lastPollAtMs = Date.now();
    await cacheQueue.invalidateCachePrefix('live_incidents:');

    if (allNewActive.length > 0 && options?.onNewAlerts) {
      try {
        options.onNewAlerts(allNewActive);
      } catch {
        // ignore callback failures
      }
    }

    const sources = await listLiveFeedSyncRuns();
    return {
      startedAt,
      finishedAt: new Date().toISOString(),
      insertedCount,
      updatedCount,
      resolvedCount,
      newActiveAlerts: allNewActive,
      sources,
    };
  };

  if (options?.fetchImpl !== undefined) {
    return exec();
  }

  inFlightPoll = exec().finally(() => {
    inFlightPoll = null;
  });
  return inFlightPoll;
}

export function startLiveFeedPolling(options?: {
  intervalMs?: number;
  onNewAlerts?: OnNewAlertsCallback;
}): void {
  if (process.env.NODE_ENV === 'test' || process.env.LIFELINE_DISABLE_AUTO_POLL === 'true' || process.env.LIFELINE_LIVE_POLL_ENABLED === 'false') {
    return;
  }
  stopLiveFeedPolling();

  const intervalMs = Math.max(60_000, options?.intervalMs ?? 180_000);

  // Initial background sync shortly after server startup
  const startupTimer = setTimeout(() => {
    void pollAllLiveSources({ force: true, onNewAlerts: options?.onNewAlerts }).catch(() => {});
  }, 1500);
  startupTimer.unref();

  pollTimer = setInterval(() => {
    void pollAllLiveSources({ force: true, onNewAlerts: options?.onNewAlerts }).catch(() => {});
  }, intervalMs);
  pollTimer.unref();
}

export function stopLiveFeedPolling(): void {
  if (pollTimer) {
    clearInterval(pollTimer);
    pollTimer = null;
  }
}

export async function getActiveAlertCountsByRegion() {
  const all = await listLiveExternalAlerts({ activeOnly: true, limit: 200 });
  return {
    totalActive: all.length,
    karnatakaActive: all.filter((a) => a.stateName.toLowerCase() === 'karnataka').length,
  };
}
