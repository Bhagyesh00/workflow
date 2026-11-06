/**
 * Structured JSON logging (pino). Secrets never reach the log: auth headers, cookies, passwords,
 * tokens and credential data are redacted by path.
 */
import type { DataObject, Logger } from '@workflow/workflow';
import { type DestinationStream, type Logger as PinoLogger, pino } from 'pino';

export type { PinoLogger };

const REDACT = [
  'req.headers.authorization',
  'req.headers.cookie',
  'req.headers["x-api-key"]',
  'req.headers["x-auth-token"]',
  'res.headers["set-cookie"]',
  '*.password',
  '*.passwordHash',
  '*.token',
  '*.accessToken',
  '*.refreshToken',
  '*.clientSecret',
  '*.apiKey',
  '*.data_enc',
  '*.dataEnc',
  '*.secretAccessKey',
  '*.serviceAccountKey',
  '*.secretId',
  '*.privateKey',
  '*.passphrase',
  '*.settingsEnc',
  '*.settings_enc',
  // database errors carry the query parameters (hashes, ciphertexts, run data)
  'err.params',
  'err.cause.params',
];

/**
 * Paths whose segments are bearer secrets: the invitation token (`/invitation/<token>`, the editor
 * page, and `/rest/invitations/<token>/accept`) and the resume URLs (`/webhook-waiting/<executionId>/<signature>`,
 * `/form-waiting/<executionId>/<signature>`).
 */
const SECRET_PATHS: RegExp[] = [
  /^(\/+(?:rest\/+)?invitations?\/+)[^/]+/,
  /^(\/+webhook-waiting\/+).+/,
  /^(\/+form-waiting\/+).+/,
];

/** the request URL with every token-bearing path segment replaced; the query string is kept */
export function redactUrl(url: string): string {
  const queryAt = url.indexOf('?');
  const rawPath = queryAt === -1 ? url : url.slice(0, queryAt);
  const query = queryAt === -1 ? '' : url.slice(queryAt);
  let decoded = rawPath;
  try {
    // the router matches the decoded path, so `/%69nvitation/<token>` reaches the same route
    decoded = decodeURI(rawPath);
  } catch {
    // an invalid escape never matches a route; the raw path is checked as is
  }
  for (const pattern of SECRET_PATHS) {
    if (pattern.test(decoded)) return `${decoded.replace(pattern, '$1[redacted]')}${query}`;
  }
  return url;
}

/** Fastify's request fields for the `incoming request` and error lines, with the URL redacted */
function serializeRequest(request: {
  method?: string;
  url?: string;
  headers?: Record<string, unknown>;
  host?: string;
  ip?: string;
  socket?: { remotePort?: number };
}) {
  return {
    method: request.method,
    url: request.url === undefined ? undefined : redactUrl(request.url),
    version: request.headers?.['accept-version'],
    host: request.host,
    remoteAddress: request.ip,
    remotePort: request.socket?.remotePort,
  };
}

export function createLogger(level: string, base: DataObject = {}, destination?: DestinationStream): PinoLogger {
  return pino(
    {
      level,
      base: { ...base },
      redact: { paths: REDACT, censor: '[redacted]' },
      timestamp: pino.stdTimeFunctions.isoTime,
      formatters: { level: (label) => ({ level: label }) },
      serializers: { req: serializeRequest },
    },
    destination,
  );
}

/** Adapt pino to the engine's `Logger` contract (message first, metadata second). */
export function toWorkflowLogger(logger: PinoLogger): Logger {
  return {
    debug: (message, meta) => logger.debug(meta ?? {}, message),
    info: (message, meta) => logger.info(meta ?? {}, message),
    warn: (message, meta) => logger.warn(meta ?? {}, message),
    error: (message, meta) => logger.error(meta ?? {}, message),
  };
}
