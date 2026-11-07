/** Anthropic chat model sub-node. */
import type { DataObject, NodePropertyOption, NodeType } from '@workflow/workflow';
import {
  ANTHROPIC_API_VERSION,
  ANTHROPIC_DEFAULT_BASE_URL,
  ANTHROPIC_DEFAULT_MODEL,
  anthropicAdapter,
} from '../../providers/anthropic';
import { HttpChatModel, readCommonOptions, trimSlash } from '../../shared/chat-model';
import {
  maxRetriesOption,
  maxTokensOption,
  modelDescription,
  modelOptionsProperty,
  timeoutOption,
} from './model-options';

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
