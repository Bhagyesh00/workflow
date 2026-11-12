/**
 * Embeddings AWS Bedrock sub-node: one InvokeModel call per text, in parallel. Titan and Cohere models take
 * different bodies; a Cohere model is told what the text is for.
 */
import type {
  AiEmbeddings,
  DataObject,
  HttpRequestOptions,
  NodeType,
  SupplyDataContext,
} from '@workflow/workflow';
import { logEmbeddingEvent } from '../../shared/ai-events';
import {
  additionalFieldsOption,
  authenticationProperty,
  bedrockCredentialType,
  bedrockRuntimeBase,
  listBedrockModels,
  parseAdditionalFields,
  readBedrockCredential,
} from '../../shared/aws';
import { withRetries } from '../../shared/retry';

/** the same at a model id, an inference profile id and an ARN */
const COHERE_MODEL = /(^|[./])cohere\.embed/;
/** calls at the same time; a big document is many texts, and a throttled call is retried */
const MAX_PARALLEL_CALLS = 16;

type Purpose = 'document' | 'query';

interface BedrockEmbeddingsConfig {
  url: string;
  credentialType: string;
  model: string;
  itemIndex: number;
  maxRetries: number;
  timeoutMs?: number;
  additionalFields?: DataObject;
}

function bedrockEmbeddingBody(text: string, purpose: Purpose, config: BedrockEmbeddingsConfig): DataObject {
  const input = text.replace(/\r?\n/g, ' ');
  return COHERE_MODEL.test(config.model)
    ? {
        ...config.additionalFields,
        texts: [input],
        input_type: purpose === 'query' ? 'search_query' : 'search_document',
      }
    : { ...config.additionalFields, inputText: input };
}

function vectorOf(body: unknown): number[] {
  const b = (body ?? {}) as Record<string, any>;
  const many = Array.isArray(b.embeddings) ? b.embeddings : b.embeddings?.float;
  const vector = [b.embedding, b.embeddingsByType?.float, many?.[0]].find(Array.isArray) as
    | number[]
    | undefined;
  if (!vector?.length) throw new Error('The Bedrock embeddings API returned no vector');
  return vector;
}

class BedrockEmbeddings implements AiEmbeddings {
  readonly kind = 'embeddings' as const;
  dimensions?: number;

  constructor(
    private readonly ctx: SupplyDataContext,
    private readonly config: BedrockEmbeddingsConfig,
  ) {}

  embedDocuments(texts: string[]): Promise<number[][]> {
    return this.embed(texts, 'document');
  }

  async embedQuery(text: string): Promise<number[]> {
    return (await this.embed([text], 'query'))[0];
  }

  private async embed(texts: string[], purpose: Purpose): Promise<number[][]> {
    if (!texts.length) return [];
    const input = { model: this.config.model, texts: texts.length, purpose };
    try {
      const vectors = await this.embedAll(texts, purpose);
      this.dimensions ??= vectors[0].length;
      this.ctx.logSubNodeRun(input, { vectors: vectors.length, dimensions: vectors[0].length });
      logEmbeddingEvent(this.ctx, purpose, texts);
      return vectors;
    } catch (error) {
      this.ctx.logSubNodeRun(input, {}, error as Error);
      throw error;
    }
  }

  /** results in input order; after a failure no further call starts */
  private async embedAll(texts: string[], purpose: Purpose): Promise<number[][]> {
    const vectors: number[][] = new Array(texts.length);
    let next = 0;
    let failed = false;
    const worker = async () => {
      while (next < texts.length && !failed) {
        const index = next++;
        try {
          vectors[index] = await this.embedOne(texts[index], purpose);
        } catch (error) {
          failed = true;
          throw error;
        }
      }
    };
    const workers = Array.from({ length: Math.min(MAX_PARALLEL_CALLS, texts.length) }, worker);
    await Promise.all(workers);
    return vectors;
  }

  private async embedOne(text: string, purpose: Purpose): Promise<number[]> {
    const request: HttpRequestOptions = {
      url: this.config.url,
      method: 'POST',
      headers: { 'content-type': 'application/json', accept: 'application/json' },
      // a string before the credential signs it, so the signature covers the exact bytes sent
      body: JSON.stringify(bedrockEmbeddingBody(text, purpose, this.config)),
      bodyType: 'raw',
      timeout: this.config.timeoutMs,
    };
    const body = await withRetries(
      () =>
        this.ctx.helpers.httpRequestWithAuthentication(
          this.config.credentialType,
          request,
          this.config.itemIndex,
        ),
      { maxRetries: this.config.maxRetries, signal: this.ctx.signal },
    );
    return vectorOf(body);
  }
}

export const EmbeddingsAwsBedrockNode: NodeType = {
  description: {
    name: 'ai.embeddingsAwsBedrock',
    displayName: 'Embeddings AWS Bedrock',
    description: 'Turns text into vectors with embedding models on AWS Bedrock',
    icon: 'simple:amazonaws',
    group: ['transform'],
    version: 1,
    defaults: { name: 'Embeddings AWS Bedrock' },
    inputs: [],
    outputs: ['ai_embedding'],
    outputNames: ['Embeddings'],
    credentials: [
      { name: 'aws', required: true, displayOptions: { show: { authentication: ['iam'] } } },
      { name: 'awsAssumeRole', required: true, displayOptions: { show: { authentication: ['assumeRole'] } } },
    ],
    categories: ['AI', 'Embeddings'],
    alias: ['vector', 'rag', 'semantic search', 'bedrock', 'aws'],
    properties: [
      authenticationProperty,
      {
        displayName: 'Model',
        name: 'model',
        type: 'options',
        default: '',
        typeOptions: { loadOptionsMethod: 'listModels', loadOptionsDependsOn: ['authentication'] },
        description: 'The embedding model or inference profile that turns text into vectors',
      },
      {
        displayName: 'Options',
        name: 'options',
        type: 'collection',
        default: {},
        placeholder: 'Add option',
        options: [
          additionalFieldsOption,
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
    const credentialType = bedrockCredentialType(ctx.getNodeParameter('authentication', itemIndex, 'iam'));
    const { region, runtimeEndpoint } = readBedrockCredential(
      await ctx.getCredentials(credentialType, itemIndex),
    );
    const options = ctx.getNodeParameter('options', itemIndex, {}) as DataObject;
    const model = String(ctx.getNodeParameter('model', itemIndex, '')).trim();
    if (!model) throw new Error('Choose a model');
    const base = bedrockRuntimeBase({ region, model, endpoint: runtimeEndpoint });
    return {
      response: new BedrockEmbeddings(ctx, {
        // encoded once: the signature encodes the path again on its own
        url: `${base}/model/${encodeURIComponent(model)}/invoke`,
        credentialType,
        model,
        itemIndex,
        maxRetries: Number(options.maxRetries ?? 2),
        timeoutMs: options.timeout ? Number(options.timeout) : undefined,
        additionalFields: parseAdditionalFields(options.additionalModelRequestFields),
      }),
    };
  },
  methods: {
    loadOptions: {
      async listModels(ctx) {
        return listBedrockModels(ctx, 'EMBEDDING');
      },
    },
  },
};
