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
