/** Mistral Cloud Chat Model sub-node: Mistral and Magistral models on the Mistral chat completions API. */
import type { DataObject, LoadOptionsContext, NodeType } from '@workflow/workflow';
import { openAiAdapter } from '../../providers/openai';
import { HttpChatModel, readCommonOptions } from '../../shared/chat-model';
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

export const MISTRAL_BASE_URL = 'https://api.mistral.ai/v1';

interface MistralModel {
  id?: string;
  capabilities?: { completion_chat?: boolean };
}

/** The model list of the account: chat models, or only the embedding models. */
export async function listMistralModels(ctx: LoadOptionsContext, kind: 'chat' | 'embed') {
  const response = (await ctx.helpers.httpRequestWithAuthentication('mistralCloudApi', {
    url: `${MISTRAL_BASE_URL}/models`,
  })) as { data?: MistralModel[] };
  const models = (response.data ?? []).filter((m): m is MistralModel & { id: string } => Boolean(m?.id));
  const picked = models.filter((m) =>
    kind === 'embed'
      ? /embed/i.test(m.id)
      : !/embed|moderation|ocr/i.test(m.id) && m.capabilities?.completion_chat !== false,
  );
  return sortOptions(picked.map((m) => ({ name: m.id, value: m.id })));
}

export const LmChatMistralCloudNode: NodeType = {
  description: modelDescription(
    {
      name: 'ai.lmChatMistralCloud',
      displayName: 'Mistral Cloud Chat Model',
      description: 'Mistral and Magistral models through the Mistral API',
      icon: 'simple:mistralai',
      alias: ['mistral', 'magistral', 'llm'],
      credential: 'mistralCloudApi',
      defaultsName: 'Mistral Cloud Chat Model',
    },
    [
      modelOptionsProperty('model', 'mistral-small-latest'),
      {
        displayName: 'Options',
        name: 'options',
        type: 'collection',
        default: {},
        placeholder: 'Add option',
        options: [
          maxTokensOption(1024),
          temperatureOption,
          topPOption,
          {
            displayName: 'Enable Safe Mode',
            name: 'safeMode',
            type: 'boolean',
            default: false,
            description: 'Whether to inject a safety prompt before all conversations',
          },
          {
            displayName: 'Random Seed',
            name: 'randomSeed',
            type: 'number',
            default: 0,
            description: 'The seed for random sampling. With a seed, repeated calls give the same result.',
          },
          timeoutOption,
          maxRetriesOption,
        ],
      },
    ],
  ),
  async supplyData(ctx, itemIndex) {
    await ctx.getCredentials('mistralCloudApi', itemIndex);
    const options = ctx.getNodeParameter('options', itemIndex, {}) as DataObject;
    const common = readCommonOptions(options);
    const model = String(ctx.getNodeParameter('model', itemIndex, 'mistral-small-latest')).trim();
    if (!model) throw new Error('Choose a model');
    const extraBody: DataObject = {};
    if (options.safeMode === true) extraBody.safe_prompt = true;
    if (options.randomSeed !== undefined && options.randomSeed !== null && options.randomSeed !== '') {
      extraBody.random_seed = Number(options.randomSeed);
    }
    const adapter = openAiAdapter({
      baseUrl: MISTRAL_BASE_URL,
      model,
      provider: 'mistral',
      credentialType: 'mistralCloudApi',
      maxTokensField: 'max_tokens',
      responseFormatMode: 'jsonSchema',
      streamUsage: false,
      temperature: common.temperature,
      topP: common.topP,
      maxTokens: common.maxTokens,
      ...(Object.keys(extraBody).length ? { extraBody } : {}),
    });
    return { response: new HttpChatModel(ctx, adapter, { itemIndex, ...common }) };
  },
  methods: {
    loadOptions: {
      async listModels(ctx) {
        return listMistralModels(ctx, 'chat');
      },
    },
  },
};
