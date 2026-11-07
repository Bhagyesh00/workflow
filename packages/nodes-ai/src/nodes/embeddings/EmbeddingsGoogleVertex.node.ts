/**
 * Embeddings Google Vertex sub-node: the `:predict` call of a Vertex AI text embedding model (default
 * text-embedding-005). The credential, project and region work as on the Vertex chat node.
 */
import { type DataObject, NodeOperationError, type NodeType } from '@workflow/workflow';
import { geminiModelPath, vertexModelBase } from '../../providers/gemini';
import { HttpEmbeddings } from '../../shared/http-embeddings';
import {
  readVertexTarget,
  vertexAuthenticationProperty,
  vertexProjectProperty,
  vertexRegionOption,
} from '../models/gemini-options';
import { LmChatGoogleVertexNode } from '../models/LmChatGoogleVertex.node';

export const VERTEX_DEFAULT_EMBEDDING_MODEL = 'text-embedding-005';
/** `text-embedding-005` takes up to 250 texts a call; the 20,000 token cap makes a smaller default safer */
const DEFAULT_BATCH = 100;
const MAX_BATCH = 250;

export const EmbeddingsGoogleVertexNode: NodeType = {
  description: {
    name: 'ai.embeddingsGoogleVertex',
    displayName: 'Embeddings Google Vertex',
    description: 'Turns text into vectors with embedding models on Google Cloud Vertex AI',
    icon: 'simple:googlecloud',
    group: ['transform'],
    version: 1,
    defaults: { name: 'Embeddings Google Vertex' },
    inputs: [],
    outputs: ['ai_embedding'],
    outputNames: ['Embeddings'],
    credentials: LmChatGoogleVertexNode.description.credentials,
    categories: ['AI', 'Embeddings'],
    alias: ['vector', 'rag', 'semantic search', 'vertex', 'google'],
    properties: [
      vertexAuthenticationProperty,
      vertexProjectProperty,
      {
        displayName: 'Model Name',
        name: 'model',
        type: 'string',
        default: VERTEX_DEFAULT_EMBEDDING_MODEL,
        required: true,
        description: 'The embedding model, for example text-embedding-005',
      },
      {
        displayName: 'Options',
        name: 'options',
        type: 'collection',
        default: {},
        placeholder: 'Add option',
        options: [
          vertexRegionOption,
          {
            displayName: 'Dimensions',
            name: 'dimensions',
            type: 'number',
            default: 768,
            typeOptions: { minValue: 1 },
            description: 'Shorter vectors (models that support it)',
          },
          {
            displayName: 'Batch Size',
            name: 'batchSize',
            type: 'number',
            default: DEFAULT_BATCH,
            typeOptions: { minValue: 1, maxValue: MAX_BATCH },
            description: 'Texts sent in one call',
          },
          {
            displayName: 'Max Retries',
            name: 'maxRetries',
            type: 'number',
            default: 2,
            typeOptions: { minValue: 0, maxValue: 10 },
            description: 'Retries on rate limits (429) and server errors (5xx), with exponential backoff',
          },
          { displayName: 'Timeout (ms)', name: 'timeout', type: 'number', default: 60_000 },
        ],
      },
    ],
  },
  async supplyData(ctx, itemIndex) {
    const options = ctx.getNodeParameter('options', itemIndex, {}) as DataObject;
    const { credentialType, target } = await readVertexTarget(ctx, itemIndex, options);
    const model = geminiModelPath(
      String(ctx.getNodeParameter('model', itemIndex, VERTEX_DEFAULT_EMBEDDING_MODEL)).trim(),
    );
    if (!model) throw new NodeOperationError(ctx.getNode(), 'Enter the embedding model', { itemIndex });
    const url = `${vertexModelBase(target, model)}:predict`;
    const dimensions = options.dimensions ? Number(options.dimensions) : undefined;
    return {
      response: new HttpEmbeddings(ctx, {
        credentialType,
        model,
        itemIndex,
        batchSize: Math.max(1, Math.min(MAX_BATCH, Number(options.batchSize ?? DEFAULT_BATCH))),
        maxRetries: Number(options.maxRetries ?? 2),
        timeoutMs: options.timeout ? Number(options.timeout) : undefined,
        dimensions,
        request: (texts, purpose) => ({
          url,
          body: {
            instances: texts.map((content) => ({
              content,
              task_type: purpose === 'query' ? 'RETRIEVAL_QUERY' : 'RETRIEVAL_DOCUMENT',
            })),
            ...(dimensions ? { parameters: { outputDimensionality: dimensions } } : {}),
          },
        }),
        parse: (body) =>
          ((body as { predictions?: Array<{ embeddings?: { values?: number[] } }> }).predictions ?? []).map(
            (p) => p.embeddings?.values ?? [],
          ),
      }),
    };
  },
  // the project list and the credential test are the chat node's
  methods: LmChatGoogleVertexNode.methods,
};
