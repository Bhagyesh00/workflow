/** Ollama chat model sub-node. */
import type { DataObject, NodeProperty, NodeType } from '@workflow/workflow';
import {
  OLLAMA_DEFAULT_BASE_URL,
  OLLAMA_DEFAULT_MODEL,
  type OllamaChatConfig,
  ollamaAdapter,
} from '../../providers/ollama';
import { HttpChatModel, readCommonOptions, trimSlash } from '../../shared/chat-model';
import { modelDescription, modelOptionsProperty, sortOptions, temperatureOption, topPOption } from './model-options';

/** The options of the Ollama chat and text models. Each is sent only when added to the node. */
export const ollamaOptions: NodeProperty[] = [
  {
    displayName: 'Thinking',
    name: 'think',
    type: 'boolean',
    default: true,
    description: 'Whether models that can think do so before they answer',
  },
  temperatureOption,
  {
    displayName: 'Top K',
    name: 'topK',
    type: 'number',
    default: -1,
    typeOptions: { minValue: -1, maxValue: 100 },
    description: 'Sample from the K most likely next tokens',
  },
  topPOption,
  {
    displayName: 'Frequency Penalty',
    name: 'frequencyPenalty',
    type: 'number',
    default: 0,
    description: 'Lower the chance of words that were already used often',
  },
  {
    displayName: 'Keep Alive',
    name: 'keepAlive',
    type: 'string',
    default: '5m',
    description: 'How long the model stays loaded after the request',
  },
  {
    displayName: 'Low VRAM Mode',
    name: 'lowVram',
    type: 'boolean',
    default: false,
    description: 'Whether to use less video memory, slower',
  },
  {
    displayName: 'Main GPU',
    name: 'mainGpu',
    type: 'number',
    default: 0,
    description: 'The GPU used for the model',
  },
  {
    displayName: 'Batch Size (num_batch)',
    name: 'numBatch',
    type: 'number',
    default: 512,
    description: 'Prompt tokens processed together',
  },
  {
    displayName: 'Context Window (num_ctx)',
    name: 'numCtx',
    type: 'number',
    default: 2048,
    description: 'Tokens the model keeps in context',
  },
  {
    displayName: 'GPU Layers (num_gpu)',
    name: 'numGpu',
    type: 'number',
    default: -1,
    description: 'Layers placed on the GPU, -1 lets Ollama decide',
  },
  {
    displayName: 'Max Tokens to Generate (num_predict)',
    name: 'numPredict',
    type: 'number',
    default: -1,
    description: 'Upper bound on the tokens generated per call, -1 means no limit',
  },
  {
    displayName: 'CPU Threads (num_thread)',
    name: 'numThread',
    type: 'number',
    default: 0,
    description: 'Threads used for the model, 0 lets Ollama decide',
  },
  {
    displayName: 'Penalize Newline',
    name: 'penalizeNewline',
    type: 'boolean',
    default: true,
    description: 'Whether new lines count for the repeat penalty',
  },
  {
    displayName: 'Presence Penalty',
    name: 'presencePenalty',
    type: 'number',
    default: 0,
    description: 'Lower the chance of words that were already used at all',
  },
  {
    displayName: 'Repeat Penalty',
    name: 'repeatPenalty',
    type: 'number',
    default: 1,
    description: 'How strongly repeated text is penalised',
  },
  {
    displayName: 'Lock Memory (use_mlock)',
    name: 'useMLock',
    type: 'boolean',
    default: false,
    description: 'Whether to keep the model in memory',
  },
  {
    displayName: 'Memory Map (use_mmap)',
    name: 'useMMap',
    type: 'boolean',
    default: true,
    description: 'Whether to map the model file into memory',
  },
  {
    displayName: 'Vocabulary Only',
    name: 'vocabOnly',
    type: 'boolean',
    default: false,
    description: 'Whether to load only the vocabulary, no weights',
  },
  {
    displayName: 'Output Format',
    name: 'format',
    type: 'options',
    default: 'default',
    description: 'JSON makes the model answer with a JSON object',
    options: [
      { name: 'Default', value: 'default' },
      { name: 'JSON', value: 'json' },
    ],
  },
];

const num = (value: unknown): number | undefined =>
  value === undefined || value === null || value === '' ? undefined : Number(value);

/** the adapter fields of `ollamaOptions` */
export function ollamaOptionsConfig(options: DataObject): Omit<OllamaChatConfig, 'baseUrl' | 'model'> {
  return {
    temperature: num(options.temperature),
    topP: num(options.topP),
    maxTokens: num(options.numPredict),
    numCtx: num(options.numCtx),
    keepAlive: options.keepAlive as string | undefined,
    topK: num(options.topK),
    frequencyPenalty: num(options.frequencyPenalty),
    presencePenalty: num(options.presencePenalty),
    repeatPenalty: num(options.repeatPenalty),
    penalizeNewline: options.penalizeNewline as boolean | undefined,
    lowVram: options.lowVram as boolean | undefined,
    mainGpu: num(options.mainGpu),
    numBatch: num(options.numBatch),
    numGpu: num(options.numGpu),
    numThread: num(options.numThread),
    useMLock: options.useMLock as boolean | undefined,
    useMMap: options.useMMap as boolean | undefined,
    vocabOnly: options.vocabOnly as boolean | undefined,
    format: options.format as string | undefined,
    think: options.think as boolean | undefined,
  };
}

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
        options: ollamaOptions,
      },
    ],
  ),
  async supplyData(ctx, itemIndex) {
    const creds = await ctx.getCredentials('ollamaApi', itemIndex);
    const options = ctx.getNodeParameter('options', itemIndex, {}) as DataObject;
    const adapter = ollamaAdapter({
      baseUrl: String(creds.baseUrl || OLLAMA_DEFAULT_BASE_URL),
      model: String(ctx.getNodeParameter('model', itemIndex, OLLAMA_DEFAULT_MODEL)),
      ...ollamaOptionsConfig(options),
    });
    return { response: new HttpChatModel(ctx, adapter, { itemIndex, ...readCommonOptions(options) }) };
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
