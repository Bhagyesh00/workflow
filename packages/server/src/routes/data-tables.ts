/**
 * /rest/data-tables (P4-03), n8n's REST list without the project segment, with offset paging. Viewer
 * reads, editor and above write. The schemas here are real and the public routes reuse them; the
 * service behind them is a stub until L4.
 */
import {
  DATA_TABLE_COLUMN_NAME_MAX,
  DATA_TABLE_COLUMN_NAME_RE,
  DATA_TABLE_COLUMN_TYPES,
  DATA_TABLE_ERRORS,
  DATA_TABLE_FILTER_CONDITIONS,
  DATA_TABLE_NAME_MAX,
  DATA_TABLE_ROWS_TAKE_MAX,
} from '@workflow/workflow';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { requireRole } from '../http/auth';
import { parse } from '../http/errors';
import { idParams } from '../http/schemas';
import type { DataTableActor, DataTableService } from '../services/data-tables';

/** a query parameter that holds JSON (n8n's `filter`) */
export function jsonQuery<T extends z.ZodType>(schema: T) {
  return z
    .string()
    .transform((raw, ctx) => {
      try {
        return JSON.parse(raw) as unknown;
      } catch {
        ctx.issues.push({ code: 'custom', message: 'Must be valid JSON', input: raw });
        return z.NEVER;
      }
    })
    .pipe(schema);
}

const cellValue = z.union([z.string(), z.number(), z.boolean(), z.null()]);
/** column names are checked by the service, so an unknown one gets n8n's text */
export const dataTableRowSchema = z.record(z.string(), cellValue);

export const dataTableFilterSchema = z.object({
  type: z.enum(['and', 'or']).default('and'),
  filters: z
    .array(
      z.object({
        columnName: z.string().min(1).max(DATA_TABLE_COLUMN_NAME_MAX),
        condition: z.enum(DATA_TABLE_FILTER_CONDITIONS),
        value: cellValue.optional(),
      }),
    )
    .default([]),
});
const emptyFilter = () => ({ type: 'and' as const, filters: [] });

const direction = z.enum(['asc', 'desc']);
/** `column:direction` */
const sortBy = z
  .string()
  .max(128)
  .transform((raw) => {
    const at = raw.lastIndexOf(':');
    return { column: raw.slice(0, Math.max(at, 0)), direction: raw.slice(at + 1) };
  });

export const dataTableListSort = sortBy.pipe(
  z.object({ column: z.enum(['name', 'createdAt', 'updatedAt']), direction }),
);
export const dataTableRowsSort = sortBy.pipe(
  z.object({ column: z.string().min(1).max(DATA_TABLE_COLUMN_NAME_MAX), direction }),
);
export const dataTableListFilter = jsonQuery(
  z.object({ name: z.string().max(DATA_TABLE_NAME_MAX).optional() }),
);

const skip = z.coerce.number().int().min(0).default(0);
/** n8n caps take rather than refusing it */
const take = z.coerce
  .number()
  .int()
  .min(1)
  .default(10)
  .transform((value) => Math.min(value, DATA_TABLE_ROWS_TAKE_MAX));

const listQuery = z
  .object({ skip, take, sortBy: dataTableListSort.optional(), filter: dataTableListFilter.optional() })
  .transform(({ filter, ...rest }) => ({ ...rest, name: filter?.name }));

const rowsQuery = z.object({
  skip,
  take,
  sortBy: dataTableRowsSort.optional(),
  filter: jsonQuery(dataTableFilterSchema).optional(),
  search: z.string().max(1024).optional(),
});

export const dataTableColumnSchema = z.object({
  name: z
    .string()
    .min(1)
    .max(DATA_TABLE_COLUMN_NAME_MAX)
    .regex(DATA_TABLE_COLUMN_NAME_RE, DATA_TABLE_ERRORS.columnNameInvalid),
  type: z.enum(DATA_TABLE_COLUMN_TYPES),
});
export const dataTableNameSchema = z.string().trim().min(1).max(DATA_TABLE_NAME_MAX);

const createBody = z.object({
  name: dataTableNameSchema,
  columns: z.array(dataTableColumnSchema).default([]),
  /** size is held by the upload limit in the service, so a big file gets n8n's text */
  csv: z.string().optional(),
  hasHeaders: z.boolean().optional(),
});
const patchBody = z.object({ name: dataTableNameSchema });
const columnParams = idParams.extend({ columnId: z.uuid() });
export const dataTableColumnAddBody = dataTableColumnSchema.extend({
  index: z.number().int().min(0).optional(),
});
const columnRenameBody = z.object({ name: dataTableColumnSchema.shape.name });
const columnMoveBody = z.object({ targetIndex: z.number().int().min(0) });

export const dataTableInsertBody = z.object({
  data: z.array(dataTableRowSchema),
  returnType: z.enum(['all', 'id', 'count']).default('count'),
});
export const dataTableChangeBody = z.object({
  filter: dataTableFilterSchema,
  data: dataTableRowSchema,
  dryRun: z.boolean().default(false),
  returnData: z.boolean().default(false),
});
export const dataTableDeleteQuery = z.object({
  /** an empty filter reaches the service, which answers n8n's "needs a filter" text */
  filter: jsonQuery(dataTableFilterSchema)
    .optional()
    .transform((filter) => filter ?? emptyFilter()),
  dryRun: z.stringbool().default(false),
  returnData: z.stringbool().default(false),
});
const downloadQuery = z.object({ includeSystemColumns: z.stringbool().default(true) });
const csvPreviewBody = z.object({ csv: z.string(), hasHeaders: z.boolean().optional() });
const csvImportBody = z.object({ csv: z.string() });

export function registerDataTableRoutes(app: FastifyInstance, deps: { dataTables: DataTableService }): void {
  const { dataTables } = deps;
  const actor = (request: FastifyRequest): DataTableActor => ({
    userId: request.auth?.user.id,
    ip: request.ip,
  });

  app.get('/data-tables', async (request) => {
    const auth = requireRole(request, 'viewer');
    return { data: await dataTables.list(auth.tenant.id, parse(listQuery, request.query)) };
  });

  app.get('/data-tables/limits', async (request) => {
    const auth = requireRole(request, 'viewer');
    return { data: await dataTables.limits(auth.tenant.id) };
  });

  app.post('/data-tables', async (request) => {
    const auth = requireRole(request, 'editor');
    return { data: await dataTables.create(auth.tenant.id, parse(createBody, request.body), actor(request)) };
  });

  app.post('/data-tables/csv/preview', async (request) => {
    const auth = requireRole(request, 'editor');
    return { data: await dataTables.csvPreview(auth.tenant.id, parse(csvPreviewBody, request.body)) };
  });

  app.get('/data-tables/:id', async (request) => {
    const auth = requireRole(request, 'viewer');
    const { id } = parse(idParams, request.params);
    return { data: await dataTables.get(auth.tenant.id, id) };
  });

  app.patch('/data-tables/:id', async (request) => {
    const auth = requireRole(request, 'editor');
    const { id } = parse(idParams, request.params);
    return {
      data: await dataTables.patch(auth.tenant.id, id, parse(patchBody, request.body), actor(request)),
    };
  });

  app.delete('/data-tables/:id', async (request) => {
    const auth = requireRole(request, 'editor');
    const { id } = parse(idParams, request.params);
    await dataTables.delete(auth.tenant.id, id, actor(request));
    return { data: { ok: true } };
  });

  app.get('/data-tables/:id/dependencies', async (request) => {
    const auth = requireRole(request, 'viewer');
    const { id } = parse(idParams, request.params);
    return { data: await dataTables.dependencies(auth.tenant.id, id) };
  });

  app.get('/data-tables/:id/columns', async (request) => {
    const auth = requireRole(request, 'viewer');
    const { id } = parse(idParams, request.params);
    return { data: await dataTables.columns.list(auth.tenant.id, id) };
  });

  app.post('/data-tables/:id/columns', async (request) => {
    const auth = requireRole(request, 'editor');
    const { id } = parse(idParams, request.params);
    const body = parse(dataTableColumnAddBody, request.body);
    return { data: await dataTables.columns.add(auth.tenant.id, id, body, actor(request)) };
  });

  app.delete('/data-tables/:id/columns/:columnId', async (request) => {
    const auth = requireRole(request, 'editor');
    const { id, columnId } = parse(columnParams, request.params);
    await dataTables.columns.delete(auth.tenant.id, id, columnId, actor(request));
    return { data: { ok: true } };
  });

  app.patch('/data-tables/:id/columns/:columnId/move', async (request) => {
    const auth = requireRole(request, 'editor');
    const { id, columnId } = parse(columnParams, request.params);
    const body = parse(columnMoveBody, request.body);
    return { data: await dataTables.columns.move(auth.tenant.id, id, columnId, body, actor(request)) };
  });

  app.patch('/data-tables/:id/columns/:columnId/rename', async (request) => {
    const auth = requireRole(request, 'editor');
    const { id, columnId } = parse(columnParams, request.params);
    const body = parse(columnRenameBody, request.body);
    return { data: await dataTables.columns.rename(auth.tenant.id, id, columnId, body, actor(request)) };
  });

  app.get('/data-tables/:id/rows', async (request) => {
    const auth = requireRole(request, 'viewer');
    const { id } = parse(idParams, request.params);
    return { data: await dataTables.rows.list(auth.tenant.id, id, parse(rowsQuery, request.query)) };
  });

  app.post('/data-tables/:id/insert', async (request) => {
    const auth = requireRole(request, 'editor');
    const { id } = parse(idParams, request.params);
    const body = parse(dataTableInsertBody, request.body);
    return {
      data: await dataTables.rows.insert(auth.tenant.id, id, body.data, body.returnType, actor(request)),
    };
  });

  app.post('/data-tables/:id/upsert', async (request) => {
    const auth = requireRole(request, 'editor');
    const { id } = parse(idParams, request.params);
    const { dryRun, returnData, ...change } = parse(dataTableChangeBody, request.body);
    return {
      data: await dataTables.rows.upsert(auth.tenant.id, id, change, { dryRun, returnData }, actor(request)),
    };
  });

  app.patch('/data-tables/:id/rows', async (request) => {
    const auth = requireRole(request, 'editor');
    const { id } = parse(idParams, request.params);
    const { dryRun, returnData, ...change } = parse(dataTableChangeBody, request.body);
    return {
      data: await dataTables.rows.update(auth.tenant.id, id, change, { dryRun, returnData }, actor(request)),
    };
  });

  app.delete('/data-tables/:id/rows', async (request) => {
    const auth = requireRole(request, 'editor');
    const { id } = parse(idParams, request.params);
    const { filter, dryRun, returnData } = parse(dataTableDeleteQuery, request.query);
    return {
      data: await dataTables.rows.delete(auth.tenant.id, id, filter, { dryRun, returnData }, actor(request)),
    };
  });

  app.delete('/data-tables/:id/rows/clear', async (request) => {
    const auth = requireRole(request, 'editor');
    const { id } = parse(idParams, request.params);
    return { data: await dataTables.rows.clear(auth.tenant.id, id, actor(request)) };
  });

  app.get('/data-tables/:id/download-csv', async (request) => {
    const auth = requireRole(request, 'viewer');
    const { id } = parse(idParams, request.params);
    return { data: await dataTables.downloadCsv(auth.tenant.id, id, parse(downloadQuery, request.query)) };
  });

  app.post('/data-tables/:id/import-csv', async (request) => {
    const auth = requireRole(request, 'editor');
    const { id } = parse(idParams, request.params);
    const body = parse(csvImportBody, request.body);
    return { data: await dataTables.importCsv(auth.tenant.id, id, body, actor(request)) };
  });
}
