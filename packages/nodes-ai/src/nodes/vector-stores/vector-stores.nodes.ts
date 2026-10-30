/** Vector stores: in-memory (tenant-scoped, bounded), PGVector and Qdrant. */
import { randomUUID } from 'node:crypto';
import type { AiDocument, BaseContext, DataObject, NodeType } from '@workflow/workflow';
import { NodeOperationError } from '@workflow/workflow';
import { quoteTableName, sharedPostgres } from '../../shared/connections';
import { TenantStore } from '../../shared/tenant-store';
import {
  clearStoreOption,
  cosineSimilarity,
  createVectorStoreNode,
  matchesFilter,
  type ScoredDocument,
  type VectorBackend,
} from './vector-store-factory';

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

  async add(documents: AiDocument[], vectors: number[][]): Promise<void> {
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

export const VectorStoreInMemoryNode = createVectorStoreNode({
  name: 'ai.vectorStoreInMemory',
  displayName: 'Simple Vector Store',
  description: 'Keeps documents and their vectors in the worker process (for testing and small data)',
  icon: 'lucide:database',
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
      type: 'string',
      default: 'vector_store_key',
      required: true,
      description: 'Name of the store; nodes using the same key in this workspace share documents',
    },
  ],
  insertOptions: [clearStoreOption],
  async open(ctx: BaseContext, itemIndex: number) {
    const key = String(
      ctx.getNodeParameter('memoryKey', itemIndex, 'vector_store_key') || 'vector_store_key',
    );
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

export const VectorStorePGVectorNode = createVectorStoreNode({
  name: 'ai.vectorStorePGVector',
  displayName: 'Postgres PGVector Store',
  description: 'Stores documents in PostgreSQL with the pgvector extension (cosine distance)',
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
  insertOptions: [clearStoreOption],
  async open(ctx, itemIndex) {
    const table = quoteTableName(String(ctx.getNodeParameter('tableName', itemIndex, 'ai_vectors')));
    const { value: client, release } = await sharedPostgres(ctx, itemIndex);
    let ensured = false;
    const ensureTable = async (dimensions: number) => {
      if (ensured) return;
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
        await client.query(
          `CREATE TABLE IF NOT EXISTS ${table} (
            id UUID PRIMARY KEY,
            text TEXT NOT NULL,
            metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
            embedding vector(${Math.trunc(dimensions)}) NOT NULL
          )`,
        );
      } catch (error) {
        const code = (error as { code?: string }).code;
        if (code !== '23505' && code !== '42P07') throw error;
      }
      ensured = true;
    };
    const backend: VectorBackend = {
      async add(documents, vectors) {
        if (!documents.length) return;
        await ensureTable(vectors[0].length);
        for (let start = 0; start < documents.length; start += 500) {
          const values: unknown[] = [];
          const rows = documents.slice(start, start + 500).map((d, i) => {
            values.push(
              randomUUID(),
              d.pageContent,
              JSON.stringify(d.metadata ?? {}),
              vectorLiteral(vectors[start + i]),
            );
            const p = i * 4;
            return `($${p + 1}, $${p + 2}, $${p + 3}::jsonb, $${p + 4}::vector)`;
          });
          await client.query(
            `INSERT INTO ${table} (id, text, metadata, embedding) VALUES ${rows.join(', ')}`,
            values,
          );
        }
      },
      async search(vector, k, filter) {
        try {
          const result = await client.query(
            `SELECT text, metadata, 1 - (embedding <=> $1::vector) AS score
               FROM ${table}
              WHERE ($2::jsonb IS NULL OR metadata @> $2::jsonb)
              ORDER BY embedding <=> $1::vector
              LIMIT $3`,
            [vectorLiteral(vector), filter ? JSON.stringify(filter) : null, k],
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

function qdrantFilter(filter?: DataObject): DataObject | undefined {
  if (!filter) return undefined;
  return {
    must: Object.entries(filter).map(([key, value]) => ({ key: `metadata.${key}`, match: { value } })),
  };
}

export const VectorStoreQdrantNode = createVectorStoreNode({
  name: 'ai.vectorStoreQdrant',
  displayName: 'Qdrant Vector Store',
  description: 'Stores documents in a Qdrant collection',
  icon: 'lucide:database-zap',
  credentials: [{ name: 'qdrantApi', required: true }],
  properties: [
    {
      displayName: 'Collection Name',
      name: 'qdrantCollection',
      type: 'string',
      default: '',
      required: true,
      description: 'Created on the first insert when missing (cosine distance)',
    },
  ],
  insertOptions: [clearStoreOption],
  async open(ctx, itemIndex) {
    const creds = await ctx.getCredentials('qdrantApi', itemIndex);
    const collection = String(ctx.getNodeParameter('qdrantCollection', itemIndex, '')).trim();
    if (!/^[A-Za-z0-9_.-]{1,255}$/.test(collection)) {
      throw new NodeOperationError(
        ctx.getNode(),
        'Enter a collection name (letters, digits, "_", "-" and ".")',
        {
          itemIndex,
        },
      );
    }
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
        await request({ url: base, method: 'PUT', body: { vectors: { size, distance: 'Cosine' } } });
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
            payload: { content: d.pageContent, metadata: d.metadata ?? {} },
          }));
          await request({ url: `${base}/points`, method: 'PUT', qs: { wait: 'true' }, body: { points } });
        }
      },
      async search(vector, k, filter) {
        const response = (await request({
          url: `${base}/points/search`,
          method: 'POST',
          body: { vector, limit: k, with_payload: true, ...(filter ? { filter: qdrantFilter(filter) } : {}) },
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
            pageContent: String(r.payload?.content ?? ''),
            metadata: ((r.payload?.metadata as DataObject | undefined) ?? {}) as DataObject,
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

export const vectorStoreNodes: NodeType[] = [
  VectorStoreInMemoryNode,
  VectorStorePGVectorNode,
  VectorStoreQdrantNode,
];
