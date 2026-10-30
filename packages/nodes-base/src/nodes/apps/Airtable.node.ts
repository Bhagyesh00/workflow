/** Airtable: list / search / get / create / update / upsert / delete records; list bases and schemas. */
import {
  type BaseContext,
  type DataObject,
  type ExecuteContext,
  type HttpMethod,
  type Item,
  isResourceLocatorValue,
  type ListSearchResult,
  NodeOperationError,
  type NodeProperty,
  type NodeType,
} from '@workflow/workflow';
import { fieldList } from '../../utils/utilities';
import {
  compact,
  forOps,
  locator,
  type OperationHandler,
  operationProperty,
  requiredId,
  resourceProperty,
  returnAllProperties,
  runOperations,
} from './shared';

const BASE = 'https://api.airtable.com/v0';
const CREDENTIAL = 'airtableTokenApi';

type AirtableContext = Pick<BaseContext, 'helpers'>;

async function airtableRequest<T = DataObject>(
  ctx: AirtableContext,
  method: HttpMethod,
  path: string,
  body?: DataObject,
  qs?: DataObject,
  itemIndex = 0,
): Promise<T> {
  return (await ctx.helpers.httpRequestWithAuthentication(
    CREDENTIAL,
    {
      method,
      url: `${BASE}${path}`,
      body,
      bodyType: body ? 'json' : undefined,
      qs: qs ? compact(qs) : undefined,
      responseType: 'json',
    },
    itemIndex,
  )) as T;
}

function flatten(record: DataObject): DataObject {
  return { ...((record.fields as DataObject) ?? {}), id: record.id, createdTime: record.createdTime };
}

function pathOf(ctx: ExecuteContext, i: number): string {
  return `/${encodeURIComponent(requiredId(ctx, 'base', i, 'Base'))}/${encodeURIComponent(requiredId(ctx, 'table', i, 'Table'))}`;
}

function fieldsFrom(ctx: ExecuteContext, i: number, item: Item): DataObject {
  if (ctx.getNodeParameter('dataMode', i, 'autoMapInputData') === 'defineBelow') {
    const list = ((ctx.getNodeParameter('fieldsUi', i, {}) as DataObject).fieldValues ?? []) as Array<{
      fieldName: string;
      fieldValue: unknown;
    }>;
    return Object.fromEntries(list.filter((f) => f.fieldName).map((f) => [f.fieldName, f.fieldValue]));
  }
  const ignore = new Set([
    'id',
    'createdTime',
    ...fieldList(ctx.getNodeParameter('options.ignoreFields', i, '')),
  ]);
  return Object.fromEntries(Object.entries(item.json).filter(([k]) => !ignore.has(k)));
}

async function listRecords(ctx: ExecuteContext, i: number, formula?: string): Promise<DataObject[]> {
  const returnAll = ctx.getNodeParameter('returnAll', i, false) as boolean;
  const limit = returnAll ? Number.POSITIVE_INFINITY : Number(ctx.getNodeParameter('limit', i, 50));
  const options = ctx.getNodeParameter('options', i, {}) as DataObject;
  const qs: DataObject = {
    view: options.view,
    filterByFormula: formula,
    'fields[]': fieldList(options.fields).length ? fieldList(options.fields) : undefined,
  };
  const sorts = ((ctx.getNodeParameter('sort', i, {}) as DataObject).property ?? []) as Array<{
    field: string;
    direction: string;
  }>;
  sorts
    .filter((s) => s.field)
    .forEach((s, n) => {
      qs[`sort[${n}][field]`] = s.field;
      qs[`sort[${n}][direction]`] = s.direction === 'desc' ? 'desc' : 'asc';
    });
  const records: DataObject[] = [];
  let offset: string | undefined;
  for (let page = 0; page < 1000; page++) {
    const response = await airtableRequest(
      ctx,
      'GET',
      pathOf(ctx, i),
      undefined,
      {
        ...qs,
        pageSize: Math.min(100, Number.isFinite(limit) ? limit - records.length : 100),
        offset,
      },
      i,
    );
    records.push(...((response.records as DataObject[]) ?? []));
    offset = response.offset as string | undefined;
    if (!offset || records.length >= limit) break;
  }
  return (Number.isFinite(limit) ? records.slice(0, limit) : records).map(flatten);
}

const handlers: Record<string, Record<string, OperationHandler>> = {
  record: {
    async list(ctx, i) {
      return listRecords(ctx, i);
    },
    async search(ctx, i) {
      const formula = String(ctx.getNodeParameter('filterByFormula', i, '') ?? '').trim();
      if (!formula) throw new NodeOperationError(ctx.getNode(), 'Enter a filter formula', { itemIndex: i });
      return listRecords(ctx, i, formula);
    },
    async get(ctx, i) {
      const record = await airtableRequest(
        ctx,
        'GET',
        `${pathOf(ctx, i)}/${encodeURIComponent(requiredId(ctx, 'id', i, 'Record ID'))}`,
        undefined,
        undefined,
        i,
      );
      return flatten(record);
    },
    async create(ctx, i, item) {
      const response = await airtableRequest(
        ctx,
        'POST',
        pathOf(ctx, i),
        {
          records: [{ fields: fieldsFrom(ctx, i, item) }],
          typecast: Boolean(ctx.getNodeParameter('options.typecast', i, false)),
        },
        undefined,
        i,
      );
      return ((response.records as DataObject[]) ?? []).map(flatten);
    },
    async update(ctx, i, item) {
      const response = await airtableRequest(
        ctx,
        'PATCH',
        pathOf(ctx, i),
        {
          records: [{ id: requiredId(ctx, 'id', i, 'Record ID'), fields: fieldsFrom(ctx, i, item) }],
          typecast: Boolean(ctx.getNodeParameter('options.typecast', i, false)),
        },
        undefined,
        i,
      );
      return ((response.records as DataObject[]) ?? []).map(flatten);
    },
    async upsert(ctx, i, item) {
      const mergeOn = fieldList(ctx.getNodeParameter('fieldsToMergeOn', i, ''));
      if (!mergeOn.length)
        throw new NodeOperationError(ctx.getNode(), 'Enter the field(s) to match on', { itemIndex: i });
      const fields = fieldsFrom(ctx, i, item);
      const missing = mergeOn.filter((f) => !(f in fields));
      if (missing.length) {
        throw new NodeOperationError(
          ctx.getNode(),
          `The item has no value for ${missing.map((m) => `"${m}"`).join(', ')}`,
          { itemIndex: i },
        );
      }
      const response = await airtableRequest(
        ctx,
        'PATCH',
        pathOf(ctx, i),
        {
          performUpsert: { fieldsToMergeOn: mergeOn },
          records: [{ fields }],
          typecast: Boolean(ctx.getNodeParameter('options.typecast', i, false)),
        },
        undefined,
        i,
      );
      return ((response.records as DataObject[]) ?? []).map(flatten);
    },
    async delete(ctx, i) {
      const response = await airtableRequest(
        ctx,
        'DELETE',
        `${pathOf(ctx, i)}/${encodeURIComponent(requiredId(ctx, 'id', i, 'Record ID'))}`,
        undefined,
        undefined,
        i,
      );
      return { id: response.id, deleted: response.deleted ?? true };
    },
  },
  base: {
    async list(ctx, i) {
      const returnAll = ctx.getNodeParameter('returnAll', i, false) as boolean;
      const limit = returnAll ? Number.POSITIVE_INFINITY : Number(ctx.getNodeParameter('limit', i, 50));
      const bases: DataObject[] = [];
      let offset: string | undefined;
      for (let page = 0; page < 100; page++) {
        const response = await airtableRequest(ctx, 'GET', '/meta/bases', undefined, { offset }, i);
        bases.push(...((response.bases as DataObject[]) ?? []));
        offset = response.offset as string | undefined;
        if (!offset || bases.length >= limit) break;
      }
      return Number.isFinite(limit) ? bases.slice(0, limit) : bases;
    },
    async schema(ctx, i) {
      const response = await airtableRequest(
        ctx,
        'GET',
        `/meta/bases/${encodeURIComponent(requiredId(ctx, 'base', i, 'Base'))}/tables`,
        undefined,
        undefined,
        i,
      );
      return (response.tables as DataObject[]) ?? [];
    },
  },
};

// ---------------------------------------------------------------------------------------------
// description
// ---------------------------------------------------------------------------------------------

const baseLocator = locator('base', 'Base', {
  searchListMethod: 'searchBases',
  urlRegex: 'https://airtable\\.com/(app[A-Za-z0-9]+)',
  urlPlaceholder: 'https://airtable.com/app12DiScdfes/tbl9WvGeEPa6lZyVq/viwHdfasdfeieg5p',
  idPlaceholder: 'appD3dfaeidke',
});
const tableLocator = locator('table', 'Table', {
  searchListMethod: 'searchTables',
  urlRegex: 'https://airtable\\.com/app[A-Za-z0-9]+/(tbl[A-Za-z0-9]+)',
  urlPlaceholder: 'https://airtable.com/app12DiScdfes/tbl9WvGeEPa6lZyVq/viw...',
  idPlaceholder: 'tbl3dirwqeidke',
});
const recordOps = ['list', 'search', 'get', 'create', 'update', 'upsert', 'delete'];

const properties: NodeProperty[] = [
  resourceProperty(
    [
      { name: 'Record', value: 'record' },
      { name: 'Base', value: 'base' },
    ],
    'record',
  ),
  operationProperty(
    'record',
    [
      { name: 'Get Many', value: 'list', action: 'Get many records' },
      { name: 'Search', value: 'search', action: 'Search records with a formula' },
      { name: 'Get', value: 'get', action: 'Get a record' },
      { name: 'Create', value: 'create', action: 'Create a record' },
      { name: 'Update', value: 'update', action: 'Update a record' },
      { name: 'Create or Update', value: 'upsert', action: 'Create or update a record' },
      { name: 'Delete', value: 'delete', action: 'Delete a record' },
    ],
    'list',
  ),
  operationProperty(
    'base',
    [
      { name: 'Get Many', value: 'list', action: 'Get many bases' },
      { name: 'Get Schema', value: 'schema', action: 'Get the schema of a base' },
    ],
    'list',
  ),
  forOps(baseLocator, 'record', recordOps),
  forOps(baseLocator, 'base', 'schema'),
  forOps(tableLocator, 'record', recordOps),
  forOps(
    {
      displayName: 'Record ID',
      name: 'id',
      type: 'string',
      default: '={{ $json.id }}',
      required: true,
      placeholder: 'recXXXXXXXXXXXXXX',
    },
    'record',
    ['get', 'update', 'delete'],
  ),
  forOps(
    {
      displayName: 'Filter By Formula',
      name: 'filterByFormula',
      type: 'string',
      default: '',
      required: true,
      placeholder: "AND({Status} = 'Open', {Priority} > 2)",
      description: 'An Airtable formula; records for which it is true are returned',
    },
    'record',
    'search',
  ),
  forOps(
    {
      displayName: 'Fields to Match On',
      name: 'fieldsToMergeOn',
      type: 'string',
      default: '',
      required: true,
      placeholder: 'Email',
      description: 'Comma-separated fields that identify an existing record (up to 3)',
    },
    'record',
    'upsert',
  ),
  forOps(
    {
      displayName: 'Mapping Column Mode',
      name: 'dataMode',
      type: 'options',
      default: 'autoMapInputData',
      options: [
        {
          name: 'Map Each Field Automatically',
          value: 'autoMapInputData',
          description: 'Item fields become record fields',
        },
        { name: 'Map Each Field Manually', value: 'defineBelow' },
      ],
    },
    'record',
    ['create', 'update', 'upsert'],
  ),
  {
    displayName: 'Fields',
    name: 'fieldsUi',
    type: 'fixedCollection',
    default: { fieldValues: [] },
    placeholder: 'Add field',
    typeOptions: { multipleValues: true },
    displayOptions: {
      show: { resource: ['record'], operation: ['create', 'update', 'upsert'], dataMode: ['defineBelow'] },
    },
    options: [
      {
        displayName: 'Field',
        name: 'fieldValues',
        values: [
          { displayName: 'Field Name', name: 'fieldName', type: 'string', default: '' },
          { displayName: 'Field Value', name: 'fieldValue', type: 'string', default: '' },
        ],
      },
    ],
  },
  ...returnAllProperties(['record', 'base'], ['list', 'search'], 1000),
  forOps(
    {
      displayName: 'Sort',
      name: 'sort',
      type: 'fixedCollection',
      default: { property: [] },
      placeholder: 'Add sort rule',
      typeOptions: { multipleValues: true, sortable: true },
      options: [
        {
          displayName: 'Rule',
          name: 'property',
          values: [
            { displayName: 'Field', name: 'field', type: 'string', default: '' },
            {
              displayName: 'Direction',
              name: 'direction',
              type: 'options',
              default: 'asc',
              options: [
                { name: 'Ascending', value: 'asc' },
                { name: 'Descending', value: 'desc' },
              ],
            },
          ],
        },
      ],
    },
    'record',
    ['list', 'search'],
  ),
  forOps(
    {
      displayName: 'Options',
      name: 'options',
      type: 'collection',
      default: {},
      placeholder: 'Add option',
      options: [
        {
          displayName: 'Fields',
          name: 'fields',
          type: 'string',
          default: '',
          description: 'Comma-separated fields to return',
        },
        {
          displayName: 'View',
          name: 'view',
          type: 'string',
          default: '',
          description: 'Name or ID of a view to read through',
        },
      ],
    },
    'record',
    ['list', 'search'],
  ),
  forOps(
    {
      displayName: 'Options',
      name: 'options',
      type: 'collection',
      default: {},
      placeholder: 'Add option',
      options: [
        {
          displayName: 'Typecast',
          name: 'typecast',
          type: 'boolean',
          default: false,
          description:
            'Whether Airtable converts text to the field type (and creates missing select options)',
        },
        {
          displayName: 'Ignore Fields',
          name: 'ignoreFields',
          type: 'string',
          default: '',
          description: 'Comma-separated item fields not sent (automatic mapping)',
        },
      ],
    },
    'record',
    ['create', 'update', 'upsert'],
  ),
];

export const AirtableNode: NodeType = {
  description: {
    name: 'app.airtable',
    displayName: 'Airtable',
    description: 'Read, search, create, update and delete Airtable records',
    icon: 'simple:airtable',
    iconColor: '#18bfff',
    group: ['input', 'output'],
    version: 1,
    defaults: { name: 'Airtable' },
    inputs: ['main'],
    outputs: ['main'],
    categories: ['Data & Storage', 'Productivity'],
    alias: ['spreadsheet', 'database', 'table', 'records', 'base'],
    subtitle: '={{ $parameter.operation + ": " + $parameter.resource }}',
    usableAsTool: true,
    credentials: [{ name: 'airtableTokenApi', required: true }],
    properties,
  },
  async execute(ctx) {
    return runOperations(ctx, handlers);
  },
  methods: {
    listSearch: {
      async searchBases(ctx, filter, paginationToken): Promise<ListSearchResult> {
        const response = await airtableRequest(ctx, 'GET', '/meta/bases', undefined, {
          offset: paginationToken,
        });
        const term = (filter ?? '').toLowerCase();
        return {
          results: ((response.bases as DataObject[]) ?? [])
            .filter((b) => !term || String(b.name).toLowerCase().includes(term))
            .map((b) => ({
              name: String(b.name),
              value: String(b.id),
              url: `https://airtable.com/${String(b.id)}`,
            })),
          paginationToken: response.offset as string | undefined,
        };
      },
      async searchTables(ctx, filter): Promise<ListSearchResult> {
        const base = ctx.getCurrentNodeParameter('base');
        const baseId = isResourceLocatorValue(base) ? base.value : String(base ?? '');
        if (!baseId) return { results: [] };
        const response = await airtableRequest(
          ctx,
          'GET',
          `/meta/bases/${encodeURIComponent(baseId)}/tables`,
        );
        const term = (filter ?? '').toLowerCase();
        return {
          results: ((response.tables as DataObject[]) ?? [])
            .filter((t) => !term || String(t.name).toLowerCase().includes(term))
            .map((t) => ({
              name: String(t.name),
              value: String(t.id),
              url: `https://airtable.com/${baseId}/${String(t.id)}`,
            })),
        };
      },
    },
  },
};
