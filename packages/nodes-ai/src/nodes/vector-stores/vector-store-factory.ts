/**
 * Shared behaviour of the vector store nodes. One node works in three modes:
 * - insert: main input + document loader + embeddings; adds the documents, outputs them;
 * - load: main input + embeddings; returns the top-k documents for a prompt as items;
 * - retrieve: sub-node; supplies an `AiVectorStore` to chains and tools.
 * Ports change with the mode (`inputs` / `outputs` are expressions over `$parameter.mode`).
 */
import {
  type AiDocument,
  type AiEmbeddings,
  type AiReranker,
  type AiVectorStore,
  type BaseContext,
  type DataObject,
  type Item,
  NodeOperationError,
  type NodeProperty,
  type NodeType,
  type NodeTypeDescription,
  type SupplyDataContext,
} from '@workflow/workflow';
import { getDocumentLoader, getEmbeddings } from '../../shared/ai-inputs';
import { collectionList, errorMessage } from '../../shared/utils';

export interface ScoredDocument {
  document: AiDocument;
  score: number;
}

/** Operation modes a vector store node can offer (n8n's names). */
export type VectorStoreMode = 'load' | 'insert' | 'retrieve' | 'retrieve-as-tool' | 'update';

/** Modes of a store without update; a store that updates lists `[...DEFAULT_VECTOR_STORE_MODES, 'update']`. */
export const DEFAULT_VECTOR_STORE_MODES: VectorStoreMode[] = [
  'load',
  'insert',
  'retrieve',
  'retrieve-as-tool',
];

/** Storage behind a vector store node. Vectors are computed by the factory. */
export interface VectorBackend {
  /** `ids`, when given, has one entry per document: the store upserts by id (update mode). */
  add(documents: AiDocument[], vectors: number[][], ids?: string[]): Promise<void>;
  /** `text` is the query as typed, for stores that search by text too (hybrid search, Databricks). */
  search(vector: number[], k: number, filter?: DataObject, text?: string): Promise<ScoredDocument[]>;
  clear?(): Promise<void>;
}

export interface OpenedBackend {
  backend: VectorBackend;
  close?: () => Promise<void>;
}

export interface VectorStoreSpec {
  name: string;
  displayName: string;
  description: string;
  icon: string;
  credentials?: NodeTypeDescription['credentials'];
  /** store-specific parameters (shown in every mode) */
  properties: NodeProperty[];
  /** store-specific insert options */
  insertOptions?: NodeProperty[];
  /** modes offered; `DEFAULT_VECTOR_STORE_MODES` when not set */
  modes?: VectorStoreMode[];
  /** search filter shown: the Metadata Filter list, a JSON filter, or none (a store with its own filter option) */
  filter?: 'metadata' | 'json' | 'none';
  /** store-specific options of the load, retrieve and retrieve-as-tool modes */
  retrieveOptions?: NodeProperty[];
  /** list searches, load options and credential tests of the node */
  methods?: NodeType['methods'];
  open(ctx: BaseContext, itemIndex: number): Promise<OpenedBackend>;
}

const MODE = "($parameter.mode ?? 'retrieve')";
const EMBEDDING_INPUT =
  "{ type: 'ai_embedding', displayName: 'Embedding', required: true, maxConnections: 1 }";
const DOCUMENT_INPUT = "{ type: 'ai_document', displayName: 'Document', required: true, maxConnections: 1 }";

export const VECTOR_STORE_INPUTS = `={{ ${MODE} === 'insert' ? ['main', ${DOCUMENT_INPUT}, ${EMBEDDING_INPUT}] : ${MODE} === 'load' ? ['main', ${EMBEDDING_INPUT}] : [${EMBEDDING_INPUT}] }}`;
export const VECTOR_STORE_OUTPUTS = `={{ ${MODE} === 'retrieve' ? [{ type: 'ai_vectorStore', displayName: 'Vector Store' }] : ['main'] }}`;

const INSERT_BATCH = 200;

export function cosineSimilarity(a: number[], b: number[]): number {
  let dot = 0;
  let na = 0;
  let nb = 0;
  const n = Math.min(a.length, b.length);
  for (let i = 0; i < n; i++) {
    dot += a[i] * b[i];
    na += a[i] * a[i];
    nb += b[i] * b[i];
  }
  return na && nb ? dot / (Math.sqrt(na) * Math.sqrt(nb)) : 0;
}

/** Every key/value of `filter` must equal the document metadata value. */
export function matchesFilter(metadata: DataObject, filter?: DataObject): boolean {
  if (!filter) return true;
  return Object.entries(filter).every(([k, v]) => JSON.stringify(metadata[k]) === JSON.stringify(v));
}

const metadataFilterProperty: NodeProperty = {
  displayName: 'Metadata Filter',
  name: 'metadata',
  type: 'fixedCollection',
  default: {},
  typeOptions: { multipleValues: true },
  description: 'Only documents whose metadata has all of these values',
  options: [
    {
      displayName: 'Fields to Match',
      name: 'metadataValues',
      values: [
        { displayName: 'Name', name: 'name', type: 'string', default: '' },
        { displayName: 'Value', name: 'value', type: 'string', default: '' },
      ],
    },
  ],
};

function readFilter(ctx: BaseContext, itemIndex: number): DataObject | undefined {
  const options = ctx.getNodeParameter('options', itemIndex, {}) as DataObject;
  const entries = collectionList<{ name: string; value: unknown }>(options.metadata, 'metadataValues').filter(
    (e) => e.name,
  );
  return entries.length ? Object.fromEntries(entries.map((e) => [e.name, e.value])) : undefined;
}

/** `AiVectorStore` for chains and tools: embeds texts and queries with the connected model. */
export function toAiVectorStore(
  backend: VectorBackend,
  embeddings: AiEmbeddings,
  defaultFilter: DataObject | undefined,
  log?: SupplyDataContext['logSubNodeRun'],
  _reranker?: AiReranker,
): AiVectorStore {
  return {
    kind: 'vectorStore',
    async addDocuments(documents) {
      for (let start = 0; start < documents.length; start += INSERT_BATCH) {
        const batch = documents.slice(start, start + INSERT_BATCH);
        const vectors = await embeddings.embedDocuments(batch.map((d) => d.pageContent));
        await backend.add(batch, vectors);
      }
      log?.({ action: 'addDocuments', documents: documents.length }, { ok: true });
    },
    async similaritySearch(query, k, filter) {
      const vector = await embeddings.embedQuery(query);
      const results = await backend.search(vector, Math.max(1, Math.min(k, 1000)), filter ?? defaultFilter);
      log?.(
        { action: 'similaritySearch', query, k },
        { documents: results.map((r) => ({ ...r.document, score: r.score })) },
      );
      return results;
    },
  };
}

export function createVectorStoreNode(spec: VectorStoreSpec): NodeType {
  const description: NodeTypeDescription = {
    name: spec.name,
    displayName: spec.displayName,
    description: spec.description,
    icon: spec.icon,
    group: ['transform'],
    version: 1,
    defaults: { name: spec.displayName },
    inputs: VECTOR_STORE_INPUTS,
    outputs: VECTOR_STORE_OUTPUTS,
    credentials: spec.credentials,
    categories: ['AI', 'Vector Stores'],
    alias: ['rag', 'semantic search', 'embeddings', 'knowledge base', 'retrieval'],
    properties: [
      {
        displayName: 'Operation Mode',
        name: 'mode',
        type: 'options',
        default: 'retrieve',
        noDataExpression: true,
        options: [
          {
            name: 'Get Many',
            value: 'load',
            description: 'Get the documents most similar to a prompt',
            action: 'Get ranked documents',
          },
          {
            name: 'Insert Documents',
            value: 'insert',
            description: 'Add documents to the store',
            action: 'Add documents',
          },
          {
            name: 'Retrieve Documents (for a Chain or Tool)',
            value: 'retrieve',
            description: 'Connect the store to a chain, retriever or vector store tool',
            action: 'Retrieve documents for a chain or tool',
          },
        ],
      },
      ...spec.properties,
      {
        displayName: 'Prompt',
        name: 'prompt',
        type: 'string',
        default: '={{ $json.chatInput }}',
        required: true,
        description: 'Text to search for',
        displayOptions: { show: { mode: ['load'] } },
      },
      {
        displayName: 'Limit',
        name: 'topK',
        type: 'number',
        default: 4,
        typeOptions: { minValue: 1, maxValue: 1000 },
        description: 'Number of documents to return',
        displayOptions: { show: { mode: ['load'] } },
      },
      {
        displayName: 'Include Metadata',
        name: 'includeDocumentMetadata',
        type: 'boolean',
        default: true,
        displayOptions: { show: { mode: ['load'] } },
      },
      {
        displayName: 'Options',
        name: 'options',
        type: 'collection',
        default: {},
        placeholder: 'Add option',
        displayOptions: { show: { mode: ['load', 'retrieve'] } },
        options: [metadataFilterProperty],
      },
      {
        displayName: 'Options',
        name: 'options',
        type: 'collection',
        default: {},
        placeholder: 'Add option',
        displayOptions: { show: { mode: ['insert'] } },
        options: spec.insertOptions ?? [],
      },
    ],
  };

  return {
    description,

    async execute(ctx) {
      const mode = ctx.getNodeParameter('mode', 0, 'retrieve') as string;
      const items = ctx.getInputData();
      if (mode === 'retrieve') {
        throw new NodeOperationError(
          ctx.getNode(),
          'In "Retrieve Documents" mode this node only works as a sub-node',
          {
            description:
              'Connect its output to a chain, retriever or vector store tool, or change the operation mode.',
          },
        );
      }
      const embeddings = (await getEmbeddings(ctx, 0))!;
      const { backend, close } = await spec.open(ctx, 0);
      try {
        if (mode === 'insert') return [await insert(ctx, backend, embeddings, items)];
        const out: Item[] = [];
        for (let i = 0; i < items.length; i++) {
          try {
            const prompt = String(ctx.getNodeParameter('prompt', i, '') ?? '');
            if (!prompt.trim())
              throw new NodeOperationError(ctx.getNode(), 'The prompt is empty', { itemIndex: i });
            const topK = Number(ctx.getNodeParameter('topK', i, 4));
            const includeMetadata = ctx.getNodeParameter('includeDocumentMetadata', i, true) !== false;
            const store = toAiVectorStore(backend, embeddings, readFilter(ctx, i));
            for (const { document, score } of await store.similaritySearch(prompt, topK)) {
              out.push({
                json: {
                  document: includeMetadata
                    ? { pageContent: document.pageContent, metadata: document.metadata }
                    : { pageContent: document.pageContent },
                  score,
                },
                pairedItem: { item: i },
              });
            }
          } catch (error) {
            if (!ctx.continueOnFail()) throw error;
            out.push({
              json: { error: errorMessage(error) },
              error: { message: errorMessage(error) },
              pairedItem: { item: i },
            });
          }
        }
        return [out];
      } finally {
        await close?.().catch(() => {});
      }
    },

    async supplyData(ctx, itemIndex) {
      const embeddings = (await getEmbeddings(ctx, itemIndex))!;
      const { backend, close } = await spec.open(ctx, itemIndex);
      return {
        response: toAiVectorStore(backend, embeddings, readFilter(ctx, itemIndex), (input, output, error) =>
          ctx.logSubNodeRun(input, output, error),
        ),
        closeFunction: close,
      };
    },
  };
}

async function insert(
  ctx: Parameters<NonNullable<NodeType['execute']>>[0],
  backend: VectorBackend,
  embeddings: AiEmbeddings,
  items: Item[],
): Promise<Item[]> {
  const loader = (await getDocumentLoader(ctx, 0))!;
  const options = ctx.getNodeParameter('options', 0, {}) as DataObject;
  if (options.clearStore && backend.clear) await backend.clear();
  const out: Item[] = [];
  const documents: AiDocument[] = [];
  for (let i = 0; i < items.length; i++) {
    const docs = await loader.load([items[i]]);
    for (const doc of docs) {
      documents.push(doc);
      out.push({ json: { pageContent: doc.pageContent, metadata: doc.metadata }, pairedItem: { item: i } });
    }
  }
  await toAiVectorStore(backend, embeddings, undefined).addDocuments(documents);
  return out;
}

export const clearStoreOption: NodeProperty = {
  displayName: 'Clear Store',
  name: 'clearStore',
  type: 'boolean',
  default: false,
  description: 'Whether to delete all documents in the store before inserting',
};
