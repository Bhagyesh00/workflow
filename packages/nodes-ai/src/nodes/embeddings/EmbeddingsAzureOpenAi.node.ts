/**
 * Embeddings Microsoft Foundry sub-node: embedding deployments on Microsoft Foundry and Azure OpenAI.
 * Classic resources call `/openai/deployments/<deployment>/embeddings?api-version=`, Foundry calls
 * `/openai/v1/embeddings` with the deployment as the model.
 */
import type { DataObject, NodeType, SupplyDataContext } from '@workflow/workflow';
import { HttpEmbeddings } from '../../shared/http-embeddings';
import {
  azureAuthenticationProperty,
  azureDeploymentProperty,
  listDeployments,
  readAuthentication,
  readAzureTarget,
  readDeployment,
} from '../models/LmChatAzureOpenAi.node';

const AZURE_EMBED_BATCH = 512;

export const EmbeddingsAzureOpenAiNode: NodeType = {
  description: {
    name: 'ai.embeddingsAzureOpenAi',
    displayName: 'Embeddings Microsoft Foundry',
    description: 'Turns text into vectors with embedding deployments on Microsoft Foundry and Azure OpenAI',
    icon: 'simple:microsoftazure',
    group: ['transform'],
    version: 1,
    defaults: { name: 'Embeddings Microsoft Foundry' },
    inputs: [],
    outputs: ['ai_embedding'],
    outputNames: ['Embeddings'],
    credentials: [
      {
        name: 'azureOpenAiApi',
        required: true,
        displayOptions: { show: { authentication: ['azureOpenAiApi'] } },
      },
      {
        name: 'azureEntraCognitiveServicesOAuth2Api',
        required: true,
        displayOptions: { show: { authentication: ['azureEntraCognitiveServicesOAuth2Api'] } },
      },
    ],
    categories: ['AI', 'Embeddings'],
    alias: ['vector', 'rag', 'semantic search', 'azure', 'azure openai', 'foundry'],
    properties: [
      azureAuthenticationProperty,
      azureDeploymentProperty(
        'Model (Deployment)',
        'The embedding deployment. A list needs a Foundry credential with a project.',
      ),
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
            default: AZURE_EMBED_BATCH,
            typeOptions: { minValue: 1, maxValue: AZURE_EMBED_BATCH },
            description: 'Texts sent per request',
          },
          {
            displayName: 'Strip New Lines',
            name: 'stripNewLines',
            type: 'boolean',
            default: true,
            description: 'Whether to replace new lines in the texts with spaces',
          },
          {
            displayName: 'Dimensions',
            name: 'dimensions',
            type: 'number',
            default: 0,
            typeOptions: { minValue: 0 },
            description:
              'The size of the vectors, for models that can shorten them. 0 leaves it to the model.',
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
  async supplyData(ctx: SupplyDataContext, itemIndex: number) {
    const authentication = readAuthentication(
      ctx.getNodeParameter('authentication', itemIndex, 'azureOpenAiApi'),
    );
    const credentials = await ctx.getCredentials(authentication, itemIndex);
    const target = readAzureTarget(ctx, credentials);
    const deployment = readDeployment(
      ctx,
      ctx.getNodeParameter('model', itemIndex, '', { extractValue: true }),
    );
    const options = ctx.getNodeParameter('options', itemIndex, {}) as DataObject;
    const batchSize = Math.max(
      1,
      Math.min(AZURE_EMBED_BATCH, Number(options.batchSize ?? AZURE_EMBED_BATCH)),
    );
    const strip = options.stripNewLines !== false;
    const dimensions = Number(options.dimensions) > 0 ? Number(options.dimensions) : undefined;
    const classic = target.kind === 'classic';
    return {
      response: new HttpEmbeddings(ctx, {
        credentialType: authentication,
        model: deployment,
        itemIndex,
        batchSize,
        maxRetries: Number(options.maxRetries ?? 2),
        timeoutMs: options.timeout ? Number(options.timeout) : undefined,
        dimensions,
        request: (texts) => ({
          url: classic
            ? `${target.baseUrl}/openai/deployments/${encodeURIComponent(deployment)}/embeddings`
            : `${target.baseUrl}/embeddings`,
          ...(classic ? { qs: { 'api-version': target.apiVersion } } : {}),
          body: {
            ...(classic ? {} : { model: deployment }),
            input: strip ? texts.map((t) => t.replace(/\r?\n/g, ' ')) : texts,
            ...(dimensions ? { dimensions } : {}),
          },
        }),
        parse: (body) =>
          [...((body as { data?: Array<{ index?: number; embedding: number[] }> }).data ?? [])]
            .sort((a, b) => (a.index ?? 0) - (b.index ?? 0))
            .map((d) => d.embedding),
      }),
    };
  },
  methods: {
    listSearch: {
      async searchDeployments(ctx, filter) {
        return listDeployments(ctx, 'embeddings', filter);
      },
    },
  },
};
