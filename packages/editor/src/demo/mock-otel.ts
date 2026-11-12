/**
 * P6-68 (L12): the demo's OpenTelemetry routes, the REST paths of the server's routes/otel.ts as the editor's
 * `otelApi` calls them (api/endpoints.ts). There is no collector: the test trace succeeds for any well-formed
 * endpoint and fails for a host ending in `.invalid` (so the page can show both texts). Rules as the server:
 * `otel:manage` on all three, PUT is a full replacement, the exporter headers come back with blank values
 * (`name=`), a blank value on PUT keeps the stored one only while the endpoint's scheme, host and port are
 * unchanged, and header values are refused over `http://`. State is per workspace and lives in the registering
 * backend; header values live in the closure and never leave it.
 */
import type { OtelSettings, OtelTestResult } from '../api/types';
import type { MockBackend } from './mock-backend';
import { copy, HttpError } from './mock-http';

const DEFAULTS: OtelSettings = {
  enabled: false,
  exporterProtocol: 'http/protobuf',
  exporterEndpoint: '',
  exporterTracingPath: '/v1/traces',
  exporterServiceName: 'workflow',
  exporterHeaders: '',
  tracesSampleRate: 1,
  startupConnectivityTimeoutMs: 2000,
  includeNodeSpans: true,
  emitWorkflowStartSpan: false,
  emitNodeStartSpan: false,
  injectOutbound: true,
  productionExecutionsOnly: true,
};

const HEADERS_OVER_HTTP =
  'Header values are only sent over https://. Use an https:// endpoint or remove the header values.';

interface TenantState {
  settings: OtelSettings;
  /** the stored header values, by name; never answered */
  values: Map<string, string>;
  /** `scheme://host:port` the stored values were saved for */
  origin: string;
}

const bad = (message: string) => new HttpError(400, 'invalid_body', message);

function originOf(endpoint: string): string {
  try {
    const url = new URL(endpoint);
    return url.origin;
  } catch {
    return '';
  }
}

/** `name=value,...` into entries; each splits at its first `=`, blank entries are skipped */
function parseHeaders(raw: string): Array<[string, string]> {
  const entries: Array<[string, string]> = [];
  for (const [index, part] of raw.split(',').entries()) {
    if (!part.trim()) continue;
    const eq = part.indexOf('=');
    if (eq < 0) throw bad(`Header ${index + 1} has no "=" separator.`);
    const name = part.slice(0, eq).trim();
    if (!name) throw bad(`Header ${index + 1} has an empty name.`);
    entries.push([name, part.slice(eq + 1).trim()]);
  }
  return entries;
}

function readBody(body: Record<string, unknown>): OtelSettings {
  const text = (key: keyof OtelSettings): string => {
    const value = body[key];
    if (typeof value !== 'string') throw bad(`${key} must be a string`);
    return value.trim();
  };
  const flag = (key: keyof OtelSettings): boolean => {
    const value = body[key];
    if (typeof value !== 'boolean') throw bad(`${key} must be true or false`);
    return value;
  };
  const protocol = body.exporterProtocol;
  if (protocol !== 'http/protobuf' && protocol !== 'grpc')
    throw bad('exporterProtocol must be http/protobuf or grpc');
  const rate = body.tracesSampleRate;
  if (typeof rate !== 'number' || !(rate >= 0 && rate <= 1)) throw bad('tracesSampleRate must be 0 to 1');
  const timeout = body.startupConnectivityTimeoutMs;
  if (typeof timeout !== 'number' || !Number.isInteger(timeout) || timeout < 0 || timeout > 60_000)
    throw bad('startupConnectivityTimeoutMs must be a whole number from 0 to 60000');
  const settings: OtelSettings = {
    enabled: flag('enabled'),
    exporterProtocol: protocol,
    exporterEndpoint: text('exporterEndpoint'),
    exporterTracingPath: text('exporterTracingPath'),
    exporterServiceName: text('exporterServiceName'),
    exporterHeaders: typeof body.exporterHeaders === 'string' ? body.exporterHeaders : '',
    tracesSampleRate: rate,
    startupConnectivityTimeoutMs: timeout,
    includeNodeSpans: flag('includeNodeSpans'),
    emitWorkflowStartSpan: flag('emitWorkflowStartSpan'),
    emitNodeStartSpan: flag('emitNodeStartSpan'),
    injectOutbound: flag('injectOutbound'),
    productionExecutionsOnly: flag('productionExecutionsOnly'),
  };
  if (!settings.exporterServiceName) throw bad('exporterServiceName is required');
  if (settings.exporterEndpoint && !/^https?:\/\/[^\s/]+/i.test(settings.exporterEndpoint))
    throw bad('The endpoint must start with http:// or https://.');
  return settings;
}

export function registerOtelRoutes(backend: MockBackend): void {
  const states = new Map<string, TenantState>();
  const stateOf = (tenantId: string): TenantState => {
    let state = states.get(tenantId);
    if (!state) {
      state = { settings: copy(DEFAULTS), values: new Map(), origin: '' };
      states.set(tenantId, state);
    }
    return state;
  };
  /** the settings as answered: every header listed as `name=` */
  const answer = (state: TenantState): OtelSettings => ({
    ...copy(state.settings),
    exporterHeaders: [...state.values.keys()].map((name) => `${name}=`).join(','),
  });

  backend.on('GET', '/otel/settings', () => {
    const { tenant } = backend.requireScope('otel:manage');
    return answer(stateOf(tenant.id));
  });

  backend.on('PUT', '/otel/settings', ({ body }) => {
    const { tenant } = backend.requireScope('otel:manage');
    const state = stateOf(tenant.id);
    const next = readBody(body);
    const entries = parseHeaders(next.exporterHeaders);
    const origin = originOf(next.exporterEndpoint);
    if (entries.some(([, value]) => value) && next.exporterEndpoint.toLowerCase().startsWith('http://'))
      throw bad(HEADERS_OVER_HTTP);
    const keep = origin !== '' && origin === state.origin;
    const values = new Map<string, string>();
    for (const [name, value] of entries)
      values.set(name, value || (keep ? (state.values.get(name) ?? '') : ''));
    state.values = values;
    state.origin = origin;
    state.settings = { ...next, exporterHeaders: '' };
    return answer(state);
  });

  backend.on('POST', '/otel/test-trace', ({ body }): OtelTestResult => {
    backend.requireScope('otel:manage');
    const input = readBody(body);
    const entries = parseHeaders(input.exporterHeaders);
    if (entries.some(([, value]) => value) && input.exporterEndpoint.toLowerCase().startsWith('http://'))
      throw bad(HEADERS_OVER_HTTP);
    if (!input.exporterEndpoint) return { success: false, error: 'Set an endpoint first.' };
    const host = new URL(input.exporterEndpoint).hostname;
    if (host.endsWith('.invalid')) return { success: false, error: `Could not reach ${host}` };
    return { success: true };
  });
}
