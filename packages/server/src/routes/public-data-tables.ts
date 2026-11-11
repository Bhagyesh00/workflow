/**
 * Public API data tables (P4-18), n8n's public controller: 16 routes with API-key scopes and cursor
 * paging (limit default 100, max 250). PUBLIC_DATA_TABLE_ROUTES is final and carries everything a
 * PUBLIC_ROUTES row needs (public-api.ts spreads it and runs the `access` check, then the key scope).
 * The handlers call the same DataTableService as /rest/data-tables; lists answer `{data, nextCursor}`
 * where the cursor is an opaque offset.
 */
import { z } from 'zod';
import type { ServerContext } from '../context';
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
import type { PublicApiInput, RouteAccess, RouteTarget } from './public-api';

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

/** the cursor is an opaque offset: `o` and the number of rows already sent */
const CURSOR_PREFIX = 'o';

export function decodeCursor(raw: string | undefined): number {
  if (raw === undefined) return 0;
  const text = Buffer.from(raw, 'base64url').toString('utf8');
  const skip = text.startsWith(CURSOR_PREFIX) ? Number(text.slice(CURSOR_PREFIX.length)) : Number.NaN;
  if (
    !Number.isSafeInteger(skip) ||
    skip < 0 ||
    Buffer.from(raw, 'base64url').toString('base64url') !== raw
  ) {
    throw ApiError.badRequest('Invalid cursor');
  }
  return skip;
}

export const encodeCursor = (skip: number) =>
  Buffer.from(`${CURSOR_PREFIX}${skip}`, 'utf8').toString('base64url');

/** one page of `{count, data}` as `{data, nextCursor}` */
export function paged<T, U>(page: { count: number; data: T[] }, skip: number, map: (item: T) => U) {
  const end = skip + page.data.length;
  return {
    data: page.data.map(map),
    nextCursor: page.data.length > 0 && end < page.count ? encodeCursor(end) : null,
  };
}

interface ColumnLike {
  id: string;
  name: string;
  type: string;
  position: number;
  createdAt: string;
  updatedAt: string;
}

/** the public column carries n8n's `index` where the service has `position` */
const columnDTO = ({ position, ...column }: ColumnLike) => ({ ...column, index: position });
const tableDTO = <T extends { columns: ColumnLike[] }>(table: T) => ({
  ...table,
  columns: table.columns.map(columnDTO),
});

const actorOf = ({ auth, request }: PublicApiInput) => ({ userId: auth.user.id, ip: request.ip });

export const publicDataTableHandlers: Record<PublicDataTableHandler, Handler> = {
  list: async (ctx, { auth, query }) => {
    const skip = decodeCursor(query.cursor);
    // `caller`: only the tables of the projects the key's user may list (`dataTable:listProject`)
    const page = await ctx.dataTables.list(auth.tenant.id, {
      skip,
      take: query.limit,
      sortBy: query.sortBy,
      name: query.filter?.name,
      caller: auth,
    });
    return paged(page, skip, tableDTO);
  },
  create: async (ctx, input) => ({
    data: tableDTO(
      await ctx.dataTables.create(
        input.auth.tenant.id,
        // the dispatcher resolved the project (`targetProject`) and checked `dataTable:create` in it; `caller`
        // makes the answer carry the table's project
        {
          name: input.body.name,
          columns: input.body.columns,
          projectId: input.projectId,
          caller: input.auth,
        },
        actorOf(input),
      ),
    ),
  }),
  get: async (ctx, { auth, params }) => ({
    data: tableDTO(await ctx.dataTables.get(auth.tenant.id, params.dataTableId, auth)),
  }),
  update: async (ctx, input) => ({
    data: tableDTO(
      await ctx.dataTables.patch(
        input.auth.tenant.id,
        input.params.dataTableId,
        { name: input.body.name },
        actorOf(input),
        input.auth,
      ),
    ),
  }),
  remove: async (ctx, input) => {
    await ctx.dataTables.delete(input.auth.tenant.id, input.params.dataTableId, actorOf(input));
    return { data: true };
  },
  // P6-86: the same paged shape as the workflow and credential dependency rows; a workflow the key's user
  // cannot read is left out
  dependencies: (ctx, { auth, params, query }) =>
    ctx.dependencies.forDataTable(auth, params.dataTableId, { limit: query.limit, cursor: query.cursor }),
  listColumns: async (ctx, { auth, params }) => ({
    data: (await ctx.dataTables.columns.list(auth.tenant.id, params.dataTableId)).map(columnDTO),
  }),
  addColumn: async (ctx, input) => ({
    data: columnDTO(
      await ctx.dataTables.columns.add(
        input.auth.tenant.id,
        input.params.dataTableId,
        input.body,
        actorOf(input),
      ),
    ),
  }),
  updateColumn: async (ctx, input) => {
    const { name, index } = input.body as { name?: string; index?: number };
    if (name === undefined && index === undefined) {
      throw ApiError.badRequest('Send a name, an index or both');
    }
    const tenantId = input.auth.tenant.id;
    const { dataTableId, columnId } = input.params;
    const actor = actorOf(input);
    let column: ColumnLike | undefined;
    if (name !== undefined) {
      column = await ctx.dataTables.columns.rename(tenantId, dataTableId, columnId, { name }, actor);
    }
    if (index !== undefined) {
      column = await ctx.dataTables.columns.move(
        tenantId,
        dataTableId,
        columnId,
        { targetIndex: index },
        actor,
      );
    }
    return { data: columnDTO(column as ColumnLike) };
  },
  removeColumn: async (ctx, input) => {
    await ctx.dataTables.columns.delete(
      input.auth.tenant.id,
      input.params.dataTableId,
      input.params.columnId,
      actorOf(input),
    );
    return { data: true };
  },
  listRows: async (ctx, { auth, params, query }) => {
    const skip = decodeCursor(query.cursor);
    const page = await ctx.dataTables.rows.list(auth.tenant.id, params.dataTableId, {
      skip,
      take: query.limit,
      sortBy: query.sortBy,
      filter: query.filter,
      search: query.search,
    });
    return paged(page, skip, (row) => row);
  },
  insertRows: async (ctx, input) => ({
    data: await ctx.dataTables.rows.insert(
      input.auth.tenant.id,
      input.params.dataTableId,
      input.body.data,
      input.body.returnType,
      actorOf(input),
    ),
  }),
  upsertRows: async (ctx, input) => {
    const { dryRun, returnData, ...change } = input.body;
    return {
      data: await ctx.dataTables.rows.upsert(
        input.auth.tenant.id,
        input.params.dataTableId,
        change,
        { dryRun, returnData },
        actorOf(input),
      ),
    };
  },
  updateRows: async (ctx, input) => {
    const { dryRun, returnData, ...change } = input.body;
    return {
      data: await ctx.dataTables.rows.update(
        input.auth.tenant.id,
        input.params.dataTableId,
        change,
        { dryRun, returnData },
        actorOf(input),
      ),
    };
  },
  deleteRows: async (ctx, input) => {
    const { filter, dryRun, returnData } = input.query;
    return {
      data: await ctx.dataTables.rows.delete(
        input.auth.tenant.id,
        input.params.dataTableId,
        filter,
        { dryRun, returnData },
        actorOf(input),
      ),
    };
  },
  clearRows: async (ctx, input) => ({
    data: await ctx.dataTables.rows.clear(input.auth.tenant.id, input.params.dataTableId, actorOf(input)),
  }),
};

const limit = z.coerce.number().int().min(1).max(250).default(100);
const cursor = z.string().max(512).optional();

const tableParams = z.object({ dataTableId: z.uuid() });
const dependenciesQuery = z.object({ limit, cursor });
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
  /** the project that owns the table; absent, the workspace's default */
  projectId: z.uuid().nullish(),
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
  /** who may call it, by the user's scopes; the key must hold `scope` as well */
  access: RouteAccess;
  scope: ApiKeyScope;
  params?: z.ZodObject;
  query?: z.ZodObject;
  body?: z.ZodType;
  /** component schema name of `data` in the response */
  response: 'DataTable' | 'DataTableColumn' | 'DataTableRow' | 'DependencyList' | 'DataTableResult';
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
const onTable: RouteTarget = ({ params }) => ({ dataTableId: params.dataTableId });

export const PUBLIC_DATA_TABLE_ROUTES: PublicDataTableRoute[] = [
  route('list', {
    method: 'GET',
    path: '/data-tables',
    summary: 'List data tables',
    access: { scope: 'dataTable:listProject', list: true },
    scope: 'dataTable:list',
    query: listQuery,
    response: 'DataTable',
    list: true,
  }),
  route('create', {
    method: 'POST',
    path: '/data-tables',
    summary: 'Create a data table',
    access: { scope: 'dataTable:create', create: true },
    scope: 'dataTable:create',
    body: createBody,
    response: 'DataTable',
  }),
  route('get', {
    method: 'GET',
    path: one,
    summary: 'Get a data table',
    access: { scope: 'dataTable:read', target: onTable },
    scope: 'dataTable:read',
    params: tableParams,
    response: 'DataTable',
  }),
  route('update', {
    method: 'PATCH',
    path: one,
    summary: 'Rename a data table',
    access: { scope: 'dataTable:update', target: onTable },
    scope: 'dataTable:update',
    params: tableParams,
    body: updateBody,
    response: 'DataTable',
  }),
  route('remove', {
    method: 'DELETE',
    path: one,
    summary: 'Delete a data table',
    access: { scope: 'dataTable:delete', target: onTable },
    scope: 'dataTable:delete',
    params: tableParams,
    response: 'DataTableResult',
  }),
  route('dependencies', {
    method: 'GET',
    path: `${one}/dependencies`,
    summary: 'List the workflows that use a data table',
    access: { scope: 'dataTable:read', target: onTable },
    scope: 'dataTable:read',
    params: tableParams,
    query: dependenciesQuery,
    response: 'DependencyList',
    list: true,
  }),
  route('listColumns', {
    method: 'GET',
    path: `${one}/columns`,
    summary: 'List the columns of a data table',
    access: { scope: 'dataTable:readColumn', target: onTable },
    scope: 'dataTableColumn:read',
    params: tableParams,
    response: 'DataTableColumn',
  }),
  route('addColumn', {
    method: 'POST',
    path: `${one}/columns`,
    summary: 'Add a column',
    access: { scope: 'dataTable:writeColumn', target: onTable },
    scope: 'dataTableColumn:create',
    params: tableParams,
    body: dataTableColumnAddBody,
    response: 'DataTableColumn',
  }),
  route('updateColumn', {
    method: 'PATCH',
    path: `${one}/columns/:columnId`,
    summary: 'Rename or move a column',
    access: { scope: 'dataTable:writeColumn', target: onTable },
    scope: 'dataTableColumn:update',
    params: columnParams,
    body: columnUpdateBody,
    response: 'DataTableColumn',
  }),
  route('removeColumn', {
    method: 'DELETE',
    path: `${one}/columns/:columnId`,
    summary: 'Delete a column',
    access: { scope: 'dataTable:writeColumn', target: onTable },
    scope: 'dataTableColumn:delete',
    params: columnParams,
    response: 'DataTableResult',
  }),
  route('listRows', {
    method: 'GET',
    path: `${one}/rows`,
    summary: 'List rows',
    access: { scope: 'dataTable:readRow', target: onTable },
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
    access: { scope: 'dataTable:writeRow', target: onTable },
    scope: 'dataTableRow:create',
    params: tableParams,
    body: dataTableInsertBody,
    response: 'DataTableResult',
  }),
  route('upsertRows', {
    method: 'POST',
    path: `${one}/rows/upsert`,
    summary: 'Update the row that matches, or insert one',
    access: { scope: 'dataTable:writeRow', target: onTable },
    scope: 'dataTableRow:upsert',
    params: tableParams,
    body: dataTableChangeBody,
    response: 'DataTableResult',
  }),
  route('updateRows', {
    method: 'PATCH',
    path: `${one}/rows/update`,
    summary: 'Update the rows that match',
    access: { scope: 'dataTable:writeRow', target: onTable },
    scope: 'dataTableRow:update',
    params: tableParams,
    body: dataTableChangeBody,
    response: 'DataTableResult',
  }),
  route('deleteRows', {
    method: 'DELETE',
    path: `${one}/rows/delete`,
    summary: 'Delete the rows that match',
    access: { scope: 'dataTable:writeRow', target: onTable },
    scope: 'dataTableRow:delete',
    params: tableParams,
    query: dataTableDeleteQuery,
    response: 'DataTableResult',
  }),
  route('clearRows', {
    method: 'DELETE',
    path: `${one}/rows/clear`,
    summary: 'Delete every row',
    access: { scope: 'dataTable:writeRow', target: onTable },
    scope: 'dataTableRow:delete',
    params: tableParams,
    response: 'DataTableResult',
  }),
];
