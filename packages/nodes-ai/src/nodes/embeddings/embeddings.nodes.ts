/**
 * Embedding model sub-nodes (OpenAI, Gemini, Ollama), all on `HttpEmbeddings`.
 */
import type {
  DataObject,
  NodeProperty,
  NodeType,
  NodeTypeDescription,
  SupplyDataContext,
} from '@workflow/workflow';
import { NodeOperationError } from '@workflow/workflow';
import { GEMINI_DEFAULT_HOST, geminiModelPath } from '../../providers/gemini';
import { OLLAMA_DEFAULT_BASE_URL } from '../../providers/ollama';
import { trimSlash } from '../../shared/chat-model';
import { HttpEmbeddings } from '../../shared/http-embeddings';
import { EmbeddingsAwsBedrockNode } from './EmbeddingsAwsBedrock.node';
import { EmbeddingsAzureOpenAiNode } from './EmbeddingsAzureOpenAi.node';
import { EmbeddingsCohereNode } from './EmbeddingsCohere.node';
import { EmbeddingsGoogleVertexNode } from './EmbeddingsGoogleVertex.node';
import { EmbeddingsMistralCloudNode } from './EmbeddingsMistralCloud.node';
import { moreEmbeddingsNodes } from './more-embeddings.nodes';

export { HttpEmbeddings };

function embeddingsDescription(
  base: Pick<NodeTypeDescription, 'name' | 'displayName' | 'description' | 'icon'> & { credential: string },
  properties: NodeProperty[],
): NodeTypeDescription {
  return {
    name: base.name,
    displayName: base.displayName,
    description: base.description,
    icon: base.icon,
    group: ['transform'],
    version: 1,
    defaults: { name: base.displayName },
    inputs: [],
    outputs: ['ai_embedding'],
    outputNames: ['Embeddings'],
    credentials: [{ name: base.credential, required: true }],
    categories: ['AI', 'Embeddings'],
    alias: ['vector', 'rag', 'semantic search'],
    properties,
  };
}

const commonOptions = (batchSize: number, extra: NodeProperty[] = []): NodeProperty => ({
  displayName: 'Options',
  name: 'options',
  type: 'collection',
  default: {},
  placeholder: 'Add option',
  options: [
    ...extra,
    {
      displayName: 'Batch Size',
      name: 'batchSize',
      type: 'number',
      default: batchSize,
      typeOptions: { minValue: 1, maxValue: 2048 },
      description: 'Texts sent per request',
    },
    { displayName: 'Timeout (ms)', name: 'timeout', type: 'number', default: 60_000 },
    {
      displayName: 'Max Retries',
      name: 'maxRetries',
      type: 'number',
      default: 2,
      typeOptions: { minValue: 0 },
    },
  ],
});

function readOptions(ctx: SupplyDataContext, itemIndex: number, maxBatch: number) {
  const options = ctx.getNodeParameter('options', itemIndex, {}) as DataObject;
  return {
    options,
    batchSize: Math.max(1, Math.min(maxBatch, Number(options.batchSize ?? maxBatch))),
    maxRetries: Number(options.maxRetries ?? 2),
    timeoutMs: options.timeout ? Number(options.timeout) : undefined,
    dimensions: options.dimensions ? Number(options.dimensions) : undefined,
  };
}

const modelProperty = (defaultModel: string, description?: string): NodeProperty => ({
  displayName: 'Model',
  name: 'model',
  type: 'string',
  default: defaultModel,
  required: true,
  description,
});

export const EmbeddingsOpenAiNode: NodeType = {
  description: embeddingsDescription(
    {
      name: 'ai.embeddingsOpenAi',
      displayName: 'Embeddings OpenAI',
      description: 'Turns text into vectors with OpenAI embedding models',
      icon: 'simple:openai',
      credential: 'openAiApi',
    },
    [
      modelProperty('text-embedding-3-small', 'e.g. text-embedding-3-small, text-embedding-3-large'),
      commonOptions(512, [
        {
          displayName: 'Dimensions',
          name: 'dimensions',
          type: 'number',
          default: 1536,
          description: 'Shorter vectors (text-embedding-3 models only)',
        },
      ]),
    ],
  ),
  async supplyData(ctx, itemIndex) {
    const creds = await ctx.getCredentials('openAiApi', itemIndex);
    const { batchSize, maxRetries, timeoutMs, dimensions } = readOptions(ctx, itemIndex, 2048);
    const model = String(ctx.getNodeParameter('model', itemIndex, 'text-embedding-3-small'));
    const baseUrl = trimSlash(String(creds.baseUrl || 'https://api.openai.com/v1'));
    return {
      response: new HttpEmbeddings(ctx, {
        credentialType: 'openAiApi',
        model,
        itemIndex,
        batchSize,
        maxRetries,
        timeoutMs,
        dimensions,
        request: (texts) => ({
          url: `${baseUrl}/embeddings`,
          body: { model, input: texts, encoding_format: 'float', ...(dimensions ? { dimensions } : {}) },
        }),
        parse: (body) =>
          [...((body as { data?: Array<{ index: number; embedding: number[] }> }).data ?? [])]
            .sort((a, b) => a.index - b.index)
            .map((d) => d.embedding),
      }),
    };
  },
};

export const EmbeddingsGoogleGeminiNode: NodeType = {
  description: embeddingsDescription(
    {
      name: 'ai.embeddingsGoogleGemini',
      displayName: 'Embeddings Google Gemini',
      description: 'Turns text into vectors with Gemini embedding models',
      icon: 'simple:googlegemini',
      credential: 'googleGeminiApi',
    },
    [
      modelProperty('gemini-embedding-001'),
      commonOptions(100, [
        {
          displayName: 'Dimensions',
          name: 'dimensions',
          type: 'number',
          default: 768,
          description: 'Output dimensionality (models that support it)',
        },
      ]),
    ],
  ),
  async supplyData(ctx, itemIndex) {
    const creds = await ctx.getCredentials('googleGeminiApi', itemIndex);
    const { batchSize, maxRetries, timeoutMs, dimensions } = readOptions(ctx, itemIndex, 100);
    const model = geminiModelPath(String(ctx.getNodeParameter('model', itemIndex, 'gemini-embedding-001')));
    const host = trimSlash(String(creds.host || GEMINI_DEFAULT_HOST));
    return {
      response: new HttpEmbeddings(ctx, {
        credentialType: 'googleGeminiApi',
        model,
        itemIndex,
        batchSize,
        maxRetries,
        timeoutMs,
        dimensions,
        request: (texts, purpose) => ({
          url: `${host}/v1beta/models/${encodeURIComponent(model)}:batchEmbedContents`,
          body: {
            requests: texts.map((text) => ({
              model: `models/${model}`,
              content: { parts: [{ text }] },
              taskType: purpose === 'query' ? 'RETRIEVAL_QUERY' : 'RETRIEVAL_DOCUMENT',
              ...(dimensions ? { outputDimensionality: dimensions } : {}),
            })),
          },
        }),
        parse: (body) =>
          ((body as { embeddings?: Array<{ values: number[] }> }).embeddings ?? []).map((e) => e.values),
      }),
    };
  },
};

export const EmbeddingsOllamaNode: NodeType = {
  description: embeddingsDescription(
    {
      name: 'ai.embeddingsOllama',
      displayName: 'Embeddings Ollama',
      description: 'Turns text into vectors with a model served by Ollama',
      icon: 'simple:ollama',
      credential: 'ollamaApi',
    },
    [modelProperty('nomic-embed-text'), commonOptions(64)],
  ),
  async supplyData(ctx, itemIndex) {
    const creds = await ctx.getCredentials('ollamaApi', itemIndex);
    const { batchSize, maxRetries, timeoutMs } = readOptions(ctx, itemIndex, 512);
    const model = String(ctx.getNodeParameter('model', itemIndex, 'nomic-embed-text'));
    if (!model) throw new NodeOperationError(ctx.getNode(), 'Enter the embedding model', { itemIndex });
    const baseUrl = trimSlash(String(creds.baseUrl || OLLAMA_DEFAULT_BASE_URL));
    return {
      response: new HttpEmbeddings(ctx, {
        credentialType: 'ollamaApi',
        model,
        itemIndex,
        batchSize,
        maxRetries,
        timeoutMs,
        request: (texts) => ({ url: `${baseUrl}/api/embed`, body: { model, input: texts } }),
        parse: (body) => (body as { embeddings?: number[][] }).embeddings ?? [],
      }),
    };
  },
};

export const embeddingsNodes: NodeType[] = [
  EmbeddingsOpenAiNode,
  EmbeddingsGoogleGeminiNode,
  EmbeddingsOllamaNode,
  EmbeddingsAwsBedrockNode,
  EmbeddingsAzureOpenAiNode,
  EmbeddingsGoogleVertexNode,
  EmbeddingsMistralCloudNode,
  EmbeddingsCohereNode,
  ...moreEmbeddingsNodes,
];
