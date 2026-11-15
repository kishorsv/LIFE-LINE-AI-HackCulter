import type { NextFunction, Request, Response } from 'express';

export type LogLevel = 'info' | 'warn' | 'error';

interface LogEntry {
  timestamp: string;
  level: LogLevel;
  event: string;
  message?: string;
  meta?: Record<string, unknown>;
}

interface ErrorTrackerEntry {
  timestamp: string;
  method: string;
  path: string;
  statusCode: number;
  message: string;
}

const recentErrors: ErrorTrackerEntry[] = [];
const MAX_RECENT_ERRORS = 50;

function redactSensitiveMeta(meta?: Record<string, unknown>): Record<string, unknown> | undefined {
  if (!meta) return undefined;
  const out: Record<string, unknown> = {};
  for (const [key, val] of Object.entries(meta)) {
    if (/token|secret|password|authorization|key/i.test(key)) {
      out[key] = '[REDACTED]';
    } else {
      out[key] = val;
    }
  }
  return out;
}

export function writeStructuredLog(level: LogLevel, event: string, message?: string, meta?: Record<string, unknown>) {
  if (process.env.NODE_ENV === 'test' && level === 'info') return;
  const entry: LogEntry = {
    timestamp: new Date().toISOString(),
    level,
    event,
    ...(message ? { message } : {}),
    ...(meta ? { meta: redactSensitiveMeta(meta) } : {}),
  };
  const line = JSON.stringify(entry);
  if (level === 'error') {
    console.error(line);
  } else if (level === 'warn') {
    console.warn(line);
  } else {
    console.log(line);
  }
}

export function recordServerError(entry: Omit<ErrorTrackerEntry, 'timestamp'>) {
  recentErrors.unshift({ ...entry, timestamp: new Date().toISOString() });
  if (recentErrors.length > MAX_RECENT_ERRORS) {
    recentErrors.length = MAX_RECENT_ERRORS;
  }
}

export function getErrorMonitorSummary() {
  return {
    capturedCount: recentErrors.length,
    latestTimestamp: recentErrors[0]?.timestamp || null,
  };
}

export function requestLoggerMiddleware(req: Request, res: Response, next: NextFunction) {
  if (!req.path.startsWith('/api/')) {
    next();
    return;
  }
  const startedAt = Date.now();
  res.on('finish', () => {
    const durationMs = Date.now() - startedAt;
    const level: LogLevel = res.statusCode >= 500 ? 'error' : res.statusCode >= 400 ? 'warn' : 'info';
    writeStructuredLog(level, 'api_request', `${req.method} ${req.path} -> ${res.statusCode}`, {
      method: req.method,
      path: req.path,
      statusCode: res.statusCode,
      durationMs,
      ip: req.ip,
    });
  });
  next();
}

export function errorHandlerMiddleware(err: unknown, req: Request, res: Response, _next: NextFunction) {
  const message = err instanceof Error ? err.message : 'Unexpected internal server error';
  const statusCode =
    typeof (err as { statusCode?: number }).statusCode === 'number'
      ? (err as { statusCode: number }).statusCode
      : 500;

  recordServerError({
    method: req.method,
    path: req.path,
    statusCode,
    message,
  });

  writeStructuredLog('error', 'unhandled_route_error', message, {
    method: req.method,
    path: req.path,
    statusCode,
  });

  if (res.headersSent) return;
  res.status(statusCode).json({
    error: statusCode >= 500 && process.env.NODE_ENV === 'production' ? 'Internal server error.' : message,
  });
}
