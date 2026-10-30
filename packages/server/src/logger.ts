/**
 * Structured JSON logging (pino). Secrets never reach the log: auth headers, cookies, passwords,
 * tokens and credential data are redacted by path.
 */
import type { DataObject, Logger } from '@workflow/workflow';
import { type Logger as PinoLogger, pino } from 'pino';

export type { PinoLogger };

const REDACT = [
  'req.headers.authorization',
  'req.headers.cookie',
  'req.headers["x-api-key"]',
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
  // database errors carry the query parameters (hashes, ciphertexts, run data)
  'err.params',
  'err.cause.params',
];

export function createLogger(level: string, base: DataObject = {}): PinoLogger {
  return pino({
    level,
    base: { ...base },
    redact: { paths: REDACT, censor: '[redacted]' },
    timestamp: pino.stdTimeFunctions.isoTime,
    formatters: { level: (label) => ({ level: label }) },
  });
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
