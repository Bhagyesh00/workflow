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

/**
 * A form's address, and a Chat Trigger's (production or test, ending in /chat), carries the sign-in's
 * one-time code in its query when the visitor comes back.
 */
const SIGN_IN_PATHS: RegExp[] = [/^\/+form(?:-test|-waiting)?\//, /^\/+webhook(?:-test)?\/.+\/chat\/*$/];

/**
 * P6-19: paths whose whole query is a one-time secret: the reset and email change links (`token`), the OIDC
 * callback (`code`, `state`) and the SAML ACS (`SAMLResponse`, `RelayState`). The query is dropped, not
 * masked, so no key of it survives either.
 */
const QUERY_DROPPED_PATHS: RegExp[] = [
  /\/(?:reset-password|confirm-email-change)\/*$/,
  /^\/+(?:rest\/+)?sso\/+oidc\/+[^/]+\/+callback\/*$/,
  /^\/+(?:rest\/+)?sso\/+saml\/+[^/]+\/+acs\/*$/,
];

/** P6-19: a webhook URL carries the sign-in's one-time `code` when the browser path comes back (`auto`) */
const WEBHOOK_CODE_PATHS: RegExp[] = [/^\/+webhook(?:-test)?\//];

/** the request URL with every token-bearing path segment and form or chat sign-in code replaced; the rest of the query is kept */
export function redactUrl(url: string): string {
  const queryAt = url.indexOf('?');
  const rawPath = queryAt === -1 ? url : url.slice(0, queryAt);
  const rawQuery = queryAt === -1 ? '' : url.slice(queryAt);
  let decoded = rawPath;
  try {
    // the router matches the decoded path, so `/%69nvitation/<token>` reaches the same route
    decoded = decodeURI(rawPath);
  } catch {
    // an invalid escape never matches a route; the raw path is checked as is
  }
  const dropped = QUERY_DROPPED_PATHS.some((pattern) => pattern.test(decoded));
  const signIn = [...SIGN_IN_PATHS, ...WEBHOOK_CODE_PATHS].some((pattern) => pattern.test(decoded));
  const query = dropped ? '' : signIn ? rawQuery.replace(/([?&]code=)[^&]*/g, '$1[redacted]') : rawQuery;
  for (const pattern of SECRET_PATHS) {
    if (pattern.test(decoded)) return `${decoded.replace(pattern, '$1[redacted]')}${query}`;
  }
  return `${rawPath}${query}`;
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

export function createLogger(
  level: string,
  base: DataObject = {},
  destination?: DestinationStream,
): PinoLogger {
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
