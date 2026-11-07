/**
 * Shared behaviour of the vector store nodes. One node works in up to five modes (a store lists the
 * ones it allows in `spec.modes`):
 * - insert: main input + document loader + embeddings; adds the documents, outputs them;
 * - update: main input + embeddings; replaces the document with the given id by the item JSON;
 * - load: main input + embeddings; returns the top-k documents for a prompt as items;
 * - retrieve: sub-node; supplies an `AiVectorStore` to chains and retrievers;
 * - retrieve-as-tool: sub-node; supplies a search tool to an agent.
 * Ports change with the mode and with Use Reranker (`inputs` / `outputs` are expressions over
 * `$parameter.mode` and `$parameter.useReranker`).
 */
import {
  type AiDocument,
  type AiEmbeddings,
  type AiReranker,
  type AiVectorStore,
  type BaseContext,
  type DataObject,
  type ExecuteContext,
  type Item,
  NodeOperationError,
  type NodeProperty,
  type NodeType,
  type NodeTypeDescription,
  type SupplyDataContext,
} from '@workflow/workflow';
import { getDocumentLoader, getEmbeddings, getReranker } from '../../shared/ai-inputs';
import { createTool, toolDescriptionProperty, toolNameOf } from '../../shared/tools';
import { collectionList, errorMessage } from '../../shared/utils';
import { flattenJson } from '../document-loaders/DocumentDefaultDataLoader.node';

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
const RERANK = '($parameter.useReranker === true)';
const EMBEDDING_INPUT =
  "{ type: 'ai_embedding', displayName: 'Embedding', required: true, maxConnections: 1 }";
const DOCUMENT_INPUT = "{ type: 'ai_document', displayName: 'Document', required: true, maxConnections: 1 }";
const RERANKER_INPUT = "{ type: 'ai_reranker', displayName: 'Reranker', required: true, maxConnections: 1 }";

export const VECTOR_STORE_INPUTS = `={{ ${MODE} === 'insert' ? ['main', ${DOCUMENT_INPUT}, ${EMBEDDING_INPUT}] : ${MODE} === 'update' ? ['main', ${EMBEDDING_INPUT}] : ${MODE} === 'load' ? (${RERANK} ? ['main', ${EMBEDDING_INPUT}, ${RERANKER_INPUT}] : ['main', ${EMBEDDING_INPUT}]) : (${RERANK} ? [${EMBEDDING_INPUT}, ${RERANKER_INPUT}] : [${EMBEDDING_INPUT}]) }}`;
export const VECTOR_STORE_OUTPUTS = `={{ ${MODE} === 'retrieve' ? [{ type: 'ai_vectorStore', displayName: 'Vector Store' }] : ${MODE} === 'retrieve-as-tool' ? [{ type: 'ai_tool', displayName: 'Tool' }] : ['main'] }}`;

/** documents embedded and written per call; the node's Embedding Batch Size option replaces it */
export const DEFAULT_EMBEDDING_BATCH_SIZE = 200;
const MAX_EMBEDDING_BATCH_SIZE = 10_000;

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

const searchFilterJsonProperty: NodeProperty = {
  displayName: 'Search Filter (JSON)',
  name: 'searchFilterJson',
  type: 'json',
  default: '',
  typeOptions: { rows: 4 },
  description: "A filter in the store's own query language, passed on with every search",
};

const embeddingBatchSizeProperty: NodeProperty = {
  displayName: 'Embedding Batch Size',
  name: 'embeddingBatchSize',
  type: 'number',
  default: DEFAULT_EMBEDDING_BATCH_SIZE,
  typeOptions: { minValue: 1, maxValue: MAX_EMBEDDING_BATCH_SIZE },
  description: 'Documents sent to the embeddings model in one request',
};

const MODE_OPTIONS: Array<{
  name: string;
  value: VectorStoreMode;
  description: string;
  action: string;
}> = [
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
  {
    name: 'Retrieve Documents (As Tool for AI Agent)',
    value: 'retrieve-as-tool',
    description: 'Let an AI agent search the store as a tool',
    action: 'Retrieve documents as a tool for an agent',
  },
  {
    name: 'Update Documents',
    value: 'update',
    description: 'Replace the document with a given ID by the item data',
    action: 'Update documents',
  },
];

function parseJsonObject(ctx: BaseContext, raw: unknown, label: string): DataObject | undefined {
  if (raw === undefined || raw === null || raw === '') return undefined;
  let value: unknown = raw;
  if (typeof raw === 'string') {
    if (!raw.trim()) return undefined;
    try {
      value = JSON.parse(raw);
    } catch {
      throw new NodeOperationError(ctx.getNode(), `${label} is not valid JSON`);
    }
  }
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new NodeOperationError(ctx.getNode(), `${label} must be a JSON object`);
  }
  return value as DataObject;
}

function readFilter(
  ctx: BaseContext,
  itemIndex: number,
  kind: NonNullable<VectorStoreSpec['filter']>,
): DataObject | undefined {
  if (kind === 'none') return undefined;
  const options = ctx.getNodeParameter('options', itemIndex, {}) as DataObject;
  if (kind === 'json') return parseJsonObject(ctx, options.searchFilterJson, 'The search filter');
  const entries = collectionList<{ name: string; value: unknown }>(options.metadata, 'metadataValues').filter(
    (e) => e.name,
  );
  return entries.length ? Object.fromEntries(entries.map((e) => [e.name, e.value])) : undefined;
}

function batchSizeOf(ctx: BaseContext, itemIndex: number): number {
  const options = ctx.getNodeParameter('options', itemIndex, {}) as DataObject;
  const n = Math.trunc(Number(options.embeddingBatchSize));
  return Number.isFinite(n) && n >= 1 ? Math.min(n, MAX_EMBEDDING_BATCH_SIZE) : DEFAULT_EMBEDDING_BATCH_SIZE;
}

/** Embeds `documents` in groups of `batchSize` and writes each group; `ids` has one entry per document. */
async function addInBatches(
  backend: VectorBackend,
  embeddings: AiEmbeddings,
  documents: AiDocument[],
  batchSize: number,
  ids?: string[],
): Promise<void> {
  for (let start = 0; start < documents.length; start += batchSize) {
    const batch = documents.slice(start, start + batchSize);
    const vectors = await embeddings.embedDocuments(batch.map((d) => d.pageContent));
    await backend.add(batch, vectors, ids?.slice(start, start + batchSize));
  }
}

function withoutRelevanceScore(document: AiDocument): AiDocument {
  const metadata = { ...document.metadata };
  delete metadata.relevanceScore;
  return { pageContent: document.pageContent, metadata };
}

/**
 * `AiVectorStore` for chains and tools: embeds texts and queries with the connected model. With a
 * reranker the search results are reranked and the score is the reranker's.
 */
export function toAiVectorStore(
  backend: VectorBackend,
  embeddings: AiEmbeddings,
  defaultFilter: DataObject | undefined,
  log?: SupplyDataContext['logSubNodeRun'],
  reranker?: AiReranker,
): AiVectorStore {
  return {
    kind: 'vectorStore',
    async addDocuments(documents) {
      await addInBatches(backend, embeddings, documents, DEFAULT_EMBEDDING_BATCH_SIZE);
      log?.({ action: 'addDocuments', documents: documents.length }, { ok: true });
    },
    async similaritySearch(query, k, filter) {
      const vector = await embeddings.embedQuery(query);
      let results = await backend.search(
        vector,
        Math.max(1, Math.min(k, 1000)),
        filter ?? defaultFilter,
        query,
      );
      if (reranker && results.length) {
        const ranked = await reranker.rerank(
          query,
          results.map((r) => r.document),
        );
        results = ranked.map(({ document, score }) => ({ document: withoutRelevanceScore(document), score }));
      }
      log?.(
        { action: 'similaritySearch', query, k },
        { documents: results.map((r) => ({ ...r.document, score: r.score })) },
      );
      return results;
    },
  };
}

export function createVectorStoreNode(spec: VectorStoreSpec): NodeType {
  const modes = spec.modes ?? DEFAULT_VECTOR_STORE_MODES;
  const filterKind = spec.filter ?? 'metadata';
  const searchOptions: NodeProperty[] = [
    ...(filterKind === 'metadata' ? [metadataFilterProperty] : []),
    ...(filterKind === 'json' ? [searchFilterJsonProperty] : []),
    ...(spec.retrieveOptions ?? []),
  ];
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
        options: MODE_OPTIONS.filter((o) => modes.includes(o.value)),
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
        displayName: 'ID',
        name: 'id',
        type: 'string',
        default: '',
        required: true,
        description: 'ID of the document to replace',
        displayOptions: { show: { mode: ['update'] } },
      },
      {
        ...toolDescriptionProperty('e.g. Search the product manuals'),
        displayOptions: { show: { mode: ['retrieve-as-tool'] } },
      },
      {
        displayName: 'Limit',
        name: 'topK',
        type: 'number',
        default: 4,
        typeOptions: { minValue: 1, maxValue: 1000 },
        description: 'Number of documents to return',
        displayOptions: { show: { mode: ['load', 'retrieve-as-tool'] } },
      },
      {
        displayName: 'Include Metadata',
        name: 'includeDocumentMetadata',
        type: 'boolean',
        default: true,
        displayOptions: { show: { mode: ['load', 'retrieve-as-tool'] } },
      },
      {
        displayName: 'Use Reranker',
        name: 'useReranker',
        type: 'boolean',
        default: false,
        description: 'Whether to rerank the results with a connected reranker',
        displayOptions: { show: { mode: ['load', 'retrieve', 'retrieve-as-tool'] } },
      },
      ...(searchOptions.length
        ? [
            {
              displayName: 'Options',
              name: 'options',
              type: 'collection' as const,
              default: {},
              placeholder: 'Add option',
              displayOptions: { show: { mode: ['load', 'retrieve', 'retrieve-as-tool'] } },
              options: searchOptions,
            },
          ]
        : []),
      {
        displayName: 'Options',
        name: 'options',
        type: 'collection',
        default: {},
        placeholder: 'Add option',
        displayOptions: { show: { mode: ['insert'] } },
        options: [...(spec.insertOptions ?? []), embeddingBatchSizeProperty],
      },
    ],
  };

  const requireMode = (ctx: BaseContext, mode: string): void => {
    if (!modes.includes(mode as VectorStoreMode)) {
      throw new NodeOperationError(
        ctx.getNode(),
        mode === 'update'
          ? 'Update operation is not implemented for this Vector Store'
          : `The operation mode "${mode}" is not available for this Vector Store`,
      );
    }
  };

  const rerankerFor = async (
    ctx: ExecuteContext | SupplyDataContext,
    itemIndex: number,
  ): Promise<AiReranker | undefined> => {
    if (ctx.getNodeParameter('useReranker', itemIndex, false) !== true) return undefined;
    const reranker = await getReranker(ctx, itemIndex);
    if (!reranker) {
      throw new NodeOperationError(ctx.getNode(), 'Use Reranker is on but no reranker is connected', {
        itemIndex,
      });
    }
    return reranker;
  };

  return {
    description,
    methods: spec.methods,

    async execute(ctx) {
      const mode = ctx.getNodeParameter('mode', 0, 'retrieve') as string;
      requireMode(ctx, mode);
      const items = ctx.getInputData();
      if (mode === 'retrieve' || mode === 'retrieve-as-tool') {
        throw new NodeOperationError(
          ctx.getNode(),
          mode === 'retrieve'
            ? 'In "Retrieve Documents" mode this node only works as a sub-node'
            : 'In "Retrieve Documents (As Tool for AI Agent)" mode this node only works as a sub-node',
          {
            description:
              'Connect its output to a chain, retriever, vector store tool or agent, or change the operation mode.',
          },
        );
      }
      const embeddings = (await getEmbeddings(ctx, 0))!;
      const { backend, close } = await spec.open(ctx, 0);
      try {
        if (mode === 'insert') return [await insert(ctx, backend, embeddings, items)];
        const out: Item[] = [];
        const reranker = mode === 'load' ? await rerankerFor(ctx, 0) : undefined;
        for (let i = 0; i < items.length; i++) {
          try {
            if (mode === 'update') {
              out.push(await updateDocument(ctx, backend, embeddings, items[i], i));
              continue;
            }
            const prompt = String(ctx.getNodeParameter('prompt', i, '') ?? '');
            if (!prompt.trim())
              throw new NodeOperationError(ctx.getNode(), 'The prompt is empty', { itemIndex: i });
            const topK = Number(ctx.getNodeParameter('topK', i, 4));
            const includeMetadata = ctx.getNodeParameter('includeDocumentMetadata', i, true) !== false;
            const store = toAiVectorStore(
              backend,
              embeddings,
              readFilter(ctx, i, filterKind),
              undefined,
              reranker,
            );
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
      const mode = ctx.getNodeParameter('mode', itemIndex, 'retrieve') as string;
      requireMode(ctx, mode);
      const embeddings = (await getEmbeddings(ctx, itemIndex))!;
      const reranker = await rerankerFor(ctx, itemIndex);
      const toolDescription = String(ctx.getNodeParameter('toolDescription', itemIndex, '') ?? '').trim();
      if (mode === 'retrieve-as-tool' && !toolDescription) {
        throw new NodeOperationError(ctx.getNode(), 'Enter a description for the tool', { itemIndex });
      }
      const { backend, close } = await spec.open(ctx, itemIndex);
      const filter = readFilter(ctx, itemIndex, filterKind);
      if (mode !== 'retrieve-as-tool') {
        return {
          response: toAiVectorStore(
            backend,
            embeddings,
            filter,
            (input, output, error) => ctx.logSubNodeRun(input, output, error),
            reranker,
          ),
          closeFunction: close,
        };
      }
      const topK = Number(ctx.getNodeParameter('topK', itemIndex, 4));
      const includeMetadata = ctx.getNodeParameter('includeDocumentMetadata', itemIndex, true) !== false;
      const store = toAiVectorStore(backend, embeddings, filter, undefined, reranker);
      return {
        response: createTool(
          ctx,
          {
            name: toolNameOf(ctx),
            description: toolDescription,
            parameters: {
              type: 'object',
              properties: { input: { type: 'string', description: 'Query to search for. Required' } },
              required: ['input'],
            },
          },
          async (args) => {
            const query = typeof args.input === 'string' ? args.input.trim() : '';
            if (!query) throw new NodeOperationError(ctx.getNode(), 'The "input" argument is required');
            const found = await store.similaritySearch(query, topK);
            // one JSON text per document, one per line
            return found
              .map(({ document }) =>
                JSON.stringify(
                  includeMetadata
                    ? { pageContent: document.pageContent, metadata: document.metadata }
                    : { pageContent: document.pageContent },
                ),
              )
              .join('\n');
          },
        ),
        closeFunction: close,
      };
    },
  };
}

async function insert(
  ctx: ExecuteContext,
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
  await addInBatches(backend, embeddings, documents, batchSizeOf(ctx, 0));
  return out;
}

/** Update mode: the item JSON, flattened to text, replaces the document stored under the ID parameter. */
async function updateDocument(
  ctx: ExecuteContext,
  backend: VectorBackend,
  embeddings: AiEmbeddings,
  item: Item,
  itemIndex: number,
): Promise<Item> {
  const id = String(ctx.getNodeParameter('id', itemIndex, '') ?? '').trim();
  if (!id) throw new NodeOperationError(ctx.getNode(), 'The ID is empty', { itemIndex });
  const data: unknown = item.json;
  if (!data || typeof data !== 'object' || Array.isArray(data)) {
    throw new NodeOperationError(ctx.getNode(), 'Single document per item expected', { itemIndex });
  }
  const pageContent = flattenJson(data).join('\n');
  if (!pageContent) {
    throw new NodeOperationError(ctx.getNode(), 'Single document per item expected', {
      itemIndex,
      description: 'The item has no data to store.',
    });
  }
  await addInBatches(backend, embeddings, [{ pageContent, metadata: {} }], 1, [id]);
  return { json: { id, pageContent }, pairedItem: { item: itemIndex } };
}

export const clearStoreOption: NodeProperty = {
  displayName: 'Clear Store',
  name: 'clearStore',
  type: 'boolean',
  default: false,
  description: 'Whether to delete all documents in the store before inserting',
};
