/** Google Gemini chat model sub-node. */
import type { DataObject, NodeType } from '@workflow/workflow';
import { GEMINI_DEFAULT_HOST, GEMINI_DEFAULT_MODEL, geminiAdapter } from '../../providers/gemini';
import { HttpChatModel, readCommonOptions, trimSlash } from '../../shared/chat-model';
import { geminiGenerationOptions, readGeminiGeneration } from './gemini-options';
import { modelDescription, modelOptionsProperty, sortOptions } from './model-options';

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
          ...geminiGenerationOptions().slice(0, -2),
          {
            displayName: 'Safety Threshold (all categories)',
            name: 'safetyThreshold',
            type: 'options',
            default: 'default',
            description: 'One threshold for every category; a rule under Safety Settings overrides it',
            options: [
              { name: 'Provider Default', value: 'default' },
              { name: 'Block Low and Above', value: 'BLOCK_LOW_AND_ABOVE' },
              { name: 'Block Medium and Above', value: 'BLOCK_MEDIUM_AND_ABOVE' },
              { name: 'Block Only High', value: 'BLOCK_ONLY_HIGH' },
              { name: 'Block None', value: 'BLOCK_NONE' },
            ],
          },
          ...geminiGenerationOptions().slice(-2),
        ],
      },
    ],
  ),
  async supplyData(ctx, itemIndex) {
    const creds = await ctx.getCredentials('googleGeminiApi', itemIndex);
    const options = ctx.getNodeParameter('options', itemIndex, {}) as DataObject;
    const common = readCommonOptions(options);
    const adapter = geminiAdapter({
      host: String(creds.host || GEMINI_DEFAULT_HOST),
      model: String(ctx.getNodeParameter('modelName', itemIndex, GEMINI_DEFAULT_MODEL)),
      ...readGeminiGeneration(options, common, options.safetyThreshold as string | undefined),
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
