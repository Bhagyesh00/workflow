/**
 * MCP tools: the data tables of the caller's projects (P5-04, P6-35; research-B section 2, part a). Each
 * tool names the REST route's scope as `access`, and the handler checks it on the table's project before
 * it calls `DataTableService`, so a table of another project is a 403 with n8n's text. Everything goes
 * through the service, so its limits, texts and audit rows apply. Table contents are untrusted
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
import { mcpAuth, requireMcpScope } from '../workflow-gate';

const READ = { readOnlyHint: true, destructiveHint: false, openWorldHint: false };
const WRITE = { readOnlyHint: false, destructiveHint: false, openWorldHint: false };

/** the most rows one `add_data_table_rows` call inserts */
export const MCP_DATA_TABLE_INSERT_MAX = 1000;

const dataTableId = z.uuid().describe('The id of the data table');
const columnId = z.uuid().describe('The id of the column');
const cell = z.union([z.string(), z.number(), z.boolean(), z.null()]);

const actor = (caller: McpCaller) => ({ userId: caller.user.id });

const searchDataTables: McpToolDefinition<{
  query?: string;
  projectId?: string;
  limit: number;
  skip: number;
}> = {
  name: 'search_data_tables',
  description:
    'Search the data tables of your projects by name, or of one project (projectId); each comes with its columns.',
  scopes: ['dataTable:read'],
  access: 'dataTable:listProject',
  input: z.object({
    query: z.string().max(128).optional().describe('Part of the table name'),
    projectId: z.uuid().optional().describe('Only the tables of this project (from search_projects)'),
    limit: z.number().int().min(1).max(100).default(20),
    skip: z.number().int().min(0).default(0),
  }),
  annotations: READ,
  async handler(ctx, caller, input) {
    return ctx.dataTables.list(caller.tenant.id, {
      name: input.query,
      projectId: input.projectId,
      take: input.limit,
      skip: input.skip,
      caller: mcpAuth(caller),
    });
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
  access: 'dataTable:readRow',
  input: rowsInput,
  annotations: READ,
  async handler(ctx, caller, input) {
    await requireMcpScope(ctx, caller, 'dataTable:readRow', { dataTableId: input.dataTableId });
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
  projectId: z
    .uuid()
    .optional()
    .describe('The project to create it in (from search_projects); default: your personal project'),
});

const createDataTable: McpToolDefinition<z.output<typeof createInput>> = {
  name: 'create_data_table',
  description: 'Create a data table with the given columns.',
  scopes: ['dataTable:write'],
  access: 'dataTable:create',
  input: createInput,
  annotations: WRITE,
  async handler(ctx, caller, input) {
    // the project is named or the caller's default one; `dataTable:create` is checked on it by the service
    return ctx.dataTables.create(
      caller.tenant.id,
      { name: input.name, columns: input.columns, projectId: input.projectId, caller: mcpAuth(caller) },
      actor(caller),
    );
  },
};

const renameDataTable: McpToolDefinition<{ dataTableId: string; name: string }> = {
  name: 'rename_data_table',
  description: 'Rename a data table.',
  scopes: ['dataTable:write'],
  access: 'dataTable:update',
  input: z.object({ dataTableId, name: dataTableNameSchema }),
  annotations: { ...WRITE, idempotentHint: true },
  async handler(ctx, caller, input) {
    await requireMcpScope(ctx, caller, 'dataTable:update', { dataTableId: input.dataTableId });
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
  access: 'dataTable:writeColumn',
  input: addColumnInput,
  annotations: WRITE,
  async handler(ctx, caller, input) {
    await requireMcpScope(ctx, caller, 'dataTable:writeColumn', { dataTableId: input.dataTableId });
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
  access: 'dataTable:writeColumn',
  input: z.object({ dataTableId, columnId, name: dataTableColumnSchema.shape.name }),
  annotations: { ...WRITE, idempotentHint: true },
  async handler(ctx, caller, input) {
    await requireMcpScope(ctx, caller, 'dataTable:writeColumn', { dataTableId: input.dataTableId });
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
  access: 'dataTable:writeColumn',
  input: z.object({ dataTableId, columnId }),
  annotations: { readOnlyHint: false, destructiveHint: true, openWorldHint: false },
  async handler(ctx, caller, input) {
    await requireMcpScope(ctx, caller, 'dataTable:writeColumn', { dataTableId: input.dataTableId });
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
  access: 'dataTable:writeRow',
  input: addRowsInput,
  annotations: WRITE,
  async handler(ctx, caller, input) {
    await requireMcpScope(ctx, caller, 'dataTable:writeRow', { dataTableId: input.dataTableId });
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
