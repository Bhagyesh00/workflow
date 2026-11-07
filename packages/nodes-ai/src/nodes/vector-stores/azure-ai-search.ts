/**
 * Azure AI Search Vector Store. Plain REST against the search service (no vendor SDK): the index is
 * created from the first inserted document, documents are written with `mergeOrUpload`, and a search
 * is a vector, hybrid (vector plus text) or semantic hybrid query. Every call goes through the
 * credential helper, so the credential's allowed domains and the SSRF guard apply and the `api-key`
 * header is added after the request is built.
 */
import { randomUUID } from 'node:crypto';
import type { AiDocument, BaseContext, DataObject, HttpFullResponse, NodeProperty } from '@workflow/workflow';
import { NodeOperationError } from '@workflow/workflow';
import { errorMessage, redactSecrets } from '../../shared/utils';
import {
  clearStoreOption,
  createVectorStoreNode,
  DEFAULT_VECTOR_STORE_MODES,
  type ScoredDocument,
  type VectorBackend,
} from './vector-store-factory';

const API_VERSION = '2024-07-01';
const INDEX_NAME = /^[a-z0-9][a-z0-9-]{0,127}$/;
const FIELD_NAME = /^[A-Za-z][A-Za-z0-9_]{0,127}$/;
const RESERVED_FIELDS = new Set(['id', 'content', 'content_vector', 'metadata']);
const VECTOR_FIELD = 'content_vector';
const DEFAULT_SEMANTIC_CONFIG = 'default-semantic';
/** documents per index request (the service accepts up to 1000) */
const INDEX_BATCH = 500;

type QueryType = 'vector' | 'hybrid' | 'semanticHybrid';

/** the Metadata Keys to Insert option as a list of field names */
function metadataKeysOf(raw: unknown, ctx: BaseContext): string[] {
  if (typeof raw !== 'string' || !raw.trim()) return [];
  const keys = [
    ...new Set(
      raw
        .split(',')
        .map((k) => k.trim())
        .filter(Boolean),
    ),
  ];
  for (const key of keys) {
    if (!FIELD_NAME.test(key) || RESERVED_FIELDS.has(key)) {
      throw new NodeOperationError(ctx.getNode(), `"${key}" cannot be used as a metadata field name`, {
        description:
          'Use letters, digits and underscores, starting with a letter, and not id, content, content_vector or metadata.',
      });
    }
  }
  return keys;
}

function scalarText(value: unknown): string | undefined {
  if (value === null || value === undefined) return undefined;
  return typeof value === 'object' ? JSON.stringify(value) : String(value);
}

function endpointOf(ctx: BaseContext, raw: unknown, itemIndex: number): string {
  let url: URL;
  try {
    url = new URL(String(raw ?? '').trim());
  } catch {
    throw new NodeOperationError(ctx.getNode(), 'The Azure AI Search endpoint is not a valid URL', {
      itemIndex,
    });
  }
  if (url.protocol !== 'https:' || url.username || url.password || url.search || url.hash) {
    throw new NodeOperationError(
      ctx.getNode(),
      'The Azure AI Search endpoint must be an https address without credentials',
      { itemIndex },
    );
  }
  return `https://${url.host}`;
}

const metadataKeysOption: NodeProperty = {
  displayName: 'Metadata Keys to Insert',
  name: 'metadataKeys',
  type: 'string',
  default: '',
  placeholder: 'topic, author',
  description:
    'Comma-separated metadata keys stored as their own filterable text fields, used by the OData filter. Only applies when the node creates the index.',
};

const clearIndexOption: NodeProperty = {
  ...clearStoreOption,
  displayName: 'Clear Index',
  description: 'Whether to delete the index before inserting; it is created again from the first document',
};

export const VectorStoreAzureAISearchNode = createVectorStoreNode({
  name: 'ai.vectorStoreAzureAISearch',
  displayName: 'Azure AI Search Vector Store',
  description: 'Stores documents in an Azure AI Search index with vector, hybrid or semantic search',
  icon: 'simple:microsoftazure',
  credentials: [{ name: 'azureAiSearchApi', required: true }],
  modes: [...DEFAULT_VECTOR_STORE_MODES, 'update'],
  filter: 'none',
  properties: [
    {
      displayName: 'Index Name',
      name: 'indexName',
      type: 'string',
      default: '',
      required: true,
      placeholder: 'my-index',
      description:
        'Lowercase letters, digits and dashes. Created from the first inserted document when missing.',
    },
  ],
  insertOptions: [clearIndexOption, metadataKeysOption],
  retrieveOptions: [
    {
      displayName: 'Query Type',
      name: 'queryType',
      type: 'options',
      default: 'hybrid',
      options: [
        { name: 'Vector', value: 'vector', description: 'Nearest vectors only' },
        { name: 'Hybrid', value: 'hybrid', description: 'Vector and keyword search merged' },
        {
          name: 'Semantic Hybrid',
          value: 'semanticHybrid',
          description: 'Hybrid search reranked by the semantic ranker',
        },
      ],
    },
    {
      displayName: 'Filter',
      name: 'odataFilter',
      type: 'string',
      default: '',
      placeholder: "topic eq 'animals'",
      description: 'An OData filter applied to the search (fields from Metadata Keys to Insert)',
    },
    {
      displayName: 'Semantic Configuration',
      name: 'semanticConfiguration',
      type: 'string',
      default: DEFAULT_SEMANTIC_CONFIG,
      description: 'Name of the semantic configuration of the index, used by Semantic Hybrid',
      displayOptions: { show: { queryType: ['semanticHybrid'] } },
    },
  ],
  async open(ctx, itemIndex) {
    const indexName = String(ctx.getNodeParameter('indexName', itemIndex, '') ?? '').trim();
    if (!INDEX_NAME.test(indexName)) {
      throw new NodeOperationError(ctx.getNode(), 'Enter a valid index name', {
        itemIndex,
        description: 'Use lowercase letters, digits and dashes, starting with a letter or digit.',
      });
    }
    const creds = await ctx.getCredentials('azureAiSearchApi', itemIndex);
    const base = endpointOf(ctx, creds.endpoint, itemIndex);
    const options = ctx.getNodeParameter('options', itemIndex, {}) as DataObject;
    const indexPath = `/indexes/${encodeURIComponent(indexName)}`;

    const call = async (
      method: 'GET' | 'POST' | 'PUT' | 'DELETE',
      path: string,
      body?: DataObject,
      tolerate404 = false,
    ): Promise<DataObject | undefined> => {
      let response: HttpFullResponse<unknown>;
      try {
        response = (await ctx.helpers.httpRequestWithAuthentication(
          'azureAiSearchApi',
          {
            url: `${base}${path}`,
            method,
            qs: { 'api-version': API_VERSION },
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
          `Azure AI Search request failed: ${redactSecrets(errorMessage(error))}`,
          { itemIndex },
        );
      }
      const status = response.statusCode;
      if (status >= 300 && status < 400) {
        throw new NodeOperationError(
          ctx.getNode(),
          `Azure AI Search answered with a redirect (status ${status}); it was not followed`,
          { itemIndex },
        );
      }
      if (status === 404 && tolerate404) return undefined;
      if (status < 200 || status >= 300) {
        const detail = redactSecrets(
          typeof response.body === 'string' ? response.body : JSON.stringify(response.body ?? ''),
        ).slice(0, 300);
        throw new NodeOperationError(ctx.getNode(), `Azure AI Search request failed with status ${status}`, {
          itemIndex,
          description: detail,
        });
      }
      return response.body && typeof response.body === 'object' ? (response.body as DataObject) : {};
    };

    /** metadata fields that exist as their own columns, known once the index was read or created */
    let extraFields: string[] | undefined;

    const createIndex = async (dimensions: number, keys: string[]): Promise<void> => {
      await call('PUT', indexPath, {
        name: indexName,
        fields: [
          { name: 'id', type: 'Edm.String', key: true, filterable: true, retrievable: true },
          { name: 'content', type: 'Edm.String', searchable: true, retrievable: true },
          {
            name: VECTOR_FIELD,
            type: 'Collection(Edm.Single)',
            searchable: true,
            retrievable: false,
            dimensions,
            vectorSearchProfile: 'default-profile',
          },
          { name: 'metadata', type: 'Edm.String', retrievable: true },
          ...keys.map((name) => ({ name, type: 'Edm.String', filterable: true, retrievable: true })),
        ],
        vectorSearch: {
          algorithms: [{ name: 'default-hnsw', kind: 'hnsw', hnswParameters: { metric: 'cosine' } }],
          profiles: [{ name: 'default-profile', algorithm: 'default-hnsw' }],
        },
        semantic: {
          configurations: [
            {
              name: DEFAULT_SEMANTIC_CONFIG,
              prioritizedFields: { prioritizedContentFields: [{ fieldName: 'content' }] },
            },
          ],
        },
      });
      extraFields = keys;
    };

    /** The index is created from the first document when the service has none of that name. */
    const ensureIndex = async (dimensions: number): Promise<string[]> => {
      if (extraFields) return extraFields;
      const existing = await call('GET', indexPath, undefined, true);
      if (existing) {
        const fields = Array.isArray(existing.fields) ? (existing.fields as DataObject[]) : [];
        extraFields = fields
          .map((f) => String(f.name ?? ''))
          .filter((name) => name && !RESERVED_FIELDS.has(name));
        return extraFields;
      }
      await createIndex(dimensions, metadataKeysOf(options.metadataKeys, ctx));
      return extraFields ?? [];
    };

    const backend: VectorBackend = {
      async add(documents: AiDocument[], vectors: number[][], ids?: string[]) {
        if (!documents.length) return;
        const fields = await ensureIndex(vectors[0].length);
        for (let start = 0; start < documents.length; start += INDEX_BATCH) {
          const value = documents.slice(start, start + INDEX_BATCH).map((d, i) => {
            const row: DataObject = {
              '@search.action': 'mergeOrUpload',
              id: ids?.[start + i] ?? randomUUID(),
              content: d.pageContent,
              [VECTOR_FIELD]: vectors[start + i],
            };
            const metadata = d.metadata ?? {};
            if (Object.keys(metadata).length) row.metadata = JSON.stringify(metadata);
            for (const key of fields) {
              const text = scalarText(metadata[key]);
              if (text !== undefined) row[key] = text;
            }
            return row;
          });
          await call('POST', `${indexPath}/docs/index`, { value });
        }
      },

      async search(vector, k, _filter, text): Promise<ScoredDocument[]> {
        const queryType = (
          ['vector', 'hybrid', 'semanticHybrid'].includes(String(options.queryType))
            ? options.queryType
            : 'hybrid'
        ) as QueryType;
        const top = Math.max(1, Math.min(k, 1000));
        const body: DataObject = {
          vectorQueries: [{ kind: 'vector', vector, fields: VECTOR_FIELD, k: top }],
          select: 'id, content, metadata',
          top,
        };
        if (queryType !== 'vector' && text?.trim()) body.search = text;
        if (queryType === 'semanticHybrid') {
          body.queryType = 'semantic';
          body.semanticConfiguration =
            typeof options.semanticConfiguration === 'string' && options.semanticConfiguration.trim()
              ? options.semanticConfiguration.trim()
              : DEFAULT_SEMANTIC_CONFIG;
        }
        const odata = typeof options.odataFilter === 'string' ? options.odataFilter.trim() : '';
        if (odata) body.filter = odata;
        const result = await call('POST', `${indexPath}/docs/search`, body, true);
        if (!result) {
          throw new NodeOperationError(ctx.getNode(), `Index ${indexName} not found`, {
            itemIndex,
            description: 'Insert documents first, or check the index name',
          });
        }
        const rows = Array.isArray(result.value) ? (result.value as DataObject[]) : [];
        return rows.map((row) => {
          let metadata: DataObject = {};
          if (typeof row.metadata === 'string' && row.metadata) {
            try {
              const parsed: unknown = JSON.parse(row.metadata);
              if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
                metadata = parsed as DataObject;
              }
            } catch {
              metadata = {};
            }
          }
          const reranker = row['@search.rerankerScore'];
          return {
            document: { pageContent: String(row.content ?? ''), metadata },
            score: Number(typeof reranker === 'number' ? reranker : (row['@search.score'] ?? 0)),
          };
        });
      },

      async clear() {
        await call('DELETE', indexPath, undefined, true);
        extraFields = undefined;
      },
    };
    return { backend };
  },
});
