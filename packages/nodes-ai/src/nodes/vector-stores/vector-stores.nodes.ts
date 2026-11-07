/**
 * Vector stores: in-memory (tenant-scoped, bounded), PGVector and Qdrant here; `vectorStoreNodes` also lists
 * the stores that have their own file.
 */
import { randomUUID } from 'node:crypto';
import type {
  AiDocument,
  BaseContext,
  DataObject,
  ListSearchResult,
  LoadOptionsContext,
  NodeProperty,
  NodeType,
} from '@workflow/workflow';
import { isResourceLocatorValue, NodeOperationError } from '@workflow/workflow';
import { quoteTableName, sharedPostgres } from '../../shared/connections';
import { TenantStore } from '../../shared/tenant-store';
import { VectorStoreAzureAISearchNode } from './azure-ai-search';
import { VectorStoreChromaDBNode } from './chroma';
import { VectorStoreDatabricksNode } from './databricks';
import { VectorStoreMilvusNode } from './milvus';
import { VectorStoreMongoDBAtlasNode } from './mongodb-atlas';
import { VectorStorePineconeNode } from './pinecone';
import { VectorStoreRedisNode } from './redis-vector';
import { VectorStoreSupabaseNode } from './supabase';
import {
  clearStoreOption,
  cosineSimilarity,
  createVectorStoreNode,
  matchesFilter,
  type ScoredDocument,
  type VectorBackend,
} from './vector-store-factory';
import { VectorStoreWeaviateNode } from './weaviate';

// ---------------------------------------------------------------------------------------------
// In-memory
// ---------------------------------------------------------------------------------------------

/** documents per in-memory store; the oldest are dropped beyond this */
export const MEMORY_STORE_MAX_DOCUMENTS = 20_000;
/** approximate bytes one workspace may hold across all its in-memory stores */
export const MEMORY_STORE_MAX_BYTES_PER_TENANT = 128 * 1024 * 1024;
/** vector length accepted on insert (the largest hosted embedding models use up to 4,096) */
export const MEMORY_STORE_MAX_DIMENSIONS = 8_192;
/** characters of text accepted per document on insert */
export const MEMORY_STORE_MAX_CONTENT_CHARS = 200_000;

/** fixed cost of one entry: the entry object, the document, the metadata object and array headers */
const ENTRY_OVERHEAD_BYTES = 200;

/** Approximate heap bytes of one stored document: 8 per vector number, 2 per text character. */
export function documentBytes(document: AiDocument, vector: number[]): number {
  let metadataChars = 0;
  try {
    metadataChars = JSON.stringify(document.metadata)?.length ?? 0;
  } catch {
    metadataChars = 0;
  }
  return ENTRY_OVERHEAD_BYTES + vector.length * 8 + (document.pageContent.length + metadataChars) * 2;
}

export interface MemoryVectorBackendOptions {
  /** approximate bytes this store may hold; the oldest documents are evicted beyond it */
  maxBytes?: number;
  maxDimensions?: number;
  maxContentChars?: number;
  /** node name shown in limit errors */
  nodeName?: string;
  /** called after the size changed, so the owner can enforce its tenant-wide byte budget */
  onChange?: () => void;
}

/**
 * Limits: a batch is rejected up front (nothing is stored) with a NodeOperationError when a vector
 * or a text is over its cap. Growth is handled by evicting the oldest documents, first past the
 * document count, then past the byte budget, so inserting never fails because the store is full
 * and the newest data always survives.
 */
export class MemoryVectorBackend implements VectorBackend {
  private entries: Array<{ document: AiDocument; vector: number[]; bytes: number }> = [];
  private totalBytes = 0;
  private readonly maxBytes: number;
  private readonly maxDimensions: number;
  private readonly maxContentChars: number;
  private readonly nodeName: string;
  private readonly onChange?: () => void;

  constructor(
    private readonly maxDocuments = MEMORY_STORE_MAX_DOCUMENTS,
    options: MemoryVectorBackendOptions = {},
  ) {
    this.maxBytes = options.maxBytes ?? MEMORY_STORE_MAX_BYTES_PER_TENANT;
    this.maxDimensions = options.maxDimensions ?? MEMORY_STORE_MAX_DIMENSIONS;
    this.maxContentChars = options.maxContentChars ?? MEMORY_STORE_MAX_CONTENT_CHARS;
    this.nodeName = options.nodeName ?? 'Simple Vector Store';
    this.onChange = options.onChange;
  }

  get size(): number {
    return this.entries.length;
  }

  /** approximate heap bytes held by this store */
  get bytes(): number {
    return this.totalBytes;
  }

  async add(documents: AiDocument[], vectors: number[][], _ids?: string[]): Promise<void> {
    if (vectors.length !== documents.length) {
      throw new NodeOperationError(
        this.nodeName,
        `Got ${vectors.length} embeddings for ${documents.length} documents`,
      );
    }
    const staged = documents.map((d, i) => {
      const received: unknown = vectors[i];
      if (!Array.isArray(received)) {
        throw new NodeOperationError(this.nodeName, `Embedding ${i + 1} is not a list of numbers`);
      }
      if (received.length > this.maxDimensions) {
        throw new NodeOperationError(
          this.nodeName,
          `An embedding has ${received.length} dimensions, more than the ${this.maxDimensions} the Simple Vector Store accepts`,
          {
            description:
              'Use a smaller embedding model, or a database-backed vector store for larger vectors.',
          },
        );
      }
      if (d.pageContent.length > this.maxContentChars) {
        throw new NodeOperationError(
          this.nodeName,
          `A document has ${d.pageContent.length} characters, more than the ${this.maxContentChars} the Simple Vector Store accepts`,
          { description: 'Split the text into smaller chunks with a text splitter before inserting.' },
        );
      }
      for (let j = 0; j < received.length; j++) {
        if (typeof received[j] !== 'number' || !Number.isFinite(received[j])) {
          throw new NodeOperationError(this.nodeName, `Embedding ${i + 1} must hold only finite numbers`, {
            description: 'The embeddings service returned a value that is not a number.',
          });
        }
      }
      // validated and copied, so the 8 bytes per number charged below is what is really held
      const vector = Array.from(received as number[]);
      const document = { pageContent: d.pageContent, metadata: { ...d.metadata } };
      return { document, vector, bytes: documentBytes(document, vector) };
    });
    for (const entry of staged) {
      this.entries.push(entry);
      this.totalBytes += entry.bytes;
    }
    let drop = Math.max(0, this.entries.length - this.maxDocuments);
    let remaining = this.totalBytes;
    for (let i = 0; i < drop; i++) remaining -= this.entries[i].bytes;
    while (remaining > this.maxBytes && drop < this.entries.length - 1) {
      remaining -= this.entries[drop].bytes;
      drop++;
    }
    if (drop > 0) {
      for (const removed of this.entries.splice(0, drop)) this.totalBytes -= removed.bytes;
    }
    this.onChange?.();
  }

  async search(vector: number[], k: number, filter?: DataObject): Promise<ScoredDocument[]> {
    return this.entries
      .filter((e) => matchesFilter(e.document.metadata, filter))
      .map((e) => ({
        document: { pageContent: e.document.pageContent, metadata: { ...e.document.metadata } },
        score: cosineSimilarity(vector, e.vector),
      }))
      .sort((a, b) => b.score - a.score)
      .slice(0, k);
  }

  async clear(): Promise<void> {
    this.entries = [];
    this.totalBytes = 0;
    this.onChange?.();
  }
}

const memoryStores = new TenantStore<MemoryVectorBackend>({
  maxKeysPerTenant: 20,
  maxTenants: 1000,
  maxBytesPerTenant: MEMORY_STORE_MAX_BYTES_PER_TENANT,
  sizeOf: (backend) => backend.bytes,
});

/** test hook */
export function clearMemoryVectorStores(): void {
  memoryStores.clear();
}

/** The text of a resource locator value, or of a plain string saved before the picker existed. */
function locatorText(raw: unknown): string {
  return String((isResourceLocatorValue(raw) ? raw.value : raw) ?? '').trim();
}

const DEFAULT_MEMORY_KEY = 'vector_store_key';

/** Lists this workspace's Simple Vector Store keys, filtered by the typed text. */
async function vectorStoresSearch(ctx: LoadOptionsContext, filter?: string): Promise<ListSearchResult> {
  const needle = (filter ?? '').trim().toLowerCase();
  const keys = memoryStores
    .keys(ctx.getTenantId())
    .filter((key) => !needle || key.toLowerCase().includes(needle))
    .sort((a, b) => a.localeCompare(b));
  return { results: keys.map((key) => ({ name: key, value: key })) };
}

export const VectorStoreInMemoryNode = createVectorStoreNode({
  name: 'ai.vectorStoreInMemory',
  displayName: 'Simple Vector Store',
  description: 'Keeps documents and their vectors in the worker process (for testing and small data)',
  icon: 'lucide:database',
  filter: 'none',
  properties: [
    {
      displayName:
        'Data lives in the memory of the process: it is lost on restart, not shared between workers, and capped at 20,000 documents per store, 20 stores and about 128 MB per workspace (the oldest documents are dropped first).',
      name: 'notice',
      type: 'notice',
      default: '',
    },
    {
      displayName: 'Memory Key',
      name: 'memoryKey',
      type: 'resourceLocator',
      default: { __rl: true, mode: 'id', value: DEFAULT_MEMORY_KEY },
      required: true,
      description: 'Name of the store; nodes using the same key in this workspace share documents',
      modes: [
        {
          displayName: 'From List',
          name: 'list',
          type: 'list',
          placeholder: 'Select a store...',
          typeOptions: { searchListMethod: 'vectorStoresSearch', searchable: true },
        },
        {
          displayName: 'New or By Name',
          name: 'id',
          type: 'string',
          placeholder: 'Type a name; a new store is created on the first insert',
        },
      ],
    },
  ],
  insertOptions: [clearStoreOption],
  methods: { listSearch: { vectorStoresSearch } },
  async open(ctx: BaseContext, itemIndex: number) {
    const key =
      locatorText(ctx.getNodeParameter('memoryKey', itemIndex, DEFAULT_MEMORY_KEY)) || DEFAULT_MEMORY_KEY;
    const tenantId = ctx.getTenantId();
    const backend = memoryStores.getOrCreate(
      tenantId,
      key,
      () =>
        new MemoryVectorBackend(MEMORY_STORE_MAX_DOCUMENTS, {
          nodeName: ctx.getNode().name,
          onChange: () => memoryStores.settle(tenantId, key),
        }),
    );
    return { backend };
  },
});

// ---------------------------------------------------------------------------------------------
// PGVector
// ---------------------------------------------------------------------------------------------

function vectorLiteral(vector: number[]): string {
  if (!vector.every((n) => Number.isFinite(n))) throw new Error('Embedding contains non-numeric values');
  return `[${vector.join(',')}]`;
}

/** A column name as a quoted identifier: letters, digits and underscores only. */
export function quoteColumnName(name: string): string {
  if (!/^[A-Za-z_][A-Za-z0-9_]{0,62}$/.test(name)) {
    throw new Error(`Invalid column name "${name}": use letters, digits and underscores`);
  }
  return `"${name}"`;
}

/** pgvector operators; the score is higher for a closer document in every strategy. */
const DISTANCE_STRATEGIES = {
  cosine: { operator: '<=>', score: (distance: string) => `1 - (${distance})` },
  innerProduct: { operator: '<#>', score: (distance: string) => `(${distance}) * -1` },
  euclidean: { operator: '<->', score: (distance: string) => `1 / (1 + (${distance}))` },
} as const;

type DistanceStrategy = keyof typeof DISTANCE_STRATEGIES;

const pgColumnNamesOption: NodeProperty = {
  displayName: 'Column Names',
  name: 'columnNames',
  type: 'fixedCollection',
  default: {},
  description: 'Names of the columns of the table',
  options: [
    {
      displayName: 'Column Names',
      name: 'values',
      values: [
        { displayName: 'ID Column', name: 'idColumnName', type: 'string', default: 'id' },
        { displayName: 'Vector Column', name: 'vectorColumnName', type: 'string', default: 'embedding' },
        { displayName: 'Content Column', name: 'contentColumnName', type: 'string', default: 'text' },
        { displayName: 'Metadata Column', name: 'metadataColumnName', type: 'string', default: 'metadata' },
      ],
    },
  ],
};

const pgCollectionOption: NodeProperty = {
  displayName: 'Collection',
  name: 'collection',
  type: 'fixedCollection',
  default: {},
  description: 'Keep the documents of several collections in one table',
  options: [
    {
      displayName: 'Collection',
      name: 'values',
      values: [
        { displayName: 'Use Collection', name: 'useCollection', type: 'boolean', default: false },
        {
          displayName: 'Collection Name',
          name: 'collectionName',
          type: 'string',
          default: 'collection',
          displayOptions: { show: { useCollection: [true] } },
        },
        {
          displayName: 'Collection Table Name',
          name: 'collectionTableName',
          type: 'string',
          default: 'ai_vector_collections',
          displayOptions: { show: { useCollection: [true] } },
        },
      ],
    },
  ],
};

const pgDistanceOption: NodeProperty = {
  displayName: 'Distance Strategy',
  name: 'distanceStrategy',
  type: 'options',
  default: 'cosine',
  description: 'How the closeness of two vectors is measured',
  options: [
    { name: 'Cosine', value: 'cosine' },
    { name: 'Inner Product', value: 'innerProduct' },
    { name: 'Euclidean', value: 'euclidean' },
  ],
};

const pgSkipInitializationOption: NodeProperty = {
  displayName: 'Skip Table Initialization',
  name: 'skipInitialization',
  type: 'boolean',
  default: false,
  description: 'Whether to leave the extension and the table alone because they already exist',
};

function optionGroup(options: DataObject, name: string): DataObject {
  const group = options[name];
  const values = group && typeof group === 'object' ? (group as DataObject).values : undefined;
  return values && typeof values === 'object' && !Array.isArray(values) ? (values as DataObject) : {};
}

export const VectorStorePGVectorNode = createVectorStoreNode({
  name: 'ai.vectorStorePGVector',
  displayName: 'Postgres PGVector Store',
  description: 'Stores documents in PostgreSQL with the pgvector extension',
  icon: 'simple:postgresql',
  credentials: [{ name: 'postgres', required: true }],
  properties: [
    {
      displayName: 'Table Name',
      name: 'tableName',
      type: 'string',
      default: 'ai_vectors',
      required: true,
      description: 'Created on the first insert with a vector column sized to the embedding model',
    },
  ],
  insertOptions: [clearStoreOption, pgColumnNamesOption, pgCollectionOption, pgSkipInitializationOption],
  retrieveOptions: [pgDistanceOption, pgColumnNamesOption, pgCollectionOption],
  async open(ctx, itemIndex) {
    const table = quoteTableName(String(ctx.getNodeParameter('tableName', itemIndex, 'ai_vectors')));
    const options = ctx.getNodeParameter('options', itemIndex, {}) as DataObject;
    const names = optionGroup(options, 'columnNames');
    const idColumn = quoteColumnName(String(names.idColumnName || 'id'));
    const vectorColumn = quoteColumnName(String(names.vectorColumnName || 'embedding'));
    const contentColumn = quoteColumnName(String(names.contentColumnName || 'text'));
    const metadataColumn = quoteColumnName(String(names.metadataColumnName || 'metadata'));
    const strategyName = String(options.distanceStrategy || 'cosine');
    if (!Object.hasOwn(DISTANCE_STRATEGIES, strategyName)) {
      throw new NodeOperationError(ctx.getNode(), `Unknown distance strategy "${strategyName}"`, {
        itemIndex,
      });
    }
    const strategy = DISTANCE_STRATEGIES[strategyName as DistanceStrategy];
    const collectionSettings = optionGroup(options, 'collection');
    const collection =
      collectionSettings.useCollection === true
        ? {
            name: String(collectionSettings.collectionName ?? '').trim(),
            table: quoteTableName(String(collectionSettings.collectionTableName || 'ai_vector_collections')),
          }
        : undefined;
    if (collection && (!collection.name || collection.name.length > 255)) {
      throw new NodeOperationError(ctx.getNode(), 'Enter a collection name of up to 255 characters', {
        itemIndex,
      });
    }
    const skipInitialization = options.skipInitialization === true;
    const { value: client, release } = await sharedPostgres(ctx, itemIndex);
    let ensured = false;
    const ensureTable = async (dimensions: number) => {
      if (ensured || skipInitialization) return;
      try {
        await client.query('CREATE EXTENSION IF NOT EXISTS vector');
      } catch (error) {
        const exists = await client.query("SELECT 1 FROM pg_extension WHERE extname = 'vector'");
        if (!exists.rowCount) {
          throw new NodeOperationError(
            ctx.getNode(),
            'The pgvector extension is not installed in this database',
            {
              description: `Ask a database administrator to run CREATE EXTENSION vector (${(error as Error).message})`,
            },
          );
        }
      }
      try {
        if (collection) {
          await client.query(
            `CREATE TABLE IF NOT EXISTS ${collection.table} (
              uuid UUID PRIMARY KEY,
              name TEXT NOT NULL UNIQUE,
              cmetadata JSONB
            )`,
          );
        }
        await client.query(
          `CREATE TABLE IF NOT EXISTS ${table} (
            ${idColumn} UUID PRIMARY KEY,
            ${contentColumn} TEXT NOT NULL,
            ${metadataColumn} JSONB NOT NULL DEFAULT '{}'::jsonb,
            ${vectorColumn} vector(${Math.trunc(dimensions)}) NOT NULL
          )`,
        );
        if (collection)
          await client.query(`ALTER TABLE ${table} ADD COLUMN IF NOT EXISTS "collection_id" UUID`);
      } catch (error) {
        const code = (error as { code?: string }).code;
        if (code !== '23505' && code !== '42P07') throw error;
      }
      ensured = true;
    };
    const findCollection = async (): Promise<string | undefined> => {
      if (!collection) return undefined;
      try {
        const found = await client.query(`SELECT uuid FROM ${collection.table} WHERE name = $1`, [
          collection.name,
        ]);
        return found.rows[0] ? String(found.rows[0].uuid) : undefined;
      } catch (error) {
        if ((error as { code?: string }).code === '42P01') return undefined;
        throw error;
      }
    };
    const backend: VectorBackend = {
      async add(documents, vectors) {
        if (!documents.length) return;
        await ensureTable(vectors[0].length);
        let collectionId: string | undefined;
        if (collection) {
          const row = await client.query(
            `INSERT INTO ${collection.table} (uuid, name, cmetadata) VALUES ($1, $2, '{}'::jsonb)
             ON CONFLICT (name) DO UPDATE SET name = EXCLUDED.name RETURNING uuid`,
            [randomUUID(), collection.name],
          );
          collectionId = String(row.rows[0].uuid);
        }
        const width = collectionId ? 5 : 4;
        for (let start = 0; start < documents.length; start += 500) {
          const values: unknown[] = [];
          const rows = documents.slice(start, start + 500).map((d, i) => {
            values.push(
              randomUUID(),
              d.pageContent,
              JSON.stringify(d.metadata ?? {}),
              vectorLiteral(vectors[start + i]),
            );
            if (collectionId) values.push(collectionId);
            const p = i * width;
            return `($${p + 1}, $${p + 2}, $${p + 3}::jsonb, $${p + 4}::vector${collectionId ? `, $${p + 5}::uuid` : ''})`;
          });
          await client.query(
            `INSERT INTO ${table} (${idColumn}, ${contentColumn}, ${metadataColumn}, ${vectorColumn}${collectionId ? ', "collection_id"' : ''}) VALUES ${rows.join(', ')}`,
            values,
          );
        }
      },
      async search(vector, k, filter) {
        try {
          const collectionId = await findCollection();
          if (collection && !collectionId) return [];
          const distance = `${vectorColumn} ${strategy.operator} $1::vector`;
          const result = await client.query(
            `SELECT ${contentColumn} AS text, ${metadataColumn} AS metadata, ${strategy.score(distance)} AS score
               FROM ${table}
              WHERE ($2::jsonb IS NULL OR ${metadataColumn} @> $2::jsonb)${collectionId ? ' AND "collection_id" = $4::uuid' : ''}
              ORDER BY ${distance}
              LIMIT $3`,
            [
              vectorLiteral(vector),
              filter ? JSON.stringify(filter) : null,
              k,
              ...(collectionId ? [collectionId] : []),
            ],
          );
          return result.rows.map((r) => ({
            document: { pageContent: String(r.text), metadata: (r.metadata ?? {}) as DataObject },
            score: Number(r.score),
          }));
        } catch (error) {
          // nothing inserted yet: an empty store, not an error
          if ((error as { code?: string }).code === '42P01') return [];
          throw error;
        }
      },
      async clear() {
        try {
          if (collection) {
            const collectionId = await findCollection();
            if (collectionId)
              await client.query(`DELETE FROM ${table} WHERE "collection_id" = $1::uuid`, [collectionId]);
            return;
          }
          await client.query(`DELETE FROM ${table}`);
        } catch (error) {
          if ((error as { code?: string }).code !== '42P01') throw error;
        }
      },
    };
    return { backend, close: release };
  },
});

// ---------------------------------------------------------------------------------------------
// Qdrant
// ---------------------------------------------------------------------------------------------

const QDRANT_PAYLOAD_KEY = /^[A-Za-z_][A-Za-z0-9_]{0,63}$/;
const QDRANT_COLLECTION = /^[A-Za-z0-9_.-]{1,255}$/;

/** `must` conditions from the metadata filter, merged with the JSON filter the user typed. */
function qdrantFilter(metadataKey: string, filter?: DataObject, extra?: DataObject): DataObject | undefined {
  const must: unknown[] = Object.entries(filter ?? {}).map(([key, value]) => ({
    key: `${metadataKey}.${key}`,
    match: { value },
  }));
  const { must: extraMust, ...rest } = extra ?? {};
  if (Array.isArray(extraMust)) must.push(...extraMust);
  else if (extraMust && typeof extraMust === 'object') must.push(extraMust);
  if (!must.length && !Object.keys(rest).length) return undefined;
  return { ...rest, ...(must.length ? { must } : {}) };
}

const qdrantContentKeyOption: NodeProperty = {
  displayName: 'Content Payload Key',
  name: 'contentPayloadKey',
  type: 'string',
  default: 'content',
  description: 'Payload field that holds the text of a document',
};

const qdrantMetadataKeyOption: NodeProperty = {
  displayName: 'Metadata Payload Key',
  name: 'metadataPayloadKey',
  type: 'string',
  default: 'metadata',
  description: 'Payload field that holds the metadata of a document',
};

/** Lists the collections of the Qdrant server, filtered by the typed text. */
async function qdrantCollectionsSearch(ctx: LoadOptionsContext, filter?: string): Promise<ListSearchResult> {
  const creds = await ctx.getCredentials('qdrantApi', 0);
  const response = (await ctx.helpers.httpRequestWithAuthentication(
    'qdrantApi',
    { url: `${String(creds.url ?? '').replace(/\/+$/, '')}/collections` },
    0,
  )) as { result?: { collections?: Array<{ name?: unknown }> } };
  const needle = (filter ?? '').trim().toLowerCase();
  const names = (response.result?.collections ?? [])
    .map((c) => String(c.name ?? ''))
    .filter((name) => name && (!needle || name.toLowerCase().includes(needle)))
    .sort((a, b) => a.localeCompare(b));
  return { results: names.map((name) => ({ name, value: name })) };
}

export const VectorStoreQdrantNode = createVectorStoreNode({
  name: 'ai.vectorStoreQdrant',
  displayName: 'Qdrant Vector Store',
  description: 'Stores documents in a Qdrant collection',
  icon: 'lucide:database-zap',
  credentials: [{ name: 'qdrantApi', required: true }],
  properties: [
    {
      displayName: 'Qdrant Collection',
      name: 'qdrantCollection',
      type: 'resourceLocator',
      default: { __rl: true, mode: 'list', value: '' },
      required: true,
      description: 'Created on the first insert when missing (cosine distance)',
      modes: [
        {
          displayName: 'From List',
          name: 'list',
          type: 'list',
          placeholder: 'Select a collection...',
          typeOptions: { searchListMethod: 'qdrantCollectionsSearch', searchable: true },
        },
        { displayName: 'By Name', name: 'id', type: 'string', placeholder: 'Collection name' },
      ],
    },
  ],
  insertOptions: [
    clearStoreOption,
    qdrantContentKeyOption,
    qdrantMetadataKeyOption,
    {
      displayName: 'Collection Config',
      name: 'collectionConfig',
      type: 'json',
      default: '',
      typeOptions: { rows: 4 },
      description:
        'JSON merged into the request that creates the collection, for example {"on_disk_payload": true}',
    },
  ],
  retrieveOptions: [
    qdrantContentKeyOption,
    qdrantMetadataKeyOption,
    {
      displayName: 'Search Filter JSON',
      name: 'searchFilterJson',
      type: 'json',
      default: '',
      typeOptions: { rows: 4 },
      description: 'A Qdrant filter; its "must" conditions are added to the metadata filter',
    },
  ],
  methods: { listSearch: { qdrantCollectionsSearch } },
  async open(ctx, itemIndex) {
    const creds = await ctx.getCredentials('qdrantApi', itemIndex);
    const collection = locatorText(ctx.getNodeParameter('qdrantCollection', itemIndex, ''));
    if (!QDRANT_COLLECTION.test(collection)) {
      throw new NodeOperationError(
        ctx.getNode(),
        'Enter a collection name (letters, digits, "_", "-" and ".")',
        {
          itemIndex,
        },
      );
    }
    const options = ctx.getNodeParameter('options', itemIndex, {}) as DataObject;
    const contentKey = String(options.contentPayloadKey || 'content');
    const metadataKey = String(options.metadataPayloadKey || 'metadata');
    for (const key of [contentKey, metadataKey]) {
      if (!QDRANT_PAYLOAD_KEY.test(key)) {
        throw new NodeOperationError(
          ctx.getNode(),
          'A payload key may only hold letters, digits and "_" and must not start with a digit',
          { itemIndex },
        );
      }
    }
    const searchFilter = parseQdrantJson(ctx, options.searchFilterJson, 'The search filter JSON');
    const collectionConfig = parseQdrantJson(ctx, options.collectionConfig, 'The collection config');
    const base = `${String(creds.url ?? '').replace(/\/+$/, '')}/collections/${encodeURIComponent(collection)}`;
    const request = (options: Parameters<BaseContext['helpers']['httpRequestWithAuthentication']>[1]) =>
      ctx.helpers.httpRequestWithAuthentication('qdrantApi', options, itemIndex);
    let ensured = false;
    const ensureCollection = async (size: number) => {
      if (ensured) return;
      const existing = (await request({
        url: base,
        ignoreHttpStatusErrors: true,
        returnFullResponse: true,
      })) as {
        statusCode: number;
      };
      if (existing.statusCode === 404) {
        const configured = collectionConfig?.vectors;
        const vectors =
          configured && typeof configured === 'object' && !Array.isArray(configured)
            ? (configured as DataObject)
            : {};
        await request({
          url: base,
          method: 'PUT',
          body: { ...collectionConfig, vectors: { distance: 'Cosine', ...vectors, size } },
        });
      }
      ensured = true;
    };
    const backend: VectorBackend = {
      async add(documents, vectors) {
        if (!documents.length) return;
        await ensureCollection(vectors[0].length);
        for (let start = 0; start < documents.length; start += 256) {
          const points = documents.slice(start, start + 256).map((d, i) => ({
            id: randomUUID(),
            vector: vectors[start + i],
            payload: { [contentKey]: d.pageContent, [metadataKey]: d.metadata ?? {} },
          }));
          await request({ url: `${base}/points`, method: 'PUT', qs: { wait: 'true' }, body: { points } });
        }
      },
      async search(vector, k, filter) {
        const merged = qdrantFilter(metadataKey, filter, searchFilter);
        const response = (await request({
          url: `${base}/points/search`,
          method: 'POST',
          body: { vector, limit: k, with_payload: true, ...(merged ? { filter: merged } : {}) },
          ignoreHttpStatusErrors: true,
          returnFullResponse: true,
        })) as {
          statusCode: number;
          body: { result?: Array<{ score: number; payload?: DataObject }>; status?: unknown };
        };
        if (response.statusCode === 404) return [];
        if (response.statusCode >= 400) {
          throw new NodeOperationError(
            ctx.getNode(),
            `Qdrant search failed with status ${response.statusCode}`,
            {
              description: JSON.stringify(response.body?.status ?? response.body).slice(0, 500),
            },
          );
        }
        return (response.body.result ?? []).map((r) => ({
          document: {
            pageContent: String(r.payload?.[contentKey] ?? ''),
            metadata: ((r.payload?.[metadataKey] as DataObject | undefined) ?? {}) as DataObject,
          },
          score: Number(r.score),
        }));
      },
      async clear() {
        await request({ url: base, method: 'DELETE', ignoreHttpStatusErrors: true });
        ensured = false;
      },
    };
    return { backend };
  },
});

function parseQdrantJson(ctx: BaseContext, raw: unknown, label: string): DataObject | undefined {
  if (raw && typeof raw === 'object' && !Array.isArray(raw)) return raw as DataObject;
  if (typeof raw !== 'string' || !raw.trim()) return undefined;
  try {
    const parsed: unknown = JSON.parse(raw);
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) return parsed as DataObject;
  } catch {
    // reported below
  }
  throw new NodeOperationError(ctx.getNode(), `${label} must be a JSON object`);
}

export const vectorStoreNodes: NodeType[] = [
  VectorStoreInMemoryNode,
  VectorStorePGVectorNode,
  VectorStoreQdrantNode,
  VectorStorePineconeNode,
  VectorStoreSupabaseNode,
  VectorStoreWeaviateNode,
  VectorStoreMongoDBAtlasNode,
  VectorStoreRedisNode,
  VectorStoreAzureAISearchNode,
  VectorStoreChromaDBNode,
  VectorStoreMilvusNode,
  VectorStoreDatabricksNode,
];
