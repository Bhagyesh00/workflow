/** Summarization (map-reduce / refine / stuff), Retrieval Q&A and the vector store retriever. */
import {
  type AiChatModel,
  type AiDocument,
  type AiRetriever,
  type DataObject,
  type Item,
  NodeOperationError,
  type NodeType,
} from '@workflow/workflow';
import {
  documentsToContext,
  getChatModel,
  getPrompt,
  getRetriever,
  getTextSplitter,
  getVectorStore,
  promptTextProperty,
  promptTypeProperty,
} from '../../shared/ai-inputs';
import { batchingOption, runInBatches } from '../../shared/batching';
import { splitRecursively } from '../../shared/text-splitting';
import { errorMessage, fillTemplate, mapLimit, messageText } from '../../shared/utils';

const MODEL_INPUT = {
  type: 'ai_languageModel' as const,
  displayName: 'Model',
  required: true,
  maxConnections: 1,
};

// ---------------------------------------------------------------------------------------------
// Summarization
// ---------------------------------------------------------------------------------------------

export const MAP_PROMPT = 'Write a concise summary of the following:\n\n"{text}"\n\nCONCISE SUMMARY:';
export const COMBINE_PROMPT =
  'The following are summaries of parts of one text. Combine them into one concise, coherent summary:\n\n"{text}"\n\nCONCISE SUMMARY:';
export const REFINE_PROMPT =
  'Your job is to produce a final summary.\nWe have provided an existing summary up to a certain point: "{existing_answer}"\nWe have the opportunity to refine the existing summary (only if needed) with some more context below.\n------------\n"{text}"\n------------\nGiven the new context, refine the original summary. If the context is not useful, return the original summary.\n\nREFINED SUMMARY:';

/** rounds of collapsing partial summaries before the final combine */
const MAX_REDUCE_ROUNDS = 6;

async function complete(model: AiChatModel, prompt: string, signal?: AbortSignal): Promise<string> {
  const response = await model.chat({ messages: [{ role: 'user', content: prompt }], signal });
  return messageText(response.message.content).trim();
}

export interface SummarizeOptions {
  method: 'mapReduce' | 'refine' | 'stuff';
  chunkSize: number;
  mapPrompt: string;
  combinePrompt: string;
  refinePrompt: string;
  concurrency: number;
  signal?: AbortSignal;
}

export async function summarize(
  model: AiChatModel,
  chunks: string[],
  options: SummarizeOptions,
): Promise<string> {
  if (!chunks.length) return '';
  if (options.method === 'stuff') {
    return complete(model, fillTemplate(options.mapPrompt, { text: chunks.join('\n\n') }), options.signal);
  }
  if (options.method === 'refine') {
    let summary = await complete(model, fillTemplate(options.mapPrompt, { text: chunks[0] }), options.signal);
    for (const chunk of chunks.slice(1)) {
      summary = await complete(
        model,
        fillTemplate(options.refinePrompt, { existing_answer: summary, text: chunk }),
        options.signal,
      );
    }
    return summary;
  }
  // map: one summary per chunk, a few in parallel
  let summaries = await mapLimit(chunks, options.concurrency, (chunk) =>
    complete(model, fillTemplate(options.mapPrompt, { text: chunk }), options.signal),
  );
  if (summaries.length === 1) return summaries[0];
  // reduce: collapse groups that fit the chunk size until one combine call can take them all
  for (
    let round = 0;
    round < MAX_REDUCE_ROUNDS && summaries.join('\n\n').length > options.chunkSize;
    round++
  ) {
    const groups: string[][] = [[]];
    let size = 0;
    for (const s of summaries) {
      if (size + s.length > options.chunkSize && groups[groups.length - 1].length) {
        groups.push([]);
        size = 0;
      }
      groups[groups.length - 1].push(s);
      size += s.length + 2;
    }
    if (groups.length === summaries.length) break; // nothing collapses further
    summaries = await mapLimit(groups, options.concurrency, (group) =>
      complete(model, fillTemplate(options.combinePrompt, { text: group.join('\n\n') }), options.signal),
    );
  }
  return complete(
    model,
    fillTemplate(options.combinePrompt, { text: summaries.join('\n\n') }),
    options.signal,
  );
}

export const ChainSummarizationNode: NodeType = {
  description: {
    name: 'ai.chainSummarization',
    displayName: 'Summarization Chain',
    description: 'Summarizes long text by splitting it into chunks (map-reduce, refine or single call)',
    icon: 'lucide:list-collapse',
    group: ['transform'],
    version: 1,
    defaults: { name: 'Summarization Chain' },
    inputs: [
      'main',
      MODEL_INPUT,
      { type: 'ai_textSplitter', displayName: 'Text Splitter', maxConnections: 1 },
    ],
    outputs: ['main'],
    categories: ['AI', 'Chains'],
    alias: ['summary', 'summarize', 'tl;dr', 'condense'],
    properties: [
      {
        displayName: 'Text',
        name: 'text',
        type: 'string',
        default: '={{ $json.text }}',
        typeOptions: { rows: 2 },
        description: 'Text to summarize',
      },
      {
        displayName: 'Summarization Method',
        name: 'summarizationMethod',
        type: 'options',
        default: 'mapReduce',
        options: [
          {
            name: 'Map Reduce (Recommended)',
            value: 'mapReduce',
            description: 'Summarize chunks in parallel, then combine',
          },
          { name: 'Refine', value: 'refine', description: 'Improve a running summary chunk by chunk' },
          { name: 'Stuff', value: 'stuff', description: 'One call with the whole text (short texts only)' },
        ],
      },
      {
        displayName: 'Options',
        name: 'options',
        type: 'collection',
        default: {},
        placeholder: 'Add option',
        options: [
          {
            displayName: 'Chunk Size',
            name: 'chunkSize',
            type: 'number',
            default: 4000,
            description: 'Characters per chunk when no text splitter is connected',
          },
          { displayName: 'Chunk Overlap', name: 'chunkOverlap', type: 'number', default: 200 },
          {
            displayName: 'Summary Prompt',
            name: 'mapPrompt',
            type: 'string',
            default: MAP_PROMPT,
            typeOptions: { rows: 4 },
          },
          {
            displayName: 'Combine Prompt',
            name: 'combinePrompt',
            type: 'string',
            default: COMBINE_PROMPT,
            typeOptions: { rows: 4 },
          },
          {
            displayName: 'Refine Prompt',
            name: 'refinePrompt',
            type: 'string',
            default: REFINE_PROMPT,
            typeOptions: { rows: 6 },
          },
          {
            displayName: 'Parallel Requests',
            name: 'concurrency',
            type: 'number',
            default: 4,
            typeOptions: { minValue: 1, maxValue: 16 },
          },
        ],
      },
    ],
  },
  async execute(ctx) {
    const items = ctx.getInputData();
    const out: Item[] = [];
    for (let i = 0; i < items.length; i++) {
      try {
        const value = ctx.getNodeParameter('text', i, '');
        const text = typeof value === 'string' ? value : JSON.stringify(value ?? '');
        if (!text.trim())
          throw new NodeOperationError(ctx.getNode(), 'The text to summarize is empty', { itemIndex: i });
        const options = ctx.getNodeParameter('options', i, {}) as DataObject;
        const chunkSize = Number(options.chunkSize ?? 4000);
        const splitter = await getTextSplitter(ctx, i);
        const chunks = splitter
          ? await splitter.split(text)
          : splitRecursively(text, {
              chunkSize,
              chunkOverlap: Math.min(Number(options.chunkOverlap ?? 200), chunkSize - 1),
            });
        const model = await getChatModel(ctx, i);
        const summary = await summarize(model, chunks, {
          method:
            (ctx.getNodeParameter('summarizationMethod', i, 'mapReduce') as SummarizeOptions['method']) ??
            'mapReduce',
          chunkSize,
          mapPrompt: String(options.mapPrompt ?? MAP_PROMPT),
          combinePrompt: String(options.combinePrompt ?? COMBINE_PROMPT),
          refinePrompt: String(options.refinePrompt ?? REFINE_PROMPT),
          concurrency: Number(options.concurrency ?? 4),
          signal: ctx.signal,
        });
        out.push({ json: { text: summary, chunks: chunks.length }, pairedItem: { item: i } });
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
  },
};

// ---------------------------------------------------------------------------------------------
// Retrieval Q&A
// ---------------------------------------------------------------------------------------------

export const QA_PROMPT =
  "You are an assistant for question-answering tasks. Use the following pieces of retrieved context to answer the question. If you don't know the answer, say that you don't know.\n----------------\nContext: {context}";

export const ChainRetrievalQaNode: NodeType = {
  description: {
    name: 'ai.chainRetrievalQa',
    displayName: 'Question and Answer Chain',
    description: 'Answers a question from documents found by a retriever or vector store',
    icon: 'lucide:message-circle-question',
    group: ['transform'],
    version: 1,
    defaults: { name: 'Question and Answer Chain' },
    inputs: [
      'main',
      MODEL_INPUT,
      { type: 'ai_retriever', displayName: 'Retriever', maxConnections: 1 },
      { type: 'ai_vectorStore', displayName: 'Vector Store', maxConnections: 1 },
    ],
    outputs: ['main'],
    categories: ['AI', 'Chains'],
    alias: ['rag', 'qa', 'knowledge base', 'retrieval'],
    properties: [
      promptTypeProperty,
      promptTextProperty,
      {
        displayName: 'Options',
        name: 'options',
        type: 'collection',
        default: {},
        placeholder: 'Add option',
        options: [
          {
            displayName: 'System Prompt Template',
            name: 'systemPromptTemplate',
            type: 'string',
            default: QA_PROMPT,
            typeOptions: { rows: 6 },
            description: 'Uses {context} for the retrieved documents',
          },
          {
            displayName: 'Documents to Retrieve',
            name: 'topK',
            type: 'number',
            default: 4,
            typeOptions: { minValue: 1, maxValue: 100 },
            description: 'Used with a vector store input',
          },
          {
            displayName: 'Return Source Documents',
            name: 'returnSourceDocuments',
            type: 'boolean',
            default: false,
          },
          batchingOption(5),
        ],
      },
    ],
  },
  async execute(ctx) {
    const items = ctx.getInputData();
    const batching = ((ctx.getNodeParameter('options', 0, {}) as DataObject).batching ?? {}) as DataObject;
    const size = Number(batching.batchSize ?? 5);
    const delay = Number(batching.delayBetweenBatches ?? 0);
    const settled = await runInBatches(
      items.length,
      {
        batchSize: Number.isFinite(size) && size >= 1 ? Math.floor(size) : 5,
        delayMs: Number.isFinite(delay) && delay > 0 ? delay : 0,
        signal: ctx.signal,
      },
      async (i): Promise<Item> => {
        const question = getPrompt(ctx, i, items[i]);
        const options = ctx.getNodeParameter('options', i, {}) as DataObject;
        const retriever = await getRetriever(ctx, i);
        const store = retriever ? undefined : await getVectorStore(ctx, i, false);
        if (!retriever && !store) {
          throw new NodeOperationError(ctx.getNode(), 'Connect a retriever or a vector store', {
            itemIndex: i,
          });
        }
        const documents: AiDocument[] = retriever
          ? await retriever.retrieve(question)
          : (await store!.similaritySearch(question, Number(options.topK ?? 4))).map((r) => r.document);
        const model = await getChatModel(ctx, i);
        const response = await model.chat({
          messages: [
            {
              role: 'system',
              content: fillTemplate(String(options.systemPromptTemplate ?? QA_PROMPT), {
                context: documentsToContext(documents),
              }),
            },
            { role: 'user', content: question },
          ],
          signal: ctx.signal,
        });
        const json: DataObject = { response: messageText(response.message.content) };
        if (options.returnSourceDocuments) {
          json.sourceDocuments = documents.map((d) => ({ pageContent: d.pageContent, metadata: d.metadata }));
        }
        return { json, pairedItem: { item: i } };
      },
    );
    const out: Item[] = [];
    for (let i = 0; i < items.length; i++) {
      const result = settled[i];
      if (result.status === 'fulfilled') {
        out.push(result.value);
        continue;
      }
      if (!ctx.continueOnFail()) throw result.reason;
      out.push({
        json: { error: errorMessage(result.reason) },
        error: { message: errorMessage(result.reason) },
        pairedItem: { item: i },
      });
    }
    return [out];
  },
};

// ---------------------------------------------------------------------------------------------
// Vector store retriever
// ---------------------------------------------------------------------------------------------

export const RetrieverVectorStoreNode: NodeType = {
  description: {
    name: 'ai.retrieverVectorStore',
    displayName: 'Vector Store Retriever',
    description: 'Uses a vector store as a retriever for chains',
    icon: 'lucide:search',
    group: ['transform'],
    version: 1,
    defaults: { name: 'Vector Store Retriever' },
    inputs: [{ type: 'ai_vectorStore', displayName: 'Vector Store', required: true, maxConnections: 1 }],
    outputs: ['ai_retriever'],
    outputNames: ['Retriever'],
    categories: ['AI', 'Retrievers'],
    alias: ['rag', 'search'],
    properties: [
      {
        displayName: 'Limit',
        name: 'topK',
        type: 'number',
        default: 4,
        typeOptions: { minValue: 1, maxValue: 100 },
        description: 'Number of documents to retrieve',
      },
    ],
  },
  async supplyData(ctx, itemIndex) {
    const store = (await getVectorStore(ctx, itemIndex))!;
    const topK = Number(ctx.getNodeParameter('topK', itemIndex, 4));
    const retriever: AiRetriever = {
      kind: 'retriever',
      async retrieve(query) {
        const documents = (await store.similaritySearch(query, topK)).map((r) => r.document);
        ctx.logSubNodeRun({ query }, { documents });
        return documents;
      },
    };
    return { response: retriever };
  },
};

export const ragChainNodes: NodeType[] = [
  ChainSummarizationNode,
  ChainRetrievalQaNode,
  RetrieverVectorStoreNode,
];
