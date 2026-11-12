/**
 * P6-67 (S5 C0 stub, L11 fills it): a workspace's OpenTelemetry settings. `forTenant` is FULL and frozen in C0 (L10
 * calls it; L11 adds only a per-process cache reloaded on bus `otel:reload` `{ tenantId }`). `read`, `replace` and
 * `testTrace` throw until L11.
 *
 * The header values are one `ctx.cipher.encrypt` payload in `otel_settings.exporter_headers_enc`, binding
 * `{ tenantId, credentialId: 'otel:<tenantId>' }`; its plain value is the `exporterHeaders` text (`name=value,...`,
 * n8n's form). They never leave `forTenant` except to the exporter.
 */
import { type OtelSettings, type OtelTestResult, parseOtlpHeaders } from '@workflow/workflow';
import type { ServiceDeps } from '../../context';
import type { OtelSettingsRow } from '../../db/schema';
import type { AuthContext } from '../../http/auth';

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

export class OtelSettingsService {
  constructor(readonly deps: ServiceDeps) {}

  /**
   * FULL (C0, frozen): the tenant's settings when tracing is enabled, else null (no row, or `enabled` false). Reads
   * the row on every call (L11 adds the cache) and decrypts the headers with the tenant's binding.
   */
  async forTenant(tenantId: string): Promise<EffectiveOtelSettings | null> {
    const row = await this.deps.repos.otelSettings.get(tenantId);
    if (!row?.enabled) return null;
    return this.effective(row);
  }

  private effective(row: OtelSettingsRow): EffectiveOtelSettings {
    const headers = row.exporterHeadersEnc
      ? headersOf(
          this.deps
            .context()
            .cipher.decrypt<unknown>(row.exporterHeadersEnc, otelHeadersBinding(row.tenantId)),
        )
      : {};
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
      headers,
    };
  }

  /** stub (L11): n8n's fields, each header as `name=` (value blank) */
  read(_auth: AuthContext): Promise<OtelSettings> {
    throw new Error('not implemented (L11)');
  }

  /** stub (L11): a full replacement, as n8n's public PUT */
  replace(_auth: AuthContext, _input: OtelSettings): Promise<OtelSettings> {
    throw new Error('not implemented (L11)');
  }

  /** stub (L11): sends one test span with the supplied fields (not saved) */
  testTrace(_auth: AuthContext, _input: OtelSettings): Promise<OtelTestResult> {
    throw new Error('not implemented (L11)');
  }
}
