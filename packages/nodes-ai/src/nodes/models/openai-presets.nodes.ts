/**
 * Named OpenAI-compatible chat models: DeepSeek, xAI Grok, OpenRouter, Vercel AI Gateway, NVIDIA, Moonshot,
 * MiniMax, Qwen, Databricks, Lemonade and Groq. One table, one factory: each row holds the default URL, the
 * default model, the options and the extra request fields of its provider. Every call goes through the
 * credential type of the row, so the SSRF guard and the allowed domains apply. No partner header is sent.
 */
import type {
  AiChatResponse,
  DataObject,
  LoadOptionsContext,
  NodeProperty,
  NodePropertyOption,
  NodeType,
} from '@workflow/workflow';
import { openAiAdapter } from '../../providers/openai';
import { type ChatAdapter, HttpChatModel, readCommonOptions, trimSlash } from '../../shared/chat-model';
import { databricksGatewayUrl } from '../../shared/databricks';
import {
  listOpenAiModels,
  maxRetriesOption,
  maxTokensOption,
  modelDescription,
  modelOptionsProperty,
  sortOptions,
  temperatureOption,
  timeoutOption,
  topPOption,
} from './model-options';

const frequencyPenaltyOption: NodeProperty = {
  displayName: 'Frequency Penalty',
  name: 'frequencyPenalty',
  type: 'number',
  default: 0,
  typeOptions: { minValue: -2, maxValue: 2, numberPrecision: 1 },
  description: 'Positive values lower the chance of repeating the same words',
};
const presencePenaltyOption: NodeProperty = {
  displayName: 'Presence Penalty',
  name: 'presencePenalty',
  type: 'number',
  default: 0,
  typeOptions: { minValue: -2, maxValue: 2, numberPrecision: 1 },
  description: 'Positive values raise the chance of talking about new topics',
};
const responseFormatOption: NodeProperty = {
  displayName: 'Response Format',
  name: 'responseFormat',
  type: 'options',
  default: 'text',
  options: [
    { name: 'Text', value: 'text' },
    { name: 'JSON', value: 'json_object' },
  ],
  description: 'JSON asks the model for a valid JSON object',
};

/** -1 means no limit, as the providers read it */
const unlimitedMaxTokens: NodeProperty = {
  ...maxTokensOption(-1),
  typeOptions: { minValue: -1 },
  description: 'Upper bound on the tokens generated per call. -1 leaves it to the provider.',
};

const csv = (value: unknown): string[] =>
  String(value ?? '')
    .split(',')
    .map((v) => v.trim())
    .filter(Boolean);

/** the `<think>` blocks of a reasoning model are not part of the answer */
const THINK_BLOCK = /<think>[\s\S]*?<\/think>\s*/gi;

function hideThinking(adapter: ChatAdapter): ChatAdapter {
  const strip = (response: AiChatResponse): AiChatResponse =>
    typeof response.message.content === 'string'
      ? {
          ...response,
          message: { ...response.message, content: response.message.content.replace(THINK_BLOCK, '').trim() },
        }
      : response;
  return {
    ...adapter,
    parseResponse: (body) => strip(adapter.parseResponse(body)),
    ...(adapter.streamParser
      ? {
          streamParser: (onDelta) => {
            const parser = (adapter.streamParser as NonNullable<ChatAdapter['streamParser']>)(onDelta);
            return { push: (event, json) => parser.push(event, json), finish: () => strip(parser.finish()) };
          },
        }
      : {}),
  };
}

interface Preset {
  name: string;
  displayName: string;
  description: string;
  icon: string;
  alias: string[];
  credential: string;
  /** the credential field that holds the base URL (Lemonade: `baseUrl`) */
  urlField: string;
  defaultUrl: string;
  defaultModel: string;
  defaultMaxTokens: number;
  /** Groq shows only max tokens and temperature */
  minimalOptions?: boolean;
  /** options this provider adds */
  extraOptions: NodeProperty[];
  /** the URL the chat call goes to, from the credential */
  baseUrl?: (creds: DataObject, url: string) => string;
  /** request body fields from the node's options */
  extraBody?: (options: DataObject) => DataObject;
  /** wrap the adapter (MiniMax) */
  wrap?: (adapter: ChatAdapter, options: DataObject) => ChatAdapter;
  /** the model list, when it is not `GET <base>/models` */
  listModels?: (ctx: LoadOptionsContext, base: string) => Promise<NodePropertyOption[]>;
  /** the user may have no key (Lemonade) */
  optionalKey?: boolean;
}

const effortOptions = (levels: string[]): NodeProperty['options'] =>
  levels.map((value) => ({ name: value[0].toUpperCase() + value.slice(1), value }));

const openRouterRouting: NodeProperty = {
  displayName: 'Provider Routing',
  name: 'providerRouting',
  type: 'collection',
  default: {},
  placeholder: 'Add routing option',
  description: 'Which OpenRouter providers may serve the call',
  options: [
    {
      displayName: 'Order',
      name: 'order',
      type: 'string',
      default: '',
      placeholder: 'e.g. anthropic, openai',
      description: 'Provider names in the order to try, separated by commas',
    },
    {
      displayName: 'Allow Fallbacks',
      name: 'allowFallbacks',
      type: 'boolean',
      default: true,
      description: 'Whether to try other providers when the first one fails',
    },
    {
      displayName: 'Require Parameters',
      name: 'requireParameters',
      type: 'boolean',
      default: false,
      description: 'Whether to use only providers that support every parameter of the request',
    },
    {
      displayName: 'Data Collection',
      name: 'dataCollection',
      type: 'options',
      default: 'allow',
      options: [
        { name: 'Allow', value: 'allow' },
        { name: 'Deny', value: 'deny' },
      ],
      description: 'Whether providers may store and train on your data',
    },
    {
      displayName: 'Zero Data Retention',
      name: 'zdr',
      type: 'boolean',
      default: false,
      description: 'Whether to use only providers with a zero data retention policy',
    },
    {
      displayName: 'Only',
      name: 'only',
      type: 'string',
      default: '',
      description: 'Providers to allow, separated by commas',
    },
    {
      displayName: 'Ignore',
      name: 'ignore',
      type: 'string',
      default: '',
      description: 'Providers to skip, separated by commas',
    },
    {
      displayName: 'Sort',
      name: 'sort',
      type: 'options',
      default: 'price',
      options: [
        { name: 'Price', value: 'price' },
        { name: 'Throughput', value: 'throughput' },
        { name: 'Latency', value: 'latency' },
      ],
      description: 'What to rank the providers by',
    },
  ],
};

function openRouterBody(options: DataObject): DataObject {
  const body: DataObject = {};
  if (options.reasoningEffort) body.reasoning = { effort: options.reasoningEffort };
  const r = options.providerRouting as DataObject | undefined;
  if (r && typeof r === 'object') {
    const provider: DataObject = {};
    const order = csv(r.order);
    const only = csv(r.only);
    const ignore = csv(r.ignore);
    if (order.length) provider.order = order;
    if (only.length) provider.only = only;
    if (ignore.length) provider.ignore = ignore;
    if (typeof r.allowFallbacks === 'boolean') provider.allow_fallbacks = r.allowFallbacks;
    if (typeof r.requireParameters === 'boolean') provider.require_parameters = r.requireParameters;
    if (r.dataCollection) provider.data_collection = r.dataCollection;
    if (r.zdr === true) provider.zdr = true;
    if (r.sort) provider.sort = r.sort;
    if (Object.keys(provider).length) body.provider = provider;
  }
  return body;
}

/** Databricks lists the serving endpoints of the workspace; the chat ones are the models to pick */
async function listDatabricksModels(ctx: LoadOptionsContext, credential: string, host: string) {
  // https only, as for the chat calls: a user grant adds its bearer token to this request
  databricksGatewayUrl(host);
  const response = (await ctx.helpers.httpRequestWithAuthentication(credential, {
    url: `${trimSlash(host)}/api/2.0/serving-endpoints`,
  })) as { endpoints?: Array<{ name?: string; task?: string }> };
  return sortOptions(
    (response.endpoints ?? [])
      .filter((e): e is { name: string; task?: string } => Boolean(e?.name))
      .filter((e) => !e.task || /chat/.test(e.task))
      .map((e) => ({ name: e.name, value: e.name })),
  );
}

const PRESETS: Preset[] = [
  {
    name: 'ai.lmChatDeepSeek',
    displayName: 'DeepSeek Chat Model',
    description: 'Chat with DeepSeek models',
    icon: 'simple:deepseek',
    alias: ['deepseek', 'llm'],
    credential: 'deepSeekApi',
    urlField: 'url',
    defaultUrl: 'https://api.deepseek.com',
    defaultModel: 'deepseek-chat',
    defaultMaxTokens: -1,
    extraOptions: [],
  },
  {
    name: 'ai.lmChatXAiGrok',
    displayName: 'xAI Grok Chat Model',
    description: 'Chat with xAI Grok models',
    icon: 'simple:x',
    alias: ['xai', 'grok', 'llm'],
    credential: 'xAiApi',
    urlField: 'url',
    defaultUrl: 'https://api.x.ai/v1',
    defaultModel: 'grok-2-vision-1212',
    defaultMaxTokens: -1,
    extraOptions: [
      {
        displayName: 'Enable Priority',
        name: 'priority',
        type: 'boolean',
        default: false,
        description: 'Whether to ask for priority processing of the call',
      },
      {
        displayName: 'Reasoning Effort',
        name: 'reasoningEffort',
        type: 'options',
        default: 'low',
        options: effortOptions(['low', 'high']),
        description: 'How hard a reasoning model thinks before it answers',
      },
    ],
    extraBody: (o) => (o.priority === true ? { service_tier: 'priority' } : {}),
  },
  {
    name: 'ai.lmChatOpenRouter',
    displayName: 'OpenRouter Chat Model',
    description: 'Chat with any model on OpenRouter',
    icon: 'simple:openrouter',
    alias: ['openrouter', 'router', 'llm'],
    credential: 'openRouterApi',
    urlField: 'url',
    defaultUrl: 'https://openrouter.ai/api/v1',
    defaultModel: 'openai/gpt-4.1-mini',
    defaultMaxTokens: -1,
    extraOptions: [
      {
        displayName: 'Reasoning Effort',
        name: 'reasoningEffort',
        type: 'options',
        default: 'medium',
        options: effortOptions(['low', 'medium', 'high']),
        description: 'How hard a reasoning model thinks before it answers',
      },
      openRouterRouting,
    ],
    extraBody: openRouterBody,
  },
  {
    name: 'ai.lmChatVercelAiGateway',
    displayName: 'Vercel AI Gateway Chat Model',
    description: 'Chat through the Vercel AI Gateway',
    icon: 'simple:vercel',
    alias: ['vercel', 'gateway', 'llm'],
    credential: 'vercelAiGatewayApi',
    urlField: 'url',
    defaultUrl: 'https://ai-gateway.vercel.sh/v1',
    defaultModel: 'openai/gpt-4o',
    defaultMaxTokens: -1,
    extraOptions: [],
  },
  {
    name: 'ai.lmChatNvidia',
    displayName: 'NVIDIA Chat Model',
    description: 'Chat with models hosted by NVIDIA',
    icon: 'simple:nvidia',
    alias: ['nvidia', 'nemotron', 'nim', 'llm'],
    credential: 'nvidiaApi',
    urlField: 'url',
    defaultUrl: 'https://integrate.api.nvidia.com/v1',
    defaultModel: 'nvidia/llama-3.3-nemotron-super-49b-v1',
    defaultMaxTokens: -1,
    extraOptions: [],
    optionalKey: true,
  },
  {
    name: 'ai.lmChatMoonshot',
    displayName: 'Moonshot Kimi Chat Model',
    description: 'Chat with Moonshot Kimi models',
    icon: 'simple:moonshot',
    alias: ['moonshot', 'kimi', 'llm'],
    credential: 'moonshotApi',
    urlField: 'url',
    defaultUrl: 'https://api.moonshot.ai/v1',
    defaultModel: 'kimi-k2.5',
    defaultMaxTokens: -1,
    extraOptions: [],
  },
  {
    name: 'ai.lmChatMinimax',
    displayName: 'MiniMax Chat Model',
    description: 'Chat with MiniMax models',
    icon: 'simple:minimax',
    alias: ['minimax', 'llm'],
    credential: 'minimaxApi',
    urlField: 'url',
    defaultUrl: 'https://api.minimax.io/v1',
    defaultModel: 'MiniMax-M2',
    defaultMaxTokens: -1,
    extraOptions: [
      {
        displayName: 'Hide Thinking',
        name: 'hideThinking',
        type: 'boolean',
        default: true,
        description: 'Whether to keep the thinking of the model out of the answer',
      },
    ],
    extraBody: (o) => (o.hideThinking === false ? {} : { reasoning_split: true }),
    wrap: (adapter, o) => (o.hideThinking === false ? adapter : hideThinking(adapter)),
  },
  {
    name: 'ai.lmChatAlibabaCloud',
    displayName: 'Qwen Chat Model',
    description: 'Chat with Qwen models on Alibaba Cloud',
    icon: 'simple:alibabacloud',
    alias: ['qwen', 'alibaba', 'dashscope', 'llm'],
    credential: 'alibabaCloudApi',
    urlField: 'url',
    defaultUrl: 'https://dashscope-intl.aliyuncs.com',
    defaultModel: 'qwen-plus',
    defaultMaxTokens: -1,
    extraOptions: [],
    // the credential holds the region's host; the compatible API sits under it
    baseUrl: (_creds, url) => `${trimSlash(url)}/compatible-mode/v1`,
  },
  {
    name: 'ai.lmChatDatabricks',
    displayName: 'Databricks Chat Model',
    description: 'Chat with models on a Databricks AI Gateway',
    icon: 'simple:databricks',
    alias: ['databricks', 'llm'],
    credential: 'databricksOAuth2Api',
    urlField: 'host',
    defaultUrl: '',
    defaultModel: 'databricks-meta-llama-3-3-70b-instruct',
    defaultMaxTokens: -1,
    extraOptions: [],
    // https only: the token calls of this credential carry its client secret
    baseUrl: (_creds, host) => databricksGatewayUrl(host),
    listModels: (ctx, host) => listDatabricksModels(ctx, 'databricksOAuth2Api', host),
  },
  {
    name: 'ai.lmChatLemonade',
    displayName: 'Lemonade Chat Model',
    description: 'Chat with models served by Lemonade',
    icon: 'lucide:citrus',
    alias: ['lemonade', 'local', 'llm'],
    credential: 'lemonadeApi',
    urlField: 'baseUrl',
    defaultUrl: 'http://localhost:8000/api/v1',
    defaultModel: 'Llama-3.2-1B-Instruct-Hybrid',
    defaultMaxTokens: -1,
    extraOptions: [],
    optionalKey: true,
  },
  {
    name: 'ai.lmChatGroq',
    displayName: 'Groq Chat Model',
    description: 'Chat with models hosted by Groq',
    icon: 'simple:groq',
    alias: ['groq', 'llm'],
    credential: 'groqApi',
    urlField: 'url',
    defaultUrl: 'https://api.groq.com/openai/v1',
    defaultModel: 'llama3-8b-8192',
    defaultMaxTokens: 1024,
    minimalOptions: true,
    extraOptions: [],
  },
];

function optionList(preset: Preset): NodeProperty[] {
  const list: NodeProperty[] = preset.minimalOptions
    ? [maxTokensOption(preset.defaultMaxTokens), temperatureOption]
    : [
        frequencyPenaltyOption,
        unlimitedMaxTokens,
        responseFormatOption,
        presencePenaltyOption,
        temperatureOption,
        timeoutOption,
        maxRetriesOption,
        topPOption,
      ];
  return [...list, ...preset.extraOptions];
}

/** the base URL the credential holds, or the provider's default */
function credentialBase(preset: Preset, creds: DataObject): string {
  const url = String(creds[preset.urlField] ?? '').trim() || preset.defaultUrl;
  return preset.baseUrl ? preset.baseUrl(creds, url) : trimSlash(url);
}

function presetNode(preset: Preset): NodeType {
  const model = modelOptionsProperty('model', preset.defaultModel);
  return {
    description: modelDescription(
      {
        name: preset.name,
        displayName: preset.displayName,
        description: preset.description,
        icon: preset.icon,
        alias: preset.alias,
        credential: preset.credential,
        defaultsName: preset.displayName,
      },
      [
        model,
        {
          displayName: 'Options',
          name: 'options',
          type: 'collection',
          default: {},
          placeholder: 'Add option',
          options: optionList(preset),
        },
      ],
    ),
    async supplyData(ctx, itemIndex) {
      const creds = await ctx.getCredentials(preset.credential, itemIndex);
      const options = ctx.getNodeParameter('options', itemIndex, {}) as DataObject;
      const common = readCommonOptions(options);
      const modelId = String(ctx.getNodeParameter('model', itemIndex, preset.defaultModel)).trim();
      if (!modelId) throw new Error('Choose a model');
      const num = (v: unknown) => (v === undefined || v === null || v === '' ? undefined : Number(v));
      const reasoningEffort =
        preset.name === 'ai.lmChatXAiGrok' && options.reasoningEffort ? String(options.reasoningEffort) : undefined;
      // the option asks for JSON on every call; responseFormatMode covers only a request from a parser
      const extraBody: DataObject = {
        ...(preset.extraBody?.(options) ?? {}),
        ...(options.responseFormat === 'json_object' ? { response_format: { type: 'json_object' } } : {}),
      };
      let adapter = openAiAdapter({
        baseUrl: credentialBase(preset, creds),
        model: modelId,
        provider: preset.name.replace('ai.lmChat', '').toLowerCase(),
        credentialType: preset.credential,
        maxTokensField: 'max_tokens',
        responseFormatMode: options.responseFormat === 'json_object' ? 'jsonObject' : 'none',
        temperature: common.temperature,
        topP: common.topP,
        maxTokens: common.maxTokens !== undefined && common.maxTokens > 0 ? common.maxTokens : undefined,
        frequencyPenalty: num(options.frequencyPenalty),
        presencePenalty: num(options.presencePenalty),
        ...(reasoningEffort ? { reasoningEffort } : {}),
        ...(Object.keys(extraBody).length ? { extraBody } : {}),
      });
      if (preset.wrap) adapter = preset.wrap(adapter, options);
      return { response: new HttpChatModel(ctx, adapter, { itemIndex, ...common }) };
    },
    methods: {
      loadOptions: {
        async listModels(ctx) {
          const creds = await ctx.getCredentials(preset.credential);
          const list = preset.listModels;
          if (list) return list(ctx, String(creds[preset.urlField] ?? ''));
          return listOpenAiModels(ctx, preset.credential, credentialBase(preset, creds));
        },
      },
    },
  };
}

export const openAiPresetNodes: NodeType[] = PRESETS.map(presetNode);
