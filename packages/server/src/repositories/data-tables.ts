/**
 * Data tables (P4-03). Every query filters tenant_id, and filter values are bound parameters: a
 * column name is never SQL text. Stub until L4, which adds the rest of the row and column queries.
 */
import type { DbOrTx } from '../db/client';
import type { DataTableColumnRow, DataTableRow } from '../db/schema';
import { ApiError } from '../http/errors';

const notBuilt = () => new ApiError(501, 'not_built', 'not built');

export class DataTableRepository {
  constructor(readonly db: DbOrTx) {}

  async get(_tenantId: string, _id: string): Promise<DataTableRow | undefined> {
    throw notBuilt();
  }

  /** exact name */
  async getByName(_tenantId: string, _name: string): Promise<DataTableRow | undefined> {
    throw notBuilt();
  }

  /** by position */
  async listColumns(_tenantId: string, _tableId: string): Promise<DataTableColumnRow[]> {
    throw notBuilt();
  }

  /** SUM(size_bytes) of the workspace, for the quota */
  async totalSizeBytes(_tenantId: string): Promise<number> {
    throw notBuilt();
  }
}
