import fs from 'node:fs';
import path from 'node:path';
import { drizzle } from 'drizzle-orm/node-postgres';
import { Pool, QueryResult, QueryResultRow } from 'pg';
import * as schema from './schema.ts';
import { metrics } from '../services/metrics.ts';

declare global {
  var _postgresPool: Pool | undefined;
}

const TRANSIENT_PG_CODES = new Set(['57P01', '57P02', '57P03', '40001', '40P01', 'ECONNRESET', 'ETIMEDOUT']);

export function getPostgresConnectionString(env: NodeJS.ProcessEnv = process.env): string {
  const candidates = [env.DATABASE_URL, env.POSTGRES_URL, env.POSTGRES_PRISMA_URL];
  for (const val of candidates) {
    const trimmed = (val || '').trim();
    if (trimmed && !trimmed.includes('MY_SQL_PASSWORD')) {
      return trimmed;
    }
  }
  return '';
}

export function hasPostgresConfig(env: NodeJS.ProcessEnv = process.env): boolean {
  if (getPostgresConnectionString(env)) {
    return true;
  }
  return Boolean(
    env.SQL_HOST &&
      env.SQL_DB_NAME &&
      env.SQL_USER &&
      env.SQL_PASSWORD &&
      env.SQL_PASSWORD !== 'MY_SQL_PASSWORD'
  );
}

/**
 * Resolves Cloud SQL Unix domain socket paths when the injected SQL_HOST uses a
 * GCP project alias/slug (e.g. savvy-yucca-r4dh4:region:instance) while the
 * cloud-sql-proxy sidecar mounted the socket under the project ID (project-...:region:instance).
 */
export function resolvePostgresHost(
  rawHost: string | undefined = process.env.SQL_HOST,
  searchRoots: string[] = ['/app/cloudsql', '/cloudsql']
): string | undefined {
  if (!rawHost) return undefined;
  const trimmed = rawHost.trim();
  if (!trimmed.startsWith('/')) return trimmed;

  if (fs.existsSync(path.join(trimmed, '.s.PGSQL.5432'))) {
    return trimmed;
  }

  const baseName = path.basename(trimmed);
  const firstColon = baseName.indexOf(':');
  const instanceSuffix = firstColon >= 0 ? baseName.slice(firstColon) : '';
  const candidateParents = Array.from(new Set([path.dirname(trimmed), ...searchRoots]));

  const allSocketDirs: string[] = [];
  for (const parent of candidateParents) {
    try {
      if (!fs.existsSync(parent)) continue;
      const entries = fs.readdirSync(parent, { withFileTypes: true });
      for (const entry of entries) {
        if (!entry.isDirectory()) continue;
        const candidateDir = path.join(parent, entry.name);
        if (!fs.existsSync(path.join(candidateDir, '.s.PGSQL.5432'))) continue;
        if (instanceSuffix && entry.name.endsWith(instanceSuffix)) {
          return candidateDir;
        }
        allSocketDirs.push(candidateDir);
      }
    } catch {
      // Ignore unreadable parent directories
    }
  }

  if (allSocketDirs.length === 1) {
    return allSocketDirs[0];
  }

  return trimmed;
}

const isServerlessRuntime = Boolean(process.env.VERCEL || process.env.AWS_LAMBDA_FUNCTION_NAME);
const PG_POOL_MAX = Math.min(100, Math.max(2, Number(process.env.PG_POOL_MAX || (isServerlessRuntime ? 5 : 15))));
const DB_STATEMENT_TIMEOUT_MS = Math.min(30_000, Math.max(1000, Number(process.env.DB_STATEMENT_TIMEOUT_MS || 8000)));

let activePoolHost: string | undefined;

function resolveSslOption(connectionString: string, host?: string): false | { rejectUnauthorized: false } | undefined {
  if (process.env.DB_SSL === 'false') return false;
  if (process.env.DB_SSL === 'true') return { rejectUnauthorized: false };
  if (connectionString) {
    if (/sslmode=disable/i.test(connectionString)) return false;
    if (/@(localhost|127\.0\.0\.1)(:|\/)/i.test(connectionString)) return undefined;
    return { rejectUnauthorized: false };
  }
  if (host && !host.startsWith('/') && host !== 'localhost' && host !== '127.0.0.1') {
    return { rejectUnauthorized: false };
  }
  return undefined;
}

export const createPool = () => {
  if (!global._postgresPool) {
    const connectionString = getPostgresConnectionString();
    activePoolHost = connectionString ? undefined : resolvePostgresHost(process.env.SQL_HOST);
    const ssl = resolveSslOption(connectionString, activePoolHost);

    global._postgresPool = new Pool({
      ...(connectionString
        ? { connectionString }
        : {
            host: activePoolHost,
            user: process.env.SQL_USER,
            password: process.env.SQL_PASSWORD,
            database: process.env.SQL_DB_NAME,
          }),
      ...(ssl !== undefined ? { ssl } : {}),
      max: PG_POOL_MAX,
      min: 0,
      idleTimeoutMillis: isServerlessRuntime ? 10_000 : 30_000,
      connectionTimeoutMillis: 15_000,
      statement_timeout: DB_STATEMENT_TIMEOUT_MS,
      query_timeout: DB_STATEMENT_TIMEOUT_MS + 2000,
      allowExitOnIdle: isServerlessRuntime,
    });

    global._postgresPool.on('error', (err) => {
      console.error('Unexpected error on idle SQL pool client:', err);
    });
  }
  return global._postgresPool;
};

export let pool = createPool();
export let db = drizzle(pool, { schema });

export function refreshPostgresPoolHost(): boolean {
  if (getPostgresConnectionString()) {
    return false;
  }
  const nextHost = resolvePostgresHost(process.env.SQL_HOST);
  if (!nextHost || nextHost === activePoolHost) {
    return false;
  }
  console.log(`[db] Resolved Cloud SQL Unix socket host from ${activePoolHost || '(unset)'} to ${nextHost}`);
  const prevPool = global._postgresPool;
  global._postgresPool = undefined;
  if (prevPool) {
    void prevPool.end().catch(() => {});
  }
  pool = createPool();
  db = drizzle(pool, { schema });
  return true;
}

export function getPoolStats() {
  return {
    totalCount: pool.totalCount,
    idleCount: pool.idleCount,
    waitingCount: pool.waitingCount,
    maxConnections: PG_POOL_MAX,
  };
}

export async function queryWithRetry<T extends QueryResultRow = QueryResultRow>(
  text: string,
  params?: unknown[],
  maxAttempts = 3,
  queryName?: string
): Promise<QueryResult<T>> {
  let lastErr: unknown;
  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    const t0 = performance.now();
    try {
      const res = await pool.query<T>(text, params);
      metrics.recordDbQuery(performance.now() - t0, queryName);
      return res;
    } catch (err) {
      metrics.recordDbQuery(performance.now() - t0, queryName);
      lastErr = err;
      const code = (err as { code?: string })?.code || '';
      const msg = err instanceof Error ? err.message : '';
      const isTransient =
        TRANSIENT_PG_CODES.has(code) || /ECONNRESET|ETIMEDOUT|Connection terminated/i.test(msg);
      if (!isTransient || attempt + 1 >= maxAttempts) {
        throw err;
      }
      const backoffMs = 50 * Math.pow(2, attempt) + Math.round(Math.random() * 40);
      await new Promise((r) => setTimeout(r, backoffMs));
    }
  }
  throw lastErr;
}

export async function closePool() {
  if (global._postgresPool) {
    await global._postgresPool.end().catch(() => {});
    global._postgresPool = undefined;
  }
}
