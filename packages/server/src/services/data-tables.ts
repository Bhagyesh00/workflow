/**
 * Data tables (P4-03). `forTenant` is what nodes get (`helpers.dataTables`), the other methods are
 * what the REST and public routes call. Every method is scoped to the tenant: another tenant's table
 * answers n8n's not-found text. Stub until L4, except that `forTenant` already hands out an access
 * object, because every execution builds one (executions.ts buildServices).
 */
import type {
  DataTableAccess,
  DataTableChange,
  DataTableColumn,
  DataTableColumnInput,
  DataTableColumnType,
  DataTableDryRunOption,
  DataTableFilter,
  DataTableInfo,
  DataTableInsertResult,
  DataTableInsertReturnType,
  DataTableListQuery,
  DataTablePage,
  DataTableRow,
  DataTableRowInput,
  DataTableRowResult,
  DataTableRowsQuery,
} from '@workflow/workflow';
import type { ServiceDeps } from '../context';
import { ApiError } from '../http/errors';

const notBuilt = () => new ApiError(501, 'not_built', 'not built');

/** who did it, for the audit rows */
export interface DataTableActor {
  userId?: string;
  ip?: string;
}

export interface DataTableCreateInput {
  name: string;
  columns: DataTableColumnInput[];
  /** CSV text whose rows go in with the new table (columns then come from it) */
  csv?: string;
  hasHeaders?: boolean;
}

export interface DataTablePatchInput {
  name: string;
}

export interface DataTableColumnAddInput {
  name: string;
  type: DataTableColumnType;
  /** position; last when left out */
  index?: number;
}

export interface DataTableColumnRenameInput {
  name: string;
}

export interface DataTableColumnMoveInput {
  targetIndex: number;
}

export interface DataTableRowWriteOptions extends DataTableDryRunOption {
  /** n8n: answer the rows, otherwise just `true` */
  returnData?: boolean;
}

/** rows, or `true` when `returnData` was not asked for */
export type DataTableRowWriteResult = DataTableRowResult[] | true;

export interface DataTableCsvPreviewInput {
  csv: string;
  /** default true; without headers the columns are named Column_1, Column_2, ... */
  hasHeaders?: boolean;
}

export interface DataTableCsvPreview {
  rowCount: number;
  columnCount: number;
  /** types from the first non-empty value in the first 100 rows */
  columns: DataTableColumnInput[];
}

export interface DataTableCsvImportInput {
  csv: string;
}

export interface DataTableCsvImportResult {
  importedRows: number;
  /** id, createdAt, updatedAt columns the file held; they are ignored */
  systemColumnsIgnored: string[];
}

export interface DataTableCsvDownloadOptions {
  includeSystemColumns: boolean;
}

/** n8n's download answer */
export interface DataTableCsvDownload {
  csvContent: string;
  dataTableName: string;
}

export type DataTableQuotaStatus = 'ok' | 'warn' | 'error';

/** n8n's limits answer ({totalBytes, dataTables, quotaStatus}) plus the numbers the banners show */
export interface DataTableLimits {
  totalBytes: number;
  maxBytes: number;
  warningBytes: number;
  quotaStatus: DataTableQuotaStatus;
  /** min(setting, remaining space, BODY_LIMIT_MB) */
  uploadMaxFileSize: number;
  dataTables: Record<string, { id: string; name: string; sizeBytes: number }>;
}

/** a workflow whose nodes name this table */
export interface DataTableDependency {
  type: 'workflow';
  id: string;
  name: string;
}

export interface DataTableColumnMethods {
  list(tenantId: string, id: string): Promise<DataTableColumn[]>;
  add(
    tenantId: string,
    id: string,
    input: DataTableColumnAddInput,
    actor?: DataTableActor,
  ): Promise<DataTableColumn>;
  rename(
    tenantId: string,
    id: string,
    columnId: string,
    input: DataTableColumnRenameInput,
    actor?: DataTableActor,
  ): Promise<DataTableColumn>;
  move(
    tenantId: string,
    id: string,
    columnId: string,
    input: DataTableColumnMoveInput,
    actor?: DataTableActor,
  ): Promise<DataTableColumn[]>;
  delete(tenantId: string, id: string, columnId: string, actor?: DataTableActor): Promise<void>;
}

export interface DataTableRowMethods {
  list(tenantId: string, id: string, query: DataTableRowsQuery): Promise<DataTablePage<DataTableRow>>;
  insert<T extends DataTableInsertReturnType>(
    tenantId: string,
    id: string,
    rows: DataTableRowInput[],
    returnType: T,
    actor?: DataTableActor,
  ): Promise<DataTableInsertResult<T>>;
  upsert(
    tenantId: string,
    id: string,
    change: DataTableChange,
    options: DataTableRowWriteOptions,
    actor?: DataTableActor,
  ): Promise<DataTableRowWriteResult>;
  update(
    tenantId: string,
    id: string,
    change: DataTableChange,
    options: DataTableRowWriteOptions,
    actor?: DataTableActor,
  ): Promise<DataTableRowWriteResult>;
  delete(
    tenantId: string,
    id: string,
    filter: DataTableFilter,
    options: DataTableRowWriteOptions,
    actor?: DataTableActor,
  ): Promise<DataTableRowWriteResult>;
  clear(tenantId: string, id: string, actor?: DataTableActor): Promise<{ deletedCount: number }>;
}

/** What a node sees: one tenant's tables. Stub until L4. */
class TenantDataTableAccess implements DataTableAccess {
  constructor(
    readonly service: DataTableService,
    readonly tenantId: string,
    readonly workflowId: string | undefined,
  ) {}

  async listTables(_query?: DataTableListQuery): Promise<DataTablePage<DataTableInfo>> {
    throw notBuilt();
  }
  async getTable(_ref: { id: string } | { name: string }): Promise<DataTableInfo | null> {
    throw notBuilt();
  }
  async createTable(_input: {
    name: string;
    columns: DataTableColumnInput[];
    reuseExisting?: boolean;
  }): Promise<DataTableInfo> {
    throw notBuilt();
  }
  async renameTable(_id: string, _name: string): Promise<DataTableInfo> {
    throw notBuilt();
  }
  async deleteTable(_id: string): Promise<void> {
    throw notBuilt();
  }
  async clearTable(_id: string): Promise<{ deletedCount: number }> {
    throw notBuilt();
  }
  async listColumns(_id: string): Promise<DataTableColumn[]> {
    throw notBuilt();
  }
  async insertRows<T extends DataTableInsertReturnType>(
    _id: string,
    _rows: DataTableRowInput[],
    _returnType: T,
  ): Promise<DataTableInsertResult<T>> {
    throw notBuilt();
  }
  async getRows(_id: string, _query?: DataTableRowsQuery): Promise<DataTablePage<DataTableRow>> {
    throw notBuilt();
  }
  async updateRows(
    _id: string,
    _change: DataTableChange,
    _options?: DataTableDryRunOption,
  ): Promise<DataTableRowResult[]> {
    throw notBuilt();
  }
  async upsertRow(
    _id: string,
    _change: DataTableChange,
    _options?: DataTableDryRunOption,
  ): Promise<DataTableRowResult[]> {
    throw notBuilt();
  }
  async deleteRows(
    _id: string,
    _filter: DataTableFilter,
    _options?: DataTableDryRunOption,
  ): Promise<DataTableRowResult[]> {
    throw notBuilt();
  }
  async rowsExist(_id: string, _filter: DataTableFilter): Promise<boolean> {
    throw notBuilt();
  }
}

export class DataTableService {
  constructor(readonly deps: ServiceDeps) {}

  /** the tenant-bound access nodes use; `workflowId` is the running workflow */
  forTenant(tenantId: string, options: { workflowId?: string } = {}): DataTableAccess {
    return new TenantDataTableAccess(this, tenantId, options.workflowId);
  }

  async list(_tenantId: string, _query: DataTableListQuery): Promise<DataTablePage<DataTableInfo>> {
    throw notBuilt();
  }

  async get(_tenantId: string, _id: string): Promise<DataTableInfo> {
    throw notBuilt();
  }

  async create(
    _tenantId: string,
    _input: DataTableCreateInput,
    _actor?: DataTableActor,
  ): Promise<DataTableInfo> {
    throw notBuilt();
  }

  async patch(
    _tenantId: string,
    _id: string,
    _input: DataTablePatchInput,
    _actor?: DataTableActor,
  ): Promise<DataTableInfo> {
    throw notBuilt();
  }

  async delete(_tenantId: string, _id: string, _actor?: DataTableActor): Promise<void> {
    throw notBuilt();
  }

  readonly columns: DataTableColumnMethods = {
    list: async () => {
      throw notBuilt();
    },
    add: async () => {
      throw notBuilt();
    },
    rename: async () => {
      throw notBuilt();
    },
    move: async () => {
      throw notBuilt();
    },
    delete: async () => {
      throw notBuilt();
    },
  };

  readonly rows: DataTableRowMethods = {
    list: async () => {
      throw notBuilt();
    },
    insert: async () => {
      throw notBuilt();
    },
    upsert: async () => {
      throw notBuilt();
    },
    update: async () => {
      throw notBuilt();
    },
    delete: async () => {
      throw notBuilt();
    },
    clear: async () => {
      throw notBuilt();
    },
  };

  async csvPreview(_tenantId: string, _input: DataTableCsvPreviewInput): Promise<DataTableCsvPreview> {
    throw notBuilt();
  }

  async importCsv(
    _tenantId: string,
    _id: string,
    _input: DataTableCsvImportInput,
    _actor?: DataTableActor,
  ): Promise<DataTableCsvImportResult> {
    throw notBuilt();
  }

  async downloadCsv(
    _tenantId: string,
    _id: string,
    _options: DataTableCsvDownloadOptions,
  ): Promise<DataTableCsvDownload> {
    throw notBuilt();
  }

  async limits(_tenantId: string): Promise<DataTableLimits> {
    throw notBuilt();
  }

  async dependencies(_tenantId: string, _id: string): Promise<DataTableDependency[]> {
    throw notBuilt();
  }
}
