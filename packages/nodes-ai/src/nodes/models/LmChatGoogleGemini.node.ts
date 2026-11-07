/** Google Gemini chat model sub-node. */
import type { DataObject, NodeType } from '@workflow/workflow';
import { GEMINI_DEFAULT_HOST, GEMINI_DEFAULT_MODEL, geminiAdapter } from '../../providers/gemini';
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
