/**
 * More embedding sub-nodes: NVIDIA, Databricks, Lemonade and Hugging Face Inference. The first three speak
 * the OpenAI embeddings protocol; Hugging Face sends feature-extraction calls. All run on `HttpEmbeddings`,
 * so every call goes through the credential's authentication and the SSRF guard.
 */
import type { DataObject, NodeProperty, NodeType, NodeTypeDescription } from '@workflow/workflow';
import { NodeOperationError } from '@workflow/workflow';
import { trimSlash } from '../../shared/chat-model';
import { databricksGatewayUrl } from '../../shared/databricks';
import { HttpEmbeddings } from '../../shared/http-embeddings';

const NVIDIA_DEFAULT_URL = 'https://integrate.api.nvidia.com/v1';
const LEMONADE_DEFAULT_URL = 'http://localhost:8000/api/v1';
const HUGGING_FACE_ROUTER = 'https://router.huggingface.co';
const HUGGING_FACE_DEFAULT_MODEL = 'sentence-transformers/distilbert-base-nli-mean-tokens';
const BATCH = 512;

const ADVANCED_OPTIONS: NodeProperty[] = [
  {
    displayName: 'Batch Size',
    name: 'batchSize',
    type: 'number',
    default: BATCH,
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
];

function description(
  base: Pick<NodeTypeDescription, 'name' | 'displayName' | 'description' | 'icon'> & {
    credential: string;
    alias: string[];
  },
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
    alias: ['vector', 'rag', 'semantic search', ...base.alias],
    properties,
  };
}

const modelProperty = (defaultModel: string, text: string): NodeProperty => ({
  displayName: 'Model',
  name: 'model',
  type: 'string',
  default: defaultModel,
  required: true,
  description: text,
});

const optionsProperty = (extra: NodeProperty[] = []): NodeProperty => ({
  displayName: 'Options',
  name: 'options',
  type: 'collection',
  default: {},
  placeholder: 'Add option',
  options: [...extra, ...ADVANCED_OPTIONS],
});

function common(options: DataObject) {
  return {
    batchSize: Math.max(1, Math.min(2048, Number(options.batchSize ?? BATCH))),
    maxRetries: Number(options.maxRetries ?? 2),
    timeoutMs: options.timeout ? Number(options.timeout) : undefined,
  };
}

function openAiVectors(body: unknown): number[][] {
  return [...((body as { data?: Array<{ index?: number; embedding: number[] }> }).data ?? [])]
    .sort((a, b) => (a.index ?? 0) - (b.index ?? 0))
    .map((d) => d.embedding);
}

/** Build a node on the OpenAI embeddings protocol; `baseUrl` may refuse the credential's address. */
function compatibleNode(spec: {
  name: string;
  displayName: string;
  description: string;
  icon: string;
  credential: string;
  alias: string[];
  defaultModel: string;
  modelHelp: string;
  baseUrl(creds: DataObject): string;
}): NodeType {
  return {
    description: description(spec, [modelProperty(spec.defaultModel, spec.modelHelp), optionsProperty()]),
    async supplyData(ctx, itemIndex) {
      const creds = await ctx.getCredentials(spec.credential, itemIndex);
      const options = ctx.getNodeParameter('options', itemIndex, {}) as DataObject;
      const model = String(ctx.getNodeParameter('model', itemIndex, spec.defaultModel)).trim();
      if (!model) throw new NodeOperationError(ctx.getNode(), 'Enter the embedding model', { itemIndex });
      const baseUrl = spec.baseUrl(creds);
      return {
        response: new HttpEmbeddings(ctx, {
          credentialType: spec.credential,
          model,
          itemIndex,
          ...common(options),
          request: (texts) => ({
            url: `${baseUrl}/embeddings`,
            body: { model, input: texts, encoding_format: 'float' },
          }),
          parse: openAiVectors,
        }),
      };
    },
  };
}

export const EmbeddingsNvidiaNode: NodeType = compatibleNode({
  name: 'ai.embeddingsNvidia',
  displayName: 'Embeddings NVIDIA',
  description: 'Turns text into vectors with embedding models hosted by NVIDIA',
  icon: 'simple:nvidia',
  credential: 'nvidiaApi',
  alias: ['nvidia'],
  defaultModel: 'nvidia/nv-embedqa-e5-v5',
  modelHelp: 'The NVIDIA embedding model, for example nvidia/nv-embedqa-e5-v5',
  baseUrl: (creds) => trimSlash(String(creds.url || NVIDIA_DEFAULT_URL)),
});

export const EmbeddingsDatabricksNode: NodeType = compatibleNode({
  name: 'ai.embeddingsDatabricks',
  displayName: 'Embeddings Databricks',
  description: 'Turns text into vectors with embedding models on a Databricks AI Gateway',
  icon: 'simple:databricks',
  credential: 'databricksOAuth2Api',
  alias: ['databricks'],
  defaultModel: 'databricks-gte-large-en',
  modelHelp: 'The embedding endpoint name on your Databricks AI Gateway',
  // https only: the token calls of this credential carry its client secret
  baseUrl: (creds) => databricksGatewayUrl(String(creds.host ?? '')),
});

export const EmbeddingsLemonadeNode: NodeType = compatibleNode({
  name: 'ai.embeddingsLemonade',
  displayName: 'Embeddings Lemonade',
  description: 'Turns text into vectors with models served by Lemonade',
  icon: 'lucide:citrus',
  credential: 'lemonadeApi',
  alias: ['lemonade', 'local'],
  defaultModel: 'nomic-embed-text-v1-GGUF',
  modelHelp: 'The embedding model your Lemonade server has loaded',
  baseUrl: (creds) => trimSlash(String(creds.baseUrl || LEMONADE_DEFAULT_URL)),
});

export const EmbeddingsHuggingFaceInferenceNode: NodeType = {
  description: description(
    {
      name: 'ai.embeddingsHuggingFaceInference',
      displayName: 'Embeddings Hugging Face Inference',
      description: 'Turns text into vectors through Hugging Face Inference',
      icon: 'simple:huggingface',
      credential: 'huggingFaceApi',
      alias: ['hugging face'],
    },
    [
      modelProperty(HUGGING_FACE_DEFAULT_MODEL, 'The model id on Hugging Face'),
      optionsProperty([
        {
          displayName: 'Custom Inference Endpoint',
          name: 'endpointUrl',
          type: 'string',
          default: '',
          placeholder: 'https://example.endpoints.huggingface.cloud',
          description: 'URL of your own endpoint. Empty uses the Hugging Face router.',
        },
        {
          displayName: 'Provider',
          name: 'provider',
          type: 'string',
          default: 'auto',
          description: 'The inference provider behind the router. Auto lets Hugging Face pick.',
        },
      ]),
    ],
  ),
  async supplyData(ctx, itemIndex) {
    await ctx.getCredentials('huggingFaceApi', itemIndex);
    const options = ctx.getNodeParameter('options', itemIndex, {}) as DataObject;
    const model = String(ctx.getNodeParameter('model', itemIndex, HUGGING_FACE_DEFAULT_MODEL)).trim();
    if (!model) throw new NodeOperationError(ctx.getNode(), 'Enter the embedding model', { itemIndex });
    const endpoint = String(options.endpointUrl ?? '').trim();
    const provider = String(options.provider ?? 'auto').trim() || 'auto';
    // `auto` keeps the router's default route (hf-inference); another name picks that provider's route
    const route = provider === 'auto' ? 'hf-inference' : encodeURIComponent(provider);
    const path = model.split('/').map(encodeURIComponent).join('/');
    const url = endpoint
      ? trimSlash(endpoint)
      : `${HUGGING_FACE_ROUTER}/${route}/models/${path}/pipeline/feature-extraction`;
    return {
      response: new HttpEmbeddings(ctx, {
        credentialType: 'huggingFaceApi',
        model,
        itemIndex,
        ...common(options),
        request: (texts) => ({ url, body: { inputs: texts } }),
        parse: (body) => (Array.isArray(body) ? (body as number[][]) : []),
      }),
    };
  },
};

export const moreEmbeddingsNodes: NodeType[] = [
  EmbeddingsNvidiaNode,
  EmbeddingsDatabricksNode,
  EmbeddingsLemonadeNode,
  EmbeddingsHuggingFaceInferenceNode,
];
