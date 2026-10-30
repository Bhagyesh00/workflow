/** Vector stores: in-memory (tenant-scoped, bounded), PGVector and Qdrant. */
import { randomUUID } from 'node:crypto';
import type { AiDocument, BaseContext, DataObject, NodeType } from '@workflow/workflow';
import { NodeOperationError } from '@workflow/workflow';
import { connectPostgres, quoteTableName } from '../../shared/connections';
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

export class MemoryVectorBackend implements VectorBackend {
  private entries: Array<{ document: AiDocument; vector: number[] }> = [];

  constructor(private readonly maxDocuments = MEMORY_STORE_MAX_DOCUMENTS) {}

  get size(): number {
    return this.entries.length;
  }

  async add(documents: AiDocument[], vectors: number[][]): Promise<void> {
    for (const [i, d] of documents.entries()) {
      this.entries.push({
        document: { pageContent: d.pageContent, metadata: { ...d.metadata } },
        vector: vectors[i],
      });
    }
    if (this.entries.length > this.maxDocuments) this.entries = this.entries.slice(-this.maxDocuments);
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
  }
}

const memoryStores = new TenantStore<MemoryVectorBackend>({ maxKeysPerTenant: 20, maxTenants: 1000 });

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
        'Data lives in the memory of the process: it is lost on restart, not shared between workers, and capped at 20,000 documents per store and 20 stores per workspace.',
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
    return { backend: memoryStores.getOrCreate(ctx.getTenantId(), key, () => new MemoryVectorBackend()) };
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
    const client = await connectPostgres(ctx);
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
    return { backend, close: () => client.end() };
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
