/** OpenAI chat model sub-node. All HTTP goes through `httpRequestWithAuthentication`. */
import {
  type DataObject,
  NodeOperationError,
  type NodeType,
  type SupplyDataContext,
} from '@workflow/workflow';
import { openAiAdapter, type ResponseFormatMode } from '../../providers/openai';
import {
  type OpenAiBuiltInTools,
  type OpenAiResponsesConfig,
  type OpenAiTextFormat,
  openAiResponsesAdapter,
} from '../../providers/openai-responses';
import { HttpChatModel, readCommonOptions } from '../../shared/chat-model';
import {
  listOpenAiModels,
  maxRetriesOption,
  maxTokensOption,
  modelDescription,
  modelOptionsProperty,
  temperatureOption,
  timeoutOption,
  topPOption,
} from './model-options';

const OPENAI_DEFAULT_BASE_URL = 'https://api.openai.com/v1';
const OPENAI_DEFAULT_MODEL = 'gpt-5-mini';
const RESPONSES_ONLY = { show: { useResponsesApi: [true] } };
const LEVELS = ['low', 'medium', 'high'].map((v) => ({ name: v, value: v }));

/** a JSON field that must hold an object (extra body, metadata, stored prompt variables) */
function readJsonObject(ctx: SupplyDataContext, label: string, raw: unknown): DataObject | undefined {
  if (raw === undefined || raw === null || raw === '') return undefined;
  let value: unknown = raw;
  if (typeof raw === 'string') {
    try {
      value = JSON.parse(raw);
    } catch {
      throw new NodeOperationError(ctx.getNode(), `${label} is not valid JSON`);
    }
  }
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new NodeOperationError(ctx.getNode(), `${label} must be a JSON object`);
  }
  return value as DataObject;
}

const text = (v: unknown): string | undefined => (typeof v === 'string' && v.trim() ? v.trim() : undefined);

function readBuiltInTools(builtIn: DataObject): OpenAiBuiltInTools {
  const tools: OpenAiBuiltInTools = {};
  const web = builtIn.webSearch as DataObject | undefined;
  if (web) {
    tools.webSearch = {
      searchContextSize: text(web.searchContextSize),
      country: text(web.country),
      city: text(web.city),
      region: text(web.region),
    };
  }
  const file = builtIn.fileSearch as DataObject | undefined;
  if (file) {
    const ids = String(file.vectorStoreIds ?? '')
      .split(',')
      .map((v) => v.trim())
      .filter(Boolean);
    if (ids.length) {
      tools.fileSearch = {
        vectorStoreIds: ids,
        maxResults: file.maxResults ? Number(file.maxResults) : undefined,
      };
    }
  }
  if (builtIn.codeInterpreter !== undefined) tools.codeInterpreter = true;
  return tools;
}

export const LmChatOpenAiNode: NodeType = {
  description: modelDescription(
    {
      name: 'ai.lmChatOpenAi',
      displayName: 'OpenAI Chat Model',
      description: 'Chat completions and the Responses API with OpenAI models (tools and JSON-schema output)',
      icon: 'simple:openai',
      alias: ['gpt', 'chatgpt', 'llm'],
      credential: 'openAiApi',
      defaultsName: 'OpenAI Chat Model',
    },
    [
      modelOptionsProperty('model', OPENAI_DEFAULT_MODEL),
      {
        displayName: 'Use Responses API',
        name: 'useResponsesApi',
        type: 'boolean',
        default: false,
        description: 'Call the Responses API instead of Chat Completions. Needed for the built-in tools.',
      },
      {
        displayName: 'Built-in Tools',
        name: 'builtInTools',
        type: 'collection',
        default: {},
        placeholder: 'Add built-in tool',
        displayOptions: RESPONSES_ONLY,
        options: [
          {
            displayName: 'Web Search',
            name: 'webSearch',
            type: 'collection',
            default: {},
            placeholder: 'Add option',
            options: [
              {
                displayName: 'Search Context Size',
                name: 'searchContextSize',
                type: 'options',
                default: 'medium',
                options: LEVELS,
              },
              { displayName: 'Country (ISO code)', name: 'country', type: 'string', default: '' },
              { displayName: 'City', name: 'city', type: 'string', default: '' },
              { displayName: 'Region', name: 'region', type: 'string', default: '' },
            ],
          },
          {
            displayName: 'File Search',
            name: 'fileSearch',
            type: 'collection',
            default: {},
            placeholder: 'Add option',
            options: [
              {
                displayName: 'Vector Store IDs',
                name: 'vectorStoreIds',
                type: 'string',
                default: '',
                description: 'Comma separated ids of OpenAI vector stores',
              },
              {
                displayName: 'Max Results',
                name: 'maxResults',
                type: 'number',
                default: 5,
                typeOptions: { minValue: 1, maxValue: 50 },
              },
            ],
          },
          {
            displayName: 'Code Interpreter',
            name: 'codeInterpreter',
            type: 'collection',
            default: {},
            placeholder: 'Enable',
            options: [],
          },
        ],
      },
      {
        displayName: 'Options',
        name: 'options',
        type: 'collection',
        default: {},
        placeholder: 'Add option',
        options: [
          temperatureOption,
          maxTokensOption(4096),
          topPOption,
          {
            displayName: 'Frequency Penalty',
            name: 'frequencyPenalty',
            type: 'number',
            default: 0,
            typeOptions: { minValue: -2, maxValue: 2, numberPrecision: 1 },
          },
          {
            displayName: 'Presence Penalty',
            name: 'presencePenalty',
            type: 'number',
            default: 0,
            typeOptions: { minValue: -2, maxValue: 2, numberPrecision: 1 },
          },
          {
            displayName: 'Reasoning Effort',
            name: 'reasoningEffort',
            type: 'options',
            default: 'medium',
            description: 'For reasoning models only',
            options: ['minimal', 'low', 'medium', 'high'].map((v) => ({ name: v, value: v })),
          },
          {
            displayName: 'Structured Output',
            name: 'responseFormat',
            type: 'options',
            default: 'jsonSchema',
            description: 'How JSON output is requested when an output parser asks for it',
            options: [
              { name: 'JSON Schema', value: 'jsonSchema' },
              { name: 'JSON Object', value: 'jsonObject' },
              { name: 'Prompt Instructions Only', value: 'none' },
            ],
          },
          {
            displayName: 'Base URL',
            name: 'baseURL',
            type: 'string',
            default: '',
            description: 'Overrides the base URL of the credential',
          },
          {
            displayName: 'Verbosity',
            name: 'verbosity',
            type: 'options',
            default: 'medium',
            options: LEVELS,
          },
          {
            displayName: 'Answer Format',
            name: 'textFormat',
            type: 'options',
            default: 'text',
            description: 'Used when no output parser asks for JSON (Responses API only)',
            options: [
              { name: 'Text', value: 'text' },
              { name: 'JSON Object', value: 'json_object' },
              { name: 'JSON Schema', value: 'json_schema' },
            ],
          },
          { displayName: 'JSON Schema Name', name: 'schemaName', type: 'string', default: 'response' },
          {
            displayName: 'JSON Schema',
            name: 'schema',
            type: 'json',
            default: '',
            description: 'The schema of the answer, as a JSON object',
          },
          {
            displayName: 'Service Tier',
            name: 'serviceTier',
            type: 'options',
            default: 'auto',
            options: ['auto', 'default', 'flex', 'priority'].map((v) => ({ name: v, value: v })),
          },
          {
            displayName: 'Metadata',
            name: 'metadata',
            type: 'json',
            default: '',
            description: 'Key and value pairs, as a JSON object of strings',
          },
          {
            displayName: 'Top Logprobs',
            name: 'topLogprobs',
            type: 'number',
            default: 0,
            typeOptions: { minValue: 0, maxValue: 20 },
          },
          { displayName: 'Prompt Cache Key', name: 'promptCacheKey', type: 'string', default: '' },
          { displayName: 'Safety Identifier', name: 'safetyIdentifier', type: 'string', default: '' },
          { displayName: 'Conversation ID', name: 'conversationId', type: 'string', default: '' },
          { displayName: 'Stored Prompt ID', name: 'promptId', type: 'string', default: '' },
          { displayName: 'Stored Prompt Version', name: 'promptVersion', type: 'string', default: '' },
          { displayName: 'Stored Prompt Variables', name: 'promptVariables', type: 'json', default: '' },
          {
            displayName: 'Extra Body',
            name: 'extraBody',
            type: 'json',
            default: '',
            description:
              'More fields for the request body, as a JSON object. They win over the fields above.',
          },
          timeoutOption,
          maxRetriesOption,
        ],
      },
    ],
  ),
  async supplyData(ctx: SupplyDataContext, itemIndex: number) {
    const creds = await ctx.getCredentials('openAiApi', itemIndex);
    const options = ctx.getNodeParameter('options', itemIndex, {}) as DataObject;
    const common = readCommonOptions(options);
    const baseUrl = text(options.baseURL) ?? String(creds.baseUrl || OPENAI_DEFAULT_BASE_URL);
    const model = String(ctx.getNodeParameter('model', itemIndex, OPENAI_DEFAULT_MODEL));
    const extraBody = readJsonObject(ctx, 'Extra Body', options.extraBody);
    const metadata = readJsonObject(ctx, 'Metadata', options.metadata) as Record<string, string> | undefined;
    const serviceTier =
      options.serviceTier && options.serviceTier !== 'auto' ? String(options.serviceTier) : undefined;
    const topLogprobs = options.topLogprobs ? Number(options.topLogprobs) : undefined;
    const verbosity = text(options.verbosity);
    const reasoningEffort = options.reasoningEffort as string | undefined;
    const promptCacheKey = text(options.promptCacheKey);
    const safetyIdentifier = text(options.safetyIdentifier);

    if (ctx.getNodeParameter('useResponsesApi', itemIndex, false) === true) {
      let textFormat: OpenAiTextFormat | undefined;
      if (options.textFormat === 'json_object') textFormat = { type: 'json_object' };
      else if (options.textFormat === 'json_schema') {
        const schema = readJsonObject(ctx, 'JSON Schema', options.schema);
        if (!schema) throw new NodeOperationError(ctx.getNode(), 'JSON Schema is empty');
        textFormat = {
          type: 'json_schema',
          name: text(options.schemaName) ?? 'response',
          schema,
          strict: false,
        };
      }
      const promptId = text(options.promptId);
      const config: OpenAiResponsesConfig = {
        baseUrl,
        model,
        credentialType: 'openAiApi',
        responseFormatMode: (options.responseFormat as ResponseFormatMode) ?? 'jsonSchema',
        temperature: common.temperature,
        topP: common.topP,
        maxTokens: common.maxTokens,
        reasoningEffort,
        verbosity,
        textFormat,
        serviceTier,
        metadata,
        topLogprobs,
        promptCacheKey,
        safetyIdentifier,
        conversationId: text(options.conversationId),
        storedPrompt: promptId
          ? {
              id: promptId,
              version: text(options.promptVersion),
              variables: readJsonObject(ctx, 'Stored Prompt Variables', options.promptVariables),
            }
          : undefined,
        builtInTools: readBuiltInTools(
          (ctx.getNodeParameter('builtInTools', itemIndex, {}) as DataObject) ?? {},
        ),
        extraBody,
      };
      return { response: new HttpChatModel(ctx, openAiResponsesAdapter(config), { itemIndex, ...common }) };
    }

    // Chat Completions carries the same options as body fields of its own
    const completionsBody: DataObject = {};
    if (verbosity && options.verbosity !== undefined) completionsBody.verbosity = verbosity;
    if (serviceTier) completionsBody.service_tier = serviceTier;
    if (metadata) completionsBody.metadata = metadata;
    if (topLogprobs) {
      completionsBody.logprobs = true;
      completionsBody.top_logprobs = topLogprobs;
    }
    if (promptCacheKey) completionsBody.prompt_cache_key = promptCacheKey;
    if (safetyIdentifier) completionsBody.safety_identifier = safetyIdentifier;
    const merged = { ...completionsBody, ...extraBody };
    const adapter = openAiAdapter({
      baseUrl,
      model,
      credentialType: 'openAiApi',
      maxTokensField: 'max_completion_tokens',
      responseFormatMode: (options.responseFormat as ResponseFormatMode) ?? 'jsonSchema',
      temperature: common.temperature,
      topP: common.topP,
      maxTokens: common.maxTokens,
      frequencyPenalty: options.frequencyPenalty as number | undefined,
      presencePenalty: options.presencePenalty as number | undefined,
      reasoningEffort,
      extraBody: Object.keys(merged).length ? merged : undefined,
    });
    return { response: new HttpChatModel(ctx, adapter, { itemIndex, ...common }) };
  },
  methods: {
    loadOptions: {
      async listModels(ctx) {
        const creds = await ctx.getCredentials('openAiApi');
        return listOpenAiModels(ctx, 'openAiApi', String(creds.baseUrl || OPENAI_DEFAULT_BASE_URL));
      },
    },
  },
};
