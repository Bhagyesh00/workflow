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
            displayName: 'Extended Thinking',
            name: 'thinking',
            type: 'boolean',
            default: false,
            description:
              'Whether the model reasons before it answers. A forced tool call is not sent while this is on.',
          },
          {
            displayName: 'Thinking Mode',
            name: 'thinkingMode',
            type: 'options',
            default: 'adaptive',
            displayOptions: { show: { thinking: [true] } },
            description: 'Adaptive lets the model size its thinking. Fixed Budget is for older models, such as Haiku 4.5.',
            options: [
              { name: 'Adaptive', value: 'adaptive' },
              { name: 'Fixed Budget', value: 'budget' },
            ],
          },
          {
            displayName: 'Thinking Budget (Tokens)',
            name: 'thinkingBudget',
            type: 'number',
            default: 1024,
            typeOptions: { minValue: 1024 },
            displayOptions: { show: { thinking: [true], thinkingMode: ['budget'] } },
            description: 'Most tokens the model may spend thinking',
          },
          {
            displayName: 'Top K',
            name: 'topK',
            type: 'number',
            default: -1,
            typeOptions: { minValue: -1 },
            description: 'Sample from the K most likely next tokens. -1 leaves it unset.',
          },
          {
            displayName: 'Top P',
            name: 'topP',
            type: 'number',
            default: 1,
            typeOptions: { minValue: 0, maxValue: 1, numberPrecision: 2 },
            description: 'Sample from the smallest set of tokens whose probabilities add up to this value',
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
          'Temperature is fixed by the current Anthropic API version; use Effort to trade depth for speed. Top K and Top P are sent only to older models that still take them (Opus 4.6, Sonnet 4 and Haiku 4 families and before) with Extended Thinking off; otherwise they are left out.',
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
      thinking: options.thinking === true,
      thinkingMode: options.thinkingMode === 'budget' ? 'budget' : 'adaptive',
      thinkingBudget: options.thinkingBudget as number | undefined,
      topK: options.topK as number | undefined,
      topP: options.topP as number | undefined,
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
