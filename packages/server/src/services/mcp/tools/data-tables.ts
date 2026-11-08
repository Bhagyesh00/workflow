/**
 * MCP tools: the workspace's data tables (P5-04; research-B section 2, part a). Read tools need
 * `dataTable:read` (viewer), write tools `dataTable:write` (editor), as the REST routes. Everything goes
 * through `DataTableService`, so its limits, texts and audit rows apply. Table contents are untrusted
 * text for the client's model (server instructions).
 */
import {
  DATA_TABLE_COLUMN_NAME_MAX,
  DATA_TABLE_ROWS_TAKE_MAX,
  type DataTableFilter,
  type DataTableRowInput,
} from '@workflow/workflow';
import { z } from 'zod';
import {
  dataTableColumnSchema,
  dataTableFilterSchema,
  dataTableNameSchema,
} from '../../../routes/data-tables';
import type { McpCaller, McpToolDefinition } from '../types';

const READ = { readOnlyHint: true, destructiveHint: false, openWorldHint: false };
const WRITE = { readOnlyHint: false, destructiveHint: false, openWorldHint: false };

/** the most rows one `add_data_table_rows` call inserts */
export const MCP_DATA_TABLE_INSERT_MAX = 1000;

const dataTableId = z.uuid().describe('The id of the data table');
const columnId = z.uuid().describe('The id of the column');
const cell = z.union([z.string(), z.number(), z.boolean(), z.null()]);

const actor = (caller: McpCaller) => ({ userId: caller.user.id });

const searchDataTables: McpToolDefinition<{ query?: string; limit: number; skip: number }> = {
  name: 'search_data_tables',
  description: 'Search the data tables of the workspace by name; each comes with its columns.',
  scopes: ['dataTable:read'],
  minRole: 'viewer',
  input: z.object({
    query: z.string().max(128).optional().describe('Part of the table name'),
    limit: z.number().int().min(1).max(100).default(20),
    skip: z.number().int().min(0).default(0),
  }),
  annotations: READ,
  async handler(ctx, caller, input) {
    return ctx.dataTables.list(caller.tenant.id, { name: input.query, take: input.limit, skip: input.skip });
  },
};

const rowsInput = z.object({
  dataTableId,
  limit: z.number().int().min(1).max(Math.min(100, DATA_TABLE_ROWS_TAKE_MAX)).default(20),
  skip: z.number().int().min(0).default(0),
  search: z.string().max(1024).optional(),
  filter: dataTableFilterSchema.optional(),
});

const getDataTableRows: McpToolDefinition<z.output<typeof rowsInput>> = {
  name: 'get_data_table_rows',
  description: 'Read rows of a data table, optionally filtered by column conditions or a text search.',
  scopes: ['dataTable:read'],
  minRole: 'viewer',
  input: rowsInput,
  annotations: READ,
  async handler(ctx, caller, input) {
    return ctx.dataTables.rows.list(caller.tenant.id, input.dataTableId, {
      take: input.limit,
      skip: input.skip,
      search: input.search,
      filter: input.filter as DataTableFilter | undefined,
    });
  },
};

const createInput = z.object({
  name: dataTableNameSchema,
  columns: z.array(dataTableColumnSchema).max(100).default([]),
});

const createDataTable: McpToolDefinition<z.output<typeof createInput>> = {
  name: 'create_data_table',
  description: 'Create a data table with the given columns.',
  scopes: ['dataTable:write'],
  minRole: 'editor',
  input: createInput,
  annotations: WRITE,
  async handler(ctx, caller, input) {
    return ctx.dataTables.create(
      caller.tenant.id,
      { name: input.name, columns: input.columns },
      actor(caller),
    );
  },
};

const renameDataTable: McpToolDefinition<{ dataTableId: string; name: string }> = {
  name: 'rename_data_table',
  description: 'Rename a data table.',
  scopes: ['dataTable:write'],
  minRole: 'editor',
  input: z.object({ dataTableId, name: dataTableNameSchema }),
  annotations: { ...WRITE, idempotentHint: true },
  async handler(ctx, caller, input) {
    return ctx.dataTables.patch(caller.tenant.id, input.dataTableId, { name: input.name }, actor(caller));
  },
};

const addColumnInput = dataTableColumnSchema.extend({
  dataTableId,
  index: z.number().int().min(0).optional(),
});

const addDataTableColumn: McpToolDefinition<z.output<typeof addColumnInput>> = {
  name: 'add_data_table_column',
  description: 'Add a column to a data table (last, or at index).',
  scopes: ['dataTable:write'],
  minRole: 'editor',
  input: addColumnInput,
  annotations: WRITE,
  async handler(ctx, caller, input) {
    return ctx.dataTables.columns.add(
      caller.tenant.id,
      input.dataTableId,
      { name: input.name, type: input.type, index: input.index },
      actor(caller),
    );
  },
};

const renameDataTableColumn: McpToolDefinition<{ dataTableId: string; columnId: string; name: string }> = {
  name: 'rename_data_table_column',
  description: 'Rename a column of a data table.',
  scopes: ['dataTable:write'],
  minRole: 'editor',
  input: z.object({ dataTableId, columnId, name: dataTableColumnSchema.shape.name }),
  annotations: { ...WRITE, idempotentHint: true },
  async handler(ctx, caller, input) {
    return ctx.dataTables.columns.rename(
      caller.tenant.id,
      input.dataTableId,
      input.columnId,
      { name: input.name },
      actor(caller),
    );
  },
};

const deleteDataTableColumn: McpToolDefinition<{ dataTableId: string; columnId: string }> = {
  name: 'delete_data_table_column',
  description: 'Delete a column of a data table and its values.',
  scopes: ['dataTable:write'],
  minRole: 'editor',
  input: z.object({ dataTableId, columnId }),
  annotations: { readOnlyHint: false, destructiveHint: true, openWorldHint: false },
  async handler(ctx, caller, input) {
    await ctx.dataTables.columns.delete(caller.tenant.id, input.dataTableId, input.columnId, actor(caller));
    return { deleted: true, columnId: input.columnId };
  },
};

const addRowsInput = z.object({
  dataTableId,
  rows: z
    .array(z.record(z.string().min(1).max(DATA_TABLE_COLUMN_NAME_MAX), cell))
    .min(1)
    .max(MCP_DATA_TABLE_INSERT_MAX),
});

const addDataTableRows: McpToolDefinition<z.output<typeof addRowsInput>> = {
  name: 'add_data_table_rows',
  description: `Insert rows into a data table (at most ${MCP_DATA_TABLE_INSERT_MAX}); keys are column names.`,
  scopes: ['dataTable:write'],
  minRole: 'editor',
  input: addRowsInput,
  annotations: WRITE,
  async handler(ctx, caller, input) {
    const inserted = await ctx.dataTables.rows.insert(
      caller.tenant.id,
      input.dataTableId,
      input.rows as DataTableRowInput[],
      'id',
      actor(caller),
    );
    return { inserted };
  },
};

export const dataTablesTools: McpToolDefinition<any>[] = [
  searchDataTables,
  getDataTableRows,
  createDataTable,
  renameDataTable,
  addDataTableColumn,
  renameDataTableColumn,
  deleteDataTableColumn,
  addDataTableRows,
];
