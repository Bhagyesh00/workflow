/** Ollama chat model sub-node. */
import type { DataObject, NodeType } from '@workflow/workflow';
import { OLLAMA_DEFAULT_BASE_URL, OLLAMA_DEFAULT_MODEL, ollamaAdapter } from '../../providers/ollama';
import { HttpChatModel, readCommonOptions, trimSlash } from '../../shared/chat-model';
import {
  maxRetriesOption,
  maxTokensOption,
  modelDescription,
  modelOptionsProperty,
  sortOptions,
  temperatureOption,
  timeoutOption,
  topPOption,
} from './model-options';

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
          {
            displayName: 'Top K',
            name: 'topK',
            type: 'number',
            default: 40,
            description: 'Sample from the K most likely next tokens',
          },
          {
            displayName: 'Frequency Penalty',
            name: 'frequencyPenalty',
            type: 'number',
            default: 0,
            description: 'Lower the chance of words that were already used often',
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
            default: 1.1,
            description: 'How strongly repeated text is penalised',
          },
          {
            displayName: 'Penalize Newline',
            name: 'penalizeNewline',
            type: 'boolean',
            default: false,
            description: 'Whether new lines count for the repeat penalty',
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
            displayName: 'GPU Layers (num_gpu)',
            name: 'numGpu',
            type: 'number',
            default: -1,
            description: 'Layers placed on the GPU, -1 lets Ollama decide',
          },
          {
            displayName: 'CPU Threads (num_thread)',
            name: 'numThread',
            type: 'number',
            default: 0,
            description: 'Threads used for the model, 0 lets Ollama decide',
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
            default: false,
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
          {
            displayName: 'Thinking',
            name: 'think',
            type: 'boolean',
            default: true,
            description: 'Whether models that can think do so before they answer',
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
      topK: options.topK as number | undefined,
      frequencyPenalty: options.frequencyPenalty as number | undefined,
      presencePenalty: options.presencePenalty as number | undefined,
      repeatPenalty: options.repeatPenalty as number | undefined,
      penalizeNewline: options.penalizeNewline as boolean | undefined,
      lowVram: options.lowVram as boolean | undefined,
      mainGpu: options.mainGpu as number | undefined,
      numBatch: options.numBatch as number | undefined,
      numGpu: options.numGpu as number | undefined,
      numThread: options.numThread as number | undefined,
      useMLock: options.useMLock as boolean | undefined,
      useMMap: options.useMMap as boolean | undefined,
      vocabOnly: options.vocabOnly as boolean | undefined,
      format: options.format as string | undefined,
      think: options.think as boolean | undefined,
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
