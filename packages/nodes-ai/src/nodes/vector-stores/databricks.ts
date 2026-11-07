/**
 * Databricks Vector Store. Plain REST against the workspace's Vector Search API on `databricksOAuth2Api`,
 * no vendor SDK. The host is https only (`databricksHttpsHost`), so no token or query leaves over http.
 * The index info (`GET /indexes/{name}`) decides how a search is sent: an index that embeds text itself
 * (a Delta Sync index with a source column) gets `query_text`; any other index gets `query_vector`. Hybrid
 * search sends both. Insert writes rows to a Direct Access index.
 */
import { randomUUID } from 'node:crypto';
import type {
  AiDocument,
  BaseContext,
  DataObject,
  HttpFullResponse,
  HttpRequestOptions,
  ListSearchResult,
  LoadOptionsContext,
  NodeProperty,
} from '@workflow/workflow';
import { isResourceLocatorValue, NodeOperationError } from '@workflow/workflow';
import { databricksHttpsHost } from '../../shared/databricks';
import { errorMessage, redactSecrets } from '../../shared/utils';
import {
  createVectorStoreNode,
  DEFAULT_VECTOR_STORE_MODES,
  type VectorBackend,
} from './vector-store-factory';

const CREDENTIAL = 'databricksOAuth2Api';
/** `catalog.schema.index` */
const INDEX_NAME = /^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/;
const ENDPOINT_NAME = /^[A-Za-z0-9_-]{1,128}$/;
const COLUMN_NAME = /^[A-Za-z0-9_]{1,128}$/;
/** rows per upsert request */
const UPSERT_BATCH = 100;
/** indexes listed in the dropdown, over all endpoints */
const LIST_LIMIT = 200;

function locatorText(value: unknown): string {
  const raw = isResourceLocatorValue(value) ? value.value : value;
  return typeof raw === 'string' ? raw.trim() : '';
}

/** The workspace origin from the credential; the message never repeats the host. */
async function workspaceHost(ctx: BaseContext | LoadOptionsContext, itemIndex: number): Promise<string> {
  const credentials: DataObject = await ctx.getCredentials(CREDENTIAL, itemIndex);
  try {
    return databricksHttpsHost(typeof credentials.host === 'string' ? credentials.host : '');
  } catch (error) {
    throw new NodeOperationError(ctx.getNode(), errorMessage(error), { itemIndex });
  }
}

/** One Vector Search call. A redirect is an error, so the token never leaves the workspace. */
async function databricksCall(
  ctx: BaseContext | LoadOptionsContext,
  host: string,
  request: Pick<HttpRequestOptions, 'method' | 'body' | 'qs'> & { path: string },
  itemIndex: number,
): Promise<DataObject> {
  const node = ctx.getNode();
  let response: HttpFullResponse<unknown>;
  try {
    response = (await ctx.helpers.httpRequestWithAuthentication(
      CREDENTIAL,
      {
        url: `${host}${request.path}`,
        method: request.method ?? 'GET',
        headers: { accept: 'application/json' },
        ...(request.body !== undefined ? { body: request.body } : {}),
        ...(request.qs ? { qs: request.qs } : {}),
        followRedirects: false,
        ignoreHttpStatusErrors: true,
        returnFullResponse: true,
      },
      itemIndex,
    )) as HttpFullResponse<unknown>;
  } catch (error) {
    throw new NodeOperationError(node, `Databricks request failed: ${redactSecrets(errorMessage(error))}`, {
      itemIndex,
    });
  }
  const status = response.statusCode;
  if (status >= 300 && status < 400) {
    throw new NodeOperationError(
      node,
      `Databricks answered with a redirect (status ${status}); it was not followed`,
      { itemIndex },
    );
  }
  const body = response.body && typeof response.body === 'object' ? (response.body as DataObject) : {};
  if (status < 200 || status >= 300) {
    const detail = redactSecrets(
      typeof body.message === 'string'
        ? body.message
        : typeof response.body === 'string'
          ? response.body
          : '',
    ).slice(0, 300);
    throw new NodeOperationError(node, `Databricks request failed with status ${status}`, {
      itemIndex,
      description: detail,
    });
  }
  return body;
}

const list = (value: unknown): DataObject[] =>
  Array.isArray(value) ? value.filter((v): v is DataObject => !!v && typeof v === 'object') : [];

async function databricksIndexSearch(ctx: LoadOptionsContext, filter?: string): Promise<ListSearchResult> {
  const host = await workspaceHost(ctx, 0);
  const endpoints = list((await databricksCall(ctx, host, { path: '/api/2.0/vector-search/endpoints' }, 0)).endpoints)
    .map((e) => e.name)
    .filter((name): name is string => typeof name === 'string' && ENDPOINT_NAME.test(name));
  const needle = (filter ?? '').trim().toLowerCase();
  const names: string[] = [];
  for (const endpoint of endpoints) {
    const indexes = await databricksCall(
      ctx,
      host,
      { path: '/api/2.0/vector-search/indexes', qs: { endpoint_name: endpoint } },
      0,
    );
    for (const index of list(indexes.vector_indexes)) {
      if (typeof index.name === 'string' && INDEX_NAME.test(index.name)) names.push(index.name);
    }
    if (names.length >= LIST_LIMIT) break;
  }
  const found = names
    .filter((name) => !needle || name.toLowerCase().includes(needle))
    .sort((a, b) => a.localeCompare(b))
    .slice(0, LIST_LIMIT);
  return { results: found.map((name) => ({ name, value: name })) };
}

interface IndexInfo {
  primaryKey: string;
  /** the index embeds the text itself: search by `query_text` */
  managedEmbeddings: boolean;
  directAccess: boolean;
  vectorColumn: string;
}

function readIndexInfo(body: DataObject): IndexInfo {
  const spec = (value: unknown): DataObject =>
    value && typeof value === 'object' ? (value as DataObject) : ({} as DataObject);
  const delta = spec(body.delta_sync_index_spec);
  const direct = spec(body.direct_access_index_spec);
  const directAccess = body.index_type === 'DIRECT_ACCESS';
  const active = directAccess ? direct : delta;
  const source = list(active.embedding_source_columns);
  const vectors = list(active.embedding_vector_columns);
  const vectorName = vectors.find((v) => typeof v.name === 'string')?.name;
  return {
    primaryKey: typeof body.primary_key === 'string' ? body.primary_key : '',
    managedEmbeddings: source.length > 0,
    directAccess,
    vectorColumn: typeof vectorName === 'string' ? vectorName : '',
  };
}

function columnsOf(raw: unknown): string[] {
  return String(raw ?? '')
    .split(',')
    .map((c) => c.trim())
    .filter(Boolean);
}

const searchModeOption: NodeProperty = {
  displayName: 'Search Mode',
  name: 'searchMode',
  type: 'options',
  default: 'vector',
  description: 'Hybrid combines similarity search with keyword search on the prompt text',
  options: [
    { name: 'Vector', value: 'vector' },
    { name: 'Hybrid', value: 'hybrid' },
  ],
};

export const VectorStoreDatabricksNode = createVectorStoreNode({
  name: 'ai.vectorStoreDatabricks',
  displayName: 'Databricks Vector Store',
  description: 'Stores documents in a Databricks Vector Search index and searches them by similarity',
  icon: 'simple:databricks',
  credentials: [{ name: CREDENTIAL, required: true }],
  modes: DEFAULT_VECTOR_STORE_MODES,
  filter: 'json',
  properties: [
    {
      displayName: 'Index',
      name: 'databricksIndex',
      type: 'resourceLocator',
      default: { __rl: true, mode: 'list', value: '' },
      required: true,
      description: 'A Vector Search index, named catalog.schema.index',
      modes: [
        {
          displayName: 'From List',
          name: 'list',
          type: 'list',
          placeholder: 'Select an index...',
          typeOptions: { searchListMethod: 'databricksIndexSearch', searchable: true },
        },
        { displayName: 'By Name', name: 'id', type: 'string', placeholder: 'catalog.schema.index' },
      ],
    },
    {
      displayName: 'Content Column',
      name: 'contentColumn',
      type: 'string',
      default: 'text',
      required: true,
      description: 'The index column that holds the document text',
    },
    {
      displayName: 'Metadata Columns',
      name: 'metadataColumns',
      type: 'string',
      default: '',
      description:
        'Comma-separated index columns returned as the document metadata. Insert writes only these metadata keys',
    },
  ],
  retrieveOptions: [searchModeOption],
  methods: { listSearch: { databricksIndexSearch } },
  async open(ctx, itemIndex) {
    const node = ctx.getNode();
    const indexName = locatorText(ctx.getNodeParameter('databricksIndex', itemIndex, ''));
    if (!indexName) throw new NodeOperationError(node, 'Select a Databricks index', { itemIndex });
    if (!INDEX_NAME.test(indexName)) {
      throw new NodeOperationError(node, 'The index name must be catalog.schema.index', { itemIndex });
    }
    const contentColumn = String(ctx.getNodeParameter('contentColumn', itemIndex, 'text') ?? '').trim();
    const metadataColumns = columnsOf(ctx.getNodeParameter('metadataColumns', itemIndex, ''));
    for (const column of [contentColumn, ...metadataColumns]) {
      if (!COLUMN_NAME.test(column)) {
        throw new NodeOperationError(node, 'A column name may hold letters, digits and underscores only', {
          itemIndex,
          description: 'Check Content Column and Metadata Columns.',
        });
      }
    }
    const options = ctx.getNodeParameter('options', itemIndex, {}) as DataObject;
    const hybrid = options.searchMode === 'hybrid';

    const host = await workspaceHost(ctx, itemIndex);
    const base = `/api/2.0/vector-search/indexes/${encodeURIComponent(indexName)}`;
    const call = (
      path: string,
      request: Pick<HttpRequestOptions, 'method' | 'body'> = {},
    ): Promise<DataObject> => databricksCall(ctx, host, { ...request, path: `${base}${path}` }, itemIndex);

    let info: Promise<IndexInfo> | undefined;
    const indexInfo = (): Promise<IndexInfo> => {
      info ??= call('').then(readIndexInfo);
      return info;
    };

    const backend: VectorBackend = {
      async add(documents: AiDocument[], vectors: number[][]) {
        const index = await indexInfo();
        if (!index.directAccess || !index.vectorColumn || !index.primaryKey) {
          throw new NodeOperationError(node, 'Insert needs a Direct Access index with a vector column', {
            itemIndex,
            description:
              'A Delta Sync index is filled from its source table. Select a Direct Access index, or change the operation mode.',
          });
        }
        for (let start = 0; start < documents.length; start += UPSERT_BATCH) {
          const rows = documents.slice(start, start + UPSERT_BATCH).map((d, i) => {
            const row: DataObject = {};
            for (const column of metadataColumns) {
              const value = d.metadata?.[column];
              if (value !== undefined) row[column] = value;
            }
            row[index.primaryKey] = randomUUID();
            row[contentColumn] = d.pageContent;
            row[index.vectorColumn] = vectors[start + i];
            return row;
          });
          const reply = await call('/upsert-data', {
            method: 'POST',
            body: { inputs_json: JSON.stringify(rows) },
          });
          if (reply.status !== undefined && reply.status !== 'SUCCESS') {
            throw new NodeOperationError(node, 'Databricks did not write all rows', {
              itemIndex,
              description: redactSecrets(JSON.stringify(reply.result ?? reply)).slice(0, 300),
            });
          }
        }
      },
      async search(vector, k, filter, text) {
        const index = await indexInfo();
        const query = text?.trim() ?? '';
        if ((index.managedEmbeddings || hybrid) && !query) {
          throw new NodeOperationError(node, 'This search needs the prompt text', { itemIndex });
        }
        const columns = [contentColumn, ...metadataColumns];
        const reply = await call('/query', {
          method: 'POST',
          body: {
            columns,
            // a managed-embedding index embeds the text itself; hybrid also needs the text for keywords
            ...(index.managedEmbeddings ? { query_text: query } : { query_vector: vector }),
            ...(hybrid && !index.managedEmbeddings ? { query_text: query } : {}),
            query_type: hybrid ? 'HYBRID' : 'ANN',
            num_results: Math.max(1, Math.min(k, 1000)),
            ...(filter && Object.keys(filter).length ? { filters_json: JSON.stringify(filter) } : {}),
          },
        });
        const manifest = (reply.manifest ?? {}) as DataObject;
        const names = list(manifest.columns).map((c) => String(c.name ?? ''));
        const result = (reply.result ?? {}) as DataObject;
        const rows = Array.isArray(result.data_array) ? (result.data_array as unknown[][]) : [];
        const at = (name: string) => names.indexOf(name);
        if (rows.length && at(contentColumn) < 0) {
          throw new NodeOperationError(node, `The index has no column ${contentColumn}`, {
            itemIndex,
            description: 'Check Content Column.',
          });
        }
        const scoreAt = names.includes('score') ? at('score') : names.length - 1;
        return rows.map((row) => {
          const metadata: DataObject = {};
          for (const column of metadataColumns) {
            if (at(column) >= 0 && row[at(column)] !== null) metadata[column] = row[at(column)] as never;
          }
          const content = row[at(contentColumn)];
          return {
            document: { pageContent: typeof content === 'string' ? content : '', metadata },
            score: Number(row[scoreAt] ?? 0),
          };
        });
      },
    };
    return { backend };
  },
});
