/**
 * Server configuration, read from the environment and validated with zod (ARCHITECTURE.md §15).
 * Production fails fast on missing secrets; development gets safe local defaults.
 */
import { createHash } from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { MasterKey } from '@workflow/core';
import { type CallerPolicy, type InstanceLimits, MAX_EVALUATION_CONCURRENCY } from '@workflow/workflow';
import { z } from 'zod';
import type { PublicApiRateLimit } from './plans';

const PACKAGE_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

const bool = (fallback: boolean) =>
  z
    .enum(['true', 'false', '1', '0', 'yes', 'no'])
    .optional()
    .transform((v) => (v === undefined ? fallback : ['true', '1', 'yes'].includes(v)));

/** a flag with no default: unset stays undefined, so a saved setting or a later fallback decides */
const optionalBool = z
  .enum(['true', 'false', '1', '0', 'yes', 'no'])
  .optional()
  .transform((v) => (v === undefined ? undefined : ['true', '1', 'yes'].includes(v)));

const list = z
  .string()
  .optional()
  .transform((v) =>
    (v ?? '')
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean),
  );

/** a comma list with a default; an empty value means an empty list, not the default */
const listOr = (fallback: string[]) =>
  z
    .string()
    .optional()
    .transform((v) =>
      v === undefined
        ? fallback
        : v
            .split(',')
            .map((s) => s.trim())
            .filter(Boolean),
    );

const MB = 1024 * 1024;

/** n8n's N8N_RUNNERS_BUILTINS_DENY default */
const PYTHON_BUILTINS_DENY = [
  'eval',
  'exec',
  'compile',
  'open',
  'input',
  'breakpoint',
  'getattr',
  'object',
  'type',
  'vars',
  'setattr',
  'delattr',
  'hasattr',
  'dir',
  'memoryview',
  '__build_class__',
  'globals',
  'locals',
  'license',
  'help',
  'credits',
  'copyright',
];

const int = (fallback: number, min = 0) => z.coerce.number().int().min(min).default(fallback);
/** a non-negative number that may have a fraction (e.g. 0.25 hours) */
const num = (fallback: number) => z.coerce.number().min(0).default(fallback);
/** one URL path segment (letters, digits, `-`, `_`), as the MCP trigger endpoints */
/** P6-47: a JSON array of strings (n8n's NODES_EXCLUDE, NODES_INCLUDE); unset or bad JSON gives an empty list */
const jsonList = z
  .string()
  .optional()
  .transform((v) => {
    if (!v?.trim()) return [];
    try {
      const parsed: unknown = JSON.parse(v);
      return Array.isArray(parsed)
        ? parsed.filter((x): x is string => typeof x === 'string' && x !== '')
        : [];
    } catch {
      return [];
    }
  });

/** P6-05: INSIGHTS_MAX_AGE_DAYS as n8n: -1 or over 730 gives 730; under 1 or not a number gives 365 */
const insightsMaxAgeDays = z
  .string()
  .optional()
  .transform((v) => {
    const n = v === undefined || v.trim() === '' ? Number.NaN : Number(v);
    if (Number.isNaN(n)) return 365;
    if (n === -1 || n > 730) return 730;
    if (n < 1) return 365;
    return Math.floor(n);
  });

const endpointSegment = (fallback: string) =>
  z
    .string()
    .regex(/^[A-Za-z0-9_-]+$/, 'must be one path segment of letters, digits, - or _')
    .default(fallback);

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
  /** size caps for file, archive, image and spreadsheet nodes (`helpers.getInstanceLimits()`) */
  NODE_DECOMPRESS_MAX_MB: int(100, 1),
  NODE_ARCHIVE_MAX_ENTRIES: int(1000, 1),
  NODE_IMAGE_MAX_MEGAPIXELS: int(50, 1),
  NODE_IMAGE_MAX_INPUT_MB: int(25, 1),
  NODE_SHEET_MAX_CELLS: int(1_000_000, 1),
  NODE_REMOTE_FILE_MAX_MB: int(100, 1),
  /** P5-78: the largest file the Agent passes on to its model, in bytes */
  AI_AGENT_MAX_PASSTHROUGH_BINARY_SIZE_BYTES: int(52_428_800, 1),
  /** seconds a schedule slot may be late before it counts as missed (a node setting >= 1 replaces it) */
  SCHEDULE_MISFIRE_GRACE_S: int(60, 0),
  /** P3-17: turns the editor's autosave off (GET /settings autosaveEnabled) */
  WORKFLOWS_AUTOSAVE_DISABLED: bool(false),
  /** P3-18 version history compaction, n8n's settings with a WORKFLOW_HISTORY_ prefix (numbers, 0.25 allowed) */
  WORKFLOW_HISTORY_OPTIMIZING_MINIMUM_AGE_HOURS: num(0.25),
  WORKFLOW_HISTORY_OPTIMIZING_TIME_WINDOW_HOURS: num(2),
  WORKFLOW_HISTORY_TRIMMING_MINIMUM_AGE_DAYS: num(6),
  WORKFLOW_HISTORY_TRIMMING_TIME_WINDOW_DAYS: num(2),
  WORKFLOW_HISTORY_COMPACTION_BATCH_SIZE: num(100),
  WORKFLOW_HISTORY_COMPACTION_BATCH_DELAY_MS: num(1000),
  /** P4-03 data tables, per workspace (n8n: per instance); a plan may override the size (dataTableBytes) */
  DATA_TABLES_MAX_SIZE_BYTES: int(200 * MB, 1),
  /** default: 80% of the max */
  DATA_TABLES_WARNING_THRESHOLD_BYTES: z.coerce.number().int().min(0).optional(),
  DATA_TABLES_SIZE_CHECK_CACHE_DURATION_MS: int(5000, 0),
  /** default: remaining space (see dataTableUploadLimitBytes) */
  DATA_TABLES_UPLOAD_MAX_FILE_SIZE_BYTES: z.coerce.number().int().min(1).optional(),
  /** P4-06 native Python, n8n's N8N_RUNNERS_* settings without the prefix */
  PYTHON_ENABLED: bool(true),
  RUNNERS_STDLIB_ALLOW: list,
  RUNNERS_EXTERNAL_ALLOW: list,
  RUNNERS_BUILTINS_DENY: listOr(PYTHON_BUILTINS_DENY),
  RUNNERS_ALLOW_TRANSITIVE_IMPORTS: bool(false),
  RUNNERS_MAX_CONCURRENCY: int(5, 1),
  /** ours, forced by Pyodide: a folder of pure-Python wheels */
  RUNNERS_PYTHON_WHEELS_DIR: z.string().default(''),
  /** P4-07 external secrets, seconds */
  EXTERNAL_SECRETS_UPDATE_INTERVAL: int(300, 1),
  EXTERNAL_SECRETS_CONNECT_TIMEOUT: int(20, 1),
  EXTERNAL_SECRETS_REFRESH_TIMEOUT: int(20, 1),
  EXTERNAL_SECRETS_PREFER_GET: bool(false),
  /** P5-56: directory of the built chat widget (chat.js, chat.css) */
  CHAT_WIDGET_DIST: z.string().optional(),
  /** P5-56: when true, hosted and public chat trigger URLs answer 404 */
  DISABLE_PUBLIC_CHAT_TRIGGER: bool(false),
  /** P5-02: evaluation cases run at once per workspace; read as at most 10 */
  CONCURRENCY_EVALUATION_LIMIT: int(5, 1),
  /**
   * P6-25: the caller policy of a workflow whose settings name none (n8n's
   * WORKFLOW_CALLER_POLICY_DEFAULT_OPTION, default same project); an explicit setting always wins
   */
  WORKFLOW_CALLER_POLICY_DEFAULT_OPTION: z
    .enum(['any', 'none', 'sameProject', 'allowList'] satisfies CallerPolicy[])
    .default('sameProject'),
  /** P5-04: the public origin MCP clients reach (default BASE_URL); its host is the only one MCP routes accept */
  MCP_BASE_URL: z.url().optional(),
  /** P5-04: when true, MCP access is set by MCP_ACCESS_ENABLED and the settings page cannot change it */
  MCP_MANAGED_BY_ENV: bool(false),
  MCP_ACCESS_ENABLED: bool(false),
  /** P5-13: the build tools of the MCP server */
  MCP_BUILDER_ENABLED: bool(true),
  /** P5-14: OAuth clients per workspace */
  MCP_MAX_REGISTERED_CLIENTS: int(5000, 1),
  /** P5-03: path segments of the MCP Server Trigger's production and test URLs */
  ENDPOINT_MCP: endpointSegment('mcp'),
  ENDPOINT_MCP_TEST: endpointSegment('mcp-test'),
  /** P5-03, P5-04: an MCP session unused this long is closed; the sweep runs every interval */
  MCP_SERVER_SESSION_IDLE_TTL_MS: int(900000, 1),
  MCP_SERVER_SESSION_SWEEP_INTERVAL_MS: int(300000, 1),
  /** P5-04: requests per window and client on the MCP server */
  MCP_SERVER_RATE_LIMIT: int(100, 1),
  /** P5-14: requests per 5 minutes and client on each OAuth server route */
  OAUTH_SERVER_REGISTER_RATE_LIMIT: int(10, 1),
  OAUTH_SERVER_AUTHORIZE_RATE_LIMIT: int(50, 1),
  OAUTH_SERVER_TOKEN_RATE_LIMIT: int(20, 1),
  OAUTH_SERVER_REVOKE_RATE_LIMIT: int(30, 1),
  OAUTH_SERVER_WELL_KNOWN_RATE_LIMIT: int(100, 1),
  /** P5-09: the AI workflow builder; off by default as n8n (`make start` turns it on) */
  AI_ENABLED: bool(false),
  /** P5-09: the longest builder turn, seconds */
  AI_TIMEOUT_MAX: int(3600, 1),
  /** P5-09: when false, parameter values are not sent to the model */
  AI_ALLOW_SENDING_PARAMETER_VALUES: bool(true),
  /** P5-67: the Assistant; unset leaves it to the workspace setting (default on, as n8n's community) */
  INSTANCE_AI_ENABLED: optionalBool,
  /** P5-68: how long a confirmation card waits, ms; 0 = no timeout */
  INSTANCE_AI_CONFIRMATION_TIMEOUT: int(86_400_000),
  /** P5-67: threads not updated for this many days are deleted; 0 = never */
  INSTANCE_AI_THREAD_TTL_DAYS: int(30),
  /** P5-67: how often the thread TTL prune runs, ms; 0 = off */
  INSTANCE_AI_PRUNE_INTERVAL: int(3_600_000),
  /** P5-67: estimated message tokens that start a compaction into observations */
  INSTANCE_AI_OBSERVER_MESSAGE_TOKENS: int(30_000, 1),
  /** P5-67: estimated observation tokens that start a second, condensing call */
  INSTANCE_AI_REFLECTOR_OBSERVATION_TOKENS: int(40_000, 1),
  /** P5-67: concurrent Assistant runs on the instance; -1 = no limit */
  INSTANCE_AI_MAX_CONCURRENT_RUNS: int(-1, -1),
  /** P5-67: concurrent Assistant runs per user; -1 = no limit */
  INSTANCE_AI_MAX_CONCURRENT_RUNS_PER_USER: int(-1, -1),
  /** P5-67: a model stream silent this long (ms) is a stall; 0 = off */
  AI_MODEL_STREAM_IDLE_TIMEOUT_MS: int(90_000),
  /** P5-67: a model stream with no output this long (ms) after the request is a stall; 0 = off */
  AI_MODEL_STREAM_FIRST_OUTPUT_TIMEOUT_MS: int(180_000),
  /** P6-17: mail of the user management (n8n's N8N_EMAIL_MODE, N8N_SMTP_*); '' turns mail off */
  EMAIL_MODE: z.enum(['', 'smtp']).default('smtp'),
  SMTP_HOST: z.string().default(''),
  SMTP_PORT: int(465, 1),
  SMTP_SSL: bool(true),
  SMTP_STARTTLS: bool(true),
  SMTP_USER: z.string().default(''),
  SMTP_PASS: z.string().default(''),
  SMTP_SENDER: z.string().default(''),
  /** P6-17: a service account (client email) and its private key; the token is fetched through ctx.http */
  SMTP_OAUTH_SERVICE_CLIENT: z.string().default(''),
  SMTP_OAUTH_PRIVATE_KEY: z.string().default(''),
  /** P6-17: a file that replaces one mail template (n8n's N8N_UM_EMAIL_TEMPLATES_*); values stay escaped */
  UM_EMAIL_TEMPLATES_INVITE: z.string().default(''),
  UM_EMAIL_TEMPLATES_PWRESET: z.string().default(''),
  UM_EMAIL_TEMPLATES_WORKFLOW_SHARED: z.string().default(''),
  UM_EMAIL_TEMPLATES_CREDENTIALS_SHARED: z.string().default(''),
  UM_EMAIL_TEMPLATES_PROJECT_SHARED: z.string().default(''),
  UM_EMAIL_TEMPLATES_WORKFLOW_FAILURE: z.string().default(''),
  UM_EMAIL_TEMPLATES_API_KEY_REVOKED: z.string().default(''),
  UM_EMAIL_TEMPLATES_MCP_CLIENT_REVOKED: z.string().default(''),
  UM_EMAIL_TEMPLATES_EMAIL_CHANGE_REQUESTED: z.string().default(''),
  UM_EMAIL_TEMPLATES_EMAIL_CHANGE_COMPLETED: z.string().default(''),
  /** P6-20: when true, an invite answers no link; the link goes out only by mail */
  INVITE_LINKS_EMAIL_ONLY: bool(false),
  /** P6-18: when false, MFA cannot be set up and is not asked at sign-in */
  MFA_ENABLED: bool(true),
  /** when true, /api/v1 is not registered (404) */
  PUBLIC_API_DISABLED: bool(false),
  /** the session cookie and row lifetime in hours (n8n: 336, 14 days) */
  USER_MANAGEMENT_JWT_DURATION_HOURS: z.coerce.number().positive().default(336),
  /** P6-02: the SCIM rate limit, requests per IP per 5 minutes; 0 turns it off (as n8n) */
  SCIM_RATE_LIMIT: int(600, 0),
  /** P6-01: when true, the sign-in page sends a workspace with SSO on to its identity provider */
  SSO_REDIRECT_LOGIN_TO_SSO: bool(true),
  /** P6-47: node types left out of (or the only ones in) the registry, JSON arrays as n8n's */
  NODES_EXCLUDE: jsonList,
  NODES_INCLUDE: jsonList,
  /** P6-52: refuse adding or editing a deprecated node (on by default) */
  DEPRECATED_NODES_BLOCK: bool(true),
  /** P6-54: a workflow not run in this many days counts as abandoned in the security audit */
  SECURITY_AUDIT_DAYS_ABANDONED_WORKFLOW: int(90, 1),
  /** P6-05: n8n's N8N_INSIGHTS_* (names less `N8N_`, same defaults); platform level */
  INSIGHTS_COMPACTION_INTERVAL_MINUTES: int(60, 1),
  INSIGHTS_COMPACTION_BATCH_SIZE: int(500, 1),
  INSIGHTS_COMPACTION_HOURLY_TO_DAILY_THRESHOLD_DAYS: int(90, 1),
  INSIGHTS_COMPACTION_DAILY_TO_WEEKLY_THRESHOLD_DAYS: int(180, 1),
  INSIGHTS_FLUSH_BATCH_SIZE: int(1000, 1),
  INSIGHTS_FLUSH_INTERVAL_SECONDS: int(30, 1),
  INSIGHTS_MAX_AGE_DAYS: insightsMaxAgeDays,
  INSIGHTS_PRUNE_CHECK_INTERVAL_HOURS: int(24, 1),
  /** 0 = no bound */
  INSIGHTS_COMPACTION_MAX_BATCHES_PER_RUN: int(1000, 0),
  /** 0 = no bound */
  INSIGHTS_COMPACTION_MAX_RUNTIME_SECONDS: int(300, 0),
  INSIGHTS_COMPACTION_BATCH_DELAY_MILLISECONDS: int(100, 0),
  /** P6-83: the platform defaults of a workspace's public API rate limits (0 = no limit, windows in seconds) */
  PUBLIC_API_RATE_LIMIT_ENABLED: bool(false),
  PUBLIC_API_RATE_LIMIT_GLOBAL_READ_LIMIT: int(1200, 0),
  PUBLIC_API_RATE_LIMIT_GLOBAL_READ_WINDOW: int(60, 1),
  PUBLIC_API_RATE_LIMIT_GLOBAL_WRITE_LIMIT: int(600, 0),
  PUBLIC_API_RATE_LIMIT_GLOBAL_WRITE_WINDOW: int(60, 1),
  PUBLIC_API_RATE_LIMIT_ENDPOINT_READ_LIMIT: int(1000, 0),
  PUBLIC_API_RATE_LIMIT_ENDPOINT_READ_WINDOW: int(60, 1),
  PUBLIC_API_RATE_LIMIT_ENDPOINT_WRITE_LIMIT: int(500, 0),
  PUBLIC_API_RATE_LIMIT_ENDPOINT_WRITE_WINDOW: int(60, 1),
  /** P6-S4 (L2): n8n's N8N_SOURCECONTROL_DEFAULT_SSH_KEY_TYPE (name less `N8N_`); any other value is a ConfigError */
  SOURCECONTROL_DEFAULT_SSH_KEY_TYPE: z.enum(['ed25519', 'rsa']).default('ed25519'),
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
  /** instance size caps handed to nodes through ExecutionServices.nodeLimits */
  nodeLimits: InstanceLimits;
  /** default misfire grace of the Schedule Trigger in seconds */
  scheduleMisfireGraceS: number;
  /** P3-17: WORKFLOWS_AUTOSAVE_DISABLED */
  autosaveDisabled: boolean;
  /** P3-18: WORKFLOW_HISTORY_* compaction settings */
  historyCompaction: {
    optimizingMinimumAgeHours: number;
    optimizingTimeWindowHours: number;
    trimmingMinimumAgeDays: number;
    trimmingTimeWindowDays: number;
    batchSize: number;
    batchDelayMs: number;
  };
  /** P4-03: DATA_TABLES_* */
  dataTables: {
    maxSizeBytes: number;
    warningThresholdBytes: number;
    sizeCheckCacheDurationMs: number;
    /** undefined = remaining space; read it through dataTableUploadLimitBytes */
    uploadMaxFileSizeBytes: number | undefined;
  };
  /** P4-06: PYTHON_ENABLED and RUNNERS_* */
  python: {
    enabled: boolean;
    stdlibAllow: string[];
    externalAllow: string[];
    builtinsDeny: string[];
    allowTransitiveImports: boolean;
    maxConcurrency: number;
    /** '' = no wheels folder */
    wheelsDir: string;
  };
  /** P4-07: EXTERNAL_SECRETS_* */
  externalSecrets: {
    updateIntervalS: number;
    connectTimeoutS: number;
    refreshTimeoutS: number;
    preferGet: boolean;
  };
  /** P5-56: CHAT_WIDGET_DIST, the built widget served at /chat-widget */
  chatWidgetDist: string;
  /** P5-56: DISABLE_PUBLIC_CHAT_TRIGGER */
  disablePublicChatTrigger: boolean;
  /** P5-02: CONCURRENCY_EVALUATION_LIMIT, 1 to 10 (MAX_EVALUATION_CONCURRENCY) */
  evaluationConcurrencyLimit: number;
  /** P6-25: WORKFLOW_CALLER_POLICY_DEFAULT_OPTION, for a workflow with no `callerPolicy` (L5 reads it) */
  workflowCallerPolicyDefault: CallerPolicy;
  /** P5-03, P5-04, P5-13, P5-14: MCP_*, ENDPOINT_MCP*, OAUTH_SERVER_* */
  mcp: {
    /** MCP_BASE_URL or baseUrl, without trailing slash; MCP URLs and the Host check use it */
    baseUrl: string;
    managedByEnv: boolean;
    accessEnabled: boolean;
    builderEnabled: boolean;
    /** per workspace */
    maxRegisteredClients: number;
    /** ENDPOINT_MCP, one path segment */
    endpoint: string;
    /** ENDPOINT_MCP_TEST, one path segment */
    endpointTest: string;
    sessionIdleTtlMs: number;
    sessionSweepMs: number;
    /** MCP_SERVER_RATE_LIMIT */
    rateLimit: number;
    /** OAUTH_SERVER_*_RATE_LIMIT, requests per 5 minutes */
    oauthRateLimits: {
      register: number;
      authorize: number;
      token: number;
      revoke: number;
      wellKnown: number;
    };
  };
  /** P5-09: AI_* */
  ai: {
    enabled: boolean;
    /** AI_TIMEOUT_MAX, seconds */
    timeoutMaxS: number;
    allowSendingParameterValues: boolean;
  };
  /** P5-67: INSTANCE_AI_* and AI_MODEL_STREAM_* */
  assistant: {
    /** INSTANCE_AI_ENABLED; undefined when unset (the workspace setting, then on, decides) */
    enabled: boolean | undefined;
    /** ms a card waits; 0 = no timeout */
    confirmationTimeoutMs: number;
    /** 0 = threads are never pruned */
    threadTtlDays: number;
    /** ms between thread prunes; 0 = off */
    pruneIntervalMs: number;
    observerMessageTokens: number;
    reflectorObservationTokens: number;
    /** -1 = no limit */
    maxConcurrentRuns: number;
    /** -1 = no limit */
    maxConcurrentRunsPerUser: number;
    /** ms; 0 = off */
    streamIdleTimeoutMs: number;
    /** ms; 0 = off */
    streamFirstOutputTimeoutMs: number;
  };
  /** P6-17: EMAIL_MODE, SMTP_*, UM_EMAIL_TEMPLATES_* (the Mailer reads it) */
  mail: MailConfig;
  /** P6-18: MFA_ENABLED */
  mfaEnabled: boolean;
  /** PUBLIC_API_DISABLED */
  publicApiDisabled: boolean;
  /** USER_MANAGEMENT_JWT_DURATION_HOURS in ms; session rows and the cookie live this long */
  sessionTtlMs: number;
  /** P6-02: SCIM_RATE_LIMIT, requests per IP per 5 minutes; 0 = off */
  scimRateLimit: number;
  /** P6-01: SSO_REDIRECT_LOGIN_TO_SSO */
  ssoRedirectLogin: boolean;
  /** P6-20: INVITE_LINKS_EMAIL_ONLY */
  inviteLinksEmailOnly: boolean;
  /**
   * P6-47 (L3): NODES_EXCLUDE, NODES_INCLUDE; `buildRegistries(packages, config.nodes)` applies them
   * (an empty `include` means every type)
   */
  nodes: { exclude: string[]; include: string[] };
  /** P6-52 (L7): DEPRECATED_NODES_BLOCK */
  deprecatedNodesBlock: boolean;
  /** P6-54 (L9): SECURITY_AUDIT_DAYS_ABANDONED_WORKFLOW (a request's `daysAbandonedWorkflow` wins) */
  securityAudit: { daysAbandonedWorkflow: number };
  /** P6-05 (L11): INSIGHTS_* */
  insights: InsightsConfig;
  /** P6-83 (L15): PUBLIC_API_RATE_LIMIT_*, the defaults under a workspace's `publicApiRateLimit` */
  publicApiRateLimit: PublicApiRateLimit;
  /** P6-S4 (L2): SOURCECONTROL_DEFAULT_SSH_KEY_TYPE, the key type `generateKeyPair` uses when none is given */
  sourceControl: { defaultKeyType: 'ed25519' | 'rsa' };
}

/** P6-05: the insights collector, compaction and prune bounds (n8n's insights.config.ts names) */
export interface InsightsConfig {
  compactionIntervalMinutes: number;
  compactionBatchSize: number;
  compactionHourlyToDailyThresholdDays: number;
  compactionDailyToWeeklyThresholdDays: number;
  flushBatchSize: number;
  flushIntervalSeconds: number;
  /** 1..730 */
  maxAgeDays: number;
  pruneCheckIntervalHours: number;
  /** 0 = no bound */
  compactionMaxBatchesPerRun: number;
  /** 0 = no bound */
  compactionMaxRuntimeSeconds: number;
  compactionBatchDelayMilliseconds: number;
}

/** P6-17: the mail templates a file may replace (UM_EMAIL_TEMPLATES_*) */
export type MailTemplateName =
  | 'invite'
  | 'passwordReset'
  | 'workflowShared'
  | 'credentialShared'
  | 'projectShared'
  | 'workflowFailure'
  | 'apiKeyRevoked'
  | 'mcpClientRevoked'
  | 'emailChangeRequested'
  | 'emailChangeCompleted';

export interface MailConfig {
  /** EMAIL_MODE; '' turns mail off */
  mode: '' | 'smtp';
  smtp: {
    /** '' = not set up */
    host: string;
    port: number;
    ssl: boolean;
    startTls: boolean;
    user: string;
    pass: string;
    /** the From address */
    sender: string;
    /** SMTP_OAUTH_SERVICE_CLIENT, '' = none */
    oauthServiceClient: string;
    /** SMTP_OAUTH_PRIVATE_KEY, '' = none; never logged */
    oauthPrivateKey: string;
  };
  /** a file path per template; an absent key keeps the built-in template */
  templates: Partial<Record<MailTemplateName, string>>;
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

  if (e.ENDPOINT_MCP === e.ENDPOINT_MCP_TEST) {
    throw new ConfigError('ENDPOINT_MCP and ENDPOINT_MCP_TEST must differ');
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
    nodeLimits: {
      maxDecompressedBytes: e.NODE_DECOMPRESS_MAX_MB * MB,
      maxArchiveEntries: e.NODE_ARCHIVE_MAX_ENTRIES,
      maxImagePixels: e.NODE_IMAGE_MAX_MEGAPIXELS * 1_000_000,
      maxImageInputBytes: e.NODE_IMAGE_MAX_INPUT_MB * MB,
      maxSpreadsheetCells: e.NODE_SHEET_MAX_CELLS,
      maxRemoteFileBytes: e.NODE_REMOTE_FILE_MAX_MB * MB,
      maxPassthroughBinaryBytes: e.AI_AGENT_MAX_PASSTHROUGH_BINARY_SIZE_BYTES,
    },
    scheduleMisfireGraceS: e.SCHEDULE_MISFIRE_GRACE_S,
    autosaveDisabled: e.WORKFLOWS_AUTOSAVE_DISABLED,
    historyCompaction: {
      optimizingMinimumAgeHours: e.WORKFLOW_HISTORY_OPTIMIZING_MINIMUM_AGE_HOURS,
      optimizingTimeWindowHours: e.WORKFLOW_HISTORY_OPTIMIZING_TIME_WINDOW_HOURS,
      trimmingMinimumAgeDays: e.WORKFLOW_HISTORY_TRIMMING_MINIMUM_AGE_DAYS,
      trimmingTimeWindowDays: e.WORKFLOW_HISTORY_TRIMMING_TIME_WINDOW_DAYS,
      batchSize: e.WORKFLOW_HISTORY_COMPACTION_BATCH_SIZE,
      batchDelayMs: e.WORKFLOW_HISTORY_COMPACTION_BATCH_DELAY_MS,
    },
    dataTables: {
      maxSizeBytes: e.DATA_TABLES_MAX_SIZE_BYTES,
      warningThresholdBytes:
        e.DATA_TABLES_WARNING_THRESHOLD_BYTES ?? Math.floor(e.DATA_TABLES_MAX_SIZE_BYTES * 0.8),
      sizeCheckCacheDurationMs: e.DATA_TABLES_SIZE_CHECK_CACHE_DURATION_MS,
      uploadMaxFileSizeBytes: e.DATA_TABLES_UPLOAD_MAX_FILE_SIZE_BYTES,
    },
    python: {
      enabled: e.PYTHON_ENABLED,
      stdlibAllow: e.RUNNERS_STDLIB_ALLOW,
      externalAllow: e.RUNNERS_EXTERNAL_ALLOW,
      builtinsDeny: e.RUNNERS_BUILTINS_DENY,
      allowTransitiveImports: e.RUNNERS_ALLOW_TRANSITIVE_IMPORTS,
      maxConcurrency: e.RUNNERS_MAX_CONCURRENCY,
      wheelsDir: e.RUNNERS_PYTHON_WHEELS_DIR && path.resolve(e.RUNNERS_PYTHON_WHEELS_DIR),
    },
    externalSecrets: {
      updateIntervalS: e.EXTERNAL_SECRETS_UPDATE_INTERVAL,
      connectTimeoutS: e.EXTERNAL_SECRETS_CONNECT_TIMEOUT,
      refreshTimeoutS: e.EXTERNAL_SECRETS_REFRESH_TIMEOUT,
      preferGet: e.EXTERNAL_SECRETS_PREFER_GET,
    },
    chatWidgetDist: path.resolve(e.CHAT_WIDGET_DIST ?? path.join(PACKAGE_DIR, '..', 'chat-widget', 'dist')),
    disablePublicChatTrigger: e.DISABLE_PUBLIC_CHAT_TRIGGER,
    evaluationConcurrencyLimit: Math.min(e.CONCURRENCY_EVALUATION_LIMIT, MAX_EVALUATION_CONCURRENCY),
    workflowCallerPolicyDefault: e.WORKFLOW_CALLER_POLICY_DEFAULT_OPTION,
    mcp: {
      baseUrl: e.MCP_BASE_URL ? e.MCP_BASE_URL.replace(/\/+$/, '') : baseUrl,
      managedByEnv: e.MCP_MANAGED_BY_ENV,
      accessEnabled: e.MCP_ACCESS_ENABLED,
      builderEnabled: e.MCP_BUILDER_ENABLED,
      maxRegisteredClients: e.MCP_MAX_REGISTERED_CLIENTS,
      endpoint: e.ENDPOINT_MCP,
      endpointTest: e.ENDPOINT_MCP_TEST,
      sessionIdleTtlMs: e.MCP_SERVER_SESSION_IDLE_TTL_MS,
      sessionSweepMs: e.MCP_SERVER_SESSION_SWEEP_INTERVAL_MS,
      rateLimit: e.MCP_SERVER_RATE_LIMIT,
      oauthRateLimits: {
        register: e.OAUTH_SERVER_REGISTER_RATE_LIMIT,
        authorize: e.OAUTH_SERVER_AUTHORIZE_RATE_LIMIT,
        token: e.OAUTH_SERVER_TOKEN_RATE_LIMIT,
        revoke: e.OAUTH_SERVER_REVOKE_RATE_LIMIT,
        wellKnown: e.OAUTH_SERVER_WELL_KNOWN_RATE_LIMIT,
      },
    },
    ai: {
      enabled: e.AI_ENABLED,
      timeoutMaxS: e.AI_TIMEOUT_MAX,
      allowSendingParameterValues: e.AI_ALLOW_SENDING_PARAMETER_VALUES,
    },
    assistant: {
      enabled: e.INSTANCE_AI_ENABLED,
      confirmationTimeoutMs: e.INSTANCE_AI_CONFIRMATION_TIMEOUT,
      threadTtlDays: e.INSTANCE_AI_THREAD_TTL_DAYS,
      pruneIntervalMs: e.INSTANCE_AI_PRUNE_INTERVAL,
      observerMessageTokens: e.INSTANCE_AI_OBSERVER_MESSAGE_TOKENS,
      reflectorObservationTokens: e.INSTANCE_AI_REFLECTOR_OBSERVATION_TOKENS,
      maxConcurrentRuns: e.INSTANCE_AI_MAX_CONCURRENT_RUNS,
      maxConcurrentRunsPerUser: e.INSTANCE_AI_MAX_CONCURRENT_RUNS_PER_USER,
      streamIdleTimeoutMs: e.AI_MODEL_STREAM_IDLE_TIMEOUT_MS,
      streamFirstOutputTimeoutMs: e.AI_MODEL_STREAM_FIRST_OUTPUT_TIMEOUT_MS,
    },
    mail: {
      mode: e.EMAIL_MODE,
      smtp: {
        host: e.SMTP_HOST,
        port: e.SMTP_PORT,
        ssl: e.SMTP_SSL,
        startTls: e.SMTP_STARTTLS,
        user: e.SMTP_USER,
        pass: e.SMTP_PASS,
        sender: e.SMTP_SENDER,
        oauthServiceClient: e.SMTP_OAUTH_SERVICE_CLIENT,
        oauthPrivateKey: e.SMTP_OAUTH_PRIVATE_KEY,
      },
      templates: mailTemplates({
        invite: e.UM_EMAIL_TEMPLATES_INVITE,
        passwordReset: e.UM_EMAIL_TEMPLATES_PWRESET,
        workflowShared: e.UM_EMAIL_TEMPLATES_WORKFLOW_SHARED,
        credentialShared: e.UM_EMAIL_TEMPLATES_CREDENTIALS_SHARED,
        projectShared: e.UM_EMAIL_TEMPLATES_PROJECT_SHARED,
        workflowFailure: e.UM_EMAIL_TEMPLATES_WORKFLOW_FAILURE,
        apiKeyRevoked: e.UM_EMAIL_TEMPLATES_API_KEY_REVOKED,
        mcpClientRevoked: e.UM_EMAIL_TEMPLATES_MCP_CLIENT_REVOKED,
        emailChangeRequested: e.UM_EMAIL_TEMPLATES_EMAIL_CHANGE_REQUESTED,
        emailChangeCompleted: e.UM_EMAIL_TEMPLATES_EMAIL_CHANGE_COMPLETED,
      }),
    },
    mfaEnabled: e.MFA_ENABLED,
    publicApiDisabled: e.PUBLIC_API_DISABLED,
    sessionTtlMs: Math.round(e.USER_MANAGEMENT_JWT_DURATION_HOURS * 60 * 60 * 1000),
    scimRateLimit: e.SCIM_RATE_LIMIT,
    ssoRedirectLogin: e.SSO_REDIRECT_LOGIN_TO_SSO,
    inviteLinksEmailOnly: e.INVITE_LINKS_EMAIL_ONLY,
    nodes: { exclude: e.NODES_EXCLUDE, include: e.NODES_INCLUDE },
    deprecatedNodesBlock: e.DEPRECATED_NODES_BLOCK,
    securityAudit: { daysAbandonedWorkflow: e.SECURITY_AUDIT_DAYS_ABANDONED_WORKFLOW },
    insights: {
      compactionIntervalMinutes: e.INSIGHTS_COMPACTION_INTERVAL_MINUTES,
      compactionBatchSize: e.INSIGHTS_COMPACTION_BATCH_SIZE,
      compactionHourlyToDailyThresholdDays: e.INSIGHTS_COMPACTION_HOURLY_TO_DAILY_THRESHOLD_DAYS,
      compactionDailyToWeeklyThresholdDays: e.INSIGHTS_COMPACTION_DAILY_TO_WEEKLY_THRESHOLD_DAYS,
      flushBatchSize: e.INSIGHTS_FLUSH_BATCH_SIZE,
      flushIntervalSeconds: e.INSIGHTS_FLUSH_INTERVAL_SECONDS,
      maxAgeDays: e.INSIGHTS_MAX_AGE_DAYS,
      pruneCheckIntervalHours: e.INSIGHTS_PRUNE_CHECK_INTERVAL_HOURS,
      compactionMaxBatchesPerRun: e.INSIGHTS_COMPACTION_MAX_BATCHES_PER_RUN,
      compactionMaxRuntimeSeconds: e.INSIGHTS_COMPACTION_MAX_RUNTIME_SECONDS,
      compactionBatchDelayMilliseconds: e.INSIGHTS_COMPACTION_BATCH_DELAY_MILLISECONDS,
    },
    publicApiRateLimit: {
      enabled: e.PUBLIC_API_RATE_LIMIT_ENABLED,
      globalReadLimit: e.PUBLIC_API_RATE_LIMIT_GLOBAL_READ_LIMIT,
      globalReadWindow: e.PUBLIC_API_RATE_LIMIT_GLOBAL_READ_WINDOW,
      globalWriteLimit: e.PUBLIC_API_RATE_LIMIT_GLOBAL_WRITE_LIMIT,
      globalWriteWindow: e.PUBLIC_API_RATE_LIMIT_GLOBAL_WRITE_WINDOW,
      endpointReadLimit: e.PUBLIC_API_RATE_LIMIT_ENDPOINT_READ_LIMIT,
      endpointReadWindow: e.PUBLIC_API_RATE_LIMIT_ENDPOINT_READ_WINDOW,
      endpointWriteLimit: e.PUBLIC_API_RATE_LIMIT_ENDPOINT_WRITE_LIMIT,
      endpointWriteWindow: e.PUBLIC_API_RATE_LIMIT_ENDPOINT_WRITE_WINDOW,
    },
    sourceControl: { defaultKeyType: e.SOURCECONTROL_DEFAULT_SSH_KEY_TYPE },
  };
}

/** the set template files, resolved; an empty value keeps the built-in template */
function mailTemplates(files: Record<MailTemplateName, string>): MailConfig['templates'] {
  const out: MailConfig['templates'] = {};
  for (const [name, file] of Object.entries(files) as [MailTemplateName, string][]) {
    if (file.trim()) out[name] = path.resolve(file.trim());
  }
  return out;
}

/**
 * The biggest CSV a workspace may upload now: the setting, the space it has left and the body limit,
 * whichever is smallest (CSV comes as JSON text, so a bigger body would get Fastify's 413).
 */
export function dataTableUploadLimitBytes(config: Config, remainingBytes: number): number {
  return Math.max(
    0,
    Math.min(
      config.dataTables.uploadMaxFileSizeBytes ?? Number.POSITIVE_INFINITY,
      remainingBytes,
      config.bodyLimitBytes,
    ),
  );
}

export const packageDir = PACKAGE_DIR;
