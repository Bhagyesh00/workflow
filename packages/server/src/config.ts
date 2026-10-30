/**
 * Server configuration, read from the environment and validated with zod (ARCHITECTURE.md §15).
 * Production fails fast on missing secrets; development gets safe local defaults.
 */
import { createHash } from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { MasterKey } from '@workflow/core';
import { z } from 'zod';

const PACKAGE_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

const bool = (fallback: boolean) =>
  z
    .enum(['true', 'false', '1', '0', 'yes', 'no'])
    .optional()
    .transform((v) => (v === undefined ? fallback : ['true', '1', 'yes'].includes(v)));

const list = z
  .string()
  .optional()
  .transform((v) =>
    (v ?? '')
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean),
  );

const int = (fallback: number, min = 0) => z.coerce.number().int().min(min).default(fallback);

const envSchema = z.object({
  NODE_ENV: z.enum(['development', 'production', 'test']).default('development'),
  PORT: int(5678),
  HOST: z.string().default('0.0.0.0'),
  BASE_URL: z.url().default('http://localhost:5678'),
  DATABASE_URL: z.string().optional(),
  REDIS_URL: z.string().optional(),
  EXECUTIONS_MODE: z.enum(['regular', 'queue']).default('regular'),
  ENCRYPTION_KEYS: z.string().optional(),
  BINARY_DATA_MODE: z.enum(['inline', 'filesystem', 's3']).default('filesystem'),
  BINARY_DATA_DIR: z.string().default('./data/binary'),
  SSRF_PROTECTION: bool(true),
  SSRF_ALLOW: list,
  SSRF_DENY: list,
  CODE_MEMORY_MB: int(128, 8),
  CODE_TIMEOUT_MS: int(30_000, 100),
  EXECUTION_TIMEOUT_DEFAULT_S: int(300, 1),
  EXECUTION_TIMEOUT_MAX_S: int(3600, 1),
  EXECUTIONS_PRUNE_DAYS: int(14, 1),
  SIGNUP_ENABLED: bool(true),
  BRAND_NAME: z.string().default('Workflow'),
  BRAND_LOGO_URL: z.string().default(''),
  BRAND_PRIMARY_COLOR: z.string().default('#4f46e5'),
  DEFAULT_TIMEZONE: z.string().default('UTC'),
  DEFAULT_PLAN: z.string().default('unlimited'),
  LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent']).default('info'),
  CORS_ORIGINS: list,
  /** max request body (webhooks, REST) in megabytes */
  BODY_LIMIT_MB: int(16, 1),
  QUEUE_CONCURRENCY: int(10, 1),
  QUEUE_PREFIX: z.string().default('wf'),
  LOGIN_RATE_LIMIT_MAX: int(10, 1),
  LOGIN_RATE_LIMIT_WINDOW_MS: int(60_000, 1000),
  WAIT_TRACKER_INTERVAL_MS: int(5000, 50),
  /** optional bearer token required by GET /metrics */
  METRICS_TOKEN: z.string().optional(),
  /** directory of the built editor SPA */
  EDITOR_DIST: z.string().optional(),
  TRUST_PROXY: bool(false),
});

export type Env = z.input<typeof envSchema>;

export interface Config {
  env: 'development' | 'production' | 'test';
  port: number;
  host: string;
  /** without trailing slash */
  baseUrl: string;
  databaseUrl: string;
  redisUrl?: string;
  executionsMode: 'regular' | 'queue';
  encryptionKeys: MasterKey[];
  binaryData: { mode: 'inline' | 'filesystem'; dir: string };
  ssrf: { enabled: boolean; allow: string[]; deny: string[] };
  code: { memoryMb: number; timeoutMs: number };
  executionTimeout: { defaultS: number; maxS: number };
  pruneDays: number;
  signupEnabled: boolean;
  brand: { name: string; logoUrl: string; primaryColor: string };
  defaultTimezone: string;
  defaultPlan: string;
  logLevel: string;
  /** origins allowed for CSRF checks (BASE_URL origin + CORS_ORIGINS) */
  allowedOrigins: string[];
  bodyLimitBytes: number;
  queue: { concurrency: number; prefix: string };
  loginRateLimit: { max: number; windowMs: number };
  waitTrackerIntervalMs: number;
  metricsToken?: string;
  editorDist: string;
  trustProxy: boolean;
  cookieSecure: boolean;
}

export class ConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ConfigError';
  }
}

/** a fixed, clearly-labelled key for local development only */
function devKey(): MasterKey {
  return { id: 'dev', key: createHash('sha256').update('workflow-platform-insecure-dev-key').digest() };
}

export function parseEncryptionKeys(value: string): MasterKey[] {
  return value
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean)
    .map((entry) => {
      const sep = entry.indexOf(':');
      if (sep <= 0) throw new ConfigError('ENCRYPTION_KEYS entries must look like "<id>:<base64 32 bytes>"');
      const id = entry.slice(0, sep);
      const key = Buffer.from(entry.slice(sep + 1), 'base64');
      if (key.length !== 32) throw new ConfigError(`Encryption key "${id}" must decode to exactly 32 bytes`);
      if (id.includes('.')) throw new ConfigError(`Encryption key id "${id}" must not contain "."`);
      return { id, key };
    });
}

export function loadConfig(env: Record<string, string | undefined> = process.env): Config {
  const parsed = envSchema.safeParse(env);
  if (!parsed.success) {
    const issues = parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ');
    throw new ConfigError(`Invalid configuration: ${issues}`);
  }
  const e = parsed.data;
  const production = e.NODE_ENV === 'production';

  if (production && !e.DATABASE_URL) throw new ConfigError('DATABASE_URL is required in production');
  if (production && !e.ENCRYPTION_KEYS) throw new ConfigError('ENCRYPTION_KEYS is required in production');
  if (e.EXECUTIONS_MODE === 'queue' && !e.REDIS_URL) {
    throw new ConfigError('REDIS_URL is required when EXECUTIONS_MODE=queue');
  }
  if (e.BINARY_DATA_MODE === 's3') {
    throw new ConfigError('BINARY_DATA_MODE=s3 is not supported by this build; use filesystem or inline');
  }

  const encryptionKeys = e.ENCRYPTION_KEYS ? parseEncryptionKeys(e.ENCRYPTION_KEYS) : [devKey()];
  if (!encryptionKeys.length) throw new ConfigError('ENCRYPTION_KEYS does not contain any key');

  const baseUrl = e.BASE_URL.replace(/\/+$/, '');
  const origins = new Set<string>([new URL(baseUrl).origin]);
  for (const o of e.CORS_ORIGINS) {
    try {
      origins.add(new URL(o).origin);
    } catch {
      throw new ConfigError(`CORS_ORIGINS contains an invalid origin "${o}"`);
    }
  }

  return {
    env: e.NODE_ENV,
    port: e.PORT,
    host: e.HOST,
    baseUrl,
    databaseUrl:
      e.DATABASE_URL ??
      (e.NODE_ENV === 'test'
        ? 'postgres://postgres:postgres@127.0.0.1:5432/workflow_test'
        : 'postgres://postgres:postgres@127.0.0.1:5432/workflow_dev'),
    redisUrl: e.REDIS_URL,
    executionsMode: e.EXECUTIONS_MODE,
    encryptionKeys,
    binaryData: { mode: e.BINARY_DATA_MODE, dir: path.resolve(e.BINARY_DATA_DIR) },
    ssrf: { enabled: e.SSRF_PROTECTION, allow: e.SSRF_ALLOW, deny: e.SSRF_DENY },
    code: { memoryMb: e.CODE_MEMORY_MB, timeoutMs: e.CODE_TIMEOUT_MS },
    executionTimeout: {
      defaultS: e.EXECUTION_TIMEOUT_DEFAULT_S,
      maxS: Math.max(e.EXECUTION_TIMEOUT_MAX_S, e.EXECUTION_TIMEOUT_DEFAULT_S),
    },
    pruneDays: e.EXECUTIONS_PRUNE_DAYS,
    signupEnabled: e.SIGNUP_ENABLED,
    brand: { name: e.BRAND_NAME, logoUrl: e.BRAND_LOGO_URL, primaryColor: e.BRAND_PRIMARY_COLOR },
    defaultTimezone: e.DEFAULT_TIMEZONE,
    defaultPlan: e.DEFAULT_PLAN,
    logLevel: e.LOG_LEVEL,
    allowedOrigins: [...origins],
    bodyLimitBytes: e.BODY_LIMIT_MB * 1024 * 1024,
    queue: { concurrency: e.QUEUE_CONCURRENCY, prefix: e.QUEUE_PREFIX },
    loginRateLimit: { max: e.LOGIN_RATE_LIMIT_MAX, windowMs: e.LOGIN_RATE_LIMIT_WINDOW_MS },
    waitTrackerIntervalMs: e.WAIT_TRACKER_INTERVAL_MS,
    metricsToken: e.METRICS_TOKEN,
    editorDist: path.resolve(e.EDITOR_DIST ?? path.join(PACKAGE_DIR, '..', 'editor', 'dist')),
    trustProxy: e.TRUST_PROXY,
    cookieSecure: baseUrl.startsWith('https://'),
  };
}

export const packageDir = PACKAGE_DIR;
