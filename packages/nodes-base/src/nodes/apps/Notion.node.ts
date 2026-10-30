/** Notion: databases, database pages, pages, blocks and users (Notion API 2022-06-28). */
import {
  type BaseContext,
  type DataObject,
  type ExecuteContext,
  type HttpMethod,
  isPlainObject,
  type ListSearchResult,
  NodeOperationError,
  type NodeProperty,
  type NodeType,
} from '@workflow/workflow';
import { fieldList, parseJsonParameter } from '../../utils/utilities';
import {
  forOps,
  locator,
  type OperationHandler,
  operationProperty,
  requiredId,
  resourceProperty,
  returnAllProperties,
  runOperations,
} from './shared';

const BASE = 'https://api.notion.com/v1';
const CREDENTIAL = 'notionApi';
/** Notion caps rich text content at 2000 characters per text object */
const TEXT_LIMIT = 2000;

type NotionContext = Pick<BaseContext, 'helpers'>;

async function notionRequest<T = DataObject>(
  ctx: NotionContext,
  method: HttpMethod,
  path: string,
  body?: DataObject,
  qs?: DataObject,
  itemIndex = 0,
): Promise<T> {
  return (await ctx.helpers.httpRequestWithAuthentication(
    CREDENTIAL,
    { method, url: `${BASE}${path}`, body, bodyType: body ? 'json' : undefined, qs, responseType: 'json' },
    itemIndex,
  )) as T;
}

/** Follow `next_cursor` until `limit` results (POST bodies take start_cursor, GETs take it in the query). */
async function notionPaginate(
  ctx: ExecuteContext,
  i: number,
  method: 'GET' | 'POST',
  path: string,
  body: DataObject,
  limit: number,
): Promise<DataObject[]> {
  const out: DataObject[] = [];
  let cursor: string | undefined;
  for (let page = 0; page < 1000; page++) {
    const pageSize = Math.min(100, Number.isFinite(limit) ? limit - out.length : 100);
    const response =
      method === 'POST'
        ? await notionRequest(
            ctx,
            'POST',
            path,
            { ...body, page_size: pageSize, ...(cursor ? { start_cursor: cursor } : {}) },
            undefined,
            i,
          )
        : await notionRequest(
            ctx,
            'GET',
            path,
            undefined,
            { page_size: pageSize, ...(cursor ? { start_cursor: cursor } : {}) },
            i,
          );
    out.push(...((response.results as DataObject[]) ?? []));
    cursor = response.has_more ? (response.next_cursor as string) : undefined;
    if (!cursor || out.length >= limit) break;
  }
  return Number.isFinite(limit) ? out.slice(0, limit) : out;
}

export function richText(content: string): DataObject[] {
  const chunks: DataObject[] = [];
  for (let start = 0; start < content.length; start += TEXT_LIMIT) {
    chunks.push({ type: 'text', text: { content: content.slice(start, start + TEXT_LIMIT) } });
  }
  return chunks.length ? chunks : [{ type: 'text', text: { content: '' } }];
}

const PROPERTY_TYPES = [
  'title',
  'rich_text',
  'number',
  'checkbox',
  'select',
  'multi_select',
  'status',
  'date',
  'url',
  'email',
  'phone_number',
  'people',
  'relation',
] as const;
type PropertyType = (typeof PROPERTY_TYPES)[number];

/** Notion property value from a simple string/number/boolean input. */
export function notionPropertyValue(type: PropertyType, value: unknown): DataObject {
  const text = value === undefined || value === null ? '' : String(value);
  switch (type) {
    case 'title':
      return { title: richText(text) };
    case 'rich_text':
      return { rich_text: richText(text) };
    case 'number': {
      if (text.trim() === '') return { number: null };
      const n = Number(text);
      if (Number.isNaN(n)) throw new Error(`"${text}" is not a number`);
      return { number: n };
    }
    case 'checkbox':
      return { checkbox: value === true || ['true', '1', 'yes', 'on'].includes(text.toLowerCase()) };
    case 'select':
      return { select: text ? { name: text } : null };
    case 'status':
      return { status: text ? { name: text } : null };
    case 'multi_select':
      return { multi_select: fieldList(value).map((name) => ({ name })) };
    case 'date': {
      if (isPlainObject(value)) return { date: value };
      if (!text) return { date: null };
      const [start, end] = text.split('/').map((s) => s.trim());
      return { date: { start, ...(end ? { end } : {}) } };
    }
    case 'url':
      return { url: text || null };
    case 'email':
      return { email: text || null };
    case 'phone_number':
      return { phone_number: text || null };
    case 'people':
      return { people: fieldList(value).map((id) => ({ object: 'user', id })) };
    case 'relation':
      return { relation: fieldList(value).map((id) => ({ id })) };
    default:
      throw new Error(`Unsupported property type "${String(type)}"`);
  }
}

function plainText(parts: unknown): string {
  return Array.isArray(parts) ? parts.map((p) => String((p as DataObject).plain_text ?? '')).join('') : '';
}

/** Readable value of a page property (for "simplify"). */
export function simplifyProperty(property: DataObject): unknown {
  const type = String(property.type);
  const value = property[type] as unknown;
  switch (type) {
    case 'title':
    case 'rich_text':
      return plainText(value);
    case 'select':
    case 'status':
      return (value as DataObject | null)?.name ?? null;
    case 'multi_select':
      return ((value as DataObject[]) ?? []).map((o) => o.name);
    case 'people':
      return ((value as DataObject[]) ?? []).map((p) => p.id);
    case 'relation':
      return ((value as DataObject[]) ?? []).map((r) => r.id);
    case 'date':
      return value ?? null;
    case 'files':
      return ((value as DataObject[]) ?? []).map(
        (f) => (f.file as DataObject | undefined)?.url ?? (f.external as DataObject | undefined)?.url,
      );
    case 'formula':
      return (value as DataObject | null)?.[String((value as DataObject | null)?.type)] ?? null;
    case 'rollup':
      return (value as DataObject | null)?.[String((value as DataObject | null)?.type)] ?? null;
    case 'unique_id': {
      const id = value as DataObject | null;
      return id ? `${id.prefix ? `${String(id.prefix)}-` : ''}${String(id.number)}` : null;
    }
    default:
      return value ?? null;
  }
}

export function simplifyPage(page: DataObject): DataObject {
  const properties: DataObject = {};
  let name: string | undefined;
  for (const [key, prop] of Object.entries((page.properties ?? {}) as Record<string, DataObject>)) {
    properties[key] = simplifyProperty(prop);
    if (prop.type === 'title') name = String(properties[key]);
  }
  return {
    id: page.id,
    name,
    url: page.url,
    archived: page.archived ?? page.in_trash ?? false,
    createdTime: page.created_time,
    lastEditedTime: page.last_edited_time,
    properties,
  };
}

function simplifyDatabase(db: DataObject): DataObject {
  return {
    id: db.id,
    name: plainText(db.title),
    url: db.url,
    createdTime: db.created_time,
    lastEditedTime: db.last_edited_time,
    properties: Object.fromEntries(
      Object.entries((db.properties ?? {}) as Record<string, DataObject>).map(([k, v]) => [k, v.type]),
    ),
  };
}

function simple(ctx: ExecuteContext, i: number): boolean {
  return ctx.getNodeParameter('simple', i, true) !== false;
}

function propertiesFrom(ctx: ExecuteContext, i: number): DataObject {
  const list = ((ctx.getNodeParameter('propertiesUi', i, {}) as DataObject).propertyValues ?? []) as Array<{
    key: string;
    type: PropertyType;
    value: unknown;
  }>;
  const out: DataObject = {};
  for (const entry of list) {
    if (!entry.key) continue;
    try {
      out[entry.key] = notionPropertyValue(entry.type ?? 'rich_text', entry.value);
    } catch (error) {
      throw new NodeOperationError(ctx.getNode(), `Property "${entry.key}": ${(error as Error).message}`, {
        itemIndex: i,
      });
    }
  }
  const raw = ctx.getNodeParameter('options.rawProperties', i, '');
  if (raw) {
    const parsed = parseJsonParameter(ctx, raw, 'Properties (JSON)', i);
    if (!isPlainObject(parsed))
      throw new NodeOperationError(ctx.getNode(), 'Properties (JSON) must be an object', { itemIndex: i });
    Object.assign(out, parsed);
  }
  return out;
}

const BLOCK_TYPES = [
  'paragraph',
  'heading_1',
  'heading_2',
  'heading_3',
  'bulleted_list_item',
  'numbered_list_item',
  'to_do',
  'quote',
  'code',
  'callout',
  'divider',
] as const;

export function blocksFrom(ctx: ExecuteContext, i: number, parameter = 'blockUi'): DataObject[] {
  const list = ((ctx.getNodeParameter(parameter, i, {}) as DataObject).blockValues ?? []) as Array<{
    type: (typeof BLOCK_TYPES)[number];
    text?: string;
    checked?: boolean;
    language?: string;
  }>;
  const blocks: DataObject[] = list.map((b) => {
    if (b.type === 'divider') return { object: 'block', type: 'divider', divider: {} };
    const content: DataObject = { rich_text: richText(String(b.text ?? '')) };
    if (b.type === 'to_do') content.checked = Boolean(b.checked);
    if (b.type === 'code') content.language = b.language || 'plain text';
    return { object: 'block', type: b.type, [b.type]: content };
  });
  const raw = ctx.getNodeParameter('options.rawBlocks', i, '');
  if (raw) {
    const parsed = parseJsonParameter(ctx, raw, 'Blocks (JSON)', i);
    if (!Array.isArray(parsed))
      throw new NodeOperationError(ctx.getNode(), 'Blocks (JSON) must be an array', { itemIndex: i });
    blocks.push(...(parsed as DataObject[]));
  }
  return blocks;
}

const FILTER_BY_TYPE: Record<string, string> = {
  title: 'title',
  rich_text: 'rich_text',
  number: 'number',
  checkbox: 'checkbox',
  select: 'select',
  multi_select: 'multi_select',
  status: 'status',
  date: 'date',
  url: 'url',
  email: 'email',
  phone_number: 'phone_number',
  people: 'people',
  relation: 'relation',
};

function filterFrom(ctx: ExecuteContext, i: number): DataObject | undefined {
  const mode = ctx.getNodeParameter('filterType', i, 'none') as string;
  if (mode === 'json') {
    const parsed = parseJsonParameter(ctx, ctx.getNodeParameter('filterJson', i, ''), 'Filter (JSON)', i);
    if (parsed === undefined) return undefined;
    if (!isPlainObject(parsed))
      throw new NodeOperationError(ctx.getNode(), 'Filter (JSON) must be an object', { itemIndex: i });
    return parsed;
  }
  if (mode !== 'manual') return undefined;
  const conditions = ((ctx.getNodeParameter('filters', i, {}) as DataObject).conditions ?? []) as Array<{
    key: string;
    type: string;
    condition: string;
    value?: unknown;
  }>;
  const built = conditions
    .filter((c) => c.key && c.condition)
    .map((c) => {
      const kind = FILTER_BY_TYPE[c.type] ?? 'rich_text';
      let value: unknown = c.value;
      if (c.condition === 'is_empty' || c.condition === 'is_not_empty') value = true;
      else if (kind === 'number') value = Number(c.value);
      else if (kind === 'checkbox') value = c.value === true || String(c.value).toLowerCase() === 'true';
      return { property: c.key, [kind]: { [c.condition]: value } };
    });
  if (!built.length) return undefined;
  if (built.length === 1) return built[0];
  return { [ctx.getNodeParameter('matchType', i, 'and') === 'or' ? 'or' : 'and']: built };
}

function limitOf(ctx: ExecuteContext, i: number): number {
  return ctx.getNodeParameter('returnAll', i, false)
    ? Number.POSITIVE_INFINITY
    : Number(ctx.getNodeParameter('limit', i, 50));
}

function id(ctx: ExecuteContext, name: string, i: number, label: string): string {
  return encodeURIComponent(requiredId(ctx, name, i, label));
}

const handlers: Record<string, Record<string, OperationHandler>> = {
  database: {
    async get(ctx, i) {
      const db = await notionRequest(
        ctx,
        'GET',
        `/databases/${id(ctx, 'databaseId', i, 'Database')}`,
        undefined,
        undefined,
        i,
      );
      return simple(ctx, i) ? simplifyDatabase(db) : db;
    },
    async getAll(ctx, i) {
      const results = await notionPaginate(
        ctx,
        i,
        'POST',
        '/search',
        { filter: { property: 'object', value: 'database' } },
        limitOf(ctx, i),
      );
      return simple(ctx, i) ? results.map(simplifyDatabase) : results;
    },
    async search(ctx, i) {
      const query = String(ctx.getNodeParameter('text', i, '') ?? '');
      const results = await notionPaginate(
        ctx,
        i,
        'POST',
        '/search',
        { query, filter: { property: 'object', value: 'database' } },
        limitOf(ctx, i),
      );
      return simple(ctx, i) ? results.map(simplifyDatabase) : results;
    },
  },
  databasePage: {
    async create(ctx, i) {
      const children = blocksFrom(ctx, i);
      const page = await notionRequest(
        ctx,
        'POST',
        '/pages',
        {
          parent: { database_id: requiredId(ctx, 'databaseId', i, 'Database') },
          properties: propertiesFrom(ctx, i),
          ...(children.length ? { children } : {}),
        },
        undefined,
        i,
      );
      return simple(ctx, i) ? simplifyPage(page) : page;
    },
    async update(ctx, i) {
      const page = await notionRequest(
        ctx,
        'PATCH',
        `/pages/${id(ctx, 'pageId', i, 'Page')}`,
        { properties: propertiesFrom(ctx, i) },
        undefined,
        i,
      );
      return simple(ctx, i) ? simplifyPage(page) : page;
    },
    async getAll(ctx, i) {
      const sorts = ((ctx.getNodeParameter('sort', i, {}) as DataObject).sortValue ?? []) as Array<{
        key: string;
        direction: string;
      }>;
      const body: DataObject = {};
      const filter = filterFrom(ctx, i);
      if (filter) body.filter = filter;
      if (sorts.length) {
        body.sorts = sorts
          .filter((s) => s.key)
          .map((s) =>
            ['created_time', 'last_edited_time'].includes(s.key)
              ? { timestamp: s.key, direction: s.direction || 'ascending' }
              : { property: s.key, direction: s.direction || 'ascending' },
          );
      }
      const results = await notionPaginate(
        ctx,
        i,
        'POST',
        `/databases/${id(ctx, 'databaseId', i, 'Database')}/query`,
        body,
        limitOf(ctx, i),
      );
      return simple(ctx, i) ? results.map(simplifyPage) : results;
    },
  },
  page: {
    async get(ctx, i) {
      const page = await notionRequest(
        ctx,
        'GET',
        `/pages/${id(ctx, 'pageId', i, 'Page')}`,
        undefined,
        undefined,
        i,
      );
      return simple(ctx, i) ? simplifyPage(page) : page;
    },
    async create(ctx, i) {
      const children = blocksFrom(ctx, i);
      const page = await notionRequest(
        ctx,
        'POST',
        '/pages',
        {
          parent: { page_id: requiredId(ctx, 'pageId', i, 'Parent page') },
          properties: { title: { title: richText(String(ctx.getNodeParameter('title', i, '') ?? '')) } },
          ...(children.length ? { children } : {}),
        },
        undefined,
        i,
      );
      return simple(ctx, i) ? simplifyPage(page) : page;
    },
    async search(ctx, i) {
      const query = String(ctx.getNodeParameter('text', i, '') ?? '');
      const results = await notionPaginate(
        ctx,
        i,
        'POST',
        '/search',
        { query, filter: { property: 'object', value: 'page' } },
        limitOf(ctx, i),
      );
      return simple(ctx, i) ? results.map(simplifyPage) : results;
    },
    async archive(ctx, i) {
      const page = await notionRequest(
        ctx,
        'PATCH',
        `/pages/${id(ctx, 'pageId', i, 'Page')}`,
        { archived: true },
        undefined,
        i,
      );
      return simple(ctx, i) ? simplifyPage(page) : page;
    },
  },
  block: {
    async append(ctx, i) {
      const children = blocksFrom(ctx, i);
      if (!children.length)
        throw new NodeOperationError(ctx.getNode(), 'Add at least one block', { itemIndex: i });
      const response = await notionRequest(
        ctx,
        'PATCH',
        `/blocks/${id(ctx, 'blockId', i, 'Block')}/children`,
        { children },
        undefined,
        i,
      );
      return (response.results as DataObject[]) ?? [];
    },
    async getAll(ctx, i) {
      return notionPaginate(
        ctx,
        i,
        'GET',
        `/blocks/${id(ctx, 'blockId', i, 'Block')}/children`,
        {},
        limitOf(ctx, i),
      );
    },
  },
  user: {
    async get(ctx, i) {
      return notionRequest(ctx, 'GET', `/users/${id(ctx, 'userId', i, 'User')}`, undefined, undefined, i);
    },
    async getAll(ctx, i) {
      return notionPaginate(ctx, i, 'GET', '/users', {}, limitOf(ctx, i));
    },
  },
};

// ---------------------------------------------------------------------------------------------
// description
// ---------------------------------------------------------------------------------------------

const NOTION_URL = 'notion\\.(?:so|site)/(?:[^?#]*?)([0-9a-f]{32})';
const databaseLocator = locator('databaseId', 'Database', {
  searchListMethod: 'searchDatabases',
  urlRegex: NOTION_URL,
  urlPlaceholder: 'https://www.notion.so/team/0fe2f7de558b471eab07e9d871cdf4a9?v=...',
  idPlaceholder: '0fe2f7de558b471eab07e9d871cdf4a9',
});
const pageLocator = locator('pageId', 'Page', {
  searchListMethod: 'searchPages',
  urlRegex: NOTION_URL,
  urlPlaceholder: 'https://www.notion.so/My-Page-b4eeb113e118403aa450af65ac25f0b9',
  idPlaceholder: 'b4eeb113e118403aa450af65ac25f0b9',
});

const simplifyOption: NodeProperty = {
  displayName: 'Simplify',
  name: 'simple',
  type: 'boolean',
  default: true,
  description: 'Whether to return readable property values instead of the raw Notion objects',
};

const propertiesUi: NodeProperty = {
  displayName: 'Properties',
  name: 'propertiesUi',
  type: 'fixedCollection',
  default: { propertyValues: [] },
  placeholder: 'Add property',
  typeOptions: { multipleValues: true },
  options: [
    {
      displayName: 'Property',
      name: 'propertyValues',
      values: [
        { displayName: 'Name', name: 'key', type: 'string', default: '', placeholder: 'Status' },
        {
          displayName: 'Type',
          name: 'type',
          type: 'options',
          default: 'rich_text',
          options: PROPERTY_TYPES.map((t) => ({
            name: t.replace(/_/g, ' ').replace(/^\w/, (c) => c.toUpperCase()),
            value: t,
          })),
        },
        {
          displayName: 'Value',
          name: 'value',
          type: 'string',
          default: '',
          description:
            'Lists (multi select, people, relation) are comma-separated; dates are ISO 8601, a range as "start/end"; checkboxes are true or false',
        },
      ],
    },
  ],
};

const blockUi: NodeProperty = {
  displayName: 'Blocks',
  name: 'blockUi',
  type: 'fixedCollection',
  default: { blockValues: [] },
  placeholder: 'Add block',
  typeOptions: { multipleValues: true, sortable: true },
  options: [
    {
      displayName: 'Block',
      name: 'blockValues',
      values: [
        {
          displayName: 'Type',
          name: 'type',
          type: 'options',
          default: 'paragraph',
          options: BLOCK_TYPES.map((t) => ({
            name: t.replace(/_/g, ' ').replace(/^\w/, (c) => c.toUpperCase()),
            value: t,
          })),
        },
        {
          displayName: 'Text',
          name: 'text',
          type: 'string',
          default: '',
          typeOptions: { rows: 2 },
          displayOptions: { hide: { type: ['divider'] } },
        },
        {
          displayName: 'Checked',
          name: 'checked',
          type: 'boolean',
          default: false,
          displayOptions: { show: { type: ['to_do'] } },
        },
        {
          displayName: 'Language',
          name: 'language',
          type: 'string',
          default: 'javascript',
          displayOptions: { show: { type: ['code'] } },
        },
      ],
    },
  ],
};

const rawProperties: NodeProperty = {
  displayName: 'Properties (JSON)',
  name: 'rawProperties',
  type: 'json',
  default: '',
  description: 'Notion property objects merged over the fields above, for types not covered there',
};
const rawBlocks: NodeProperty = {
  displayName: 'Blocks (JSON)',
  name: 'rawBlocks',
  type: 'json',
  default: '',
  description: 'Notion block objects appended after the blocks above',
};

const properties: NodeProperty[] = [
  resourceProperty(
    [
      { name: 'Database', value: 'database' },
      { name: 'Database Page', value: 'databasePage' },
      { name: 'Page', value: 'page' },
      { name: 'Block', value: 'block' },
      { name: 'User', value: 'user' },
    ],
    'databasePage',
  ),
  operationProperty(
    'database',
    [
      { name: 'Get', value: 'get', action: 'Get a database' },
      { name: 'Get Many', value: 'getAll', action: 'Get many databases' },
      { name: 'Search', value: 'search', action: 'Search databases by title' },
    ],
    'get',
  ),
  operationProperty(
    'databasePage',
    [
      { name: 'Create', value: 'create', action: 'Create a database page' },
      { name: 'Update', value: 'update', action: 'Update a database page' },
      { name: 'Get Many', value: 'getAll', action: 'Get many database pages' },
    ],
    'create',
  ),
  operationProperty(
    'page',
    [
      { name: 'Get', value: 'get', action: 'Get a page' },
      { name: 'Create', value: 'create', action: 'Create a page' },
      { name: 'Search', value: 'search', action: 'Search pages by title' },
      { name: 'Archive', value: 'archive', action: 'Archive a page' },
    ],
    'get',
  ),
  operationProperty(
    'block',
    [
      { name: 'Append After', value: 'append', action: 'Append blocks' },
      { name: 'Get Child Blocks', value: 'getAll', action: 'Get child blocks' },
    ],
    'append',
  ),
  operationProperty(
    'user',
    [
      { name: 'Get', value: 'get', action: 'Get a user' },
      { name: 'Get Many', value: 'getAll', action: 'Get many users' },
    ],
    'get',
  ),
  forOps(databaseLocator, 'database', 'get'),
  forOps(databaseLocator, 'databasePage', ['create', 'getAll']),
  forOps(pageLocator, 'databasePage', 'update'),
  forOps(pageLocator, 'page', ['get', 'archive']),
  forOps({ ...pageLocator, displayName: 'Parent Page' }, 'page', 'create'),
  forOps({ ...pageLocator, name: 'blockId', displayName: 'Block (or Page)' }, 'block', ['append', 'getAll']),
  forOps(
    { displayName: 'User ID', name: 'userId', type: 'string', default: '', required: true },
    'user',
    'get',
  ),
  forOps(
    { displayName: 'Search Text', name: 'text', type: 'string', default: '' },
    ['database', 'page'],
    'search',
  ),
  forOps(
    { displayName: 'Title', name: 'title', type: 'string', default: '', required: true },
    'page',
    'create',
  ),
  forOps(propertiesUi, 'databasePage', ['create', 'update']),
  forOps(blockUi, 'databasePage', 'create'),
  forOps(blockUi, 'page', 'create'),
  forOps(blockUi, 'block', 'append'),
  forOps(
    {
      displayName: 'Filter',
      name: 'filterType',
      type: 'options',
      default: 'none',
      options: [
        { name: 'None', value: 'none' },
        { name: 'Build Manually', value: 'manual' },
        { name: 'JSON', value: 'json', description: 'A Notion filter object' },
      ],
    },
    'databasePage',
    'getAll',
  ),
  {
    displayName: 'Must Match',
    name: 'matchType',
    type: 'options',
    default: 'and',
    options: [
      { name: 'All Filters', value: 'and' },
      { name: 'Any Filter', value: 'or' },
    ],
    displayOptions: { show: { resource: ['databasePage'], operation: ['getAll'], filterType: ['manual'] } },
  },
  {
    displayName: 'Filters',
    name: 'filters',
    type: 'fixedCollection',
    default: { conditions: [] },
    placeholder: 'Add condition',
    typeOptions: { multipleValues: true },
    displayOptions: { show: { resource: ['databasePage'], operation: ['getAll'], filterType: ['manual'] } },
    options: [
      {
        displayName: 'Condition',
        name: 'conditions',
        values: [
          { displayName: 'Property Name', name: 'key', type: 'string', default: '' },
          {
            displayName: 'Property Type',
            name: 'type',
            type: 'options',
            default: 'rich_text',
            options: Object.keys(FILTER_BY_TYPE).map((t) => ({
              name: t.replace(/_/g, ' ').replace(/^\w/, (c) => c.toUpperCase()),
              value: t,
            })),
          },
          {
            displayName: 'Condition',
            name: 'condition',
            type: 'options',
            default: 'equals',
            options: [
              'equals',
              'does_not_equal',
              'contains',
              'does_not_contain',
              'starts_with',
              'ends_with',
              'greater_than',
              'less_than',
              'greater_than_or_equal_to',
              'less_than_or_equal_to',
              'before',
              'after',
              'on_or_before',
              'on_or_after',
              'is_empty',
              'is_not_empty',
            ].map((c) => ({ name: c.replace(/_/g, ' ').replace(/^\w/, (x) => x.toUpperCase()), value: c })),
          },
          { displayName: 'Value', name: 'value', type: 'string', default: '' },
        ],
      },
    ],
  },
  {
    displayName: 'Filter (JSON)',
    name: 'filterJson',
    type: 'json',
    default: '',
    displayOptions: { show: { resource: ['databasePage'], operation: ['getAll'], filterType: ['json'] } },
  },
  forOps(
    {
      displayName: 'Sort',
      name: 'sort',
      type: 'fixedCollection',
      default: { sortValue: [] },
      placeholder: 'Add sort',
      typeOptions: { multipleValues: true, sortable: true },
      options: [
        {
          displayName: 'Sort',
          name: 'sortValue',
          values: [
            {
              displayName: 'Property Name',
              name: 'key',
              type: 'string',
              default: '',
              description: 'Or created_time / last_edited_time',
            },
            {
              displayName: 'Direction',
              name: 'direction',
              type: 'options',
              default: 'ascending',
              options: [
                { name: 'Ascending', value: 'ascending' },
                { name: 'Descending', value: 'descending' },
              ],
            },
          ],
        },
      ],
    },
    'databasePage',
    'getAll',
  ),
  ...returnAllProperties(['database', 'databasePage', 'page', 'block', 'user'], ['getAll', 'search'], 1000),
  forOps(
    simplifyOption,
    ['database', 'databasePage', 'page'],
    ['get', 'getAll', 'search', 'create', 'update', 'archive'],
  ),
  forOps(
    {
      displayName: 'Options',
      name: 'options',
      type: 'collection',
      default: {},
      placeholder: 'Add option',
      options: [rawProperties, rawBlocks],
    },
    'databasePage',
    'create',
  ),
  forOps(
    {
      displayName: 'Options',
      name: 'options',
      type: 'collection',
      default: {},
      placeholder: 'Add option',
      options: [rawProperties],
    },
    'databasePage',
    'update',
  ),
  forOps(
    {
      displayName: 'Options',
      name: 'options',
      type: 'collection',
      default: {},
      placeholder: 'Add option',
      options: [rawBlocks],
    },
    ['page', 'block'],
    ['create', 'append'],
  ),
];

async function searchByObject(
  ctx: Pick<BaseContext, 'helpers'>,
  object: 'database' | 'page',
  filter?: string,
  token?: string,
): Promise<ListSearchResult> {
  const response = await notionRequest(ctx, 'POST', '/search', {
    query: filter ?? '',
    filter: { property: 'object', value: object },
    page_size: 100,
    ...(token ? { start_cursor: token } : {}),
  });
  return {
    results: ((response.results as DataObject[]) ?? []).map((r) => {
      const name =
        object === 'database' ? plainText(r.title) : String(simplifyPage(r).name ?? '') || String(r.id);
      return {
        name: name || String(r.id),
        value: String(r.id).replace(/-/g, ''),
        url: r.url as string | undefined,
      };
    }),
    paginationToken: response.has_more ? (response.next_cursor as string) : undefined,
  };
}

export const NotionNode: NodeType = {
  description: {
    name: 'app.notion',
    displayName: 'Notion',
    description: 'Create and query Notion database pages, pages, blocks and users',
    icon: 'simple:notion',
    iconColor: '#000000',
    group: ['output'],
    version: 1,
    defaults: { name: 'Notion' },
    inputs: ['main'],
    outputs: ['main'],
    categories: ['Productivity'],
    alias: ['notes', 'wiki', 'docs', 'database', 'knowledge base'],
    subtitle: '={{ $parameter.operation + ": " + $parameter.resource }}',
    usableAsTool: true,
    credentials: [{ name: 'notionApi', required: true }],
    properties,
  },
  async execute(ctx) {
    return runOperations(ctx, handlers);
  },
  methods: {
    listSearch: {
      searchDatabases: (ctx, filter, token) => searchByObject(ctx, 'database', filter, token),
      searchPages: (ctx, filter, token) => searchByObject(ctx, 'page', filter, token),
    },
  },
};
