/** Summarization (map-reduce / refine / stuff) and Retrieval Q&A; the retrievers are in nodes/retrievers. */
import {
  type AiChatModel,
  type AiDocument,
  type AiDocumentLoader,
  type DataObject,
  type ExecuteContext,
  type Item,
  NodeOperationError,
  type NodeType,
} from '@workflow/workflow';
import {
  documentsToContext,
  getChatModel,
  getDocumentLoader,
  getPrompt,
  getRetriever,
  getTextSplitter,
  getVectorStore,
  promptTextProperty,
  promptTypeProperty,
} from '../../shared/ai-inputs';
import { batchingOption, runInBatches } from '../../shared/batching';
import { fileToSources, itemJsonToSources } from '../../shared/file-text';
import { splitRecursively } from '../../shared/text-splitting';
import { errorMessage, fillTemplate, mapLimit, messageText } from '../../shared/utils';

const MODEL_INPUT = {
  type: 'ai_languageModel' as const,
  displayName: 'Model',
  required: true,
  maxConnections: 1,
};
const DOCUMENT_INPUT = {
  type: 'ai_document' as const,
  displayName: 'Document',
  required: true,
  maxConnections: 1,
};
const SPLITTER_INPUT = { type: 'ai_textSplitter' as const, displayName: 'Text Splitter', maxConnections: 1 };

// ---------------------------------------------------------------------------------------------
// Summarization
// ---------------------------------------------------------------------------------------------

export const MAP_PROMPT = 'Write a concise summary of the following:\n\n"{text}"\n\nCONCISE SUMMARY:';
export const REFINE_PROMPT =
  'Your job is to produce a final summary.\nWe have provided an existing summary up to a certain point: "{existing_answer}"\nWe have the opportunity to refine the existing summary (only if needed) with some more context below.\n------------\n"{text}"\n------------\nGiven the new context, refine the original summary. If the context is not useful, return the original summary.\n\nREFINED SUMMARY:';

/** rounds of collapsing partial summaries before the final combine */
const MAX_REDUCE_ROUNDS = 6;

async function complete(model: AiChatModel, prompt: string, signal?: AbortSignal): Promise<string> {
  const response = await model.chat({ messages: [{ role: 'user', content: prompt }], signal });
  return messageText(response.message.content).trim();
}

export interface SummarizeOptions {
  method: 'map_reduce' | 'refine' | 'stuff';
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

const SUMMARY_INPUTS = `={{ ['main', ${JSON.stringify(MODEL_INPUT)}, ...(($parameter.operationMode ?? 'nodeInputJson') === 'documentLoader' ? [${JSON.stringify(DOCUMENT_INPUT)}] : []), ...(($parameter.operationMode ?? 'nodeInputJson') !== 'documentLoader' && $parameter.chunkingMode === 'advanced' ? [${JSON.stringify(SPLITTER_INPUT)}] : [])] }}`;

const NOT_DOCUMENT_LOADER = { operationMode: ['nodeInputJson', 'nodeInputBinary'] };

/** the texts to summarize for one item, one per chunk */
async function summaryChunks(
  ctx: ExecuteContext,
  items: Item[],
  i: number,
  mode: string,
  chunking: { size: number; overlap: number },
  options: DataObject,
): Promise<string[]> {
  if (mode === 'documentLoader') {
    const loader = await getDocumentLoader(ctx, i);
    const documents = await loader!.load([items[i] as Parameters<AiDocumentLoader['load']>[0][number]]);
    return documents.map((d) => d.pageContent).filter((text) => text.trim() !== '');
  }
  let text: string;
  if (mode === 'nodeInputBinary') {
    const key = String(options.binaryDataKey ?? 'data') || 'data';
    const binary = items[i].binary?.[key];
    if (!binary) {
      throw new NodeOperationError(ctx.getNode(), `The item has no binary property "${key}"`, {
        itemIndex: i,
      });
    }
    const bytes = binary.id
      ? await ctx.helpers.getBinaryDataBuffer(i, key)
      : Buffer.from(binary.data ?? '', 'base64');
    const sources = await fileToSources(
      ctx,
      i,
      { bytes, mimeType: binary.mimeType, fileName: binary.fileName },
      { loader: 'auto', splitPages: false },
    );
    text = sources.map((source) => source.text).join('\n\n');
  } else {
    const value = ctx.getNodeParameter('text', i, '');
    // no Text set: summarize the whole item JSON, as n8n does
    text =
      value === undefined || value === null || (typeof value === 'string' && value.trim() === '')
        ? itemJsonToSources(items[i].json)
            .map((source) => source.text)
            .join('\n')
        : typeof value === 'string'
          ? value
          : JSON.stringify(value);
  }
  if (!text.trim())
    throw new NodeOperationError(ctx.getNode(), 'The text to summarize is empty', { itemIndex: i });
  if (ctx.getNodeParameter('chunkingMode', i, 'simple') === 'advanced') {
    const splitter = await getTextSplitter(ctx, i, true);
    return splitter!.split(text);
  }
  return splitRecursively(text, {
    chunkSize: chunking.size,
    chunkOverlap: Math.min(chunking.overlap, chunking.size - 1),
  });
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
    inputs: SUMMARY_INPUTS,
    outputs: ['main'],
    categories: ['AI', 'Chains'],
    alias: ['summary', 'summarize', 'tl;dr', 'condense'],
    properties: [
      {
        displayName: 'Data to Summarize',
        name: 'operationMode',
        type: 'options',
        default: 'nodeInputJson',
        noDataExpression: true,
        options: [
          {
            name: 'Use Node Input (JSON)',
            value: 'nodeInputJson',
            description: 'Summarize the Text field, or the whole item JSON when the field is empty',
          },
          {
            name: 'Use Node Input (Binary)',
            value: 'nodeInputBinary',
            description: 'Summarize the text of a file in the item',
          },
          {
            name: 'Use Document Loader',
            value: 'documentLoader',
            description: 'Summarize the documents of a connected document loader',
          },
        ],
      },
      {
        displayName: 'Text',
        name: 'text',
        type: 'string',
        default: '={{ $json.text }}',
        typeOptions: { rows: 2 },
        description: 'Text to summarize. Leave empty to summarize the whole item JSON.',
        displayOptions: { show: { operationMode: ['nodeInputJson'] } },
      },
      {
        displayName: 'Chunking Strategy',
        name: 'chunkingMode',
        type: 'options',
        default: 'simple',
        noDataExpression: true,
        displayOptions: { show: NOT_DOCUMENT_LOADER },
        options: [
          { name: 'Simple (Define Below)', value: 'simple' },
          { name: 'Advanced', value: 'advanced', description: 'Use a connected Text Splitter' },
        ],
      },
      {
        displayName: 'Characters Per Chunk',
        name: 'chunkSize',
        type: 'number',
        default: 1000,
        typeOptions: { minValue: 1 },
        description: 'Characters per chunk',
        displayOptions: { show: { ...NOT_DOCUMENT_LOADER, chunkingMode: ['simple'] } },
      },
      {
        displayName: 'Chunk Overlap (Characters)',
        name: 'chunkOverlap',
        type: 'number',
        default: 200,
        typeOptions: { minValue: 0 },
        description: 'Characters shared between neighbouring chunks',
        displayOptions: { show: { ...NOT_DOCUMENT_LOADER, chunkingMode: ['simple'] } },
      },
      {
        displayName: 'Options',
        name: 'options',
        type: 'collection',
        default: {},
        placeholder: 'Add option',
        options: [
          {
            displayName: 'Input Data Field Name',
            name: 'binaryDataKey',
            type: 'string',
            default: 'data',
            description: 'The name of the binary property that holds the file',
            displayOptions: { show: { '/operationMode': ['nodeInputBinary'] } },
          },
          {
            displayName: 'Summarization Method and Prompts',
            name: 'summarizationMethodAndPrompts',
            type: 'fixedCollection',
            default: { values: { summarizationMethod: 'map_reduce' } },
            placeholder: 'Add Option',
            options: [
              {
                displayName: 'Values',
                name: 'values',
                values: [
                  {
                    displayName: 'Summarization Method',
                    name: 'summarizationMethod',
                    type: 'options',
                    default: 'map_reduce',
                    options: [
                      {
                        name: 'Map Reduce (Recommended)',
                        value: 'map_reduce',
                        description: 'Summarize chunks in parallel, then combine',
                      },
                      {
                        name: 'Refine',
                        value: 'refine',
                        description: 'Improve a running summary chunk by chunk',
                      },
                      {
                        name: 'Stuff',
                        value: 'stuff',
                        description: 'One call with the whole text (short texts only)',
                      },
                    ],
                  },
                  {
                    displayName: 'Individual Summary Prompt',
                    name: 'combineMapPrompt',
                    type: 'string',
                    default: MAP_PROMPT,
                    typeOptions: { rows: 4 },
                    description: 'Prompt for the summary of one chunk. Uses {text}.',
                    displayOptions: { show: { summarizationMethod: ['map_reduce'] } },
                  },
                  {
                    displayName: 'Final Prompt to Combine',
                    name: 'prompt',
                    type: 'string',
                    default: MAP_PROMPT,
                    typeOptions: { rows: 4 },
                    description:
                      'Prompt that combines the summaries, or summarizes all text at once. Uses {text}.',
                    displayOptions: { show: { summarizationMethod: ['map_reduce', 'stuff'] } },
                  },
                  {
                    displayName: 'Initial Prompt',
                    name: 'refineQuestionPrompt',
                    type: 'string',
                    default: MAP_PROMPT,
                    typeOptions: { rows: 4 },
                    description: 'Prompt for the first chunk. Uses {text}.',
                    displayOptions: { show: { summarizationMethod: ['refine'] } },
                  },
                  {
                    displayName: 'Subsequent (Refine) Prompt',
                    name: 'refinePrompt',
                    type: 'string',
                    default: REFINE_PROMPT,
                    typeOptions: { rows: 6 },
                    description: 'Prompt for each later chunk. Uses {existing_answer} and {text}.',
                    displayOptions: { show: { summarizationMethod: ['refine'] } },
                  },
                ],
              },
            ],
          },
          {
            displayName: 'Parallel Requests',
            name: 'concurrency',
            type: 'number',
            default: 4,
            typeOptions: { minValue: 1, maxValue: 16 },
            description: 'Chunk summaries asked at the same time (Map Reduce)',
          },
          batchingOption(5),
        ],
      },
    ],
  },
  async execute(ctx) {
    const items = ctx.getInputData();
    const options0 = ctx.getNodeParameter('options', 0, {}) as DataObject;
    const batching = (options0.batching ?? {}) as DataObject;
    const size = Number(batching.batchSize ?? 5);
    const delay = Number(batching.delayBetweenBatches ?? 0);
    const settled = await runInBatches(
      items.length,
      {
        batchSize: Number.isFinite(size) && size >= 1 ? Math.floor(size) : 5,
        delayMs: Number.isFinite(delay) && delay > 0 ? delay : 0,
        signal: ctx.signal,
        // without continue-on-fail, a failed item ends the node once its batch is done
        stopOnFailure: !ctx.continueOnFail(),
      },
      async (i): Promise<Item> => {
        const options = ctx.getNodeParameter('options', i, {}) as DataObject;
        const mode = String(ctx.getNodeParameter('operationMode', i, 'nodeInputJson'));
        const chunkSize = Math.max(1, Number(ctx.getNodeParameter('chunkSize', i, 1000)) || 1000);
        const chunkOverlap = Math.max(0, Number(ctx.getNodeParameter('chunkOverlap', i, 200)) || 0);
        const chunks = await summaryChunks(
          ctx,
          items,
          i,
          mode,
          { size: chunkSize, overlap: chunkOverlap },
          options,
        );
        const chosen = ((options.summarizationMethodAndPrompts as DataObject | undefined)?.values ??
          {}) as DataObject;
        const method = (chosen.summarizationMethod ?? 'map_reduce') as SummarizeOptions['method'];
        const prompt = String(chosen.prompt ?? MAP_PROMPT);
        const model = await getChatModel(ctx, i);
        const summary = await summarize(model, chunks, {
          method,
          chunkSize,
          // the engine's first-call prompt: per chunk (map), the whole text (stuff), the first chunk (refine)
          mapPrompt: String(
            method === 'stuff'
              ? prompt
              : method === 'refine'
                ? (chosen.refineQuestionPrompt ?? MAP_PROMPT)
                : (chosen.combineMapPrompt ?? MAP_PROMPT),
          ),
          combinePrompt: prompt,
          refinePrompt: String(chosen.refinePrompt ?? REFINE_PROMPT),
          concurrency: Number(options.concurrency ?? 4),
          signal: ctx.signal,
        });
        return { json: { response: { output_text: summary } }, pairedItem: { item: i } };
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
        // without continue-on-fail, a failed item ends the node once its batch is done
        stopOnFailure: !ctx.continueOnFail(),
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

export const ragChainNodes: NodeType[] = [ChainSummarizationNode, ChainRetrievalQaNode];
