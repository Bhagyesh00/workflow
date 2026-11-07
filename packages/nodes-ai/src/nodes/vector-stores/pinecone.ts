/**
 * Pinecone Vector Store. Plain REST, no vendor SDK: the control plane lists the indexes (name to host),
 * the data plane upserts, queries and deletes. Every call goes through the credential helper, so the
 * credential's allowed domains and the SSRF guard apply.
 */
import { randomUUID } from 'node:crypto';
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
import { errorMessage, redactSecrets } from '../../shared/utils';
import {
  clearStoreOption,
  createVectorStoreNode,
  DEFAULT_VECTOR_STORE_MODES,
  type VectorBackend,
} from './vector-store-factory';

const CONTROL_PLANE = 'https://api.pinecone.io';
const API_VERSION = '2025-10';
const PINECONE_HOST = /(^|\.)pinecone\.io$/;
/** vectors per upsert request */
const UPSERT_BATCH = 100;
/** metadata key that holds the text of a document */
const TEXT_KEY = 'text';

const pineconeHeaders = { 'X-Pinecone-Api-Version': API_VERSION, accept: 'application/json' };

function locatorText(value: unknown): string {
  const raw = isResourceLocatorValue(value) ? value.value : value;
  return typeof raw === 'string' ? raw.trim() : '';
}

/**
 * Pinecone metadata holds strings, numbers, booleans and lists of strings. Nested objects become dotted
 * keys, a list of strings stays, any other list is written as JSON text, null is dropped.
 */
export function flattenMetadata(metadata: DataObject | undefined): DataObject {
  const out: DataObject = {};
  const visit = (value: unknown, path: string): void => {
    if (value === null || value === undefined) return;
    if (typeof value === 'string' || typeof value === 'boolean') {
      out[path] = value;
    } else if (typeof value === 'number') {
      out[path] = Number.isFinite(value) ? value : String(value);
    } else if (Array.isArray(value)) {
      out[path] = value.every((v) => typeof v === 'string') ? (value as string[]) : JSON.stringify(value);
    } else if (typeof value === 'object') {
      for (const [key, inner] of Object.entries(value as DataObject)) {
        visit(inner, path ? `${path}.${key}` : key);
      }
    } else {
      out[path] = String(value);
    }
  };
  for (const [key, value] of Object.entries(metadata ?? {})) visit(value, key);
  return out;
}

/**
 * The index host comes from the server and `Api-Key` is sent to it, so it must be https on a
 * pinecone.io host, with no credentials, port or path.
 */
function dataPlaneBase(ctx: BaseContext, rawHost: unknown, itemIndex: number): string {
  const refuse = (): never => {
    throw new NodeOperationError(ctx.getNode(), 'The index host returned by Pinecone is not accepted', {
      itemIndex,
      description: 'It must be an https address on pinecone.io. No request was sent to it.',
    });
  };
  if (typeof rawHost !== 'string' || !rawHost.trim()) return refuse();
  const text = rawHost.trim();
  let url: URL;
  try {
    url = new URL(/^[a-z][a-z0-9+.-]*:\/\//i.test(text) ? text : `https://${text}`);
  } catch {
    return refuse();
  }
  const bare = !url.username && !url.password && !url.port && (url.pathname === '/' || url.pathname === '');
  if (url.protocol !== 'https:' || !PINECONE_HOST.test(url.hostname) || !bare || url.search || url.hash) {
    return refuse();
  }
  return `https://${url.hostname}`;
}

async function listIndexes(
  ctx: BaseContext | LoadOptionsContext,
  itemIndex: number,
): Promise<Array<{ name: string; host: unknown }>> {
  const response = (await ctx.helpers.httpRequestWithAuthentication(
    'pineconeApi',
    { url: `${CONTROL_PLANE}/indexes`, headers: pineconeHeaders, followRedirects: false },
    itemIndex,
  )) as { indexes?: Array<{ name?: unknown; host?: unknown }> };
  return (response?.indexes ?? [])
    .filter((i) => typeof i.name === 'string' && i.name)
    .map((i) => ({ name: String(i.name), host: i.host }));
}

async function pineconeIndexSearch(ctx: LoadOptionsContext, filter?: string): Promise<ListSearchResult> {
  const needle = (filter ?? '').trim().toLowerCase();
  const names = (await listIndexes(ctx, 0))
    .map((i) => i.name)
    .filter((name) => !needle || name.toLowerCase().includes(needle))
    .sort((a, b) => a.localeCompare(b));
  return { results: names.map((name) => ({ name, value: name })) };
}

const namespaceOption: NodeProperty = {
  displayName: 'Pinecone Namespace',
  name: 'pineconeNamespace',
  type: 'string',
  default: '',
  description: 'Partition of the index to use; the default namespace when empty',
};

const clearNamespaceOption: NodeProperty = {
  ...clearStoreOption,
  displayName: 'Clear Namespace',
  description:
    'Whether to delete all vectors in the namespace before inserting; only acts when a namespace is set',
};

export const VectorStorePineconeNode = createVectorStoreNode({
  name: 'ai.vectorStorePinecone',
  displayName: 'Pinecone Vector Store',
  description: 'Stores documents in a Pinecone index and searches them by similarity',
  icon: 'simple:pinecone',
  credentials: [{ name: 'pineconeApi', required: true }],
  modes: [...DEFAULT_VECTOR_STORE_MODES, 'update'],
  filter: 'metadata',
  properties: [
    {
      displayName: 'Pinecone Index',
      name: 'pineconeIndex',
      type: 'resourceLocator',
      default: { __rl: true, mode: 'list', value: '' },
      required: true,
      description: 'The index must exist; this node never creates one',
      modes: [
        {
          displayName: 'From List',
          name: 'list',
          type: 'list',
          placeholder: 'Select an index...',
          typeOptions: { searchListMethod: 'pineconeIndexSearch', searchable: true },
        },
        { displayName: 'By Name', name: 'id', type: 'string', placeholder: 'Index name' },
      ],
    },
  ],
  insertOptions: [namespaceOption, clearNamespaceOption],
  retrieveOptions: [namespaceOption],
  methods: { listSearch: { pineconeIndexSearch } },
  async open(ctx, itemIndex) {
    const indexName = locatorText(ctx.getNodeParameter('pineconeIndex', itemIndex, ''));
    if (!indexName) {
      throw new NodeOperationError(ctx.getNode(), 'Select a Pinecone index', { itemIndex });
    }
    const options = ctx.getNodeParameter('options', itemIndex, {}) as DataObject;
    const namespace = typeof options.pineconeNamespace === 'string' ? options.pineconeNamespace.trim() : '';

    const found = (await listIndexes(ctx, itemIndex)).find((i) => i.name === indexName);
    if (!found) {
      throw new NodeOperationError(ctx.getNode(), `Index ${indexName} not found`, {
        itemIndex,
        description: 'Please check that the index exists in your vector store',
      });
    }
    const base = dataPlaneBase(ctx, found.host, itemIndex);

    /** One data-plane call. A redirect is an error, so the key never leaves the host. */
    const call = async (path: string, body: DataObject, tolerate404 = false): Promise<DataObject> => {
      let response: HttpFullResponse<unknown>;
      try {
        response = (await ctx.helpers.httpRequestWithAuthentication(
          'pineconeApi',
          {
            url: `${base}${path}`,
            method: 'POST',
            headers: pineconeHeaders,
            body,
            followRedirects: false,
            ignoreHttpStatusErrors: true,
            returnFullResponse: true,
          },
          itemIndex,
        )) as HttpFullResponse<unknown>;
      } catch (error) {
        throw new NodeOperationError(
          ctx.getNode(),
          `Pinecone request failed: ${redactSecrets(errorMessage(error))}`,
          { itemIndex },
        );
      }
      const status = response.statusCode;
      if (status >= 300 && status < 400) {
        throw new NodeOperationError(
          ctx.getNode(),
          `Pinecone answered with a redirect (status ${status}); it was not followed`,
          { itemIndex },
        );
      }
      if (status === 404 && tolerate404) return {};
      if (status < 200 || status >= 300) {
        const detail = redactSecrets(
          typeof response.body === 'string' ? response.body : JSON.stringify(response.body ?? ''),
        ).slice(0, 300);
        throw new NodeOperationError(ctx.getNode(), `Pinecone request failed with status ${status}`, {
          itemIndex,
          description: detail,
        });
      }
      return response.body && typeof response.body === 'object' ? (response.body as DataObject) : {};
    };

    const backend: VectorBackend = {
      async add(documents: AiDocument[], vectors: number[][], ids?: string[]) {
        for (let start = 0; start < documents.length; start += UPSERT_BATCH) {
          const batch = documents.slice(start, start + UPSERT_BATCH).map((d, i) => ({
            id: ids?.[start + i] ?? randomUUID(),
            values: vectors[start + i],
            metadata: { ...flattenMetadata(d.metadata), [TEXT_KEY]: d.pageContent },
          }));
          await call('/vectors/upsert', { vectors: batch, ...(namespace ? { namespace } : {}) });
        }
      },
      async search(vector, k, filter) {
        const flat = filter ? flattenMetadata(filter) : undefined;
        const pineconeFilter =
          flat && Object.keys(flat).length
            ? Object.fromEntries(Object.entries(flat).map(([key, value]) => [key, { $eq: value }]))
            : undefined;
        const body = await call('/query', {
          vector,
          topK: Math.max(1, Math.min(k, 10_000)),
          includeMetadata: true,
          ...(namespace ? { namespace } : {}),
          ...(pineconeFilter ? { filter: pineconeFilter } : {}),
        });
        const matches = Array.isArray(body.matches) ? (body.matches as DataObject[]) : [];
        return matches.map((m) => {
          const { [TEXT_KEY]: text, ...metadata } = (m.metadata ?? {}) as DataObject;
          return {
            document: { pageContent: typeof text === 'string' ? text : '', metadata },
            score: Number(m.score ?? 0),
          };
        });
      },
      async clear() {
        // the default namespace is never wiped by this option
        if (!namespace) return;
        await call('/vectors/delete', { deleteAll: true, namespace }, true);
      },
    };
    return { backend };
  },
});
