/** Embeddings Cohere sub-node: Cohere embedding models on `/v2/embed`. */
import type { DataObject, NodeType } from '@workflow/workflow';
import { COHERE_DEFAULT_BASE_URL } from '../../providers/cohere';
import { trimSlash } from '../../shared/chat-model';
import { HttpEmbeddings } from '../../shared/http-embeddings';

/** n8n's fixed model list; a model Cohere retired shows the provider's error */
const COHERE_EMBEDDING_MODELS = [
  'embed-english-v2.0',
  'embed-english-light-v2.0',
  'embed-multilingual-v2.0',
  'embed-english-v3.0',
  'embed-english-light-v3.0',
  'embed-multilingual-v3.0',
  'embed-multilingual-light-v3.0',
];
const COHERE_EMBED_BATCH = 96;

export const EmbeddingsCohereNode: NodeType = {
  description: {
    name: 'ai.embeddingsCohere',
    displayName: 'Embeddings Cohere',
    description: 'Turns text into vectors with Cohere embedding models',
    icon: 'simple:cohere',
    group: ['transform'],
    version: 1,
    defaults: { name: 'Embeddings Cohere' },
    inputs: [],
    outputs: ['ai_embedding'],
    outputNames: ['Embeddings'],
    credentials: [{ name: 'cohereApi', required: true }],
    categories: ['AI', 'Embeddings'],
    alias: ['vector', 'rag', 'semantic search', 'cohere'],
    properties: [
      {
        displayName: 'Model',
        name: 'model',
        type: 'options',
        default: 'embed-english-v2.0',
        options: COHERE_EMBEDDING_MODELS.map((m) => ({ name: m, value: m })),
        description: 'The model that turns text into vectors',
      },
      {
        displayName: 'Options',
        name: 'options',
        type: 'collection',
        default: {},
        placeholder: 'Add option',
        options: [
          {
            displayName: 'Batch Size',
            name: 'batchSize',
            type: 'number',
            default: COHERE_EMBED_BATCH,
            typeOptions: { minValue: 1, maxValue: COHERE_EMBED_BATCH },
            description: 'Texts sent per request (Cohere accepts up to 96)',
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
      },
    ],
  },
  async supplyData(ctx, itemIndex) {
    const creds = await ctx.getCredentials('cohereApi', itemIndex);
    const options = ctx.getNodeParameter('options', itemIndex, {}) as DataObject;
    const model =
      String(ctx.getNodeParameter('model', itemIndex, 'embed-english-v2.0')).trim() || 'embed-english-v2.0';
    const baseUrl = trimSlash(String(creds.url || COHERE_DEFAULT_BASE_URL));
    const batchSize = Math.max(
      1,
      Math.min(COHERE_EMBED_BATCH, Number(options.batchSize ?? COHERE_EMBED_BATCH)),
    );
    return {
      response: new HttpEmbeddings(ctx, {
        credentialType: 'cohereApi',
        model,
        itemIndex,
        batchSize,
        maxRetries: Number(options.maxRetries ?? 2),
        timeoutMs: options.timeout ? Number(options.timeout) : undefined,
        request: (texts, purpose) => ({
          url: `${baseUrl}/v2/embed`,
          body: {
            model,
            texts,
            input_type: purpose === 'query' ? 'search_query' : 'search_document',
            embedding_types: ['float'],
          },
        }),
        parse: (body) => (body as { embeddings?: { float?: number[][] } }).embeddings?.float ?? [],
      }),
    };
  },
};
