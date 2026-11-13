// Log streaming destinations, OpenTelemetry settings and custom telemetry tags (P6-06, P6-67).
// Field names follow n8n's where a user or an API client sees them. No node: import: the editor bundles this file.

// ---------------------------------------------------------------------------------------------
// Log streaming destinations
// ---------------------------------------------------------------------------------------------

export type LogDestinationType = 'webhook' | 'syslog' | 'sentry';

/** per destination: the breaker opens after `maxFailures` failed sends within `failureWindowMs` */
export interface CircuitBreakerSettings {
  maxFailures: number;
  failureWindowMs: number;
}

/** n8n's defaults: 5 failures within 60 s */
export const DEFAULT_CIRCUIT_BREAKER: Readonly<CircuitBreakerSettings> = Object.freeze({
  maxFailures: 5,
  failureWindowMs: 60_000,
});

export interface LogDestinationBase {
  id: string;
  type: LogDestinationType;
  label: string;
  enabled: boolean;
  /** catalog names, group prefixes (`audit`) or `*` */
  subscribedEvents: string[];
  /** audit events only: every string under a `_`-prefixed key becomes `*` */
  anonymizeAuditMessages: boolean;
  /** a generic HTTP auth credential of the workspace (webhook only) */
  credentialId?: string | null;
  circuitBreaker?: CircuitBreakerSettings;
}

export interface WebhookDestinationSettings {
  url: string;
  method: 'GET' | 'POST' | 'PUT' | 'PATCH';
  sendQuery: boolean;
  queryParameters: Array<{ name: string; value: string }>;
  sendHeaders: boolean;
  headerParameters: Array<{ name: string; value: string }>;
  sendPayload: boolean;
  responseCodeMustMatch: boolean;
  expectedStatusCode: number;
  options: {
    allowUnauthorizedCerts: boolean;
    queryParameterArrays: 'brackets' | 'indices' | 'repeat';
    redirect: { followRedirects: boolean; maxRedirects: number };
    /** milliseconds */
    timeout: number;
  };
}

export interface SyslogDestinationSettings {
  host: string;
  port: number;
  protocol: 'udp' | 'tcp' | 'tls';
  /** PEM CA bundle of the authority that signed the server's certificate; required for `tls` (no system roots) */
  tlsCa?: string;
  facility: number;
  app_name: string;
  eol: string;
}

export interface SentryDestinationSettings {
  dsn: string;
  tracesSampleRate?: number;
  sendPayload: boolean;
}

export interface LogDestinationSettingsByType {
  webhook: WebhookDestinationSettings;
  syslog: SyslogDestinationSettings;
  sentry: SentryDestinationSettings;
}

export type LogDestinationSettings = LogDestinationSettingsByType[LogDestinationType];

/**
 * A destination as the API returns it and takes it on save. Secret values (header and query values,
 * the Sentry DSN key) are blank on read; a blank value on save keeps the stored one.
 */
export type LogDestination = {
  [T in LogDestinationType]: LogDestinationBase & {
    type: T;
    settings: LogDestinationSettingsByType[T];
    /** redacted text of the last failed send, null after a good one */
    lastError?: string | null;
    /** events dropped from the full send queue since the process started */
    droppedEvents?: number;
  };
}[LogDestinationType];

export interface LogDestinationTestResult {
  success: boolean;
  error?: string;
}

// ---------------------------------------------------------------------------------------------
// OpenTelemetry settings (per workspace)
// ---------------------------------------------------------------------------------------------

export interface OtelSettings {
  enabled: boolean;
  exporterProtocol: 'http/protobuf' | 'grpc';
  /** `http://` or `https://` base URL of the collector */
  exporterEndpoint: string;
  /** HTTP only, e.g. `/v1/traces` */
  exporterTracingPath: string;
  exporterServiceName: string;
  /** n8n's `k=v,k=v` string; values are blank on read */
  exporterHeaders: string;
  /** 0 to 1 */
  tracesSampleRate: number;
  startupConnectivityTimeoutMs: number;
  includeNodeSpans: boolean;
  emitWorkflowStartSpan: boolean;
  emitNodeStartSpan: boolean;
  /** add `traceparent` to the HTTP requests nodes send */
  injectOutbound: boolean;
  productionExecutionsOnly: boolean;
}

export interface OtelTestResult {
  success: boolean;
  error?: string;
}

export type OtlpHeaderProblem = 'missing "=" separator' | 'empty key';

export interface ParsedOtlpHeaders {
  headers: Record<string, string>;
  /** `position` is the 1-based place of the entry in the comma-separated list */
  invalidEntries: Array<{ position: number; problem: OtlpHeaderProblem }>;
}

/**
 * Parses n8n's `k=v,k=v` header string. Each entry splits at its first `=`; key and value are trimmed;
 * blank entries are skipped; an entry with no `=` or an empty key is reported and left out.
 * The result never holds a value in `invalidEntries`, so it can be logged.
 */
export function parseOtlpHeaders(raw: string | null | undefined): ParsedOtlpHeaders {
  const headers: Record<string, string> = {};
  const invalidEntries: ParsedOtlpHeaders['invalidEntries'] = [];
  if (typeof raw !== 'string' || raw.trim() === '') return { headers, invalidEntries };
  for (const [i, part] of raw.split(',').entries()) {
    const entry = part.trim();
    if (entry === '') continue;
    const eq = entry.indexOf('=');
    if (eq === -1) {
      invalidEntries.push({ position: i + 1, problem: 'missing "=" separator' });
      continue;
    }
    const key = entry.slice(0, eq).trim();
    if (key === '') {
      invalidEntries.push({ position: i + 1, problem: 'empty key' });
      continue;
    }
    headers[key] = entry.slice(eq + 1).trim();
  }
  return { headers, invalidEntries };
}

// ---------------------------------------------------------------------------------------------
// Custom telemetry tags (workflow setting, node setting, project field)
// ---------------------------------------------------------------------------------------------

export interface TelemetryTag {
  key: string;
  value: string;
}

/** our bounds: at most 20 tags, keys up to 64 characters, values up to 256 */
export const TELEMETRY_TAG_LIMITS = Object.freeze({ max: 20, keyLength: 64, valueLength: 256 });

/** null when valid, else the 400 text. A key is required (trimmed) and unique; the bounds above apply. */
export function validateTelemetryTags(tags: unknown): string | null {
  if (tags === undefined || tags === null) return null;
  if (!Array.isArray(tags)) return 'Telemetry tags must be a list of key and value pairs';
  if (tags.length > TELEMETRY_TAG_LIMITS.max) {
    return `A workflow, node or project can have at most ${TELEMETRY_TAG_LIMITS.max} telemetry tags`;
  }
  const seen = new Set<string>();
  for (const tag of tags) {
    if (
      typeof tag !== 'object' ||
      tag === null ||
      typeof (tag as TelemetryTag).key !== 'string' ||
      typeof (tag as TelemetryTag).value !== 'string'
    ) {
      return 'Each telemetry tag needs a text key and a text value';
    }
    const key = (tag as TelemetryTag).key.trim();
    if (key === '') return 'Each telemetry tag needs a key';
    if (key.length > TELEMETRY_TAG_LIMITS.keyLength) {
      return `Telemetry tag keys can have at most ${TELEMETRY_TAG_LIMITS.keyLength} characters`;
    }
    if ((tag as TelemetryTag).value.length > TELEMETRY_TAG_LIMITS.valueLength) {
      return `Telemetry tag values can have at most ${TELEMETRY_TAG_LIMITS.valueLength} characters`;
    }
    if (seen.has(key)) return `The telemetry tag key "${key}" is used more than once`;
    seen.add(key);
  }
  return null;
}

/**
 * The tags of a workflow setting or project field (an array) or of a node setting (n8n's `{ tag: [...] }`).
 * Keeps entries with a non-blank text key (trimmed); a non-text value becomes its text, a missing one ''.
 */
export function telemetryTagsOf(value: unknown): TelemetryTag[] {
  let list: unknown = value;
  if (list !== null && typeof list === 'object' && !Array.isArray(list))
    list = (list as { tag?: unknown }).tag;
  if (!Array.isArray(list)) return [];
  const out: TelemetryTag[] = [];
  for (const entry of list) {
    if (entry === null || typeof entry !== 'object') continue;
    const { key, value: raw } = entry as { key?: unknown; value?: unknown };
    if (typeof key !== 'string' || key.trim() === '') continue;
    const text =
      typeof raw === 'string' ? raw : typeof raw === 'number' || typeof raw === 'boolean' ? String(raw) : '';
    out.push({ key: key.trim(), value: text });
  }
  return out;
}
