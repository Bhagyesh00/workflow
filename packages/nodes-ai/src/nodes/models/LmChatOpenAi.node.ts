/** OpenAI chat model sub-node. All HTTP goes through `httpRequestWithAuthentication`. */
import type { DataObject, NodeType, SupplyDataContext } from '@workflow/workflow';
import { openAiAdapter, type ResponseFormatMode } from '../../providers/openai';
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
