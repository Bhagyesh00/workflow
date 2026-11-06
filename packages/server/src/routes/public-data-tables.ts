/**
 * Public API data tables (P4-18), n8n's public controller: 16 routes with API-key scopes and cursor
 * paging (limit default 100, max 250). PUBLIC_DATA_TABLE_ROUTES is final and carries everything a
 * PUBLIC_ROUTES row needs (C0c spreads it into public-api.ts, which has the role and scope gates).
 * The handlers are stubs until L7 and call the same DataTableService as /rest/data-tables.
 */
import { z } from 'zod';
import type { ServerContext } from '../context';
import type { Role } from '../db/schema';
import type { ApiKeyScope } from '../http/api-key-scopes';
import { ApiError } from '../http/errors';
import {
  dataTableChangeBody,
  dataTableColumnAddBody,
  dataTableColumnSchema,
  dataTableDeleteQuery,
  dataTableFilterSchema,
  dataTableInsertBody,
  dataTableListFilter,
  dataTableListSort,
  dataTableNameSchema,
  dataTableRowsSort,
  jsonQuery,
} from './data-tables';
import type { PublicApiInput } from './public-api';

type Handler = (ctx: ServerContext, input: PublicApiInput) => Promise<unknown>;

export type PublicDataTableHandler =
  | 'list'
  | 'create'
  | 'get'
  | 'update'
  | 'remove'
  | 'dependencies'
  | 'listColumns'
  | 'addColumn'
  | 'updateColumn'
  | 'removeColumn'
  | 'listRows'
  | 'insertRows'
  | 'upsertRows'
  | 'updateRows'
  | 'deleteRows'
  | 'clearRows';

const notBuilt: Handler = async () => {
  throw new ApiError(501, 'not_built', 'not built');
};

export const publicDataTableHandlers: Record<PublicDataTableHandler, Handler> = {
  list: notBuilt,
  create: notBuilt,
  get: notBuilt,
  update: notBuilt,
  remove: notBuilt,
  dependencies: notBuilt,
  listColumns: notBuilt,
  addColumn: notBuilt,
  updateColumn: notBuilt,
  removeColumn: notBuilt,
  listRows: notBuilt,
  insertRows: notBuilt,
  upsertRows: notBuilt,
  updateRows: notBuilt,
  deleteRows: notBuilt,
  clearRows: notBuilt,
};

const limit = z.coerce.number().int().min(1).max(250).default(100);
const cursor = z.string().max(512).optional();

const tableParams = z.object({ dataTableId: z.uuid() });
const columnParams = tableParams.extend({ columnId: z.uuid() });
const listQuery = z.object({
  limit,
  cursor,
  sortBy: dataTableListSort.optional(),
  filter: dataTableListFilter.optional(),
});
const rowsQuery = z.object({
  limit,
  cursor,
  sortBy: dataTableRowsSort.optional(),
  filter: jsonQuery(dataTableFilterSchema).optional(),
  search: z.string().max(1024).optional(),
});
const createBody = z.object({
  name: dataTableNameSchema,
  columns: z.array(dataTableColumnSchema).default([]),
});
const updateBody = z.object({ name: dataTableNameSchema });
const columnUpdateBody = z.object({
  name: dataTableColumnSchema.shape.name.optional(),
  index: z.number().int().min(0).optional(),
});

export interface PublicDataTableRoute {
  method: 'GET' | 'POST' | 'PATCH' | 'DELETE';
  path: string;
  summary: string;
  tag: 'DataTable';
  role: Role;
  scope: ApiKeyScope;
  params?: z.ZodObject;
  query?: z.ZodObject;
  body?: z.ZodType;
  /** component schema name of `data` in the response */
  response: 'DataTable' | 'DataTableColumn' | 'DataTableRow' | 'DataTableDependency' | 'DataTableResult';
  list?: boolean;
  handler: Handler;
}

const route = (
  name: PublicDataTableHandler,
  row: Omit<PublicDataTableRoute, 'tag' | 'handler'>,
): PublicDataTableRoute => ({
  ...row,
  tag: 'DataTable',
  /** late bound, so the handler that runs is the one in the table above */
  handler: (ctx, input) => publicDataTableHandlers[name](ctx, input),
});

const one = '/data-tables/:dataTableId';

export const PUBLIC_DATA_TABLE_ROUTES: PublicDataTableRoute[] = [
  route('list', {
    method: 'GET',
    path: '/data-tables',
    summary: 'List data tables',
    role: 'viewer',
    scope: 'dataTable:list',
    query: listQuery,
    response: 'DataTable',
    list: true,
  }),
  route('create', {
    method: 'POST',
    path: '/data-tables',
    summary: 'Create a data table',
    role: 'editor',
    scope: 'dataTable:create',
    body: createBody,
    response: 'DataTable',
  }),
  route('get', {
    method: 'GET',
    path: one,
    summary: 'Get a data table',
    role: 'viewer',
    scope: 'dataTable:read',
    params: tableParams,
    response: 'DataTable',
  }),
  route('update', {
    method: 'PATCH',
    path: one,
    summary: 'Rename a data table',
    role: 'editor',
    scope: 'dataTable:update',
    params: tableParams,
    body: updateBody,
    response: 'DataTable',
  }),
  route('remove', {
    method: 'DELETE',
    path: one,
    summary: 'Delete a data table',
    role: 'editor',
    scope: 'dataTable:delete',
    params: tableParams,
    response: 'DataTableResult',
  }),
  route('dependencies', {
    method: 'GET',
    path: `${one}/dependencies`,
    summary: 'List the workflows that use a data table',
    role: 'viewer',
    scope: 'dataTable:read',
    params: tableParams,
    response: 'DataTableDependency',
  }),
  route('listColumns', {
    method: 'GET',
    path: `${one}/columns`,
    summary: 'List the columns of a data table',
    role: 'viewer',
    scope: 'dataTableColumn:read',
    params: tableParams,
    response: 'DataTableColumn',
  }),
  route('addColumn', {
    method: 'POST',
    path: `${one}/columns`,
    summary: 'Add a column',
    role: 'editor',
    scope: 'dataTableColumn:create',
    params: tableParams,
    body: dataTableColumnAddBody,
    response: 'DataTableColumn',
  }),
  route('updateColumn', {
    method: 'PATCH',
    path: `${one}/columns/:columnId`,
    summary: 'Rename or move a column',
    role: 'editor',
    scope: 'dataTableColumn:update',
    params: columnParams,
    body: columnUpdateBody,
    response: 'DataTableColumn',
  }),
  route('removeColumn', {
    method: 'DELETE',
    path: `${one}/columns/:columnId`,
    summary: 'Delete a column',
    role: 'editor',
    scope: 'dataTableColumn:delete',
    params: columnParams,
    response: 'DataTableResult',
  }),
  route('listRows', {
    method: 'GET',
    path: `${one}/rows`,
    summary: 'List rows',
    role: 'viewer',
    scope: 'dataTableRow:read',
    params: tableParams,
    query: rowsQuery,
    response: 'DataTableRow',
    list: true,
  }),
  route('insertRows', {
    method: 'POST',
    path: `${one}/rows`,
    summary: 'Insert rows',
    role: 'editor',
    scope: 'dataTableRow:create',
    params: tableParams,
    body: dataTableInsertBody,
    response: 'DataTableResult',
  }),
  route('upsertRows', {
    method: 'POST',
    path: `${one}/rows/upsert`,
    summary: 'Update the row that matches, or insert one',
    role: 'editor',
    scope: 'dataTableRow:upsert',
    params: tableParams,
    body: dataTableChangeBody,
    response: 'DataTableResult',
  }),
  route('updateRows', {
    method: 'PATCH',
    path: `${one}/rows/update`,
    summary: 'Update the rows that match',
    role: 'editor',
    scope: 'dataTableRow:update',
    params: tableParams,
    body: dataTableChangeBody,
    response: 'DataTableResult',
  }),
  route('deleteRows', {
    method: 'DELETE',
    path: `${one}/rows/delete`,
    summary: 'Delete the rows that match',
    role: 'editor',
    scope: 'dataTableRow:delete',
    params: tableParams,
    query: dataTableDeleteQuery,
    response: 'DataTableResult',
  }),
  route('clearRows', {
    method: 'DELETE',
    path: `${one}/rows/clear`,
    summary: 'Delete every row',
    role: 'editor',
    scope: 'dataTableRow:delete',
    params: tableParams,
    response: 'DataTableResult',
  }),
];
