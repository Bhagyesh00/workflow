/**
 * Chroma Vector Store, v2 REST API, self-hosted or Chroma Cloud (the Authentication parameter picks the
 * credential). No vendor SDK: the collection name is looked up to its id, then documents are upserted
 * and queried by id. Every call goes through the credential helper, so the credential's allowed
 * domains and the SSRF guard apply and the key or token is added after the request is built.
 */
import { randomUUID } from 'node:crypto';
import type {
  AiDocument,
  BaseContext,
  DataObject,
  HttpFullResponse,
  ListSearchResult,
  LoadOptionsContext,
} from '@workflow/workflow';
import { isResourceLocatorValue, NodeOperationError } from '@workflow/workflow';
import { errorMessage, redactSecrets } from '../../shared/utils';
import {
  clearStoreOption,
  createVectorStoreNode,
  DEFAULT_VECTOR_STORE_MODES,
  type VectorBackend,
} from './vector-store-factory';

type ChromaCredential = 'chromaSelfHostedApi' | 'chromaCloudApi';
interface Scope {
  credential: ChromaCredential;
  base: string;
  tenant: string;
  database: string;
}

const UPSERT_BATCH = 100;
const COLLECTION_PAGE = 100;

function credentialOf(value: unknown): ChromaCredential {
  return value === 'chromaCloudApi' ? 'chromaCloudApi' : 'chromaSelfHostedApi';
}

function locatorText(value: unknown): string {
  const raw = isResourceLocatorValue(value) ? value.value : value;
  return typeof raw === 'string' ? raw.trim() : '';
}

/** Chroma metadata holds strings, numbers and booleans: nested objects become dotted keys, lists JSON text. */
function flatten(metadata: DataObject | undefined): DataObject {
  const out: DataObject = {};
  const visit = (value: unknown, path: string): void => {
    if (value === null || value === undefined) return;
    if (typeof value === 'string' || typeof value === 'boolean') out[path] = value;
    else if (typeof value === 'number') out[path] = Number.isFinite(value) ? value : String(value);
    else if (Array.isArray(value)) out[path] = JSON.stringify(value);
    else if (typeof value === 'object') {
      for (const [key, inner] of Object.entries(value as DataObject)) {
        visit(inner, path ? `${path}.${key}` : key);
      }
    } else out[path] = String(value);
  };
  for (const [key, value] of Object.entries(metadata ?? {})) visit(value, key);
  return out;
}

/** metadata filter as Chroma's `where`: one key matches directly, several are joined with `$and` */
function whereOf(filter: DataObject | undefined): DataObject | undefined {
  const flat = filter ? flatten(filter) : undefined;
  const entries = flat ? Object.entries(flat) : [];
  if (!entries.length) return undefined;
  const clauses = entries.map(([key, value]) => ({ [key]: { $eq: value } }));
  return clauses.length === 1 ? clauses[0] : { $and: clauses };
}

/** Root of the server: no credentials, no query; a trailing slash is dropped. Cloud must be https. */
function baseOf(
  ctx: BaseContext | LoadOptionsContext,
  raw: unknown,
  cloud: boolean,
  itemIndex: number,
): string {
  let url: URL;
  try {
    url = new URL(String(raw ?? '').trim());
  } catch {
    throw new NodeOperationError(ctx.getNode(), 'The Chroma base URL is not a valid URL', { itemIndex });
  }
  const protocolOk = cloud
    ? url.protocol === 'https:'
    : url.protocol === 'https:' || url.protocol === 'http:';
  if (!protocolOk || url.username || url.password || url.search || url.hash) {
    throw new NodeOperationError(
      ctx.getNode(),
      cloud
        ? 'The Chroma Cloud base URL must be an https address without credentials'
        : 'The Chroma base URL must be an http or https address without credentials',
      { itemIndex },
    );
  }
  return `${url.origin}${url.pathname.replace(/\/+$/, '')}`;
}

async function chromaRequest(
  ctx: BaseContext | LoadOptionsContext,
  credential: ChromaCredential,
  itemIndex: number,
  method: 'GET' | 'POST' | 'DELETE',
  url: string,
  body?: DataObject,
  tolerate404 = false,
): Promise<DataObject | DataObject[] | undefined> {
  let response: HttpFullResponse<unknown>;
  try {
    response = (await ctx.helpers.httpRequestWithAuthentication(
      credential,
      {
        url,
        method,
        headers: { accept: 'application/json' },
        ...(body ? { body } : {}),
        followRedirects: false,
        ignoreHttpStatusErrors: true,
        returnFullResponse: true,
      },
      itemIndex,
    )) as HttpFullResponse<unknown>;
  } catch (error) {
    throw new NodeOperationError(
      ctx.getNode(),
      `Chroma request failed: ${redactSecrets(errorMessage(error))}`,
      { itemIndex },
    );
  }
  const status = response.statusCode;
  if (status >= 300 && status < 400) {
    throw new NodeOperationError(
      ctx.getNode(),
      `Chroma answered with a redirect (status ${status}); it was not followed`,
      { itemIndex },
    );
  }
  if (status === 404 && tolerate404) return undefined;
  if (status < 200 || status >= 300) {
    const detail = redactSecrets(
      typeof response.body === 'string' ? response.body : JSON.stringify(response.body ?? ''),
    ).slice(0, 300);
    throw new NodeOperationError(ctx.getNode(), `Chroma request failed with status ${status}`, {
      itemIndex,
      description: detail,
    });
  }
  return response.body !== null && typeof response.body === 'object'
    ? (response.body as DataObject | DataObject[])
    : {};
}

/** Tenant and database: self-hosted uses Chroma's defaults, Cloud takes the credential or asks `auth/identity`. */
async function resolveScope(
  ctx: BaseContext | LoadOptionsContext,
  authentication: unknown,
  itemIndex: number,
): Promise<Scope> {
  const credential = credentialOf(authentication);
  const creds = await ctx.getCredentials(credential, itemIndex);
  const base = baseOf(ctx, creds.baseUrl, credential === 'chromaCloudApi', itemIndex);
  if (credential === 'chromaSelfHostedApi') {
    return { credential, base, tenant: 'default_tenant', database: 'default_database' };
  }
  let tenant = typeof creds.tenant === 'string' ? creds.tenant.trim() : '';
  let database = typeof creds.database === 'string' ? creds.database.trim() : '';
  if (!tenant || !database) {
    const identity = ((await chromaRequest(
      ctx,
      credential,
      itemIndex,
      'GET',
      `${base}/api/v2/auth/identity`,
    )) ?? {}) as DataObject;
    const databases = Array.isArray(identity.databases) ? identity.databases.map(String) : [];
    tenant = tenant || String(identity.tenant ?? '');
    database = database || (databases.length === 1 ? databases[0] : '');
    if (!tenant || !database) {
      throw new NodeOperationError(
        ctx.getNode(),
        'Set the tenant and database in the Chroma Cloud credential',
        {
          itemIndex,
          description: 'They could not be found from the API key.',
        },
      );
    }
  }
  return { credential, base, tenant, database };
}

const collectionsUrl = (scope: Scope): string =>
  `${scope.base}/api/v2/tenants/${encodeURIComponent(scope.tenant)}/databases/${encodeURIComponent(scope.database)}/collections`;

async function chromaCollectionSearch(ctx: LoadOptionsContext, filter?: string): Promise<ListSearchResult> {
  const scope = await resolveScope(ctx, ctx.getCurrentNodeParameter('authentication'), 0);
  const needle = (filter ?? '').trim().toLowerCase();
  const names: string[] = [];
  for (let offset = 0; offset < 10_000; offset += COLLECTION_PAGE) {
    const page = await chromaRequest(
      ctx,
      scope.credential,
      0,
      'GET',
      `${collectionsUrl(scope)}?limit=${COLLECTION_PAGE}&offset=${offset}`,
    );
    const rows = Array.isArray(page) ? page : [];
    for (const row of rows) if (typeof row.name === 'string' && row.name) names.push(row.name);
    if (rows.length < COLLECTION_PAGE) break;
  }
  return {
    results: names
      .filter((n) => !needle || n.toLowerCase().includes(needle))
      .sort((a, b) => a.localeCompare(b))
      .map((name) => ({ name, value: name })),
  };
}

export const VectorStoreChromaDBNode = createVectorStoreNode({
  name: 'ai.vectorStoreChromaDB',
  displayName: 'Chroma Vector Store',
  description: 'Stores documents in a Chroma collection, self-hosted or in Chroma Cloud',
  icon: 'simple:chroma',
  credentials: [
    {
      name: 'chromaSelfHostedApi',
      required: true,
      displayOptions: { show: { authentication: ['chromaSelfHostedApi'] } },
    },
    {
      name: 'chromaCloudApi',
      required: true,
      displayOptions: { show: { authentication: ['chromaCloudApi'] } },
    },
  ],
  modes: DEFAULT_VECTOR_STORE_MODES,
  filter: 'metadata',
  properties: [
    {
      displayName: 'Authentication',
      name: 'authentication',
      type: 'options',
      default: 'chromaSelfHostedApi',
      noDataExpression: true,
      options: [
        { name: 'Self-Hosted', value: 'chromaSelfHostedApi' },
        { name: 'Chroma Cloud', value: 'chromaCloudApi' },
      ],
    },
    {
      displayName: 'Chroma Collection',
      name: 'chromaCollection',
      type: 'resourceLocator',
      default: { __rl: true, mode: 'list', value: '' },
      required: true,
      description: 'Created on insert when it does not exist',
      modes: [
        {
          displayName: 'From List',
          name: 'list',
          type: 'list',
          placeholder: 'Select a collection...',
          typeOptions: { searchListMethod: 'chromaCollectionSearch', searchable: true },
        },
        { displayName: 'By Name', name: 'id', type: 'string', placeholder: 'Collection name' },
      ],
    },
  ],
  insertOptions: [
    {
      ...clearStoreOption,
      displayName: 'Clear Collection',
      description: 'Whether to delete all documents in the collection before inserting',
    },
  ],
  methods: { listSearch: { chromaCollectionSearch } },
  async open(ctx, itemIndex) {
    const name = locatorText(ctx.getNodeParameter('chromaCollection', itemIndex, ''));
    if (!name) throw new NodeOperationError(ctx.getNode(), 'Select a Chroma collection', { itemIndex });
    const scope = await resolveScope(ctx, ctx.getNodeParameter('authentication', itemIndex, ''), itemIndex);
    const call = async (
      method: 'GET' | 'POST' | 'DELETE',
      url: string,
      body?: DataObject,
      tolerate404 = false,
    ): Promise<DataObject | undefined> =>
      (await chromaRequest(ctx, scope.credential, itemIndex, method, url, body, tolerate404)) as
        | DataObject
        | undefined;
    const byName = `${collectionsUrl(scope)}/${encodeURIComponent(name)}`;

    let collection: { id: string; space: string } | undefined;
    const describe = (row: DataObject): { id: string; space: string } => {
      const config = (row.configuration_json ?? {}) as DataObject;
      const hnsw = (config.hnsw ?? {}) as DataObject;
      const meta = (row.metadata ?? {}) as DataObject;
      return { id: String(row.id), space: String(hnsw.space ?? meta['hnsw:space'] ?? 'l2') };
    };
    /** name to id; the collection is created (cosine space) when `createMissing` */
    const resolve = async (createMissing: boolean): Promise<{ id: string; space: string }> => {
      if (collection) return collection;
      const row = await call('GET', byName, undefined, true);
      if (row) {
        collection = describe(row);
      } else if (createMissing) {
        const created = await call('POST', collectionsUrl(scope), {
          name,
          get_or_create: true,
          configuration: { hnsw: { space: 'cosine' } },
        });
        collection = describe(created ?? {});
      } else {
        throw new NodeOperationError(ctx.getNode(), `Collection ${name} not found`, {
          itemIndex,
          description: 'Insert documents first, or check the collection name',
        });
      }
      return collection;
    };

    const backend: VectorBackend = {
      async add(documents: AiDocument[], vectors: number[][], ids?: string[]) {
        const { id } = await resolve(true);
        for (let start = 0; start < documents.length; start += UPSERT_BATCH) {
          const batch = documents.slice(start, start + UPSERT_BATCH);
          await call('POST', `${collectionsUrl(scope)}/${encodeURIComponent(id)}/upsert`, {
            ids: batch.map((_, i) => ids?.[start + i] ?? randomUUID()),
            embeddings: vectors.slice(start, start + UPSERT_BATCH),
            documents: batch.map((d) => d.pageContent),
            metadatas: batch.map((d) => {
              const flat = flatten(d.metadata);
              return Object.keys(flat).length ? flat : null;
            }),
          });
        }
      },
      async search(vector, k, filter) {
        const { id, space } = await resolve(false);
        const where = whereOf(filter);
        const body =
          (await call('POST', `${collectionsUrl(scope)}/${encodeURIComponent(id)}/query`, {
            query_embeddings: [vector],
            n_results: Math.max(1, Math.min(k, 1000)),
            include: ['documents', 'metadatas', 'distances'],
            ...(where ? { where } : {}),
          })) ?? {};
        const first = (key: string): unknown[] => {
          const outer = body[key];
          return Array.isArray(outer) && Array.isArray(outer[0]) ? (outer[0] as unknown[]) : [];
        };
        const documents = first('documents');
        const metadatas = first('metadatas');
        const distances = first('distances');
        return documents.map((text, i) => {
          const distance = Number(distances[i] ?? 0);
          return {
            document: {
              pageContent: typeof text === 'string' ? text : '',
              metadata: (metadatas[i] ?? {}) as DataObject,
            },
            // cosine and inner product: 1 - distance; squared L2: 1 / (1 + distance)
            score: space === 'l2' ? 1 / (1 + distance) : 1 - distance,
          };
        });
      },
      async clear() {
        await call('DELETE', byName, undefined, true);
        collection = undefined;
        await resolve(true);
      },
    };
    return { backend };
  },
});
