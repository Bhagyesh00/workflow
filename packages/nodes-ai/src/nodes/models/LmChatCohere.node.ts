/** Cohere Chat Model sub-node: Command models on the Cohere v2 chat API. */
import type { DataObject, LoadOptionsContext, NodeType } from '@workflow/workflow';
import { COHERE_DEFAULT_BASE_URL, COHERE_DEFAULT_MODEL, cohereAdapter } from '../../providers/cohere';
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

/** The models of the account for one endpoint (`chat` or `embed`), from the credential's URL. */
export async function listCohereModels(ctx: LoadOptionsContext, endpoint: 'chat' | 'embed') {
  const creds = await ctx.getCredentials('cohereApi');
  const base = trimSlash(String(creds.url || COHERE_DEFAULT_BASE_URL));
  const response = (await ctx.helpers.httpRequestWithAuthentication('cohereApi', {
    url: `${base}/v1/models`,
    qs: { endpoint, page_size: 1000 },
  })) as { models?: Array<{ name?: string }> };
  return sortOptions(
    (response.models ?? [])
      .filter((m) => m?.name)
      .map((m) => ({ name: String(m.name), value: String(m.name) })),
  );
}

export const LmChatCohereNode: NodeType = {
  description: modelDescription(
    {
      name: 'ai.lmChatCohere',
      displayName: 'Cohere Chat Model',
      description: 'Command models through the Cohere v2 chat API',
      icon: 'simple:cohere',
      alias: ['cohere', 'command', 'llm'],
      credential: 'cohereApi',
      defaultsName: 'Cohere Chat Model',
    },
    [
      modelOptionsProperty('model', COHERE_DEFAULT_MODEL),
      {
        displayName: 'Options',
        name: 'options',
        type: 'collection',
        default: {},
        placeholder: 'Add option',
        options: [maxTokensOption(1024), temperatureOption, topPOption, timeoutOption, maxRetriesOption],
      },
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
      maxTokens: common.maxTokens,
    });
    return { response: new HttpChatModel(ctx, adapter, { itemIndex, ...common }) };
  },
  methods: {
    loadOptions: {
      async listModels(ctx) {
        return listCohereModels(ctx, 'chat');
      },
    },
  },
};
