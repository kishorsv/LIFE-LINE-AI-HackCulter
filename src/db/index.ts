import { drizzle } from 'drizzle-orm/node-postgres';
import { Pool, QueryResult, QueryResultRow } from 'pg';
import * as schema from './schema.ts';
import { metrics } from '../services/metrics.ts';

declare global {
  var _postgresPool: Pool | undefined;
}

const TRANSIENT_PG_CODES = new Set(['57P01', '57P02', '57P03', '40001', '40P01', 'ECONNRESET', 'ETIMEDOUT']);

export function hasPostgresConfig(env: NodeJS.ProcessEnv = process.env): boolean {
  return Boolean(
    env.SQL_HOST &&
      env.SQL_DB_NAME &&
      env.SQL_USER &&
      env.SQL_PASSWORD &&
      env.SQL_PASSWORD !== 'MY_SQL_PASSWORD'
  );
}

const PG_POOL_MAX = Math.min(100, Math.max(5, Number(process.env.PG_POOL_MAX || 25)));
const DB_STATEMENT_TIMEOUT_MS = Math.min(30_000, Math.max(1000, Number(process.env.DB_STATEMENT_TIMEOUT_MS || 8000)));

export const createPool = () => {
  if (!global._postgresPool) {
    global._postgresPool = new Pool({
      host: process.env.SQL_HOST,
      user: process.env.SQL_USER,
      password: process.env.SQL_PASSWORD,
      database: process.env.SQL_DB_NAME,
      max: PG_POOL_MAX,
      min: 2,
      idleTimeoutMillis: 30_000,
      connectionTimeoutMillis: 5_000,
      statement_timeout: DB_STATEMENT_TIMEOUT_MS,
      query_timeout: DB_STATEMENT_TIMEOUT_MS + 2000,
      allowExitOnIdle: false,
    });

    global._postgresPool.on('error', (err) => {
      console.error('Unexpected error on idle SQL pool client:', err);
    });
  }
  return global._postgresPool;
};

const pool = createPool();
export const db = drizzle(pool, { schema });
export { pool };

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
  maxAttempts = 3
): Promise<QueryResult<T>> {
  let lastErr: unknown;
  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    const t0 = performance.now();
    try {
      const res = await pool.query<T>(text, params);
      metrics.recordDbQuery(performance.now() - t0);
      return res;
    } catch (err) {
      metrics.recordDbQuery(performance.now() - t0);
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
