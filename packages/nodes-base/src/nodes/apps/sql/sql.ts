/**
 * SQL building shared by the Postgres and MySQL nodes. Identifiers are quoted per dialect and
 * every value is a bound parameter; values are never interpolated into SQL text.
 */
import {
  type DataObject,
  type ExecuteContext,
  NodeOperationError,
  type NodeProperty,
} from '@workflow/workflow';

export interface Dialect {
  name: 'postgres' | 'mysql';
  quote(identifier: string): string;
  /** placeholder for the n-th (1-based) parameter */
  param(n: number): string;
  supportsReturning: boolean;
}

function checkIdentifier(identifier: string): string {
  const id = String(identifier ?? '').trim();
  if (!id) throw new Error('An identifier (schema, table or column name) is empty');
  // biome-ignore lint/suspicious/noControlCharactersInRegex: reject NUL in identifiers
  if (/\u0000/.test(id) || id.length > 128) throw new Error(`Invalid identifier "${id.slice(0, 64)}"`);
  return id;
}

export const postgresDialect: Dialect = {
  name: 'postgres',
  quote: (identifier) => `"${checkIdentifier(identifier).replace(/"/g, '""')}"`,
  param: (n) => `$${n}`,
  supportsReturning: true,
};

export const mysqlDialect: Dialect = {
  name: 'mysql',
  quote: (identifier) => `\`${checkIdentifier(identifier).replace(/`/g, '``')}\``,
  param: () => '?',
  supportsReturning: false,
};

export interface Query {
  text: string;
  values: unknown[];
}

export type WhereCondition = {
  column: string;
  condition: '=' | '!=' | '>' | '<' | '>=' | '<=' | 'LIKE' | 'IS NULL' | 'IS NOT NULL';
  value?: unknown;
};

const CONDITIONS = new Set(['=', '!=', '>', '<', '>=', '<=', 'LIKE', 'IS NULL', 'IS NOT NULL']);

export function tableRef(d: Dialect, schema: string | undefined, table: string): string {
  return schema ? `${d.quote(schema)}.${d.quote(table)}` : d.quote(table);
}

function whereClause(
  d: Dialect,
  conditions: WhereCondition[],
  combinator: 'AND' | 'OR',
  values: unknown[],
): string {
  if (!conditions.length) return '';
  const parts = conditions.map((c) => {
    if (!CONDITIONS.has(c.condition)) throw new Error(`Unsupported condition "${String(c.condition)}"`);
    if (c.condition === 'IS NULL' || c.condition === 'IS NOT NULL')
      return `${d.quote(c.column)} ${c.condition}`;
    values.push(c.value);
    return `${d.quote(c.column)} ${c.condition} ${d.param(values.length)}`;
  });
  return ` WHERE ${parts.join(combinator === 'OR' ? ' OR ' : ' AND ')}`;
}

export function buildInsert(
  d: Dialect,
  table: string,
  data: DataObject,
  options: { returning?: boolean; ignoreConflicts?: boolean } = {},
): Query {
  const columns = Object.keys(data);
  if (!columns.length) throw new Error('There are no columns to insert');
  const values = columns.map((c) => data[c]);
  const verb = options.ignoreConflicts && d.name === 'mysql' ? 'INSERT IGNORE' : 'INSERT';
  let text = `${verb} INTO ${table} (${columns.map((c) => d.quote(c)).join(', ')}) VALUES (${columns.map((_, i) => d.param(i + 1)).join(', ')})`;
  if (options.ignoreConflicts && d.name === 'postgres') text += ' ON CONFLICT DO NOTHING';
  if (options.returning && d.supportsReturning) text += ' RETURNING *';
  return { text, values };
}

export function buildUpdate(
  d: Dialect,
  table: string,
  data: DataObject,
  matchColumn: string,
  options: { returning?: boolean } = {},
): Query {
  if (!(matchColumn in data)) throw new Error(`The data has no value for the match column "${matchColumn}"`);
  const columns = Object.keys(data).filter((c) => c !== matchColumn);
  if (!columns.length) throw new Error('There are no columns to update besides the match column');
  const values: unknown[] = [];
  const sets = columns.map((c) => {
    values.push(data[c]);
    return `${d.quote(c)} = ${d.param(values.length)}`;
  });
  values.push(data[matchColumn]);
  let text = `UPDATE ${table} SET ${sets.join(', ')} WHERE ${d.quote(matchColumn)} = ${d.param(values.length)}`;
  if (options.returning && d.supportsReturning) text += ' RETURNING *';
  return { text, values };
}

export function buildUpsert(
  d: Dialect,
  table: string,
  data: DataObject,
  matchColumn: string,
  options: { returning?: boolean } = {},
): Query {
  if (!(matchColumn in data)) throw new Error(`The data has no value for the match column "${matchColumn}"`);
  const insert = buildInsert(d, table, data);
  const updates = Object.keys(data).filter((c) => c !== matchColumn);
  let text = insert.text;
  if (d.name === 'postgres') {
    text += updates.length
      ? ` ON CONFLICT (${d.quote(matchColumn)}) DO UPDATE SET ${updates.map((c) => `${d.quote(c)} = EXCLUDED.${d.quote(c)}`).join(', ')}`
      : ` ON CONFLICT (${d.quote(matchColumn)}) DO NOTHING`;
    if (options.returning) text += ' RETURNING *';
  } else {
    const cols = updates.length ? updates : [matchColumn];
    text += ` ON DUPLICATE KEY UPDATE ${cols.map((c) => `${d.quote(c)} = VALUES(${d.quote(c)})`).join(', ')}`;
  }
  return { text, values: insert.values };
}

export function buildSelect(
  d: Dialect,
  table: string,
  options: {
    columns?: string[];
    where?: WhereCondition[];
    combinator?: 'AND' | 'OR';
    sort?: Array<{ column: string; direction: 'ASC' | 'DESC' }>;
    limit?: number;
  } = {},
): Query {
  const values: unknown[] = [];
  const columns = options.columns?.length ? options.columns.map((c) => d.quote(c)).join(', ') : '*';
  let text = `SELECT ${columns} FROM ${table}${whereClause(d, options.where ?? [], options.combinator ?? 'AND', values)}`;
  if (options.sort?.length) {
    text += ` ORDER BY ${options.sort.map((s) => `${d.quote(s.column)} ${s.direction === 'DESC' ? 'DESC' : 'ASC'}`).join(', ')}`;
  }
  if (options.limit !== undefined && Number.isFinite(options.limit)) {
    const limit = Math.max(0, Math.floor(options.limit));
    // LIMIT is a whole number checked above; inlining it keeps MySQL prepared statements simple
    text += ` LIMIT ${limit}`;
  }
  return { text, values };
}

export function buildDelete(
  d: Dialect,
  table: string,
  command: 'delete' | 'truncate' | 'drop',
  options: {
    where?: WhereCondition[];
    combinator?: 'AND' | 'OR';
    cascade?: boolean;
    restartSequences?: boolean;
  } = {},
): Query {
  if (command === 'truncate') {
    let text = `TRUNCATE TABLE ${table}`;
    if (d.name === 'postgres') {
      if (options.restartSequences) text += ' RESTART IDENTITY';
      if (options.cascade) text += ' CASCADE';
    }
    return { text, values: [] };
  }
  if (command === 'drop') {
    return {
      text: `DROP TABLE IF EXISTS ${table}${d.name === 'postgres' && options.cascade ? ' CASCADE' : ''}`,
      values: [],
    };
  }
  const values: unknown[] = [];
  const where = whereClause(d, options.where ?? [], options.combinator ?? 'AND', values);
  if (!where)
    throw new Error(
      'Add at least one condition: deleting without conditions would empty the table (use Truncate for that)',
    );
  return { text: `DELETE FROM ${table}${where}`, values };
}

/** Make driver results JSON-safe: dates to ISO strings, buffers to base64, bigints to strings. */
export function jsonRow(row: unknown): DataObject {
  const convert = (value: unknown): unknown => {
    if (value instanceof Date) return Number.isNaN(value.getTime()) ? null : value.toISOString();
    if (value instanceof Uint8Array) return Buffer.from(value).toString('base64');
    if (typeof value === 'bigint') return value.toString();
    if (Array.isArray(value)) return value.map(convert);
    if (value && typeof value === 'object') {
      return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, convert(v)]));
    }
    return value;
  };
  return convert(row) as DataObject;
}

/** Comma list or array of query parameter values (`$1`, `?`). */
export function queryReplacements(value: unknown): unknown[] {
  if (Array.isArray(value)) return value;
  if (value === undefined || value === null || value === '') return [];
  if (typeof value !== 'string') return [value];
  // a JSON array keeps types and allows commas inside values
  const trimmed = value.trim();
  if (trimmed.startsWith('[')) {
    try {
      const parsed = JSON.parse(trimmed);
      if (Array.isArray(parsed)) return parsed;
    } catch {
      /* fall back to comma splitting */
    }
  }
  return value.split(',').map((v) => v.trim());
}

// ---------------------------------------------------------------------------------------------
// node parameter helpers
// ---------------------------------------------------------------------------------------------

export function readData(ctx: ExecuteContext, i: number, json: DataObject): DataObject {
  if (ctx.getNodeParameter('dataMode', i, 'autoMapInputData') === 'defineBelow') {
    const fields = ((ctx.getNodeParameter('valuesToSend', i, {}) as DataObject).values ?? []) as Array<{
      column: string;
      value: unknown;
    }>;
    return Object.fromEntries(fields.filter((f) => f.column).map((f) => [f.column, f.value]));
  }
  const skip = new Set(
    String(ctx.getNodeParameter('options.skipColumns', i, '') ?? '')
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean),
  );
  return Object.fromEntries(Object.entries(json).filter(([k]) => !skip.has(k)));
}

export function readWhere(
  ctx: ExecuteContext,
  i: number,
): { where: WhereCondition[]; combinator: 'AND' | 'OR' } {
  const where = ((ctx.getNodeParameter('where', i, {}) as DataObject).values ?? []) as WhereCondition[];
  return {
    where: where.filter((w) => w.column),
    combinator: ctx.getNodeParameter('combineConditions', i, 'AND') === 'OR' ? 'OR' : 'AND',
  };
}

export function readSort(ctx: ExecuteContext, i: number) {
  return (
    ((ctx.getNodeParameter('sort', i, {}) as DataObject).values ?? []) as Array<{
      column: string;
      direction: 'ASC' | 'DESC';
    }>
  ).filter((s) => s.column);
}

export function sqlError(ctx: ExecuteContext, error: unknown, i: number): Error {
  if (error instanceof NodeOperationError) return error;
  const e = error as { message?: string; code?: string; detail?: string; sqlMessage?: string };
  return new NodeOperationError(ctx.getNode(), e.sqlMessage ?? e.message ?? String(error), {
    itemIndex: i,
    description: e.detail ?? (e.code ? `Database error code ${e.code}` : undefined),
    cause: error,
  });
}

export function sqlProperties(options: { schema: boolean }): NodeProperty[] {
  const writeOps = ['insert', 'update', 'upsert'];
  const tableOps = ['insert', 'update', 'upsert', 'deleteTable', 'select'];
  const show = (operation: string[], extra: Record<string, unknown[]> = {}) => ({
    show: { operation, ...extra },
  });
  const whereProperty: NodeProperty = {
    displayName: 'Select Rows',
    name: 'where',
    type: 'fixedCollection',
    default: { values: [] },
    placeholder: 'Add condition',
    typeOptions: { multipleValues: true },
    description: 'Rows matching these conditions',
    options: [
      {
        displayName: 'Condition',
        name: 'values',
        values: [
          {
            displayName: 'Column',
            name: 'column',
            type: 'options',
            default: '',
            typeOptions: { loadOptionsMethod: 'getColumns', loadOptionsDependsOn: ['table.value'] },
          },
          {
            displayName: 'Operator',
            name: 'condition',
            type: 'options',
            default: '=',
            options: [
              { name: 'Equal', value: '=' },
              { name: 'Not Equal', value: '!=' },
              { name: 'Like', value: 'LIKE' },
              { name: 'Greater Than', value: '>' },
              { name: 'Less Than', value: '<' },
              { name: 'Greater Than Or Equal', value: '>=' },
              { name: 'Less Than Or Equal', value: '<=' },
              { name: 'Is Null', value: 'IS NULL' },
              { name: 'Is Not Null', value: 'IS NOT NULL' },
            ],
          },
          {
            displayName: 'Value',
            name: 'value',
            type: 'string',
            default: '',
            displayOptions: { hide: { condition: ['IS NULL', 'IS NOT NULL'] } },
          },
        ],
      },
    ],
  };
  return [
    {
      displayName: 'Operation',
      name: 'operation',
      type: 'options',
      noDataExpression: true,
      default: 'insert',
      options: [
        { name: 'Execute Query', value: 'executeQuery', action: 'Execute a SQL query' },
        { name: 'Insert', value: 'insert', action: 'Insert rows in a table' },
        { name: 'Update', value: 'update', action: 'Update rows in a table' },
        { name: 'Insert or Update', value: 'upsert', action: 'Insert or update rows in a table' },
        { name: 'Delete', value: 'deleteTable', action: 'Delete table or rows' },
        { name: 'Select', value: 'select', action: 'Select rows from a table' },
      ],
    },
    ...(options.schema
      ? [
          {
            displayName: 'Schema',
            name: 'schema',
            type: 'resourceLocator',
            default: { __rl: true, mode: 'list', value: 'public' },
            required: true,
            modes: [
              {
                displayName: 'From List',
                name: 'list',
                type: 'list',
                placeholder: 'Select a schema...',
                typeOptions: { searchListMethod: 'searchSchemas', searchable: true },
              },
              { displayName: 'By Name', name: 'name', type: 'string', placeholder: 'public' },
            ],
            displayOptions: show(tableOps),
          } as NodeProperty,
        ]
      : []),
    {
      displayName: 'Table',
      name: 'table',
      type: 'resourceLocator',
      default: { __rl: true, mode: 'list', value: '' },
      required: true,
      modes: [
        {
          displayName: 'From List',
          name: 'list',
          type: 'list',
          placeholder: 'Select a table...',
          typeOptions: { searchListMethod: 'searchTables', searchable: true },
        },
        { displayName: 'By Name', name: 'name', type: 'string', placeholder: 'orders' },
      ],
      displayOptions: show(tableOps),
    },
    {
      displayName: 'Query',
      name: 'query',
      type: 'string',
      default: '',
      required: true,
      placeholder: options.schema
        ? 'SELECT id, name FROM product WHERE quantity > $1 AND price <= $2'
        : 'SELECT id, name FROM product WHERE quantity > ? AND price <= ?',
      typeOptions: { editor: 'sqlEditor', editorLanguage: 'sql', rows: 5 },
      description: options.schema
        ? 'Use $1, $2, ... for values and set them in "Query Parameters"; never build values into the SQL text'
        : 'Use ? for values and set them in "Query Parameters"; never build values into the SQL text',
      displayOptions: show(['executeQuery']),
    },
    {
      displayName: 'Mapping Column Mode',
      name: 'dataMode',
      type: 'options',
      default: 'autoMapInputData',
      options: [
        {
          name: 'Map Each Column Automatically',
          value: 'autoMapInputData',
          description: 'Item fields with the same name as a column',
        },
        { name: 'Map Each Column Manually', value: 'defineBelow' },
      ],
      displayOptions: show(writeOps),
    },
    {
      displayName: 'Values to Send',
      name: 'valuesToSend',
      type: 'fixedCollection',
      default: { values: [] },
      placeholder: 'Add value',
      typeOptions: { multipleValues: true },
      displayOptions: show(writeOps, { dataMode: ['defineBelow'] }),
      options: [
        {
          displayName: 'Value',
          name: 'values',
          values: [
            {
              displayName: 'Column',
              name: 'column',
              type: 'options',
              default: '',
              typeOptions: { loadOptionsMethod: 'getColumns', loadOptionsDependsOn: ['table.value'] },
            },
            { displayName: 'Value', name: 'value', type: 'string', default: '' },
          ],
        },
      ],
    },
    {
      displayName: 'Column to Match On',
      name: 'columnToMatchOn',
      type: 'options',
      default: '',
      required: true,
      typeOptions: { loadOptionsMethod: 'getColumns', loadOptionsDependsOn: ['table.value'] },
      description: options.schema
        ? 'Rows with the same value in this column are updated (upsert needs a unique constraint on it)'
        : 'Rows with the same value in this column are updated (upsert needs a unique key on it)',
      displayOptions: show(['update', 'upsert']),
    },
    {
      displayName: 'Command',
      name: 'deleteCommand',
      type: 'options',
      default: 'delete',
      options: [
        { name: 'Delete Rows', value: 'delete', description: 'Delete the rows matching the conditions' },
        { name: 'Truncate', value: 'truncate', description: 'Remove every row, keep the table' },
        { name: 'Drop', value: 'drop', description: 'Delete the table itself' },
      ],
      displayOptions: show(['deleteTable']),
    },
    { ...whereProperty, displayOptions: show(['select']) },
    { ...whereProperty, displayOptions: show(['deleteTable'], { deleteCommand: ['delete'] }) },
    {
      displayName: 'Combine Conditions',
      name: 'combineConditions',
      type: 'options',
      default: 'AND',
      options: [
        { name: 'AND', value: 'AND' },
        { name: 'OR', value: 'OR' },
      ],
      displayOptions: show(['select', 'deleteTable']),
    },
    {
      displayName: 'Sort',
      name: 'sort',
      type: 'fixedCollection',
      default: { values: [] },
      placeholder: 'Add sort rule',
      typeOptions: { multipleValues: true, sortable: true },
      displayOptions: show(['select']),
      options: [
        {
          displayName: 'Rule',
          name: 'values',
          values: [
            {
              displayName: 'Column',
              name: 'column',
              type: 'options',
              default: '',
              typeOptions: { loadOptionsMethod: 'getColumns', loadOptionsDependsOn: ['table.value'] },
            },
            {
              displayName: 'Direction',
              name: 'direction',
              type: 'options',
              default: 'ASC',
              options: [
                { name: 'ASC', value: 'ASC' },
                { name: 'DESC', value: 'DESC' },
              ],
            },
          ],
        },
      ],
    },
    {
      displayName: 'Return All',
      name: 'returnAll',
      type: 'boolean',
      default: false,
      displayOptions: show(['select']),
    },
    {
      displayName: 'Limit',
      name: 'limit',
      type: 'number',
      default: 50,
      typeOptions: { minValue: 1 },
      displayOptions: show(['select'], { returnAll: [false] }),
    },
    {
      displayName: 'Options',
      name: 'options',
      type: 'collection',
      default: {},
      placeholder: 'Add option',
      options: [
        {
          displayName: 'Query Parameters',
          name: 'queryReplacement',
          type: 'string',
          default: '',
          placeholder: '={{ [$json.quantity, $json.maxPrice] }}',
          description:
            'Values for the query placeholders: an array expression, a JSON array or a comma-separated list',
          displayOptions: { show: { '/operation': ['executeQuery'] } },
        },
        {
          displayName: 'Query Batching',
          name: 'queryBatching',
          type: 'options',
          default: 'independently',
          options: [
            {
              name: 'Independently',
              value: 'independently',
              description: 'Each item runs on its own; one failure does not undo others',
            },
            {
              name: 'Transaction',
              value: 'transaction',
              description: 'All items in one transaction; any failure rolls back every item',
            },
          ],
        },
        {
          displayName: 'Output Columns',
          name: 'outputColumns',
          type: 'string',
          default: '',
          placeholder: 'id, name',
          description: 'Comma-separated columns to return (select)',
          displayOptions: { show: { '/operation': ['select'] } },
        },
        {
          displayName: 'Skip Columns',
          name: 'skipColumns',
          type: 'string',
          default: '',
          placeholder: 'internal_note',
          description: 'Comma-separated item fields not written to the table',
          displayOptions: { show: { '/operation': ['insert', 'update', 'upsert'] } },
        },
        {
          displayName: 'Skip on Conflict',
          name: 'skipOnConflict',
          type: 'boolean',
          default: false,
          description: 'Whether rows violating a unique constraint are skipped instead of failing',
          displayOptions: { show: { '/operation': ['insert'] } },
        },
        {
          displayName: 'Cascade',
          name: 'cascade',
          type: 'boolean',
          default: false,
          displayOptions: { show: { '/operation': ['deleteTable'] } },
        },
        {
          displayName: 'Connection Timeout',
          name: 'connectionTimeout',
          type: 'number',
          default: 30,
          description: 'Seconds to wait for a connection',
        },
      ],
    },
  ];
}
