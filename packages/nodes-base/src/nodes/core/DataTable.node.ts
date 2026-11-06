/**
 * Data Table (n8n v1.1 behaviour): rows (insert, get, update, upsert, delete, exists checks) and
 * tables (create, list, rename, clear, delete) of this workspace's data tables. The tables live
 * behind `helpers.dataTables`, bound to the tenant, so a table made in one workflow is read in another.
 * Columns use the SQL nodes' `dataMode` + `fieldsUi`; a table found by name must match exactly.
 */
import {
  DATA_TABLE_SYSTEM_COLUMNS,
  type DataTableInfo,
  type DisplayOptions,
  type ExecuteContext,
  type Item,
  type ListSearchResult,
  type LoadOptionsContext,
  type NodeOutput,
  type NodeProperty,
  type NodeType,
} from '@workflow/workflow';
import { runRowOperation } from './data-table/rows';
import { dataTableAccess, nodeError, rlParts, runTableOperation, type TableCache } from './data-table/tables';

const ROW_OPS = ['insert', 'get', 'update', 'upsert', 'deleteRows', 'rowExists', 'rowNotExists'];
const FILTER_OPS = ['get', 'update', 'upsert', 'deleteRows', 'rowExists', 'rowNotExists'];
const DATA_OPS = ['insert', 'update', 'upsert'];

const rowShow = (operations: string[], extra: Record<string, unknown[]> = {}): DisplayOptions => ({
  show: { resource: ['row'], operation: operations, ...extra },
});
const tableShow = (operations: string[]): DisplayOptions => ({
  show: { resource: ['table'], operation: operations },
});

const columnsDependency = { loadOptionsMethod: 'getColumns', loadOptionsDependsOn: ['dataTableId.value'] };

const CONDITION_OPTIONS = [
  { name: 'Equals', value: 'eq' },
  { name: 'Not Equal', value: 'neq' },
  { name: 'Contains (Case-Sensitive)', value: 'like' },
  { name: 'Contains (Case-Insensitive)', value: 'ilike' },
  { name: 'Greater Than', value: 'gt' },
  { name: 'Greater Than or Equal', value: 'gte' },
  { name: 'Less Than', value: 'lt' },
  { name: 'Less Than or Equal', value: 'lte' },
  { name: 'Is Empty', value: 'isEmpty' },
  { name: 'Is Not Empty', value: 'isNotEmpty' },
  { name: 'Is True', value: 'isTrue' },
  { name: 'Is False', value: 'isFalse' },
];

const properties: NodeProperty[] = [
  {
    displayName: 'Resource',
    name: 'resource',
    type: 'options',
    default: 'row',
    noDataExpression: true,
    options: [
      { name: 'Row', value: 'row' },
      { name: 'Table', value: 'table' },
    ],
  },
  // ---- operations ----
  {
    displayName: 'Operation',
    name: 'operation',
    type: 'options',
    default: 'insert',
    noDataExpression: true,
    displayOptions: { show: { resource: ['row'] } },
    options: [
      { name: 'Insert', value: 'insert', action: 'Insert row' },
      { name: 'Get', value: 'get', action: 'Get row(s)' },
      { name: 'Update', value: 'update', action: 'Update row(s)' },
      { name: 'Upsert', value: 'upsert', action: 'Upsert row' },
      { name: 'Delete', value: 'deleteRows', action: 'Delete row(s)' },
      { name: 'If Row Exists', value: 'rowExists', action: 'If row exists' },
      { name: 'If Row Does Not Exist', value: 'rowNotExists', action: 'If row does not exist' },
    ],
  },
  {
    displayName: 'Operation',
    name: 'operation',
    type: 'options',
    default: 'create',
    noDataExpression: true,
    displayOptions: { show: { resource: ['table'] } },
    options: [
      { name: 'Create', value: 'create', action: 'Create a data table' },
      { name: 'Delete', value: 'deleteTable', action: 'Delete a data table' },
      { name: 'List', value: 'list', action: 'List data tables' },
      { name: 'Update', value: 'update', action: 'Rename a data table' },
      { name: 'Clear', value: 'clear', action: 'Delete all rows of a data table' },
    ],
  },
  // ---- which table ----
  {
    displayName: 'Data Table',
    name: 'dataTableId',
    type: 'resourceLocator',
    default: { __rl: true, mode: 'list', value: '' },
    required: true,
    modes: [
      {
        displayName: 'From list',
        name: 'list',
        type: 'list',
        placeholder: 'Choose...',
        typeOptions: {
          searchListMethod: 'tableSearch',
          searchable: true,
          allowNewResource: { label: 'Create a new data table', url: '/data-tables' },
        },
      },
      { displayName: 'By name', name: 'name', type: 'string', placeholder: 'e.g. Customers' },
      { displayName: 'By ID', name: 'id', type: 'string', placeholder: 'e.g. 3f2a9c1e' },
    ],
    description: 'The data table to use',
    displayOptions: {
      show: {
        resource: ['row', 'table'],
        // everything but table create and list names a table
        operation: [...ROW_OPS, 'deleteTable', 'clear'],
      },
    },
  },
  // ---- table: create, list, rename ----
  {
    displayName: 'Name',
    name: 'tableName',
    type: 'string',
    default: '',
    required: true,
    placeholder: 'e.g. Customers',
    displayOptions: tableShow(['create']),
  },
  {
    displayName: 'Columns',
    name: 'columns',
    type: 'fixedCollection',
    default: {},
    placeholder: 'Add column',
    typeOptions: { multipleValues: true },
    displayOptions: tableShow(['create']),
    options: [
      {
        displayName: 'Column',
        name: 'column',
        values: [
          {
            displayName: 'Name',
            name: 'name',
            type: 'string',
            default: '',
            description:
              'Letters first, then letters, digits and underscores (up to 63 characters); id, createdAt and updatedAt are taken',
          },
          {
            displayName: 'Type',
            name: 'type',
            type: 'options',
            default: 'string',
            options: [
              { name: 'String', value: 'string' },
              { name: 'Number', value: 'number' },
              { name: 'Boolean', value: 'boolean' },
              { name: 'Date', value: 'date' },
            ],
          },
        ],
      },
    ],
  },
  {
    displayName: 'New Name',
    name: 'newName',
    type: 'string',
    default: '',
    required: true,
    displayOptions: tableShow(['update']),
  },
  {
    displayName: 'Return All',
    name: 'returnAll',
    type: 'boolean',
    default: true,
    description: 'Whether to return all results or only up to a given limit',
    displayOptions: tableShow(['list']),
  },
  {
    displayName: 'Limit',
    name: 'limit',
    type: 'number',
    default: 50,
    typeOptions: { minValue: 1 },
    description: 'Max number of results to return',
    displayOptions: { show: { resource: ['table'], operation: ['list'], returnAll: [false] } },
  },
  {
    displayName: 'Options',
    name: 'options',
    type: 'collection',
    default: {},
    placeholder: 'Add option',
    displayOptions: tableShow(['create']),
    options: [
      {
        displayName: 'Reuse Existing Tables',
        name: 'createIfNotExists',
        type: 'boolean',
        default: true,
        description: 'Whether to return the table that has this name instead of failing',
      },
    ],
  },
  {
    displayName: 'Options',
    name: 'options',
    type: 'collection',
    default: {},
    placeholder: 'Add option',
    displayOptions: tableShow(['list']),
    options: [
      {
        displayName: 'Name Contains',
        name: 'filterName',
        type: 'string',
        default: '',
        description: 'Only tables whose name contains this text',
      },
      {
        displayName: 'Sort By',
        name: 'sortField',
        type: 'options',
        default: 'name',
        options: [
          { name: 'Name', value: 'name' },
          { name: 'Created At', value: 'createdAt' },
          { name: 'Updated At', value: 'updatedAt' },
        ],
      },
      {
        displayName: 'Sort Direction',
        name: 'sortDirection',
        type: 'options',
        default: 'asc',
        options: [
          { name: 'Ascending', value: 'asc' },
          { name: 'Descending', value: 'desc' },
        ],
      },
    ],
  },
  // ---- rows: which rows ----
  {
    displayName: 'Match Type',
    name: 'matchType',
    type: 'options',
    default: 'anyCondition',
    displayOptions: rowShow(FILTER_OPS),
    options: [
      { name: 'Any Condition', value: 'anyCondition' },
      { name: 'All Conditions', value: 'allConditions' },
    ],
  },
  {
    displayName: 'Conditions',
    name: 'filters',
    type: 'fixedCollection',
    default: {},
    placeholder: 'Add condition',
    typeOptions: { multipleValues: true },
    description: 'Update, upsert, delete and the exists checks need at least one condition',
    displayOptions: rowShow(FILTER_OPS),
    options: [
      {
        displayName: 'Condition',
        name: 'conditions',
        values: [
          {
            displayName: 'Column',
            name: 'keyName',
            type: 'options',
            default: '',
            typeOptions: columnsDependency,
          },
          {
            displayName: 'Condition',
            name: 'condition',
            type: 'options',
            default: 'eq',
            options: CONDITION_OPTIONS,
          },
          {
            displayName: 'Value',
            name: 'keyValue',
            type: 'string',
            default: '',
            description: 'Not used by Is Empty, Is Not Empty, Is True and Is False',
          },
        ],
      },
    ],
  },
  // ---- rows: get ----
  {
    displayName: 'Return All',
    name: 'returnAll',
    type: 'boolean',
    default: false,
    description: 'Whether to return all results or only up to a given limit',
    displayOptions: rowShow(['get']),
  },
  {
    displayName: 'Limit Per Input Row',
    name: 'limit',
    type: 'number',
    default: 50,
    typeOptions: { minValue: 1 },
    description: 'Max number of rows to return for each input item',
    displayOptions: rowShow(['get'], { returnAll: [false] }),
  },
  {
    displayName: 'Order by Column',
    name: 'orderBy',
    type: 'boolean',
    default: false,
    description: 'Whether to sort the rows',
    displayOptions: rowShow(['get']),
  },
  {
    displayName: 'Order By',
    name: 'orderByColumn',
    type: 'options',
    default: 'createdAt',
    typeOptions: columnsDependency,
    displayOptions: rowShow(['get'], { orderBy: [true] }),
  },
  {
    displayName: 'Direction',
    name: 'orderByDirection',
    type: 'options',
    default: 'DESC',
    options: [
      { name: 'Ascending', value: 'ASC' },
      { name: 'Descending', value: 'DESC' },
    ],
    displayOptions: rowShow(['get'], { orderBy: [true] }),
  },
  // ---- rows: what to write ----
  {
    displayName: 'Mapping Column Mode',
    name: 'dataMode',
    type: 'options',
    default: 'defineBelow',
    displayOptions: rowShow(DATA_OPS),
    options: [
      { name: 'Map Each Column Manually', value: 'defineBelow' },
      {
        name: 'Map Each Column Automatically',
        value: 'autoMapInputData',
        description: 'Item fields with the same name as a column',
      },
    ],
  },
  {
    displayName: 'Values to Send',
    name: 'fieldsUi',
    type: 'fixedCollection',
    default: {},
    placeholder: 'Add value',
    typeOptions: { multipleValues: true },
    displayOptions: rowShow(DATA_OPS, { dataMode: ['defineBelow'] }),
    options: [
      {
        displayName: 'Field',
        name: 'fieldValues',
        values: [
          {
            displayName: 'Column',
            name: 'columnName',
            type: 'options',
            default: '',
            typeOptions: { ...columnsDependency, loadOptionsMethod: 'getWritableColumns' },
          },
          { displayName: 'Value', name: 'value', type: 'string', default: '' },
        ],
      },
    ],
  },
  {
    displayName: 'Options',
    name: 'options',
    type: 'collection',
    default: {},
    placeholder: 'Add option',
    displayOptions: rowShow(['insert']),
    options: [
      {
        displayName: 'Optimize Bulk',
        name: 'optimizeBulk',
        type: 'boolean',
        default: false,
        description:
          'Whether to insert faster by not returning the inserted rows; the node then returns one item with the number of rows',
      },
    ],
  },
  {
    displayName: 'Options',
    name: 'options',
    type: 'collection',
    default: {},
    placeholder: 'Add option',
    displayOptions: rowShow(['update', 'upsert', 'deleteRows']),
    options: [
      {
        displayName: 'Dry Run',
        name: 'dryRun',
        type: 'boolean',
        default: false,
        description:
          'Whether to return the rows before and after the change (marked in dryRunState) without changing anything',
      },
    ],
  },
];

/** the table the editor's current (unsaved) locator names; null when none or not found */
async function currentTable(ctx: LoadOptionsContext): Promise<DataTableInfo | null> {
  const access = ctx.helpers.dataTables;
  if (!access) return null;
  const { mode, value } = rlParts(ctx.getCurrentNodeParameter('dataTableId'));
  if (!value) return null;
  return access.getTable(mode === 'name' ? { name: value } : { id: value });
}

const TABLE_PAGE = 50;

export const DataTableNode: NodeType = {
  description: {
    name: 'core.dataTable',
    displayName: 'Data Table',
    description:
      'Insert, get, update, upsert and delete rows, and create, list, rename, clear and delete tables',
    icon: 'lucide:table',
    iconColor: '#2277cc',
    group: ['input', 'transform'],
    version: 1,
    defaults: { name: 'Data Table' },
    inputs: ['main'],
    outputs: ['main'],
    categories: ['Core', 'Data & Storage'],
    // n8n's codex list (it repeats "table"; once is enough here)
    alias: [
      'data',
      'table',
      'knowledge',
      'data table',
      'sheet',
      'database',
      'data base',
      'mysql',
      'postgres',
      'postgresql',
      'airtable',
      'supabase',
      'noco',
      'notion',
    ],
    usableAsTool: true,
    properties,
  },

  async execute(ctx: ExecuteContext): Promise<NodeOutput> {
    const items = ctx.getInputData();
    const access = dataTableAccess(ctx);
    const cache: TableCache = new Map();
    const resource = String(ctx.getNodeParameter('resource', 0, 'row'));
    const operation = String(ctx.getNodeParameter('operation', 0, resource === 'row' ? 'insert' : 'create'));

    if (resource === 'table') {
      const out: Item[] = [];
      // an operation that names no input (create, list) runs once per input item, as in n8n
      for (let i = 0; i < items.length; i++) {
        try {
          out.push(...(await runTableOperation(ctx, access, cache, operation, i)));
        } catch (error) {
          if (!ctx.continueOnFail()) throw nodeError(ctx, error, i);
          out.push({ json: { error: nodeError(ctx, error, i).message }, pairedItem: { item: i } });
        }
      }
      return [out];
    }

    if (!ROW_OPS.includes(operation)) {
      throw nodeError(ctx, new Error(`Unknown row operation "${operation}"`));
    }
    const out = await runRowOperation(ctx, access, cache, operation, items);
    if ([...cache.values()].some((table) => !table.columns.length)) {
      ctx.addExecutionHints({ message: 'The selected data table has no columns.', level: 'info' });
    }
    return [out];
  },

  methods: {
    listSearch: {
      async tableSearch(ctx, filter, paginationToken): Promise<ListSearchResult> {
        const access = ctx.helpers.dataTables;
        if (!access) return { results: [] };
        const skip = Math.max(0, Number.parseInt(paginationToken ?? '0', 10) || 0);
        const page = await access.listTables({
          name: filter?.trim() || undefined,
          sortBy: { column: 'name', direction: 'asc' },
          take: TABLE_PAGE,
          skip,
        });
        const next = skip + page.data.length;
        return {
          results: page.data.map((table) => ({
            name: table.name,
            value: table.id,
            url: `/data-tables/${table.id}`,
          })),
          paginationToken: next < page.count && page.data.length ? String(next) : undefined,
        };
      },
    },
    loadOptions: {
      /** the table's columns and the system columns, for conditions and the sort */
      async getColumns(ctx) {
        const table = await currentTable(ctx);
        if (!table) return [];
        return [
          ...table.columns.map((c) => ({ name: c.name, value: c.name, description: `Type: ${c.type}` })),
          ...DATA_TABLE_SYSTEM_COLUMNS.map((name) => ({
            name,
            value: name,
            description: name === 'id' ? 'Type: number' : 'Type: date',
          })),
        ];
      },
      /** only the columns a row can write */
      async getWritableColumns(ctx) {
        const table = await currentTable(ctx);
        if (!table) return [];
        return table.columns.map((c) => ({ name: c.name, value: c.name, description: `Type: ${c.type}` }));
      },
    },
  },
};
