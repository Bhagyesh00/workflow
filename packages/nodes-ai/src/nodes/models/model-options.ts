/**
 * What the chat model sub-nodes share: common options, the description shape and the model lists.
 */
import type {
  LoadOptionsContext,
  NodeProperty,
  NodePropertyOption,
  NodeTypeDescription,
} from '@workflow/workflow';
import { trimSlash } from '../../shared/chat-model';

export const temperatureOption: NodeProperty = {
  displayName: 'Sampling Temperature',
  name: 'temperature',
  type: 'number',
  default: 0.7,
  typeOptions: { minValue: 0, maxValue: 2, numberPrecision: 2 },
  description: 'Higher values make the output more random. Some reasoning models accept only the default.',
};
export const topPOption: NodeProperty = {
  displayName: 'Top P',
  name: 'topP',
  type: 'number',
  default: 1,
  typeOptions: { minValue: 0, maxValue: 1, numberPrecision: 2 },
  description: 'Nucleus sampling: consider only tokens within this probability mass',
};
export const maxTokensOption = (defaultValue: number): NodeProperty => ({
  displayName: 'Maximum Number of Tokens',
  name: 'maxTokens',
  type: 'number',
  default: defaultValue,
  typeOptions: { minValue: 1 },
  description: 'Upper bound on the tokens generated per call',
});
export const timeoutOption: NodeProperty = {
  displayName: 'Timeout (ms)',
  name: 'timeout',
  type: 'number',
  default: 120_000,
  typeOptions: { minValue: 1000 },
};
export const maxRetriesOption: NodeProperty = {
  displayName: 'Max Retries',
  name: 'maxRetries',
  type: 'number',
  default: 2,
  typeOptions: { minValue: 0, maxValue: 10 },
  description: 'Retries on rate limits (429) and server errors (5xx), with exponential backoff',
};

export function modelDescription(
  base: Pick<NodeTypeDescription, 'name' | 'displayName' | 'description' | 'icon' | 'alias'> & {
    credential: string;
    defaultsName: string;
  },
  properties: NodeProperty[],
): NodeTypeDescription {
  return {
    name: base.name,
    displayName: base.displayName,
    description: base.description,
    icon: base.icon,
    group: ['transform'],
    version: 1,
    defaults: { name: base.defaultsName },
    inputs: [],
    outputs: ['ai_languageModel'],
    outputNames: ['Model'],
    credentials: [{ name: base.credential, required: true }],
    categories: ['AI', 'Language Models'],
    alias: base.alias,
    properties,
  };
}

export function modelOptionsProperty(
  name: string,
  defaultModel: string,
  method = 'listModels',
): NodeProperty {
  return {
    displayName: 'Model',
    name,
    type: 'options',
    default: defaultModel,
    typeOptions: { loadOptionsMethod: method },
    description: 'The model that generates the completion',
  };
}

export const sortOptions = (options: NodePropertyOption[]) =>
  options.sort((a, b) => String(a.name).localeCompare(String(b.name)));

export const NON_CHAT_MODEL =
  /embed|whisper|tts|dall-e|moderation|audio|realtime|transcribe|image|search|davinci|babbage/i;

export async function listOpenAiModels(ctx: LoadOptionsContext, credentialType: string, baseUrl: string) {
  const response = (await ctx.helpers.httpRequestWithAuthentication(credentialType, {
    url: `${trimSlash(baseUrl)}/models`,
  })) as { data?: Array<{ id: string }> };
  return sortOptions(
    (response.data ?? [])
      .filter((m) => m?.id && !NON_CHAT_MODEL.test(m.id))
      .map((m) => ({ name: m.id, value: m.id })),
  );
}
