/**
 * Data tables (P4-03, P6-23). `forProject` is what nodes get (`helpers.dataTables`): only the run's
 * project, by id and by name. The other methods are what the REST and public routes call, so the rules
 * are the same for all of them. Every method is scoped to the tenant: another tenant's table answers
 * n8n's not-found text. A table belongs to one project and is never shared; names are unique per project.
 */
import {
  DATA_TABLE_COLUMN_NAME_MAX,
  DATA_TABLE_COLUMN_NAME_RE,
  DATA_TABLE_ERRORS,
  DATA_TABLE_NAME_MAX,
  DATA_TABLE_RESERVED_COLUMNS,
  DATA_TABLE_ROWS_TAKE_MAX,
  DATA_TABLE_SYSTEM_COLUMNS,
  type DataTableAccess,
  type DataTableCellValue,
  type DataTableChange,
  type DataTableColumn,
  type DataTableColumnInput,
  type DataTableColumnType,
  type DataTableCreateColumn,
  type DataTableDryRunOption,
  type DataTableDryRunRow,
  type DataTableFilter,
  type DataTableInfo,
  type DataTableInsertResult,
  type DataTableInsertReturnType,
  type DataTableListQuery,
  type DataTablePage,
  type DataTableRow,
  type DataTableRowInput,
  type DataTableRowResult,
  type DataTableRowsQuery,
  type Scope,
} from '@workflow/workflow';
import { dataTableUploadLimitBytes } from '../config';
import type { ServiceDeps } from '../context';
import type {
  DataTableColumnRow,
  DataTableRowRow,
  DataTableRow as DataTableTableRow,
  ProjectRow,
} from '../db/schema';
import type { AuthContext } from '../http/auth';
import { ApiError } from '../http/errors';
import { dataTableQuotaBytes, effectiveLimits, type TenantSettings } from '../plans';
import { createRepositories, type Repositories } from '../repositories';
import type { DataTableRepository } from '../repositories/data-tables';
import type { AccessListOptions } from '../repositories/shares';
import { isUniqueViolation, now } from '../repositories/util';
import { MISSING_SCOPE_MESSAGE } from './access';
import {
  buildCsv,
  CSV_TOO_LARGE_MESSAGE,
  csvRowsForColumns,
  csvRowsForImport,
  inferColumns,
  matchCsvColumns,
  parseCsv,
  previewCsv,
} from './data-table-csv';
import {
  assertStorableText,
  buildFilterSql,
  buildOrderBySql,
  buildSearchSql,
  coerceCellValue,
} from './data-table-filter';
import { assertWithinQuota, DataTableSizeCache, quotaStatus, warningBytes } from './data-table-size';

/** n8n's text; not in DATA_TABLE_ERRORS, which is the shared contract */
const DATA_EMPTY = 'Data columns must not be empty';
/** valid by the name rule, but they would shadow what every object has */
const UNSAFE_COLUMN_NAMES = new Set(['constructor', 'prototype']);
const RESERVED_COLUMN_NAMES = new Set<string>(DATA_TABLE_RESERVED_COLUMNS.map((name) => name.toLowerCase()));

const tableNotFound = (id: string) =>
  new ApiError(404, 'not_found', DATA_TABLE_ERRORS.tableIdNotFound(id), {
    description: DATA_TABLE_ERRORS.tableIdNotFoundDescription,
  });

const columnNotFound = (id: string, columnId: string) =>
  new ApiError(404, 'not_found', `Could not find the column '${columnId}' in the data table: ${id}`);

function tableName(name: string): string {
  const trimmed = name.trim();
  if (!trimmed || trimmed.length > DATA_TABLE_NAME_MAX) {
    throw ApiError.badRequest(`A data table name has 1 to ${DATA_TABLE_NAME_MAX} characters`);
  }
  return assertStorableText(trimmed);
}

function assertColumnName(name: string): void {
  if (name.length > DATA_TABLE_COLUMN_NAME_MAX || !DATA_TABLE_COLUMN_NAME_RE.test(name)) {
    throw ApiError.badRequest(DATA_TABLE_ERRORS.columnNameInvalid);
  }
  if (RESERVED_COLUMN_NAMES.has(name.toLowerCase()) || UNSAFE_COLUMN_NAMES.has(name)) {
    throw ApiError.badRequest(DATA_TABLE_ERRORS.columnNameReserved(name));
  }
}

function assertColumnInputs(table: string, columns: DataTableColumnInput[]): void {
  const seen = new Set<string>();
  for (const column of columns) {
    assertColumnName(column.name);
    if (seen.has(column.name)) {
      throw ApiError.conflict(DATA_TABLE_ERRORS.columnNameExists(column.name, table));
    }
    seen.add(column.name);
  }
}

const clampIndex = (index: number, length: number) => Math.max(0, Math.min(index, length));

function toColumn(row: DataTableColumnRow): DataTableColumn {
  return {
    id: row.id,
    name: row.name,
    type: row.type,
    position: row.position,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

function toInfo(row: DataTableTableRow, columns: DataTableColumnRow[]): DataTableInfo {
  return {
    id: row.id,
    name: row.name,
    columns: columns.map(toColumn),
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

/** own keys only: a column named `toString` with no value is null, not Object's method */
function cellOf(data: Record<string, unknown>, name: string): DataTableCellValue {
  return Object.hasOwn(data, name) ? ((data[name] as DataTableCellValue) ?? null) : null;
}

function toRow(row: DataTableRowRow, columns: DataTableColumnRow[]): DataTableRow {
  const out: DataTableRow = {
    id: row.rowId,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
  for (const column of columns) out[column.name] = cellOf(row.data, column.name);
  return out;
}

/** a row that does not exist on this side of a dry run: every value null, system columns too */
function emptyDryRow(columns: DataTableColumnRow[], state: 'before' | 'after'): DataTableDryRunRow {
  const out: Record<string, DataTableCellValue> = {};
  for (const name of DATA_TABLE_SYSTEM_COLUMNS) out[name] = null;
  for (const column of columns) out[column.name] = null;
  out.dryRunState = state;
  return out as unknown as DataTableDryRunRow;
}

/** a project as a table row names it */
export interface DataTableProjectRef {
  id: string;
  name: string;
  type: ProjectRow['type'];
  icon: ProjectRow['icon'];
}

/** what a table carries once the caller is known: its project and (with `includeScopes`) the caller's scopes there */
export interface DataTableAccessFields {
  projectId: string;
  homeProject: DataTableProjectRef | null;
  sharedWithProjects: DataTableProjectRef[];
  scopes?: Scope[];
}

/** a table as the REST routes answer it: the table, and (when the caller is known) its project and scopes */
export type DataTableForCaller = DataTableInfo & Partial<DataTableAccessFields>;

/**
 * What the REST list adds: with `caller` the rows narrow to the caller's `dataTable:listProject` access
 * (a named project needs that scope there) and carry their project; `includeScopes` adds the scopes.
 * Without `caller` (the public API, MCP, Assistant) the list is the whole workspace until their lanes pass one.
 */
export interface DataTableListForQuery {
  caller?: AuthContext;
  includeScopes?: boolean;
}

/** who did it, for the audit rows */
export interface DataTableActor {
  userId?: string;
  ip?: string;
  /** the running workflow, when a node did it */
  workflowId?: string;
}

export interface DataTableCreateInput {
  name: string;
  columns: DataTableCreateColumn[];
  /** P6 S1: the project the route resolved; absent: the workspace's default (L24 makes it required) */
  projectId?: string;
  /**
   * the signed-in caller (the REST route): the project is then resolved for it (`targetProject`), it must
   * hold `dataTable:create` there, and the answer carries the access fields
   */
  caller?: AuthContext;
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
  /** answers the moved column, as the editor client reads it */
  move(
    tenantId: string,
    id: string,
    columnId: string,
    input: DataTableColumnMoveInput,
    actor?: DataTableActor,
  ): Promise<DataTableColumn>;
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

/**
 * What a node sees: the tables of the run's project, by id and by name (a table of another project is not
 * found). Row writes leave no audit rows; a workflow can write many.
 */
class ProjectDataTableAccess implements DataTableAccess {
  private readonly actor: DataTableActor;

  constructor(
    readonly service: DataTableService,
    readonly tenantId: string,
    readonly projectId: string,
    readonly workflowId: string | undefined,
  ) {
    this.actor = { workflowId };
  }

  /** every operation by id passes here first: a table of another project answers the not-found text */
  private async own(id: string): Promise<string> {
    await this.service.requireInProject(this.tenantId, this.projectId, id);
    return id;
  }

  listTables(query: DataTableListQuery = {}): Promise<DataTablePage<DataTableInfo>> {
    return this.service.list(this.tenantId, { ...query, projectId: this.projectId });
  }
  getTable(ref: { id: string } | { name: string }): Promise<DataTableInfo | null> {
    return this.service.find(this.tenantId, ref, this.projectId);
  }
  async createTable(input: {
    name: string;
    columns: DataTableColumnInput[];
    reuseExisting?: boolean;
  }): Promise<DataTableInfo> {
    const { reuseExisting, ...rest } = input;
    const create = { ...rest, projectId: this.projectId };
    if (!reuseExisting) return this.service.create(this.tenantId, create, this.actor);
    const name = tableName(input.name);
    const existing = await this.service.find(this.tenantId, { name }, this.projectId);
    if (existing) return existing;
    try {
      return await this.service.create(this.tenantId, create, this.actor);
    } catch (error) {
      // another run made it just now
      const taken = error instanceof ApiError && error.statusCode === 409;
      const raced = taken ? await this.service.find(this.tenantId, { name }, this.projectId) : null;
      if (raced) return raced;
      throw error;
    }
  }
  async renameTable(id: string, name: string): Promise<DataTableInfo> {
    return this.service.patch(this.tenantId, await this.own(id), { name }, this.actor);
  }
  async deleteTable(id: string): Promise<void> {
    return this.service.delete(this.tenantId, await this.own(id), this.actor);
  }
  async clearTable(id: string): Promise<{ deletedCount: number }> {
    return this.service.rows.clear(this.tenantId, await this.own(id), this.actor);
  }
  async listColumns(id: string): Promise<DataTableColumn[]> {
    return this.service.columns.list(this.tenantId, await this.own(id));
  }
  /** P5-02: a new last column (the Evaluation node's outputs write-back); the REST rules and caps apply */
  async addColumn(id: string, column: DataTableColumnInput): Promise<DataTableColumn> {
    return this.service.columns.add(
      this.tenantId,
      await this.own(id),
      { name: column.name, type: column.type },
      this.actor,
    );
  }
  async insertRows<T extends DataTableInsertReturnType>(
    id: string,
    rows: DataTableRowInput[],
    returnType: T,
  ): Promise<DataTableInsertResult<T>> {
    return this.service.rows.insert(this.tenantId, await this.own(id), rows, returnType);
  }
  async getRows(id: string, query: DataTableRowsQuery = {}): Promise<DataTablePage<DataTableRow>> {
    return this.service.rows.list(this.tenantId, await this.own(id), query);
  }
  async updateRows(
    id: string,
    change: DataTableChange,
    options: DataTableDryRunOption = {},
  ): Promise<DataTableRowResult[]> {
    const rows = await this.service.rows.update(this.tenantId, await this.own(id), change, {
      ...options,
      returnData: true,
    });
    return rows === true ? [] : rows;
  }
  async upsertRow(
    id: string,
    change: DataTableChange,
    options: DataTableDryRunOption = {},
  ): Promise<DataTableRowResult[]> {
    const rows = await this.service.rows.upsert(this.tenantId, await this.own(id), change, {
      ...options,
      returnData: true,
    });
    return rows === true ? [] : rows;
  }
  async deleteRows(
    id: string,
    filter: DataTableFilter,
    options: DataTableDryRunOption = {},
  ): Promise<DataTableRowResult[]> {
    const rows = await this.service.rows.delete(this.tenantId, await this.own(id), filter, {
      ...options,
      returnData: true,
    });
    return rows === true ? [] : rows;
  }
  async rowsExist(id: string, filter: DataTableFilter): Promise<boolean> {
    return this.service.rowsExist(this.tenantId, await this.own(id), filter);
  }
}

export class DataTableService {
  private readonly sizes = new DataTableSizeCache();

  constructor(readonly deps: ServiceDeps) {}

  /**
   * the access nodes use; `workflowId` is the running workflow, `projectId` the run's project: the access
   * reaches that project's tables only, by id and by name, and creates in it.
   */
  forProject(tenantId: string, projectId: string, options: { workflowId?: string } = {}): DataTableAccess {
    return new ProjectDataTableAccess(this, tenantId, projectId, options.workflowId);
  }

  // ---- tables ----

  /** the access options narrow to a project or to the caller's rows (absent: the whole workspace, for system callers) */
  async list(
    tenantId: string,
    query: DataTableListQuery & AccessListOptions & DataTableListForQuery,
  ): Promise<DataTablePage<DataTableForCaller>> {
    const { repos } = this.deps;
    const { caller } = query;
    let filter = query.filter;
    if (caller) {
      const { access } = this.deps.context();
      if (query.projectId) {
        const held = await access.scopesForAuth(caller, { projectId: query.projectId });
        if (!held.has('dataTable:listProject')) throw ApiError.forbidden(MISSING_SCOPE_MESSAGE);
      }
      filter = await access.listFilter(caller, 'dataTable:listProject');
    }
    const { count, rows } = await repos.dataTables.list(tenantId, {
      filter,
      projectId: query.projectId,
      onlySharedWithMe: query.onlySharedWithMe,
      name: query.name,
      sortBy: query.sortBy,
      take: Math.min(query.take ?? DATA_TABLE_ROWS_TAKE_MAX, DATA_TABLE_ROWS_TAKE_MAX),
      skip: query.skip ?? 0,
    });
    const columns = await repos.dataTables.listColumnsOf(
      tenantId,
      rows.map((row) => row.id),
    );
    const fields = caller ? await this.accessFields(caller, rows, query.includeScopes === true) : undefined;
    return {
      count,
      data: rows.map((row) => ({
        ...toInfo(
          row,
          columns.filter((column) => column.tableId === row.id),
        ),
        ...fields?.get(row.id),
      })),
    };
  }

  /** with `caller` the answer carries the table's project and the caller's scopes there */
  async get(tenantId: string, id: string, caller?: AuthContext): Promise<DataTableForCaller> {
    const row = await this.requireTable(tenantId, id);
    return this.forCaller(
      caller,
      row,
      toInfo(row, await this.deps.repos.dataTables.listColumns(tenantId, id)),
    );
  }

  /**
   * by id or exact name; null when there is no such table. With `projectId` only that project's tables
   * count (a name is unique per project, so a name needs the project; without it a name finds nothing).
   */
  async find(
    tenantId: string,
    ref: { id: string } | { name: string },
    projectId?: string,
  ): Promise<DataTableInfo | null> {
    const { dataTables } = this.deps.repos;
    let row: DataTableTableRow | undefined;
    if ('id' in ref) {
      row = await dataTables.get(tenantId, ref.id);
      if (row && projectId !== undefined && row.projectId !== projectId) row = undefined;
    } else {
      row = projectId === undefined ? undefined : await dataTables.getByName(tenantId, projectId, ref.name);
    }
    return row ? toInfo(row, await dataTables.listColumns(tenantId, row.id)) : null;
  }

  /** the table when it belongs to `projectId`, else n8n's not-found text (the node access calls this) */
  async requireInProject(tenantId: string, projectId: string, id: string): Promise<DataTableTableRow> {
    const row = await this.requireTable(tenantId, id);
    if (row.projectId !== projectId) throw tableNotFound(id);
    return row;
  }

  // ---- the caller's view (REST) ----

  /** the table plus its project and the caller's scopes there; the table as it is when no caller is known */
  private async forCaller(
    caller: AuthContext | undefined,
    row: DataTableTableRow,
    info: DataTableInfo,
  ): Promise<DataTableForCaller> {
    if (!caller) return info;
    const fields = await this.accessFields(caller, [row], true);
    return { ...info, ...fields.get(row.id) };
  }

  /** `projectId`, `homeProject` and (with `includeScopes`) the caller's `scopes` of each table; a table's scopes are its project's */
  private async accessFields(
    auth: AuthContext,
    rows: DataTableTableRow[],
    includeScopes: boolean,
  ): Promise<Map<string, DataTableAccessFields>> {
    const { access } = this.deps.context();
    const result = new Map<string, DataTableAccessFields>();
    if (!rows.length) return result;
    const refs = new Map<string, DataTableProjectRef>();
    for (const p of await this.deps.repos.projects.listAll(auth.tenant.id)) {
      refs.set(p.id, { id: p.id, name: p.name, type: p.type, icon: p.icon ?? null });
    }
    const scopes = new Map<string, Scope[]>();
    if (includeScopes) {
      for (const projectId of new Set(rows.map((row) => row.projectId))) {
        scopes.set(projectId, [...(await access.scopesForAuth(auth, { projectId }))].sort());
      }
    }
    for (const row of rows) {
      result.set(row.id, {
        projectId: row.projectId,
        homeProject: refs.get(row.projectId) ?? null,
        sharedWithProjects: [],
        ...(includeScopes ? { scopes: scopes.get(row.projectId) } : {}),
      });
    }
    return result;
  }

  async create(
    tenantId: string,
    input: DataTableCreateInput,
    actor?: DataTableActor,
  ): Promise<DataTableForCaller> {
    const { caller, ...rest } = input;
    if (!caller) return this.insertTable(tenantId, rest, actor);
    const { access } = this.deps.context();
    const projectId = await access.targetProject(caller, rest.projectId);
    const held = await access.scopesForAuth(caller, { projectId });
    if (!held.has('dataTable:create')) throw ApiError.forbidden(MISSING_SCOPE_MESSAGE);
    const made = await this.insertTable(tenantId, { ...rest, projectId }, actor);
    return this.forCaller(caller, await this.requireTable(tenantId, made.id), made);
  }

  private async insertTable(
    tenantId: string,
    input: Omit<DataTableCreateInput, 'caller'>,
    actor?: DataTableActor,
  ): Promise<DataTableInfo> {
    const name = tableName(input.name);
    let columns = input.columns;
    let cells: DataTableRowInput[] = [];
    if (input.csv !== undefined) {
      await this.assertCsvFits(tenantId, input.csv);
      const csv = parseCsv(input.csv, input.hasHeaders ?? true);
      if (!columns.length) columns = inferColumns(csv);
      if (!columns.length) throw ApiError.badRequest('The CSV file has no columns');
      assertColumnInputs(name, columns);
      cells = csvRowsForColumns(csv, columns, matchCsvColumns(csv, columns));
    }
    assertColumnInputs(name, columns);
    const stored = cells.map((row) => this.toCells(row, columns));
    const projectId = input.projectId ?? (await this.deps.repos.projects.defaultProjectFor(tenantId));
    try {
      const made = await this.deps.database.db.transaction(async (tx) => {
        const repos = createRepositories(tx);
        if (await repos.dataTables.getByName(tenantId, projectId, name)) {
          throw ApiError.conflict(DATA_TABLE_ERRORS.tableNameExists(name));
        }
        const table = await repos.dataTables.create(tenantId, projectId, name);
        const columnRows: DataTableColumnRow[] = [];
        for (const [position, column] of columns.entries()) {
          columnRows.push(
            await repos.dataTables.addColumn(tenantId, table.id, {
              name: column.name,
              type: column.type,
              position,
            }),
          );
        }
        let bytes = 0;
        if (stored.length) {
          const first = await repos.dataTables.reserveRowIds(tenantId, table.id, stored.length);
          const rows = await repos.dataTables.insertRows(tenantId, table.id, first, stored);
          bytes = rows.reduce((sum, row) => sum + row.sizeBytes, 0);
        }
        await this.audit(repos, tenantId, actor, 'dataTable.created', table.id, {
          columns: columns.length,
          importedRows: stored.length,
        });
        return { table, columnRows, bytes };
      });
      this.sizes.added(tenantId, made.bytes);
      return toInfo(made.table, made.columnRows);
    } catch (error) {
      if (isUniqueViolation(error)) throw ApiError.conflict(DATA_TABLE_ERRORS.tableNameExists(name));
      throw error;
    }
  }

  async patch(
    tenantId: string,
    id: string,
    input: DataTablePatchInput,
    actor?: DataTableActor,
    caller?: AuthContext,
  ): Promise<DataTableForCaller> {
    const renamed = await this.rename(tenantId, id, input, actor);
    return this.forCaller(caller, await this.requireTable(tenantId, id), renamed);
  }

  private async rename(
    tenantId: string,
    id: string,
    input: DataTablePatchInput,
    actor?: DataTableActor,
  ): Promise<DataTableInfo> {
    const name = tableName(input.name);
    await this.requireTable(tenantId, id);
    try {
      return await this.deps.database.db.transaction(async (tx) => {
        const repos = createRepositories(tx);
        const row = await repos.dataTables.rename(tenantId, id, name);
        if (!row) throw tableNotFound(id);
        await this.audit(repos, tenantId, actor, 'dataTable.updated', id);
        return toInfo(row, await repos.dataTables.listColumns(tenantId, id));
      });
    } catch (error) {
      if (isUniqueViolation(error)) throw ApiError.conflict(DATA_TABLE_ERRORS.tableNameExists(name));
      throw error;
    }
  }

  /** columns and rows go by foreign key, and every user's favorite of the table with them */
  async delete(tenantId: string, id: string, actor?: DataTableActor): Promise<void> {
    await this.requireTable(tenantId, id);
    await this.deps.database.db.transaction(async (tx) => {
      const repos = createRepositories(tx);
      await repos.favorites.removeForResource(tenantId, 'dataTable', id);
      await repos.dataTables.delete(tenantId, id);
      await this.audit(repos, tenantId, actor, 'dataTable.deleted', id);
    });
    this.sizes.reset(tenantId);
  }

  // ---- columns ----

  readonly columns: DataTableColumnMethods = {
    list: async (tenantId, id) => {
      await this.requireTable(tenantId, id);
      return (await this.deps.repos.dataTables.listColumns(tenantId, id)).map(toColumn);
    },
    add: (tenantId, id, input, actor) => this.addColumn(tenantId, id, input, actor),
    rename: (tenantId, id, columnId, input, actor) => this.renameColumn(tenantId, id, columnId, input, actor),
    move: (tenantId, id, columnId, input, actor) => this.moveColumn(tenantId, id, columnId, input, actor),
    delete: (tenantId, id, columnId, actor) => this.deleteColumn(tenantId, id, columnId, actor),
  };

  private async addColumn(
    tenantId: string,
    id: string,
    input: DataTableColumnAddInput,
    actor?: DataTableActor,
  ): Promise<DataTableColumn> {
    assertColumnName(input.name);
    return this.deps.database.db.transaction(async (tx) => {
      const repos = createRepositories(tx);
      const table = await repos.dataTables.lock(tenantId, id);
      if (!table) throw tableNotFound(id);
      const existing = await repos.dataTables.listColumns(tenantId, id);
      if (existing.some((column) => column.name === input.name)) {
        throw ApiError.conflict(DATA_TABLE_ERRORS.columnNameExists(input.name, table.name));
      }
      const position = clampIndex(input.index ?? existing.length, existing.length);
      const added = await repos.dataTables.addColumn(tenantId, id, {
        name: input.name,
        type: input.type,
        position,
      });
      for (const column of existing.slice(position)) {
        await repos.dataTables.setColumnPosition(tenantId, id, column.id, column.position + 1);
      }
      await repos.dataTables.touch(tenantId, id);
      await this.audit(repos, tenantId, actor, 'dataTable.column.added', id, { columnId: added.id });
      return toColumn(added);
    });
  }

  /** the column row and the key in every row change together, or not at all */
  private async renameColumn(
    tenantId: string,
    id: string,
    columnId: string,
    input: DataTableColumnRenameInput,
    actor?: DataTableActor,
  ): Promise<DataTableColumn> {
    assertColumnName(input.name);
    const column = await this.deps.database.db.transaction(async (tx) => {
      const repos = createRepositories(tx);
      const table = await repos.dataTables.lock(tenantId, id);
      if (!table) throw tableNotFound(id);
      const existing = await repos.dataTables.listColumns(tenantId, id);
      const current = existing.find((candidate) => candidate.id === columnId);
      if (!current) throw columnNotFound(id, columnId);
      if (current.name === input.name) return current;
      if (existing.some((candidate) => candidate.name === input.name)) {
        throw ApiError.conflict(DATA_TABLE_ERRORS.columnNameExists(input.name, table.name));
      }
      const renamed = await repos.dataTables.renameColumn(tenantId, id, columnId, input.name);
      await repos.dataTables.renameRowKey(tenantId, id, current.name, input.name);
      await repos.dataTables.touch(tenantId, id);
      await this.audit(repos, tenantId, actor, 'dataTable.column.renamed', id, { columnId });
      return renamed ?? current;
    });
    this.sizes.reset(tenantId);
    return toColumn(column);
  }

  private async moveColumn(
    tenantId: string,
    id: string,
    columnId: string,
    input: DataTableColumnMoveInput,
    actor?: DataTableActor,
  ): Promise<DataTableColumn> {
    return this.deps.database.db.transaction(async (tx) => {
      const repos = createRepositories(tx);
      if (!(await repos.dataTables.lock(tenantId, id))) throw tableNotFound(id);
      const existing = await repos.dataTables.listColumns(tenantId, id);
      const from = existing.findIndex((column) => column.id === columnId);
      if (from === -1) throw columnNotFound(id, columnId);
      const [moved] = existing.splice(from, 1);
      const target = clampIndex(input.targetIndex, existing.length);
      existing.splice(target, 0, moved);
      await this.writePositions(repos, tenantId, id, existing);
      await repos.dataTables.touch(tenantId, id);
      await this.audit(repos, tenantId, actor, 'dataTable.column.moved', id, { columnId });
      return toColumn({ ...moved, position: target });
    });
  }

  private async deleteColumn(
    tenantId: string,
    id: string,
    columnId: string,
    actor?: DataTableActor,
  ): Promise<void> {
    await this.deps.database.db.transaction(async (tx) => {
      const repos = createRepositories(tx);
      if (!(await repos.dataTables.lock(tenantId, id))) throw tableNotFound(id);
      const existing = await repos.dataTables.listColumns(tenantId, id);
      const index = existing.findIndex((column) => column.id === columnId);
      if (index === -1) throw columnNotFound(id, columnId);
      const [removed] = existing.splice(index, 1);
      await repos.dataTables.deleteColumn(tenantId, id, columnId);
      await repos.dataTables.deleteRowKey(tenantId, id, removed.name);
      await this.writePositions(repos, tenantId, id, existing);
      await repos.dataTables.touch(tenantId, id);
      await this.audit(repos, tenantId, actor, 'dataTable.column.deleted', id, { columnId });
    });
    this.sizes.reset(tenantId);
  }

  private async writePositions(
    repos: Repositories,
    tenantId: string,
    id: string,
    columns: DataTableColumnRow[],
  ): Promise<void> {
    for (const [position, column] of columns.entries()) {
      if (column.position !== position) {
        await repos.dataTables.setColumnPosition(tenantId, id, column.id, position);
      }
    }
  }

  // ---- rows ----

  readonly rows: DataTableRowMethods = {
    list: (tenantId, id, query) => this.listRows(tenantId, id, query),
    insert: (tenantId, id, rows, returnType, actor) => this.insertRows(tenantId, id, rows, returnType, actor),
    upsert: (tenantId, id, change, options, actor) => this.upsertRow(tenantId, id, change, options, actor),
    update: (tenantId, id, change, options, actor) => this.updateRows(tenantId, id, change, options, actor),
    delete: (tenantId, id, filter, options, actor) => this.deleteRows(tenantId, id, filter, options, actor),
    clear: (tenantId, id, actor) => this.clearRows(tenantId, id, actor),
  };

  private async listRows(
    tenantId: string,
    id: string,
    query: DataTableRowsQuery,
  ): Promise<DataTablePage<DataTableRow>> {
    const { dataTables } = this.deps.repos;
    await this.requireTable(tenantId, id);
    const columns = await dataTables.listColumns(tenantId, id);
    const conditions = [buildFilterSql(query.filter, columns), buildSearchSql(query.search)];
    const orderBy = buildOrderBySql(query.sortBy, columns);
    const [count, rows] = await Promise.all([
      dataTables.countRows(tenantId, id, conditions),
      dataTables.listRows(tenantId, id, {
        conditions,
        orderBy,
        take: Math.min(query.take ?? DATA_TABLE_ROWS_TAKE_MAX, DATA_TABLE_ROWS_TAKE_MAX),
        skip: query.skip ?? 0,
      }),
    ]);
    return { count, data: rows.map((row) => toRow(row, columns)) };
  }

  /** with no clauses: whether the table has any row */
  async rowsExist(tenantId: string, id: string, filter: DataTableFilter): Promise<boolean> {
    const { dataTables } = this.deps.repos;
    await this.requireTable(tenantId, id);
    const columns = await dataTables.listColumns(tenantId, id);
    return dataTables.rowExists(tenantId, id, buildFilterSql(filter, columns));
  }

  private async insertRows<T extends DataTableInsertReturnType>(
    tenantId: string,
    id: string,
    rows: DataTableRowInput[],
    returnType: T,
    actor?: DataTableActor,
  ): Promise<DataTableInsertResult<T>> {
    await this.requireTable(tenantId, id);
    await this.assertQuota(tenantId);
    const { inserted, columns } = await this.writeRows(tenantId, id, rows);
    if (actor && inserted.length) {
      await this.audit(this.deps.repos, tenantId, actor, 'dataTable.rows.inserted', id, {
        rows: inserted.length,
      });
    }
    return this.insertAnswer(inserted, columns, returnType);
  }

  /**
   * The table row first, then the columns, so a column change or a delete that commits meanwhile
   * cannot leave a cell under a name the table no longer has; gone means n8n's 404 text.
   */
  private async lockColumns(repo: DataTableRepository, tenantId: string, id: string) {
    if (!(await repo.lock(tenantId, id))) throw tableNotFound(id);
    return repo.listColumns(tenantId, id);
  }

  /** takes the ids and writes the rows in one transaction */
  private async writeRows(
    tenantId: string,
    id: string,
    rows: DataTableRowInput[],
  ): Promise<{ inserted: DataTableRowRow[]; columns: DataTableColumnRow[] }> {
    const written = await this.deps.database.db.transaction(async (tx) => {
      const { dataTables } = createRepositories(tx);
      const columns = await this.lockColumns(dataTables, tenantId, id);
      const stored = rows.map((row) => this.toCells(row, columns));
      if (!stored.length) return { inserted: [], columns };
      const first = await dataTables.reserveRowIds(tenantId, id, stored.length);
      return { inserted: await dataTables.insertRows(tenantId, id, first, stored), columns };
    });
    this.sizes.added(
      tenantId,
      written.inserted.reduce((sum, row) => sum + row.sizeBytes, 0),
    );
    return written;
  }

  private insertAnswer<T extends DataTableInsertReturnType>(
    inserted: DataTableRowRow[],
    columns: DataTableColumnRow[],
    returnType: T,
  ): DataTableInsertResult<T> {
    if (returnType === 'all') {
      return inserted.map((row) => toRow(row, columns)) as DataTableInsertResult<T>;
    }
    if (returnType === 'id') {
      return inserted.map((row) => ({ id: row.rowId })) as DataTableInsertResult<T>;
    }
    return { success: true, insertedRows: inserted.length } as DataTableInsertResult<T>;
  }

  private assertChange(change: DataTableChange): void {
    if (!change.filter.filters.length) throw ApiError.badRequest(DATA_TABLE_ERRORS.filterEmpty);
    if (!Object.keys(change.data).length) throw ApiError.badRequest(DATA_EMPTY);
  }

  /** before and after, one pair per matched row; nothing is written */
  private dryRunPairs(
    rows: DataTableRowRow[],
    columns: DataTableColumnRow[],
    patch: Record<string, DataTableCellValue>,
  ): DataTableRowResult[] {
    const updatedAt = now().toISOString();
    return rows.flatMap((row) => {
      const before = toRow(row, columns);
      return [
        { ...before, dryRunState: 'before' as const },
        { ...before, ...patch, updatedAt, dryRunState: 'after' as const },
      ];
    });
  }

  private async updateRows(
    tenantId: string,
    id: string,
    change: DataTableChange,
    options: DataTableRowWriteOptions,
    actor?: DataTableActor,
  ): Promise<DataTableRowWriteResult> {
    const { dataTables } = this.deps.repos;
    await this.requireTable(tenantId, id);
    this.assertChange(change);
    const columns = await dataTables.listColumns(tenantId, id);
    const patch = this.toCells(change.data, columns);
    const condition = buildFilterSql(change.filter, columns);
    if (options.dryRun) {
      const rows = await dataTables.listRows(tenantId, id, {
        conditions: [condition],
        orderBy: buildOrderBySql(undefined, columns),
      });
      return this.dryRunPairs(rows, columns, patch);
    }
    await this.assertQuota(tenantId);
    // the columns are read again under the table lock, so a rename in between cannot misplace the cells
    const written = await this.deps.database.db.transaction(async (tx) => {
      const repo = createRepositories(tx).dataTables;
      const locked = await this.lockColumns(repo, tenantId, id);
      const rows = await repo.updateRows(
        tenantId,
        id,
        buildFilterSql(change.filter, locked),
        this.toCells(change.data, locked),
      );
      return { rows, columns: locked };
    });
    await this.afterRowChange(tenantId, id, written.rows.length, 'dataTable.rows.updated', actor);
    return options.returnData ? written.rows.map((row) => toRow(row, written.columns)) : true;
  }

  private async upsertRow(
    tenantId: string,
    id: string,
    change: DataTableChange,
    options: DataTableRowWriteOptions,
    actor?: DataTableActor,
  ): Promise<DataTableRowWriteResult> {
    const { dataTables } = this.deps.repos;
    await this.requireTable(tenantId, id);
    this.assertChange(change);
    const columns = await dataTables.listColumns(tenantId, id);
    const patch = this.toCells(change.data, columns);
    const condition = buildFilterSql(change.filter, columns);
    if (options.dryRun) {
      const rows = await dataTables.listRows(tenantId, id, {
        conditions: [condition],
        orderBy: buildOrderBySql(undefined, columns),
      });
      if (rows.length) return this.dryRunPairs(rows, columns, patch);
      const at = now().toISOString();
      const after = emptyDryRow(columns, 'after');
      return [
        emptyDryRow(columns, 'before'),
        { ...after, ...patch, id: 0, createdAt: at, updatedAt: at, dryRunState: 'after' as const },
      ];
    }
    await this.assertQuota(tenantId);
    const written = await this.deps.database.db.transaction(async (tx) => {
      const repos = createRepositories(tx).dataTables;
      const locked = await this.lockColumns(repos, tenantId, id);
      const lockedPatch = this.toCells(change.data, locked);
      const updated = await repos.updateRows(
        tenantId,
        id,
        buildFilterSql(change.filter, locked),
        lockedPatch,
      );
      if (updated.length) return { rows: updated, inserted: false, columns: locked };
      const first = await repos.reserveRowIds(tenantId, id, 1);
      return {
        rows: await repos.insertRows(tenantId, id, first, [lockedPatch]),
        inserted: true,
        columns: locked,
      };
    });
    await this.afterRowChange(
      tenantId,
      id,
      written.rows.length,
      written.inserted ? 'dataTable.rows.inserted' : 'dataTable.rows.updated',
      actor,
    );
    return options.returnData ? written.rows.map((row) => toRow(row, written.columns)) : true;
  }

  private async deleteRows(
    tenantId: string,
    id: string,
    filter: DataTableFilter,
    options: DataTableRowWriteOptions,
    actor?: DataTableActor,
  ): Promise<DataTableRowWriteResult> {
    const { dataTables } = this.deps.repos;
    await this.requireTable(tenantId, id);
    if (!filter.filters.length) throw ApiError.badRequest(DATA_TABLE_ERRORS.filterRequiredForDelete);
    const columns = await dataTables.listColumns(tenantId, id);
    const condition = buildFilterSql(filter, columns);
    if (options.dryRun) {
      const rows = await dataTables.listRows(tenantId, id, {
        conditions: [condition],
        orderBy: buildOrderBySql(undefined, columns),
      });
      return rows.flatMap((row) => [
        { ...toRow(row, columns), dryRunState: 'before' as const },
        emptyDryRow(columns, 'after'),
      ]);
    }
    const rows = await dataTables.deleteRows(tenantId, id, condition);
    await this.afterRowChange(tenantId, id, rows.length, 'dataTable.rows.deleted', actor);
    return options.returnData ? rows.map((row) => toRow(row, columns)) : true;
  }

  private async clearRows(
    tenantId: string,
    id: string,
    actor?: DataTableActor,
  ): Promise<{ deletedCount: number }> {
    await this.requireTable(tenantId, id);
    const deletedCount = await this.deps.database.db.transaction(async (tx) => {
      const repos = createRepositories(tx);
      const count = await repos.dataTables.clearRows(tenantId, id);
      await repos.dataTables.touch(tenantId, id);
      await this.audit(repos, tenantId, actor, 'dataTable.rows.cleared', id, { rows: count });
      return count;
    });
    this.sizes.reset(tenantId);
    return { deletedCount };
  }

  /** the sum changed by an unknown amount; the audit row counts rows and holds no cell */
  private async afterRowChange(
    tenantId: string,
    id: string,
    count: number,
    action: string,
    actor?: DataTableActor,
  ): Promise<void> {
    this.sizes.reset(tenantId);
    if (!count) return;
    await this.deps.repos.dataTables.touch(tenantId, id);
    if (actor) await this.audit(this.deps.repos, tenantId, actor, action, id, { rows: count });
  }

  /** the cells to store; only keys that are columns of the table get through */
  private toCells(
    row: DataTableRowInput,
    columns: DataTableColumnInput[],
  ): Record<string, DataTableCellValue> {
    const types = new Map<string, DataTableColumnType>(columns.map((column) => [column.name, column.type]));
    const out: Record<string, DataTableCellValue> = {};
    for (const key of Object.keys(row)) {
      const type = types.get(key);
      if (!type) throw ApiError.badRequest(DATA_TABLE_ERRORS.unknownColumn(key));
      out[key] = coerceCellValue(row[key] ?? null, type);
    }
    return out;
  }

  // ---- CSV ----

  async csvPreview(tenantId: string, input: DataTableCsvPreviewInput): Promise<DataTableCsvPreview> {
    await this.assertCsvFits(tenantId, input.csv);
    return previewCsv(input.csv, input.hasHeaders ?? true);
  }

  /** every row or none: one transaction */
  async importCsv(
    tenantId: string,
    id: string,
    input: DataTableCsvImportInput,
    actor?: DataTableActor,
  ): Promise<DataTableCsvImportResult> {
    await this.requireTable(tenantId, id);
    await this.assertCsvFits(tenantId, input.csv);
    const { rows, systemColumnsIgnored } = csvRowsForImport(parseCsv(input.csv, true));
    await this.assertQuota(tenantId);
    if (rows.length) await this.writeRows(tenantId, id, rows);
    await this.audit(this.deps.repos, tenantId, actor, 'dataTable.imported', id, { rows: rows.length });
    return { importedRows: rows.length, systemColumnsIgnored };
  }

  /** every row, with text cells a spreadsheet would run escaped */
  async downloadCsv(
    tenantId: string,
    id: string,
    options: DataTableCsvDownloadOptions,
  ): Promise<DataTableCsvDownload> {
    const { dataTables } = this.deps.repos;
    const table = await this.requireTable(tenantId, id);
    const columns = await dataTables.listColumns(tenantId, id);
    const rows = await dataTables.listRows(tenantId, id, { orderBy: buildOrderBySql(undefined, columns) });
    const fields = [
      ...(options.includeSystemColumns ? DATA_TABLE_SYSTEM_COLUMNS : []),
      ...columns.map((column) => column.name),
    ];
    const lines = rows.map((row) => {
      const out = toRow(row, columns);
      return fields.map((field) => out[field]);
    });
    return { csvContent: buildCsv(fields, lines), dataTableName: table.name };
  }

  // ---- limits and use ----

  /**
   * the totals are the workspace's (n8n's limits are instance wide); with `caller` the table list holds
   * only the tables of the caller's projects, so nobody sees the names of another project's tables
   */
  async limits(tenantId: string, caller?: AuthContext): Promise<DataTableLimits> {
    const { config, repos } = this.deps;
    const visible = caller
      ? await this.deps.context().access.listFilter(caller, 'dataTable:listProject')
      : undefined;
    const [maxBytes, tables] = await Promise.all([
      this.quotaBytes(tenantId),
      repos.dataTables.tableSizes(tenantId),
    ]);
    const totalBytes = tables.reduce((sum, table) => sum + table.sizeBytes, 0);
    const warnAt = warningBytes(config, maxBytes);
    return {
      totalBytes,
      maxBytes,
      warningBytes: warnAt,
      quotaStatus: quotaStatus(totalBytes, warnAt, maxBytes),
      uploadMaxFileSize: dataTableUploadLimitBytes(config, maxBytes - totalBytes),
      dataTables: Object.fromEntries(
        tables
          .filter((table) => !visible || visible.all || visible.projectIds.includes(table.projectId))
          .map(({ id, name, sizeBytes }) => [id, { id, name, sizeBytes }]),
      ),
    };
  }

  /** with `caller`, a workflow the caller cannot list (`workflow:list`) is left out */
  async dependencies(tenantId: string, id: string, caller?: AuthContext): Promise<DataTableDependency[]> {
    const table = await this.requireTable(tenantId, id);
    const visible = caller ? await this.deps.context().access.listFilter(caller, 'workflow:list') : undefined;
    const workflows = await this.deps.repos.dataTables.dependentWorkflows(tenantId, table);
    return workflows
      .filter(
        (workflow) =>
          !visible ||
          visible.all ||
          visible.projectIds.includes(workflow.projectId) ||
          visible.workflowIds.includes(workflow.id),
      )
      .map((workflow) => ({ type: 'workflow', id: workflow.id, name: workflow.name }));
  }

  // ---- shared checks ----

  private async requireTable(tenantId: string, id: string): Promise<DataTableTableRow> {
    const row = await this.deps.repos.dataTables.get(tenantId, id);
    if (!row) throw tableNotFound(id);
    return row;
  }

  private async quotaBytes(tenantId: string): Promise<number> {
    const { config, repos } = this.deps;
    const tenant = await repos.tenants.get(tenantId);
    const limits = effectiveLimits(tenant?.plan ?? '', tenant?.settings as TenantSettings | undefined);
    return dataTableQuotaBytes(config, limits);
  }

  private cachedBytes(tenantId: string): Promise<number> {
    const { config, repos } = this.deps;
    return this.sizes.bytes(tenantId, config.dataTables.sizeCheckCacheDurationMs, () =>
      repos.dataTables.totalSizeBytes(tenantId),
    );
  }

  private async assertQuota(tenantId: string): Promise<void> {
    const [maxBytes, usedBytes] = await Promise.all([this.quotaBytes(tenantId), this.cachedBytes(tenantId)]);
    assertWithinQuota(usedBytes, maxBytes);
  }

  private async assertCsvFits(tenantId: string, csv: string): Promise<void> {
    const [maxBytes, usedBytes] = await Promise.all([this.quotaBytes(tenantId), this.cachedBytes(tenantId)]);
    const limit = dataTableUploadLimitBytes(this.deps.config, maxBytes - usedBytes);
    if (Buffer.byteLength(csv) > limit) throw ApiError.badRequest(CSV_TOO_LARGE_MESSAGE);
  }

  private async audit(
    repos: Repositories,
    tenantId: string,
    actor: DataTableActor | undefined,
    action: string,
    tableId: string,
    metadata: Record<string, unknown> = {},
  ): Promise<void> {
    await repos.audit.add(tenantId, {
      userId: actor?.userId,
      action,
      resourceType: 'dataTable',
      resourceId: tableId,
      metadata: actor?.workflowId ? { ...metadata, workflowId: actor.workflowId } : metadata,
      ip: actor?.ip,
    });
  }
}
