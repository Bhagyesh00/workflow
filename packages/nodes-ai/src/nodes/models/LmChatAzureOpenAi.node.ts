/**
 * Microsoft Foundry Chat Model sub-node: chat deployments on Microsoft Foundry and Azure OpenAI, by API key
 * or Entra ID. Classic resources call `/openai/deployments/<deployment>/chat/completions?api-version=`;
 * Foundry calls `/openai/v1` (Chat Completions or the Responses API) and, for Claude, `<origin>/anthropic`.
 */
import {
  type DataObject,
  type ListSearchResult,
  type LoadOptionsContext,
  NodeOperationError,
  type NodeProperty,
  type NodeType,
  type SupplyDataContext,
} from '@workflow/workflow';
import {
  AZURE_DEFAULT_API_VERSION,
  type AzureTarget,
  azureTarget,
} from '../../credentials/azure.credentials';
import { anthropicAdapter } from '../../providers/anthropic';
import { openAiAdapter } from '../../providers/openai';
import { openAiResponsesAdapter } from '../../providers/openai-responses';
import { HttpChatModel, readCommonOptions } from '../../shared/chat-model';
import { modelDescription } from './model-options';

export const AZURE_CREDENTIAL_TYPES = ['azureOpenAiApi', 'azureEntraCognitiveServicesOAuth2Api'] as const;
export type AzureCredentialType = (typeof AZURE_CREDENTIAL_TYPES)[number];

export const CLAUDE_NEEDS_FOUNDRY =
  'Claude deployments need a credential using the Microsoft Foundry endpoint type';
export const RESPONSES_NEEDS_FOUNDRY =
  'The Responses API needs a credential using the Microsoft Foundry endpoint type';
const LIST_NEEDS_FOUNDRY =
  'The deployment list needs a credential using the Microsoft Foundry endpoint type and a project name';
const DEPLOYMENTS_API_VERSION = 'v1';
const MAX_DEPLOYMENT_PAGES = 10;
const DEFAULT_CLAUDE_MAX_TOKENS = 16_000;

/** the credential choice, shared with the embeddings node */
export const azureAuthenticationProperty: NodeProperty = {
  displayName: 'Authentication',
  name: 'authentication',
  type: 'options',
  default: 'azureOpenAiApi',
  options: [
    { name: 'API Key', value: 'azureOpenAiApi' },
    { name: 'Microsoft Entra ID (Client Credentials)', value: 'azureEntraCognitiveServicesOAuth2Api' },
  ],
};

/** the deployment, picked from the Foundry project or typed */
export const azureDeploymentProperty = (displayName: string, description: string): NodeProperty => ({
  displayName,
  name: 'model',
  type: 'resourceLocator',
  default: { __rl: true, mode: 'id', value: '' },
  required: true,
  description,
  modes: [
    {
      displayName: 'From List',
      name: 'list',
      type: 'list',
      placeholder: 'Select a deployment...',
      typeOptions: { searchListMethod: 'searchDeployments', searchable: true },
    },
    { displayName: 'By ID', name: 'id', type: 'string', placeholder: 'Deployment name' },
  ],
});

export function readAuthentication(value: unknown): AzureCredentialType {
  return value === 'azureEntraCognitiveServicesOAuth2Api' ? value : 'azureOpenAiApi';
}

/** a resource locator or a plain string, as the deployment name */
export function readDeployment(ctx: SupplyDataContext, value: unknown): string {
  const raw = value && typeof value === 'object' ? (value as { value?: unknown }).value : (value as unknown);
  const name = typeof raw === 'string' ? raw.trim() : '';
  if (!name) throw new NodeOperationError(ctx.getNode(), 'Choose a deployment');
  return name;
}

/** the credential's endpoint; a bad one is a node error with a fixed text */
export function readAzureTarget(ctx: SupplyDataContext, credentials: DataObject): AzureTarget {
  try {
    return azureTarget(credentials);
  } catch (error) {
    throw new NodeOperationError(ctx.getNode(), (error as Error).message);
  }
}

interface FoundryDeployment {
  name?: string;
  modelName?: string;
  capabilities?: Record<string, unknown>;
}

/** what a deployment list should show */
export type DeploymentKind = 'chat' | 'embeddings';

/** A capability is a string or a boolean. Azure reports no family, so the chat list holds every family, as n8n. */
function matchesKind(d: FoundryDeployment, kind: DeploymentKind): boolean {
  if (kind === 'embeddings') {
    const model = `${d.modelName ?? ''} ${d.name ?? ''}`;
    return /embed/i.test(model) || String(d.capabilities?.embeddings) === 'true';
  }
  const chat = d.capabilities?.chat_completion ?? d.capabilities?.chatCompletion;
  return chat === true || (typeof chat === 'string' && chat.toLowerCase() === 'true');
}

/** the deployments of the Foundry project; only the credential's own host is ever called */
export async function listDeployments(
  ctx: LoadOptionsContext,
  kind: DeploymentKind,
  filter?: string,
): Promise<ListSearchResult> {
  const authentication = readAuthentication(ctx.getCurrentNodeParameter('authentication'));
  const credentials = await ctx.getCredentials(authentication);
  let target: AzureTarget;
  try {
    target = azureTarget(credentials);
  } catch (error) {
    throw new Error((error as Error).message);
  }
  if (target.kind !== 'foundry' || !target.project) throw new Error(LIST_NEEDS_FOUNDRY);
  const first = `${target.origin}/api/projects/${encodeURIComponent(target.project)}/deployments`;
  const labels = new Map<string, string>();
  let url: string | undefined = first;
  for (let page = 0; url && page < MAX_DEPLOYMENT_PAGES; page++) {
    const response = (await ctx.helpers.httpRequestWithAuthentication(authentication, {
      url,
      ...(page === 0 ? { qs: { 'api-version': DEPLOYMENTS_API_VERSION } } : {}),
    })) as { value?: FoundryDeployment[]; nextLink?: string };
    for (const d of response.value ?? []) {
      if (typeof d?.name === 'string' && d.name && matchesKind(d, kind)) {
        const model = typeof d.modelName === 'string' ? d.modelName : '';
        labels.set(d.name, model ? `${d.name} (${model})` : d.name);
      }
    }
    // a next link is the server's word: follow it only on the same host
    url = undefined;
    if (typeof response.nextLink === 'string') {
      try {
        const next = new URL(response.nextLink);
        if (next.origin === target.origin) url = next.toString();
      } catch {
        url = undefined;
      }
    }
  }
  const needle = filter?.trim().toLowerCase();
  return {
    results: [...labels]
      .filter(([value]) => !needle || value.toLowerCase().includes(needle))
      .map(([value, name]) => ({ name, value }))
      .sort((a, b) => a.name.localeCompare(b.name)),
  };
}

function readExtraBody(ctx: SupplyDataContext, raw: unknown): DataObject | undefined {
  if (raw === undefined || raw === null || raw === '') return undefined;
  let value: unknown = raw;
  if (typeof raw === 'string') {
    try {
      value = JSON.parse(raw);
    } catch {
      throw new NodeOperationError(ctx.getNode(), 'Extra Body is not valid JSON');
    }
  }
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new NodeOperationError(ctx.getNode(), 'Extra Body must be a JSON object');
  }
  return value as DataObject;
}

export const LmChatAzureOpenAiNode: NodeType = {
  description: {
    ...modelDescription(
      {
        name: 'ai.lmChatAzureOpenAi',
        displayName: 'Microsoft Foundry Chat Model',
        description: 'Chat deployments on Microsoft Foundry and Azure OpenAI',
        icon: 'simple:microsoftazure',
        alias: ['azure', 'azure openai', 'foundry', 'microsoft', 'llm'],
        credential: 'azureOpenAiApi',
        defaultsName: 'Microsoft Foundry Chat Model',
      },
      [
        azureAuthenticationProperty,
        azureDeploymentProperty(
          'Model (Deployment)',
          'The deployment that answers. A list needs a Foundry credential with a project.',
        ),
        {
          displayName: 'Model Family',
          name: 'modelFamily',
          type: 'options',
          default: 'openai',
          description: 'Claude deployments need a credential using the Microsoft Foundry endpoint type',
          options: [
            { name: 'OpenAI', value: 'openai' },
            { name: 'Anthropic', value: 'anthropic' },
          ],
        },
        {
          displayName: 'Use Responses API',
          name: 'useResponsesApi',
          type: 'boolean',
          default: false,
          description: 'Call the Responses API instead of Chat Completions. Needs the Foundry endpoint type.',
          displayOptions: { show: { modelFamily: ['openai'] } },
        },
        {
          displayName: 'Options',
          name: 'options',
          type: 'collection',
          default: {},
          placeholder: 'Add option',
          options: [
            {
              displayName: 'Frequency Penalty',
              name: 'frequencyPenalty',
              type: 'number',
              default: 0,
              typeOptions: { minValue: -2, maxValue: 2, numberPrecision: 1 },
            },
            {
              displayName: 'Maximum Number of Tokens',
              name: 'maxTokens',
              type: 'number',
              default: -1,
              typeOptions: { minValue: -1 },
              description: 'Upper bound on the tokens generated per call. -1 leaves it to the model.',
            },
            {
              displayName: 'Presence Penalty',
              name: 'presencePenalty',
              type: 'number',
              default: 0,
              typeOptions: { minValue: -2, maxValue: 2, numberPrecision: 1 },
            },
            {
              displayName: 'Response Format',
              name: 'responseFormat',
              type: 'options',
              default: 'text',
              options: [
                { name: 'Text', value: 'text' },
                { name: 'JSON Object', value: 'json_object' },
              ],
            },
            {
              displayName: 'Sampling Temperature',
              name: 'temperature',
              type: 'number',
              default: 0.7,
              typeOptions: { minValue: 0, maxValue: 2, numberPrecision: 2 },
            },
            {
              displayName: 'Timeout (ms)',
              name: 'timeout',
              type: 'number',
              default: 60_000,
              typeOptions: { minValue: 1000 },
            },
            {
              displayName: 'Max Retries',
              name: 'maxRetries',
              type: 'number',
              default: 2,
              typeOptions: { minValue: 0, maxValue: 10 },
              description: 'Retries on rate limits (429) and server errors (5xx), with exponential backoff',
            },
            {
              displayName: 'Top P',
              name: 'topP',
              type: 'number',
              default: 1,
              typeOptions: { minValue: 0, maxValue: 1, numberPrecision: 2 },
            },
            {
              displayName: 'Extra Body',
              name: 'extraBody',
              type: 'json',
              default: '',
              description:
                'More fields for the request body, as a JSON object. They win over the fields above.',
            },
          ],
        },
      ],
    ),
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
    const family =
      ctx.getNodeParameter('modelFamily', itemIndex, 'openai') === 'anthropic' ? 'anthropic' : 'openai';
    const options = ctx.getNodeParameter('options', itemIndex, {}) as DataObject;
    const common = readCommonOptions(options);
    const maxTokens = common.maxTokens !== undefined && common.maxTokens > 0 ? common.maxTokens : undefined;
    const extraBody = readExtraBody(ctx, options.extraBody);
    const jsonObject = options.responseFormat === 'json_object';
    const modelOptions = { itemIndex, ...common };

    if (family === 'anthropic') {
      if (target.kind !== 'foundry') throw new NodeOperationError(ctx.getNode(), CLAUDE_NEEDS_FOUNDRY);
      const adapter = anthropicAdapter({
        baseUrl: `${target.origin}/anthropic`,
        model: deployment,
        maxTokens: maxTokens ?? DEFAULT_CLAUDE_MAX_TOKENS,
        topP: common.topP,
        promptCaching: false,
        refusalFallback: false,
        credentialType: authentication,
      });
      return { response: new HttpChatModel(ctx, adapter, modelOptions) };
    }

    if (ctx.getNodeParameter('useResponsesApi', itemIndex, false) === true) {
      if (target.kind !== 'foundry') throw new NodeOperationError(ctx.getNode(), RESPONSES_NEEDS_FOUNDRY);
      const adapter = openAiResponsesAdapter({
        baseUrl: target.baseUrl,
        model: deployment,
        credentialType: authentication,
        provider: 'azure-openai',
        temperature: common.temperature,
        topP: common.topP,
        maxTokens,
        ...(jsonObject ? { textFormat: { type: 'json_object' as const } } : {}),
        extraBody,
      });
      return { response: new HttpChatModel(ctx, adapter, modelOptions) };
    }

    const body: DataObject = {
      ...(jsonObject ? { response_format: { type: 'json_object' } } : {}),
      ...extraBody,
    };
    const adapter = openAiAdapter({
      baseUrl: target.baseUrl,
      model: deployment,
      credentialType: authentication,
      provider: 'azure-openai',
      maxTokensField: 'max_completion_tokens',
      responseFormatMode: 'jsonSchema',
      temperature: common.temperature,
      topP: common.topP,
      maxTokens,
      frequencyPenalty: options.frequencyPenalty as number | undefined,
      presencePenalty: options.presencePenalty as number | undefined,
      ...(target.kind === 'classic'
        ? {
            chatPath: `/openai/deployments/${encodeURIComponent(deployment)}/chat/completions`,
            query: { 'api-version': target.apiVersion || AZURE_DEFAULT_API_VERSION },
          }
        : {}),
      ...(Object.keys(body).length ? { extraBody: body } : {}),
    });
    return { response: new HttpChatModel(ctx, adapter, modelOptions) };
  },
  methods: {
    listSearch: {
      async searchDeployments(ctx, filter) {
        return listDeployments(ctx, 'chat', filter);
      },
    },
  },
};
