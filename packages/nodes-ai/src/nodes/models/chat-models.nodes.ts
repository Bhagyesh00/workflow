/**
 * Chat model sub-nodes. Each supplies an `AiChatModel` (provider-neutral) to agents and chains.
 * All HTTP goes through `ctx.helpers.httpRequestWithAuthentication`, so credentials are applied
 * by their credential type and the SSRF guard covers every call.
 */
import type {
  DataObject,
  LoadOptionsContext,
  NodeProperty,
  NodePropertyOption,
  NodeType,
  NodeTypeDescription,
  SupplyDataContext,
} from '@workflow/workflow';
import {
  ANTHROPIC_API_VERSION,
  ANTHROPIC_DEFAULT_BASE_URL,
  ANTHROPIC_DEFAULT_MODEL,
  anthropicAdapter,
} from '../../providers/anthropic';
import { GEMINI_DEFAULT_HOST, GEMINI_DEFAULT_MODEL, geminiAdapter } from '../../providers/gemini';
import { OLLAMA_DEFAULT_BASE_URL, OLLAMA_DEFAULT_MODEL, ollamaAdapter } from '../../providers/ollama';
import { openAiAdapter, type ResponseFormatMode } from '../../providers/openai';
import { HttpChatModel, readCommonOptions, trimSlash } from '../../shared/chat-model';

const OPENAI_DEFAULT_BASE_URL = 'https://api.openai.com/v1';
const OPENAI_DEFAULT_MODEL = 'gpt-5-mini';

const temperatureOption: NodeProperty = {
  displayName: 'Sampling Temperature',
  name: 'temperature',
  type: 'number',
  default: 0.7,
  typeOptions: { minValue: 0, maxValue: 2, numberPrecision: 2 },
  description: 'Higher values make the output more random. Some reasoning models accept only the default.',
};
const topPOption: NodeProperty = {
  displayName: 'Top P',
  name: 'topP',
  type: 'number',
  default: 1,
  typeOptions: { minValue: 0, maxValue: 1, numberPrecision: 2 },
  description: 'Nucleus sampling: consider only tokens within this probability mass',
};
const maxTokensOption = (defaultValue: number): NodeProperty => ({
  displayName: 'Maximum Number of Tokens',
  name: 'maxTokens',
  type: 'number',
  default: defaultValue,
  typeOptions: { minValue: 1 },
  description: 'Upper bound on the tokens generated per call',
});
const timeoutOption: NodeProperty = {
  displayName: 'Timeout (ms)',
  name: 'timeout',
  type: 'number',
  default: 120_000,
  typeOptions: { minValue: 1000 },
};
const maxRetriesOption: NodeProperty = {
  displayName: 'Max Retries',
  name: 'maxRetries',
  type: 'number',
  default: 2,
  typeOptions: { minValue: 0, maxValue: 10 },
  description: 'Retries on rate limits (429) and server errors (5xx), with exponential backoff',
};

function modelDescription(
  base: Pick<NodeTypeDescription, 'name' | 'displayName' | 'description' | 'icon' | 'alias'> & {
    credential: string;
    defaultsName: string;
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
    defaults: { name: base.defaultsName },
    inputs: [],
    outputs: ['ai_languageModel'],
    outputNames: ['Model'],
    credentials: [{ name: base.credential, required: true }],
    categories: ['AI', 'Language Models'],
    alias: base.alias,
    properties,
  };
}

function modelOptionsProperty(name: string, defaultModel: string, method = 'listModels'): NodeProperty {
  return {
    displayName: 'Model',
    name,
    type: 'options',
    default: defaultModel,
    typeOptions: { loadOptionsMethod: method },
    description: 'The model that generates the completion',
  };
}

const sortOptions = (options: NodePropertyOption[]) =>
  options.sort((a, b) => String(a.name).localeCompare(String(b.name)));

const NON_CHAT_MODEL =
  /embed|whisper|tts|dall-e|moderation|audio|realtime|transcribe|image|search|davinci|babbage/i;

async function listOpenAiModels(ctx: LoadOptionsContext, credentialType: string, baseUrl: string) {
  const response = (await ctx.helpers.httpRequestWithAuthentication(credentialType, {
    url: `${trimSlash(baseUrl)}/models`,
  })) as { data?: Array<{ id: string }> };
  return sortOptions(
    (response.data ?? [])
      .filter((m) => m?.id && !NON_CHAT_MODEL.test(m.id))
      .map((m) => ({ name: m.id, value: m.id })),
  );
}

// ---------------------------------------------------------------------------------------------
// OpenAI
// ---------------------------------------------------------------------------------------------

export const LmChatOpenAiNode: NodeType = {
  description: modelDescription(
    {
      name: 'ai.lmChatOpenAi',
      displayName: 'OpenAI Chat Model',
      description: 'Chat completions with OpenAI models (tools and JSON-schema output)',
      icon: 'simple:openai',
      alias: ['gpt', 'chatgpt', 'llm'],
      credential: 'openAiApi',
      defaultsName: 'OpenAI Chat Model',
    },
    [
      modelOptionsProperty('model', OPENAI_DEFAULT_MODEL),
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
    const adapter = openAiAdapter({
      baseUrl: String(creds.baseUrl || OPENAI_DEFAULT_BASE_URL),
      model: String(ctx.getNodeParameter('model', itemIndex, OPENAI_DEFAULT_MODEL)),
      credentialType: 'openAiApi',
      maxTokensField: 'max_completion_tokens',
      responseFormatMode: (options.responseFormat as ResponseFormatMode) ?? 'jsonSchema',
      temperature: common.temperature,
      topP: common.topP,
      maxTokens: common.maxTokens,
      frequencyPenalty: options.frequencyPenalty as number | undefined,
      presencePenalty: options.presencePenalty as number | undefined,
      reasoningEffort: options.reasoningEffort as string | undefined,
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

// ---------------------------------------------------------------------------------------------
// OpenAI-compatible (OpenRouter, Groq, Mistral, DeepSeek, xAI, Together, LM Studio, vLLM...)
// ---------------------------------------------------------------------------------------------

export const LmChatOpenAiCompatibleNode: NodeType = {
  description: modelDescription(
    {
      name: 'ai.lmChatOpenAiCompatible',
      displayName: 'OpenAI-Compatible Chat Model',
      description:
        'Any chat completions API: OpenRouter, Groq, Mistral, DeepSeek, xAI, Together, LM Studio, vLLM',
      icon: 'lucide:plug-zap',
      alias: [
        'openrouter',
        'groq',
        'mistral',
        'deepseek',
        'xai',
        'grok',
        'together',
        'lm studio',
        'vllm',
        'llm',
      ],
      credential: 'openAiCompatibleApi',
      defaultsName: 'Chat Model',
    },
    [
      {
        displayName: 'Model',
        name: 'model',
        type: 'string',
        default: '',
        required: true,
        placeholder: 'e.g. mistral-large-latest, deepseek-chat, llama-3.3-70b-versatile',
        description: 'Model id as the provider names it',
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
            displayName: 'Max Tokens Field',
            name: 'maxTokensField',
            type: 'options',
            default: 'max_tokens',
            options: [
              { name: 'max_tokens', value: 'max_tokens' },
              { name: 'max_completion_tokens', value: 'max_completion_tokens' },
            ],
          },
          {
            displayName: 'Structured Output',
            name: 'responseFormat',
            type: 'options',
            default: 'none',
            description: 'Enable only if the provider supports the response_format parameter',
            options: [
              { name: 'Prompt Instructions Only', value: 'none' },
              { name: 'JSON Object', value: 'jsonObject' },
              { name: 'JSON Schema', value: 'jsonSchema' },
            ],
          },
          {
            displayName: 'Extra Headers (JSON)',
            name: 'extraHeaders',
            type: 'json',
            default: '{}',
            description: 'e.g. {"HTTP-Referer": "https://example.com", "X-Title": "My App"} for OpenRouter',
          },
          timeoutOption,
          maxRetriesOption,
        ],
      },
    ],
  ),
  async supplyData(ctx, itemIndex) {
    const creds = await ctx.getCredentials('openAiCompatibleApi', itemIndex);
    const options = ctx.getNodeParameter('options', itemIndex, {}) as DataObject;
    const common = readCommonOptions(options);
    const model = String(ctx.getNodeParameter('model', itemIndex, '')).trim();
    if (!model) throw new Error('Enter the model id');
    if (!creds.baseUrl) throw new Error('The credential has no base URL');
    let extraHeaders: Record<string, string> = {};
    if (options.extraHeaders) {
      const parsed =
        typeof options.extraHeaders === 'string' ? JSON.parse(options.extraHeaders) : options.extraHeaders;
      extraHeaders = Object.fromEntries(
        Object.entries(parsed as DataObject)
          .filter(([k]) => !/^(authorization|host|content-length)$/i.test(k))
          .map(([k, v]) => [k.toLowerCase(), String(v)]),
      );
    }
    const adapter = openAiAdapter({
      baseUrl: String(creds.baseUrl),
      model,
      provider: 'openai-compatible',
      credentialType: 'openAiCompatibleApi',
      maxTokensField: (options.maxTokensField as 'max_tokens' | 'max_completion_tokens') ?? 'max_tokens',
      responseFormatMode: (options.responseFormat as ResponseFormatMode) ?? 'none',
      temperature: common.temperature,
      topP: common.topP,
      maxTokens: common.maxTokens,
      extraHeaders,
    });
    return { response: new HttpChatModel(ctx, adapter, { itemIndex, ...common }) };
  },
};

// ---------------------------------------------------------------------------------------------
// Anthropic
// ---------------------------------------------------------------------------------------------

export const LmChatAnthropicNode: NodeType = {
  description: modelDescription(
    {
      name: 'ai.lmChatAnthropic',
      displayName: 'Anthropic Chat Model',
      description: 'Claude models through the Anthropic Messages API',
      icon: 'simple:anthropic',
      alias: ['claude', 'sonnet', 'opus', 'haiku', 'llm'],
      credential: 'anthropicApi',
      defaultsName: 'Anthropic Chat Model',
    },
    [
      modelOptionsProperty('model', ANTHROPIC_DEFAULT_MODEL),
      {
        displayName: 'Options',
        name: 'options',
        type: 'collection',
        default: {},
        placeholder: 'Add option',
        options: [
          maxTokensOption(16_000),
          {
            displayName: 'Effort',
            name: 'effort',
            type: 'options',
            default: 'medium',
            description:
              'How much the model thinks and spends per answer. Lower is faster and cheaper; unset uses the model default.',
            options: ['low', 'medium', 'high', 'xhigh', 'max'].map((v) => ({ name: v, value: v })),
          },
          {
            displayName: 'Prompt Caching',
            name: 'promptCaching',
            type: 'boolean',
            default: true,
            description: 'Whether to cache the repeated prompt prefix (cheaper multi-step agent runs)',
          },
          {
            displayName: 'Refusal Fallback',
            name: 'refusalFallback',
            type: 'boolean',
            default: true,
            description:
              'Whether a request the model declines is retried on the model Anthropic recommends (Claude API, supported models only)',
          },
          timeoutOption,
          maxRetriesOption,
        ],
      },
      {
        displayName:
          'Sampling settings (temperature, top P) are fixed by the current Anthropic API version; use Effort to trade depth for speed.',
        name: 'samplingNotice',
        type: 'notice',
        default: '',
      },
    ],
  ),
  async supplyData(ctx, itemIndex) {
    const creds = await ctx.getCredentials('anthropicApi', itemIndex);
    const options = ctx.getNodeParameter('options', itemIndex, {}) as DataObject;
    const common = readCommonOptions(options);
    const adapter = anthropicAdapter({
      baseUrl: String(creds.baseUrl || ANTHROPIC_DEFAULT_BASE_URL),
      model: String(ctx.getNodeParameter('model', itemIndex, ANTHROPIC_DEFAULT_MODEL)),
      maxTokens: common.maxTokens ?? 16_000,
      effort: options.effort as string | undefined,
      promptCaching: options.promptCaching !== false,
      refusalFallback: options.refusalFallback !== false,
    });
    return { response: new HttpChatModel(ctx, adapter, { itemIndex, ...common }) };
  },
  methods: {
    loadOptions: {
      async listModels(ctx) {
        const creds = await ctx.getCredentials('anthropicApi');
        const options: NodePropertyOption[] = [];
        let afterId: string | undefined;
        for (let page = 0; page < 10; page++) {
          const response = (await ctx.helpers.httpRequestWithAuthentication('anthropicApi', {
            url: `${trimSlash(String(creds.baseUrl || ANTHROPIC_DEFAULT_BASE_URL))}/v1/models`,
            headers: { 'anthropic-version': ANTHROPIC_API_VERSION },
            qs: { limit: 100, ...(afterId ? { after_id: afterId } : {}) },
          })) as {
            data?: Array<{ id: string; display_name?: string }>;
            has_more?: boolean;
            last_id?: string;
          };
          for (const m of response.data ?? []) options.push({ name: m.display_name ?? m.id, value: m.id });
          if (!response.has_more || !response.last_id) break;
          afterId = response.last_id;
        }
        return options;
      },
    },
  },
};

// ---------------------------------------------------------------------------------------------
// Google Gemini
// ---------------------------------------------------------------------------------------------

export const LmChatGoogleGeminiNode: NodeType = {
  description: modelDescription(
    {
      name: 'ai.lmChatGoogleGemini',
      displayName: 'Google Gemini Chat Model',
      description: 'Gemini models through the Gemini API (function calling and JSON output)',
      icon: 'simple:googlegemini',
      alias: ['gemini', 'google', 'palm', 'llm'],
      credential: 'googleGeminiApi',
      defaultsName: 'Google Gemini Chat Model',
    },
    [
      modelOptionsProperty('modelName', GEMINI_DEFAULT_MODEL),
      {
        displayName: 'Options',
        name: 'options',
        type: 'collection',
        default: {},
        placeholder: 'Add option',
        options: [
          temperatureOption,
          maxTokensOption(8192),
          topPOption,
          {
            displayName: 'Top K',
            name: 'topK',
            type: 'number',
            default: 40,
            typeOptions: { minValue: 1 },
          },
          {
            displayName: 'Safety Threshold',
            name: 'safetyThreshold',
            type: 'options',
            default: 'default',
            options: [
              { name: 'Provider Default', value: 'default' },
              { name: 'Block Low and Above', value: 'BLOCK_LOW_AND_ABOVE' },
              { name: 'Block Medium and Above', value: 'BLOCK_MEDIUM_AND_ABOVE' },
              { name: 'Block Only High', value: 'BLOCK_ONLY_HIGH' },
              { name: 'Block None', value: 'BLOCK_NONE' },
            ],
          },
          timeoutOption,
          maxRetriesOption,
        ],
      },
    ],
  ),
  async supplyData(ctx, itemIndex) {
    const creds = await ctx.getCredentials('googleGeminiApi', itemIndex);
    const options = ctx.getNodeParameter('options', itemIndex, {}) as DataObject;
    const common = readCommonOptions(options);
    const threshold = options.safetyThreshold as string | undefined;
    const adapter = geminiAdapter({
      host: String(creds.host || GEMINI_DEFAULT_HOST),
      model: String(ctx.getNodeParameter('modelName', itemIndex, GEMINI_DEFAULT_MODEL)),
      temperature: common.temperature,
      topP: common.topP,
      topK: options.topK as number | undefined,
      maxTokens: common.maxTokens,
      safetySettings:
        threshold && threshold !== 'default'
          ? [
              'HARM_CATEGORY_HARASSMENT',
              'HARM_CATEGORY_HATE_SPEECH',
              'HARM_CATEGORY_SEXUALLY_EXPLICIT',
              'HARM_CATEGORY_DANGEROUS_CONTENT',
            ].map((category) => ({ category, threshold }))
          : undefined,
    });
    return { response: new HttpChatModel(ctx, adapter, { itemIndex, ...common }) };
  },
  methods: {
    loadOptions: {
      async listModels(ctx) {
        const creds = await ctx.getCredentials('googleGeminiApi');
        const response = (await ctx.helpers.httpRequestWithAuthentication('googleGeminiApi', {
          url: `${trimSlash(String(creds.host || GEMINI_DEFAULT_HOST))}/v1beta/models`,
          qs: { pageSize: 1000 },
        })) as {
          models?: Array<{ name: string; displayName?: string; supportedGenerationMethods?: string[] }>;
        };
        return sortOptions(
          (response.models ?? [])
            .filter((m) => m.supportedGenerationMethods?.includes('generateContent'))
            .map((m) => ({ name: m.displayName ?? m.name, value: m.name.replace(/^models\//, '') })),
        );
      },
    },
  },
};

// ---------------------------------------------------------------------------------------------
// Ollama
// ---------------------------------------------------------------------------------------------

export const LmChatOllamaNode: NodeType = {
  description: modelDescription(
    {
      name: 'ai.lmChatOllama',
      displayName: 'Ollama Chat Model',
      description: 'Local or self-hosted models served by Ollama',
      icon: 'simple:ollama',
      alias: ['llama', 'local', 'self-hosted', 'llm'],
      credential: 'ollamaApi',
      defaultsName: 'Ollama Chat Model',
    },
    [
      modelOptionsProperty('model', OLLAMA_DEFAULT_MODEL),
      {
        displayName: 'Options',
        name: 'options',
        type: 'collection',
        default: {},
        placeholder: 'Add option',
        options: [
          temperatureOption,
          maxTokensOption(2048),
          topPOption,
          {
            displayName: 'Context Window (num_ctx)',
            name: 'numCtx',
            type: 'number',
            default: 4096,
            typeOptions: { minValue: 256 },
          },
          {
            displayName: 'Keep Alive',
            name: 'keepAlive',
            type: 'string',
            default: '5m',
            description: 'How long the model stays loaded after the request',
          },
          timeoutOption,
          maxRetriesOption,
        ],
      },
    ],
  ),
  async supplyData(ctx, itemIndex) {
    const creds = await ctx.getCredentials('ollamaApi', itemIndex);
    const options = ctx.getNodeParameter('options', itemIndex, {}) as DataObject;
    const common = readCommonOptions(options);
    const adapter = ollamaAdapter({
      baseUrl: String(creds.baseUrl || OLLAMA_DEFAULT_BASE_URL),
      model: String(ctx.getNodeParameter('model', itemIndex, OLLAMA_DEFAULT_MODEL)),
      temperature: common.temperature,
      topP: common.topP,
      maxTokens: common.maxTokens,
      numCtx: options.numCtx as number | undefined,
      keepAlive: options.keepAlive as string | undefined,
    });
    return { response: new HttpChatModel(ctx, adapter, { itemIndex, ...common }) };
  },
  methods: {
    loadOptions: {
      async listModels(ctx) {
        const creds = await ctx.getCredentials('ollamaApi');
        const response = (await ctx.helpers.httpRequestWithAuthentication('ollamaApi', {
          url: `${trimSlash(String(creds.baseUrl || OLLAMA_DEFAULT_BASE_URL))}/api/tags`,
        })) as { models?: Array<{ name: string }> };
        return sortOptions((response.models ?? []).map((m) => ({ name: m.name, value: m.name })));
      },
    },
  },
};

export const chatModelNodes: NodeType[] = [
  LmChatOpenAiNode,
  LmChatAnthropicNode,
  LmChatGoogleGeminiNode,
  LmChatOllamaNode,
  LmChatOpenAiCompatibleNode,
];
