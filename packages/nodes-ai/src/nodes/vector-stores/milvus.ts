/**
 * Milvus Vector Store. Plain REST against the v2 API (`/v2/vectordb/...`), no vendor SDK (the SDK speaks
 * gRPC). Every call goes through `httpRequestWithAuthentication`, so the credential's allowed domains and
 * the SSRF guard apply; the credential adds `Bearer user:pass` when a user or password is set.
 * The collection is created from the first insert (auto id, cosine metric, dynamic fields); a document is
 * a row `{ vector, text, metadata }`.
 */
import type {
  AiDocument,
  BaseContext,
  DataObject,
  HttpFullResponse,
  ListSearchResult,
  LoadOptionsContext,
  NodeProperty,
} from '@workflow/workflow';
import { isResourceLocatorValue, NodeOperationError } from '@workflow/workflow';
import { trimSlash } from '../../shared/chat-model';
import { errorMessage, redactSecrets } from '../../shared/utils';
import {
  clearStoreOption,
  createVectorStoreNode,
  DEFAULT_VECTOR_STORE_MODES,
  type VectorBackend,
} from './vector-store-factory';

const CREDENTIAL = 'milvusApi';
/** Milvus collection names: a letter or underscore first, then letters, digits and underscores */
const COLLECTION_NAME = /^[A-Za-z_][A-Za-z0-9_]{0,254}$/;
/** rows per insert request */
const INSERT_BATCH = 500;
const VECTOR_FIELD = 'vector';
const TEXT_FIELD = 'text';
const METADATA_FIELD = 'metadata';
const PRIMARY_FIELD = 'id';

function locatorText(value: unknown): string {
  const raw = isResourceLocatorValue(value) ? value.value : value;
  return typeof raw === 'string' ? raw.trim() : '';
}

/** The base URL of the Milvus server, without a trailing slash; the query and hash are refused. */
function baseUrlOf(ctx: BaseContext | LoadOptionsContext, credentials: DataObject, itemIndex: number): string {
  const text = typeof credentials.baseUrl === 'string' ? credentials.baseUrl.trim() : '';
  let url: URL | undefined;
  try {
    url = new URL(text);
  } catch {
    url = undefined;
  }
  if (!url || !/^https?:$/.test(url.protocol) || url.username || url.password || url.search || url.hash) {
    throw new NodeOperationError(ctx.getNode(), 'Enter the Milvus Base URL as an http or https address', {
      itemIndex,
      description: 'It must not hold a user name, a password, a query or a fragment.',
    });
  }
  return trimSlash(text);
}

/** One REST call. Milvus answers 200 with `{ code, message }`; a non-zero code is the error. */
async function milvusCall(
  ctx: BaseContext | LoadOptionsContext,
  base: string,
  path: string,
  body: DataObject,
  itemIndex: number,
): Promise<DataObject> {
  const node = ctx.getNode();
  let response: HttpFullResponse<unknown>;
  try {
    response = (await ctx.helpers.httpRequestWithAuthentication(
      CREDENTIAL,
      {
        url: `${base}${path}`,
        method: 'POST',
        headers: { accept: 'application/json', 'content-type': 'application/json' },
        body,
        followRedirects: false,
        ignoreHttpStatusErrors: true,
        returnFullResponse: true,
      },
      itemIndex,
    )) as HttpFullResponse<unknown>;
  } catch (error) {
    throw new NodeOperationError(node, `Milvus request failed: ${redactSecrets(errorMessage(error))}`, {
      itemIndex,
    });
  }
  const status = response.statusCode;
  if (status >= 300 && status < 400) {
    throw new NodeOperationError(node, `Milvus answered with a redirect (status ${status}); it was not followed`, {
      itemIndex,
    });
  }
  const parsed =
    response.body && typeof response.body === 'object' ? (response.body as DataObject) : ({} as DataObject);
  const code = typeof parsed.code === 'number' ? parsed.code : 0;
  if (status < 200 || status >= 300 || code !== 0) {
    const detail = redactSecrets(
      typeof parsed.message === 'string'
        ? parsed.message
        : typeof response.body === 'string'
          ? response.body
          : '',
    ).slice(0, 300);
    throw new NodeOperationError(
      node,
      `Milvus request failed with ${code !== 0 ? `code ${code}` : `status ${status}`}`,
      { itemIndex, description: detail },
    );
  }
  return parsed;
}

async function listCollections(
  ctx: BaseContext | LoadOptionsContext,
  base: string,
  itemIndex: number,
): Promise<string[]> {
  const reply = await milvusCall(ctx, base, '/v2/vectordb/collections/list', {}, itemIndex);
  return Array.isArray(reply.data) ? reply.data.filter((n): n is string => typeof n === 'string') : [];
}

async function milvusCollectionSearch(ctx: LoadOptionsContext, filter?: string): Promise<ListSearchResult> {
  const credentials: DataObject = await ctx.getCredentials(CREDENTIAL, 0);
  const base = baseUrlOf(ctx, credentials, 0);
  const needle = (filter ?? '').trim().toLowerCase();
  const names = (await listCollections(ctx, base, 0))
    .filter((name) => !needle || name.toLowerCase().includes(needle))
    .sort((a, b) => a.localeCompare(b));
  return { results: names.map((name) => ({ name, value: name })) };
}

const clearCollectionOption: NodeProperty = {
  ...clearStoreOption,
  displayName: 'Clear Collection',
  description: 'Whether to delete the collection before inserting; it is created again from the first document',
};

export const VectorStoreMilvusNode = createVectorStoreNode({
  name: 'ai.vectorStoreMilvus',
  displayName: 'Milvus Vector Store',
  description: 'Stores documents in a Milvus collection and searches them by similarity',
  icon: 'simple:milvus',
  credentials: [{ name: CREDENTIAL, required: true }],
  modes: DEFAULT_VECTOR_STORE_MODES,
  filter: 'none',
  properties: [
    {
      displayName: 'Milvus Collection',
      name: 'milvusCollection',
      type: 'resourceLocator',
      default: { __rl: true, mode: 'list', value: '' },
      required: true,
      description: 'Insert creates the collection when it does not exist; the other modes need it',
      modes: [
        {
          displayName: 'From List',
          name: 'list',
          type: 'list',
          placeholder: 'Select a collection...',
          typeOptions: { searchListMethod: 'milvusCollectionSearch', searchable: true },
        },
        { displayName: 'By Name', name: 'id', type: 'string', placeholder: 'Collection name' },
      ],
    },
  ],
  insertOptions: [clearCollectionOption],
  methods: { listSearch: { milvusCollectionSearch } },
  async open(ctx, itemIndex) {
    const node = ctx.getNode();
    const collection = locatorText(ctx.getNodeParameter('milvusCollection', itemIndex, ''));
    if (!collection) throw new NodeOperationError(node, 'Select a Milvus collection', { itemIndex });
    if (!COLLECTION_NAME.test(collection)) {
      throw new NodeOperationError(node, 'The collection name is not valid for Milvus', {
        itemIndex,
        description: 'Use letters, digits and underscores, starting with a letter or an underscore.',
      });
    }
    const credentials: DataObject = await ctx.getCredentials(CREDENTIAL, itemIndex);
    const base = baseUrlOf(ctx, credentials, itemIndex);
    const call = (path: string, body: DataObject) => milvusCall(ctx, base, path, body, itemIndex);
    let known: boolean | undefined;
    const exists = async (): Promise<boolean> => {
      known ??= (await listCollections(ctx, base, itemIndex)).includes(collection);
      return known;
    };

    const backend: VectorBackend = {
      async add(documents: AiDocument[], vectors: number[][]) {
        if (!documents.length) return;
        if (!(await exists())) {
          await call('/v2/vectordb/collections/create', {
            collectionName: collection,
            dimension: vectors[0].length,
            metricType: 'COSINE',
            idType: 'Int64',
            autoID: true,
            primaryFieldName: PRIMARY_FIELD,
            vectorFieldName: VECTOR_FIELD,
            enableDynamicField: true,
          });
          known = true;
        }
        for (let start = 0; start < documents.length; start += INSERT_BATCH) {
          const data = documents.slice(start, start + INSERT_BATCH).map((d, i) => ({
            [VECTOR_FIELD]: vectors[start + i],
            [TEXT_FIELD]: d.pageContent,
            [METADATA_FIELD]: d.metadata ?? {},
          }));
          await call('/v2/vectordb/entities/insert', { collectionName: collection, data });
        }
      },
      async search(vector, k) {
        if (!(await exists())) {
          throw new NodeOperationError(node, `Collection ${collection} not found`, {
            itemIndex,
            description: 'Please check that the collection exists in your vector store',
          });
        }
        const reply = await call('/v2/vectordb/entities/search', {
          collectionName: collection,
          data: [vector],
          annsField: VECTOR_FIELD,
          limit: Math.max(1, Math.min(k, 1000)),
          outputFields: [TEXT_FIELD, METADATA_FIELD],
        });
        const rows = Array.isArray(reply.data) ? (reply.data as DataObject[]) : [];
        return rows.map((row) => {
          const metadata = row[METADATA_FIELD];
          return {
            document: {
              pageContent: typeof row[TEXT_FIELD] === 'string' ? row[TEXT_FIELD] : '',
              metadata:
                metadata && typeof metadata === 'object' && !Array.isArray(metadata)
                  ? (metadata as DataObject)
                  : {},
            },
            // the collection uses the cosine metric, where a larger distance is a closer match
            score: Number(row.distance ?? 0),
          };
        });
      },
      async clear() {
        if (!(await exists())) return;
        await call('/v2/vectordb/collections/drop', { collectionName: collection });
        known = false;
      },
    };
    return { backend };
  },
});
