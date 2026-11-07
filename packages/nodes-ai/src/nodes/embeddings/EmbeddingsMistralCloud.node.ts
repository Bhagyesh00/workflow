/** Embeddings Mistral Cloud sub-node: Mistral embedding models on the Mistral embeddings API. */
import type { DataObject, NodeType } from '@workflow/workflow';
import { HttpEmbeddings } from '../../shared/http-embeddings';
import { listMistralModels, MISTRAL_BASE_URL } from '../models/LmChatMistralCloud.node';

const MISTRAL_EMBED_BATCH = 512;

export const EmbeddingsMistralCloudNode: NodeType = {
  description: {
    name: 'ai.embeddingsMistralCloud',
    displayName: 'Embeddings Mistral Cloud',
    description: 'Turns text into vectors with Mistral embedding models',
    icon: 'simple:mistralai',
    group: ['transform'],
    version: 1,
    defaults: { name: 'Embeddings Mistral Cloud' },
    inputs: [],
    outputs: ['ai_embedding'],
    outputNames: ['Embeddings'],
    credentials: [{ name: 'mistralCloudApi', required: true }],
    categories: ['AI', 'Embeddings'],
    alias: ['vector', 'rag', 'semantic search', 'mistral'],
    properties: [
      {
        displayName: 'Model',
        name: 'model',
        type: 'options',
        default: 'mistral-embed',
        typeOptions: { loadOptionsMethod: 'listModels' },
        description: 'The embedding model that turns text into vectors',
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
            default: MISTRAL_EMBED_BATCH,
            typeOptions: { minValue: 1, maxValue: MISTRAL_EMBED_BATCH },
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
      },
    ],
  },
  async supplyData(ctx, itemIndex) {
    await ctx.getCredentials('mistralCloudApi', itemIndex);
    const options = ctx.getNodeParameter('options', itemIndex, {}) as DataObject;
    const model = String(ctx.getNodeParameter('model', itemIndex, 'mistral-embed')).trim() || 'mistral-embed';
    const batchSize = Math.max(1, Math.min(MISTRAL_EMBED_BATCH, Number(options.batchSize ?? MISTRAL_EMBED_BATCH)));
    return {
      response: new HttpEmbeddings(ctx, {
        credentialType: 'mistralCloudApi',
        model,
        itemIndex,
        batchSize,
        maxRetries: Number(options.maxRetries ?? 2),
        timeoutMs: options.timeout ? Number(options.timeout) : undefined,
        request: (texts) => ({
          url: `${MISTRAL_BASE_URL}/embeddings`,
          body: { model, input: texts },
        }),
        parse: (body) =>
          [...((body as { data?: Array<{ index?: number; embedding: number[] }> }).data ?? [])]
            .sort((a, b) => (a.index ?? 0) - (b.index ?? 0))
            .map((d) => d.embedding),
      }),
    };
  },
  methods: {
    loadOptions: {
      async listModels(ctx) {
        return listMistralModels(ctx, 'embed');
      },
    },
  },
};
