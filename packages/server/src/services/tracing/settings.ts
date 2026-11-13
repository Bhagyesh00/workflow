/**
 * P6-67 (S5 C0, L11): a workspace's OpenTelemetry settings. `forTenant` is C0's (L10 calls it) plus a per-process
 * cache, dropped when the bus announces `otel:reload` `{ tenantId }` (every save publishes it) and after a short
 * time as a safety net. `read` answers n8n's fields with each header as `name=`; `replace` is a full replacement as
 * n8n's public PUT; `testTrace` sends one test span with the supplied fields without saving them.
 *
 * The header values are one `ctx.cipher.encrypt` payload in `otel_settings.exporter_headers_enc`, binding
 * `{ tenantId, credentialId: 'otel:<tenantId>' }`; its plain value is the `exporterHeaders` text (`name=value,...`,
 * n8n's form). They never leave `forTenant` except to the exporter.
 */
import { SsrfBlockedError } from '@workflow/core';
import { type OtelSettings, type OtelTestResult, parseOtlpHeaders } from '@workflow/workflow';
import type { ServiceDeps } from '../../context';
import type { OtelSettingsRow } from '../../db/schema';
import type { AuthContext } from '../../http/auth';
import { ApiError } from '../../http/errors';
import type { OtelSettingsValues } from '../../repositories/otel-settings';
import { sendTestTrace } from './test-trace';

/** what the tracer and exporters use: the enabled settings with the decrypted headers (never answered, never logged) */
export interface EffectiveOtelSettings extends Omit<OtelSettings, 'exporterHeaders'> {
  tenantId: string;
  /** header name to value, decrypted */
  headers: Record<string, string>;
}

/** the cipher binding of a workspace's OTLP header values */
export function otelHeadersBinding(tenantId: string): { tenantId: string; credentialId: string } {
  return { tenantId, credentialId: `otel:${tenantId}` };
}

/** the decrypted header payload as a map: the `exporterHeaders` text, or (tolerated) a map of text values */
function headersOf(plain: unknown): Record<string, string> {
  if (typeof plain === 'string') return parseOtlpHeaders(plain).headers;
  if (plain && typeof plain === 'object' && !Array.isArray(plain)) {
    const headers: Record<string, string> = {};
    for (const [name, value] of Object.entries(plain as Record<string, unknown>)) {
      if (typeof value === 'string') headers[name] = value;
    }
    return headers;
  }
  return {};
}

/** the bus channel: `{ tenantId }`, a workspace's settings changed */
const RELOAD_CHANNEL = 'otel:reload';

/** how long a cached answer is trusted if the bus message is lost */
const CACHE_TTL_MS = 30_000;

/** n8n's defaults: what a workspace with no saved row reads */
const DEFAULT_SETTINGS: Readonly<OtelSettings> = Object.freeze({
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
});

const HEADER_NAME = /^[A-Za-z0-9!#$%&'*+.^_`|~-]+$/;
// biome-ignore lint/suspicious/noControlCharactersInRegex: a header value may hold no control character
const CONTROL = /[\u0000-\u001f\u007f]/;

/** the settings fields (all but the header text), in the order the audit row lists a change */
const FIELDS = [
  'enabled',
  'exporterProtocol',
  'exporterEndpoint',
  'exporterTracingPath',
  'exporterServiceName',
  'tracesSampleRate',
  'startupConnectivityTimeoutMs',
  'includeNodeSpans',
  'emitWorkflowStartSpan',
  'emitNodeStartSpan',
  'injectOutbound',
  'productionExecutionsOnly',
] as const;

/** scheme, host and port of an endpoint (default ports made explicit); null when it does not parse */
export function endpointOrigin(endpoint: string): string | null {
  try {
    const url = new URL(endpoint);
    const port = url.port || (url.protocol === 'https:' ? '443' : url.protocol === 'http:' ? '80' : '');
    return `${url.protocol}//${url.hostname.toLowerCase()}:${port}`;
  } catch {
    return null;
  }
}

/** `name=,name=`: the header names with every value blank */
function blankHeaders(headers: Record<string, string>): string {
  return Object.keys(headers)
    .map((name) => `${name}=`)
    .join(',');
}

/** what a save or a test works from, after the checks */
interface Checked {
  values: OtelSettings;
  endpoint: string;
  /** the headers to store or send: blank values filled from storage where the endpoint is unchanged */
  headers: Record<string, string>;
  /** a blank value whose stored value cannot be kept because the endpoint changed */
  lostKeep: boolean;
  stored: { row: OtelSettingsRow | undefined; headers: Record<string, string> };
}

export class OtelSettingsService {
  private readonly cache = new Map<string, { at: number; value: EffectiveOtelSettings | null }>();
  private readonly versions = new Map<string, number>();
  private subscribed: Promise<void> | null = null;

  constructor(readonly deps: ServiceDeps) {
    // every write made in this process through the shared repository drops the cache at once; the other processes
    // learn of a save from `otel:reload`
    const repository = deps.repos.otelSettings;
    const upsert = repository.upsert.bind(repository);
    repository.upsert = async (tenantId, values) => {
      try {
        return await upsert(tenantId, values);
      } finally {
        this.forget(tenantId);
      }
    };
  }

  /** drops the cached answer of a workspace (this process) */
  private forget(tenantId: string): void {
    this.versions.set(tenantId, (this.versions.get(tenantId) ?? 0) + 1);
    this.cache.delete(tenantId);
  }

  /** listens once for the saves of the other processes */
  private ensureSubscribed(): void {
    if (this.subscribed) return;
    this.subscribed = this.deps
      .context()
      .bus.subscribe(RELOAD_CHANNEL, (message) => {
        const tenantId = (message as { tenantId?: unknown } | null)?.tenantId;
        if (typeof tenantId === 'string') this.forget(tenantId);
      })
      .then(() => undefined)
      .catch(() => {
        this.subscribed = null;
      });
  }

  /**
   * The tenant's settings when tracing is enabled, else null (no row, or `enabled` false). The answer is cached in
   * this process until a save announces `otel:reload` (or 30 s pass); the headers are decrypted with the tenant's
   * binding. The caller must not change the returned object.
   */
  async forTenant(tenantId: string): Promise<EffectiveOtelSettings | null> {
    this.ensureSubscribed();
    const hit = this.cache.get(tenantId);
    if (hit && Date.now() - hit.at < CACHE_TTL_MS) return hit.value;
    const version = this.versions.get(tenantId) ?? 0;
    const row = await this.deps.repos.otelSettings.get(tenantId);
    const value = row?.enabled ? this.effective(row) : null;
    // a save that ended while this read ran has dropped the entry: do not store the older answer
    if ((this.versions.get(tenantId) ?? 0) === version) this.cache.set(tenantId, { at: Date.now(), value });
    return value;
  }

  private effective(row: OtelSettingsRow): EffectiveOtelSettings {
    return {
      tenantId: row.tenantId,
      enabled: row.enabled,
      exporterProtocol: row.exporterProtocol,
      exporterEndpoint: row.exporterEndpoint,
      exporterTracingPath: row.exporterTracingPath,
      exporterServiceName: row.exporterServiceName,
      tracesSampleRate: row.tracesSampleRate,
      startupConnectivityTimeoutMs: row.startupConnectivityTimeoutMs,
      includeNodeSpans: row.includeNodeSpans,
      emitWorkflowStartSpan: row.emitWorkflowStartSpan,
      emitNodeStartSpan: row.emitNodeStartSpan,
      injectOutbound: row.injectOutbound,
      productionExecutionsOnly: row.productionExecutionsOnly,
      headers: this.storedHeaders(row),
    };
  }

  private storedHeaders(row: OtelSettingsRow | undefined): Record<string, string> {
    if (!row?.exporterHeadersEnc) return {};
    return headersOf(
      this.deps.context().cipher.decrypt<unknown>(row.exporterHeadersEnc, otelHeadersBinding(row.tenantId)),
    );
  }

  /** n8n's fields; each header is `name=` (the value is blank, never answered) */
  async read(auth: AuthContext): Promise<OtelSettings> {
    const row = await this.deps.repos.otelSettings.get(auth.tenant.id);
    if (!row) return { ...DEFAULT_SETTINGS };
    return {
      enabled: row.enabled,
      exporterProtocol: row.exporterProtocol,
      exporterEndpoint: row.exporterEndpoint,
      exporterTracingPath: row.exporterTracingPath,
      exporterServiceName: row.exporterServiceName,
      exporterHeaders: blankHeaders(this.storedHeaders(row)),
      tracesSampleRate: row.tracesSampleRate,
      startupConnectivityTimeoutMs: row.startupConnectivityTimeoutMs,
      includeNodeSpans: row.includeNodeSpans,
      emitWorkflowStartSpan: row.emitWorkflowStartSpan,
      emitNodeStartSpan: row.emitNodeStartSpan,
      injectOutbound: row.injectOutbound,
      productionExecutionsOnly: row.productionExecutionsOnly,
    };
  }

  /**
   * The checks of a save and of a test: the endpoint (`http://` or `https://`, no user info, a literal blocked address
   * refused at once; the guard checks the rest at send), the tracing path, n8n's two header problems, headers only over
   * `https://`, and the blank header values (kept from storage while scheme, host and port are unchanged).
   */
  private async check(tenantId: string, input: OtelSettings, forTest: boolean): Promise<Checked> {
    const endpoint = input.exporterEndpoint.trim();
    // read from the parsed URL, not the raw text: `http:host`, `http:/host` and `HTTP:\host` are plain http too
    let insecure = false;
    if (endpoint === '') {
      if (input.enabled || forTest) throw ApiError.badRequest("Couldn't save: enter the collector endpoint.");
    } else {
      let url: URL;
      try {
        url = new URL(endpoint);
      } catch {
        throw ApiError.badRequest("Couldn't save: the endpoint isn't a valid URL.");
      }
      if (url.protocol !== 'http:' && url.protocol !== 'https:') {
        throw ApiError.badRequest("Couldn't save: the endpoint must start with http:// or https://.");
      }
      insecure = url.protocol === 'http:';
      if (url.username || url.password) {
        throw ApiError.badRequest("Couldn't save: the endpoint can't hold a user name or a password.");
      }
      try {
        this.deps.context().http.assertUrlAllowed(endpoint);
      } catch (error) {
        if (error instanceof SsrfBlockedError) {
          throw ApiError.badRequest("Couldn't save: the endpoint points to an address that isn't allowed.");
        }
        throw error;
      }
    }
    const path = input.exporterTracingPath.trim();
    if (path !== '' && (!path.startsWith('/') || /[\s?#]/.test(path))) {
      throw ApiError.badRequest("Couldn't save: the tracing path must start with / and hold no query.");
    }

    const parsed = parseOtlpHeaders(input.exporterHeaders);
    const bad = parsed.invalidEntries[0];
    if (bad) {
      throw ApiError.badRequest(
        bad.problem === 'empty key'
          ? `Couldn't save: header ${bad.position} has no name.`
          : `Couldn't save: header ${bad.position} has no "=" between its name and its value.`,
      );
    }
    for (const [name, value] of Object.entries(parsed.headers)) {
      if (!HEADER_NAME.test(name)) {
        throw ApiError.badRequest("Couldn't save: a header name has a character that isn't allowed.");
      }
      if (CONTROL.test(value)) {
        throw ApiError.badRequest("Couldn't save: a header value has a character that isn't allowed.");
      }
    }
    if (insecure && Object.keys(parsed.headers).length > 0) {
      throw ApiError.badRequest(
        "Couldn't send headers over http://. Use an https:// endpoint, or remove the headers.",
      );
    }

    const row = await this.deps.repos.otelSettings.get(tenantId);
    const storedHeaders = this.storedHeaders(row);
    const sameEndpoint =
      row !== undefined &&
      row.exporterEndpoint !== '' &&
      endpointOrigin(row.exporterEndpoint) === endpointOrigin(endpoint);
    const headers: Record<string, string> = {};
    let lostKeep = false;
    for (const [name, value] of Object.entries(parsed.headers)) {
      if (value !== '' || !Object.hasOwn(storedHeaders, name)) {
        headers[name] = value;
      } else if (sameEndpoint) {
        headers[name] = storedHeaders[name] as string;
      } else {
        lostKeep = true;
        headers[name] = '';
      }
    }
    return {
      values: { ...input, exporterEndpoint: endpoint, exporterTracingPath: path },
      endpoint,
      headers,
      lostKeep,
      stored: { row, headers: storedHeaders },
    };
  }

  /** a full replacement, as n8n's public PUT */
  async replace(auth: AuthContext, input: OtelSettings): Promise<OtelSettings> {
    const tenantId = auth.tenant.id;
    const checked = await this.check(tenantId, input, false);
    if (checked.lostKeep) {
      throw ApiError.badRequest(
        "Couldn't keep the saved header values: the endpoint changed. Re-enter them.",
      );
    }
    const { values, headers, stored } = checked;
    const names = Object.keys(headers);
    const text = names.map((name) => `${name}=${headers[name]}`).join(',');
    const exporterHeadersEnc =
      text === '' ? null : this.deps.context().cipher.encrypt(text, otelHeadersBinding(tenantId));
    const write: OtelSettingsValues = {
      enabled: values.enabled,
      exporterProtocol: values.exporterProtocol,
      exporterEndpoint: values.exporterEndpoint,
      exporterTracingPath: values.exporterTracingPath,
      exporterServiceName: values.exporterServiceName,
      exporterHeadersEnc,
      tracesSampleRate: values.tracesSampleRate,
      startupConnectivityTimeoutMs: values.startupConnectivityTimeoutMs,
      includeNodeSpans: values.includeNodeSpans,
      emitWorkflowStartSpan: values.emitWorkflowStartSpan,
      emitNodeStartSpan: values.emitNodeStartSpan,
      injectOutbound: values.injectOutbound,
      productionExecutionsOnly: values.productionExecutionsOnly,
      updatedBy: auth.user.id,
    };
    const before: Record<string, unknown> = stored.row ? { ...stored.row } : { ...DEFAULT_SETTINGS };
    const fields: string[] = FIELDS.filter((field) => before[field] !== values[field]);
    const sameHeaders =
      Object.keys(stored.headers).length === names.length &&
      names.every((name) => stored.headers[name] === headers[name]);
    if (!sameHeaders) fields.push('exporterHeaders');

    await this.deps.repos.otelSettings.upsert(tenantId, write);
    await this.deps.repos.audit.add(tenantId, {
      userId: auth.user.id,
      action: 'otel.settings_updated',
      resourceType: 'otel_settings',
      resourceId: tenantId,
      metadata: { fields, enabled: values.enabled },
    });
    this.forget(tenantId);
    await this.deps
      .context()
      .bus.publish(RELOAD_CHANNEL, { tenantId })
      .catch(() => {});
    return this.read(auth);
  }

  /**
   * Sends one test span with the supplied fields (not saved). A blank header value is filled from storage only while
   * the endpoint's scheme, host and port are unchanged. The answer is `{ success, error? }`; a bad field is a 400.
   */
  async testTrace(auth: AuthContext, input: OtelSettings): Promise<OtelTestResult> {
    const tenantId = auth.tenant.id;
    const { values, headers, lostKeep } = await this.check(tenantId, input, true);
    if (lostKeep) {
      throw ApiError.badRequest(
        "Couldn't keep the saved header values: the endpoint changed. Re-enter them.",
      );
    }
    return sendTestTrace(this.deps, {
      tenantId,
      enabled: values.enabled,
      exporterProtocol: values.exporterProtocol,
      exporterEndpoint: values.exporterEndpoint,
      exporterTracingPath: values.exporterTracingPath,
      exporterServiceName: values.exporterServiceName,
      tracesSampleRate: values.tracesSampleRate,
      startupConnectivityTimeoutMs: values.startupConnectivityTimeoutMs,
      includeNodeSpans: values.includeNodeSpans,
      emitWorkflowStartSpan: values.emitWorkflowStartSpan,
      emitNodeStartSpan: values.emitNodeStartSpan,
      injectOutbound: values.injectOutbound,
      productionExecutionsOnly: values.productionExecutionsOnly,
      headers,
    });
  }
}
