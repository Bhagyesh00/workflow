/**
 * Data tables (P4-03): how much a workspace stores. `size_bytes` of a row is the length of its cells as
 * jsonb text, worked out by Postgres on every write. The sum is cached for a few seconds, per tenant,
 * because every write checks it (DATA_TABLES_SIZE_CHECK_CACHE_DURATION_MS).
 */
import { DATA_TABLE_ERRORS } from '@workflow/workflow';
import { type SQL, sql } from 'drizzle-orm';
import type { Config } from '../config';
import { ApiError } from '../http/errors';

export type DataTableQuotaStatus = 'ok' | 'warn' | 'error';

/** the size of a jsonb expression, as stored in `size_bytes` */
export const rowSizeSql = (data: SQL) => sql`octet_length((${data})::text)`;

const MB = 1024 * 1024;

export class DataTableSizeCache {
  private readonly entries = new Map<string, { bytes: number; at: number }>();

  constructor(private readonly clock: () => number = Date.now) {}

  async bytes(tenantId: string, durationMs: number, load: () => Promise<number>): Promise<number> {
    const entry = this.entries.get(tenantId);
    const time = this.clock();
    if (entry && time - entry.at < durationMs) return entry.bytes;
    const bytes = await load();
    this.entries.set(tenantId, { bytes, at: this.clock() });
    return bytes;
  }

  /** rows went in: inserts are the busy path, so they keep the sum instead of forcing a new one */
  added(tenantId: string, bytes: number): void {
    const entry = this.entries.get(tenantId);
    if (entry) entry.bytes += bytes;
  }

  reset(tenantId: string): void {
    this.entries.delete(tenantId);
  }
}

export function quotaStatus(totalBytes: number, warnAtBytes: number, maxBytes: number): DataTableQuotaStatus {
  if (totalBytes >= maxBytes) return 'error';
  return totalBytes >= warnAtBytes ? 'warn' : 'ok';
}

/** the configured threshold; a plan with its own size warns at 80% of that size */
export function warningBytes(config: Config, maxBytes: number): number {
  return maxBytes === config.dataTables.maxSizeBytes
    ? config.dataTables.warningThresholdBytes
    : Math.floor(maxBytes * 0.8);
}

export function assertWithinQuota(totalBytes: number, maxBytes: number): void {
  if (totalBytes < maxBytes) return;
  throw ApiError.badRequest(
    DATA_TABLE_ERRORS.sizeLimitExceeded(Math.round(totalBytes / MB), Math.round(maxBytes / MB)),
  );
}
