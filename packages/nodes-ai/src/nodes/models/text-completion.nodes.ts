/**
 * Text completion models: Cohere, Ollama, Lemonade and Hugging Face Inference. One prompt in, text out.
 * They supply a chat model marked `completion: true`, so chains take them and the Agent and Guardrails
 * refuse them with "<node> is a text completion model; connect a chat model". Every call goes through the
 * credential type of the node, so the SSRF guard and the allowed domains apply.
 */
import type { DataObject, NodeProperty, NodeType } from '@workflow/workflow';
import { COHERE_DEFAULT_BASE_URL, COHERE_DEFAULT_MODEL, cohereAdapter } from '../../providers/cohere';
import { OLLAMA_DEFAULT_BASE_URL, OLLAMA_DEFAULT_MODEL, ollamaAdapter } from '../../providers/ollama';
import { openAiAdapter } from '../../providers/openai';
import { HttpChatModel, readCommonOptions, trimSlash } from '../../shared/chat-model';
import { listCohereModels } from './LmChatCohere.node';
import { ollamaOptions, ollamaOptionsConfig } from './LmChatOllama.node';
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

const LEMONADE_DEFAULT_URL = 'http://localhost:8000/api/v1';
const LEMONADE_DEFAULT_MODEL = 'Llama-3.2-1B-Instruct-Hybrid';
const HUGGING_FACE_DEFAULT_URL = 'https://router.huggingface.co/v1';
const HUGGING_FACE_DEFAULT_MODEL = 'mistralai/Mistral-7B-Instruct-v0.3';

const collection = (options: NodeProperty[]): NodeProperty => ({
  displayName: 'Options',
  name: 'options',
  type: 'collection',
  default: {},
  placeholder: 'Add option',
  options,
});

const penalty = (displayName: string, name: string, description: string): NodeProperty => ({
  displayName,
  name,
  type: 'number',
  default: 0,
  typeOptions: { minValue: -2, maxValue: 2, numberPrecision: 1 },
  description,
});

const num = (value: unknown): number | undefined =>
  value === undefined || value === null || value === '' ? undefined : Number(value);

/** -1 or 0 means "no limit": the field is left out of the request */
const limit = (value: number | undefined) => (value !== undefined && value > 0 ? value : undefined);

const LmCohereNode: NodeType = {
  description: modelDescription(
    {
      name: 'ai.lmCohere',
      displayName: 'Cohere Model',
      description: 'Text completion with Cohere models',
      icon: 'simple:cohere',
      alias: ['cohere', 'text completion', 'llm'],
      credential: 'cohereApi',
      defaultsName: 'Cohere Model',
    },
    [
      modelOptionsProperty('model', COHERE_DEFAULT_MODEL),
      collection([maxTokensOption(250), temperatureOption, topPOption, timeoutOption, maxRetriesOption]),
    ],
  ),
  async supplyData(ctx, itemIndex) {
    const creds = await ctx.getCredentials('cohereApi', itemIndex);
    const options = ctx.getNodeParameter('options', itemIndex, {}) as DataObject;
    const common = readCommonOptions(options);
    const model = String(ctx.getNodeParameter('model', itemIndex, COHERE_DEFAULT_MODEL)).trim();
    if (!model) throw new Error('Choose a model');
    const adapter = cohereAdapter({
      baseUrl: String(creds.url || COHERE_DEFAULT_BASE_URL),
      model,
      credentialType: 'cohereApi',
      temperature: common.temperature,
      topP: common.topP,
      maxTokens: limit(common.maxTokens),
    });
    return { response: new HttpChatModel(ctx, adapter, { itemIndex, ...common, completion: true }) };
  },
  methods: {
    loadOptions: {
      async listModels(ctx) {
        return listCohereModels(ctx, 'chat');
      },
    },
  },
};

const LmOllamaNode: NodeType = {
  description: modelDescription(
    {
      name: 'ai.lmOllama',
      displayName: 'Ollama Model',
      description: 'Text completion with models served by Ollama',
      icon: 'simple:ollama',
      alias: ['llama', 'local', 'text completion', 'llm'],
      credential: 'ollamaApi',
      defaultsName: 'Ollama Model',
    },
    [
      modelOptionsProperty('model', OLLAMA_DEFAULT_MODEL),
      collection(ollamaOptions),
    ],
  ),
  async supplyData(ctx, itemIndex) {
    const creds = await ctx.getCredentials('ollamaApi', itemIndex);
    const options = ctx.getNodeParameter('options', itemIndex, {}) as DataObject;
    const common = readCommonOptions(options);
    const adapter = ollamaAdapter({
      baseUrl: String(creds.baseUrl || OLLAMA_DEFAULT_BASE_URL),
      model: String(ctx.getNodeParameter('model', itemIndex, OLLAMA_DEFAULT_MODEL)),
      ...ollamaOptionsConfig(options),
    });
    return { response: new HttpChatModel(ctx, adapter, { itemIndex, ...common, completion: true }) };
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

const LmLemonadeNode: NodeType = {
  description: modelDescription(
    {
      name: 'ai.lmLemonade',
      displayName: 'Lemonade Model',
      description: 'Text completion with models served by Lemonade',
      icon: 'lucide:citrus',
      alias: ['lemonade', 'local', 'text completion', 'llm'],
      credential: 'lemonadeApi',
      defaultsName: 'Lemonade Model',
    },
    [
      modelOptionsProperty('model', LEMONADE_DEFAULT_MODEL),
      collection([
        penalty('Frequency Penalty', 'frequencyPenalty', 'Positive values lower the chance of repeating the same words'),
        penalty('Presence Penalty', 'presencePenalty', 'Positive values raise the chance of talking about new topics'),
        {
          ...maxTokensOption(-1),
          typeOptions: { minValue: -1 },
          description: 'Upper bound on the tokens generated per call. -1 leaves it to the server.',
        },
        temperatureOption,
        topPOption,
        timeoutOption,
        maxRetriesOption,
      ]),
    ],
  ),
  async supplyData(ctx, itemIndex) {
    const creds = await ctx.getCredentials('lemonadeApi', itemIndex);
    const options = ctx.getNodeParameter('options', itemIndex, {}) as DataObject;
    const common = readCommonOptions(options);
    const model = String(ctx.getNodeParameter('model', itemIndex, LEMONADE_DEFAULT_MODEL)).trim();
    if (!model) throw new Error('Choose a model');
    const adapter = openAiAdapter({
      baseUrl: String(creds.baseUrl || LEMONADE_DEFAULT_URL),
      model,
      provider: 'lemonade',
      credentialType: 'lemonadeApi',
      maxTokensField: 'max_tokens',
      responseFormatMode: 'none',
      temperature: common.temperature,
      topP: common.topP,
      maxTokens: limit(common.maxTokens),
      frequencyPenalty: num(options.frequencyPenalty),
      presencePenalty: num(options.presencePenalty),
    });
    return { response: new HttpChatModel(ctx, adapter, { itemIndex, ...common, completion: true }) };
  },
  methods: {
    loadOptions: {
      async listModels(ctx) {
        const creds = await ctx.getCredentials('lemonadeApi');
        return listOpenAiModels(ctx, 'lemonadeApi', String(creds.baseUrl || LEMONADE_DEFAULT_URL));
      },
    },
  },
};

const LmHuggingFaceNode: NodeType = {
  description: modelDescription(
    {
      name: 'ai.lmOpenHuggingFaceInference',
      displayName: 'Hugging Face Inference Model',
      description: 'Text completion through Hugging Face Inference',
      icon: 'simple:huggingface',
      alias: ['hugging face', 'text completion', 'llm'],
      credential: 'huggingFaceApi',
      defaultsName: 'Hugging Face Inference Model',
    },
    [
      {
        displayName: 'Model',
        name: 'model',
        type: 'string',
        default: HUGGING_FACE_DEFAULT_MODEL,
        description: 'The model id on Hugging Face, or the name your endpoint serves',
      },
      collection([
        {
          displayName: 'Custom Inference Endpoint',
          name: 'endpointUrl',
          type: 'string',
          default: '',
          placeholder: 'https://example.endpoints.huggingface.cloud/v1',
          description: 'Base URL of an OpenAI-compatible endpoint. Empty uses the Hugging Face router.',
        },
        penalty('Frequency Penalty', 'frequencyPenalty', 'Positive values lower the chance of repeating the same words'),
        penalty('Presence Penalty', 'presencePenalty', 'Positive values raise the chance of talking about new topics'),
        {
          displayName: 'Top K',
          name: 'topK',
          type: 'number',
          default: 40,
          typeOptions: { minValue: 1 },
          description: 'Sample from the K most likely next tokens',
        },
        topPOption,
        maxTokensOption(512),
        temperatureOption,
        timeoutOption,
        maxRetriesOption,
      ]),
    ],
  ),
  async supplyData(ctx, itemIndex) {
    const options = ctx.getNodeParameter('options', itemIndex, {}) as DataObject;
    const common = readCommonOptions(options);
    const model = String(ctx.getNodeParameter('model', itemIndex, HUGGING_FACE_DEFAULT_MODEL)).trim();
    if (!model) throw new Error('Choose a model');
    const endpoint = String(options.endpointUrl ?? '').trim();
    const topK = num(options.topK);
    const adapter = openAiAdapter({
      baseUrl: endpoint || HUGGING_FACE_DEFAULT_URL,
      model,
      provider: 'huggingface',
      credentialType: 'huggingFaceApi',
      maxTokensField: 'max_tokens',
      responseFormatMode: 'none',
      temperature: common.temperature,
      topP: common.topP,
      maxTokens: limit(common.maxTokens),
      frequencyPenalty: num(options.frequencyPenalty),
      presencePenalty: num(options.presencePenalty),
      ...(topK !== undefined ? { extraBody: { top_k: topK } } : {}),
    });
    return { response: new HttpChatModel(ctx, adapter, { itemIndex, ...common, completion: true }) };
  },
};

export const textCompletionNodes: NodeType[] = [LmCohereNode, LmOllamaNode, LmLemonadeNode, LmHuggingFaceNode];
