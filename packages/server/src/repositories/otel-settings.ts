/**
 * P6-66, P6-67 (S5 C0, FULL, C0-final): a workspace's OpenTelemetry settings (`otel_settings`, one row per tenant).
 * `exporterHeadersEnc` is one `ctx.cipher.encrypt` payload (binding `{ tenantId, credentialId: 'otel:<tenantId>' }`)
 * written by the settings service: this file never sees a plain header value. Every query filters tenant_id.
 */
import { eq } from 'drizzle-orm';
import type { DbOrTx } from '../db/client';
import { type OtelSettingsRow, otelSettings } from '../db/schema';
import { isUuid, now } from './util';

/** the columns a write may set (the tenant id and `updatedAt` are the repository's) */
export type OtelSettingsValues = Partial<Omit<OtelSettingsRow, 'tenantId' | 'updatedAt'>>;

export class OtelSettingsRepository {
  constructor(protected readonly db: DbOrTx) {}

  /** the tenant's row; undefined when none was saved (or the id is not a uuid) */
  async get(tenantId: string): Promise<OtelSettingsRow | undefined> {
    if (!isUuid(tenantId)) return undefined;
    const [row] = await this.db
      .select()
      .from(otelSettings)
      .where(eq(otelSettings.tenantId, tenantId))
      .limit(1);
    return row;
  }

  /** inserts the tenant's row or replaces the given columns of it; returns the stored row */
  async upsert(tenantId: string, row: OtelSettingsValues): Promise<OtelSettingsRow> {
    const values = { ...row, updatedAt: now() };
    const [stored] = await this.db
      .insert(otelSettings)
      .values({ ...values, tenantId })
      .onConflictDoUpdate({ target: otelSettings.tenantId, set: values })
      .returning();
    return stored as OtelSettingsRow;
  }
}
