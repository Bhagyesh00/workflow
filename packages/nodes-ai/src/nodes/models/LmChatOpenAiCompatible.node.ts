/** OpenAI-compatible chat model sub-node (OpenRouter, Groq, Mistral, DeepSeek, xAI, Together, LM Studio, vLLM...). */
import type { DataObject, NodeType } from '@workflow/workflow';
import { openAiAdapter, type ResponseFormatMode } from '../../providers/openai';
import { HttpChatModel, readCommonOptions } from '../../shared/chat-model';
import {
  maxRetriesOption,
  maxTokensOption,
  modelDescription,
  temperatureOption,
  timeoutOption,
  topPOption,
} from './model-options';

export const LmChatOpenAiCompatibleNode: NodeType = {
  description: modelDescription(
    {
      name: 'ai.lmChatOpenAiCompatible',
      displayName: 'OpenAI-Compatible Chat Model',
      description:
        'Any chat completions API: OpenRouter, Groq, Mistral, DeepSeek, xAI, Together, LM Studio, vLLM',
      icon: 'lucide:plug-zap',
      alias: [
        'openrouter',
        'groq',
        'mistral',
        'deepseek',
        'xai',
        'grok',
        'together',
        'lm studio',
        'vllm',
        'llm',
      ],
      credential: 'openAiCompatibleApi',
      defaultsName: 'Chat Model',
    },
    [
      {
        displayName: 'Model',
        name: 'model',
        type: 'string',
        default: '',
        required: true,
        placeholder: 'e.g. mistral-large-latest, deepseek-chat, llama-3.3-70b-versatile',
        description: 'Model id as the provider names it',
      },
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
            displayName: 'Max Tokens Field',
            name: 'maxTokensField',
            type: 'options',
            default: 'max_tokens',
            options: [
              { name: 'max_tokens', value: 'max_tokens' },
              { name: 'max_completion_tokens', value: 'max_completion_tokens' },
            ],
          },
          {
            displayName: 'Structured Output',
            name: 'responseFormat',
            type: 'options',
            default: 'none',
            description: 'Enable only if the provider supports the response_format parameter',
            options: [
              { name: 'Prompt Instructions Only', value: 'none' },
              { name: 'JSON Object', value: 'jsonObject' },
              { name: 'JSON Schema', value: 'jsonSchema' },
            ],
          },
          {
            displayName: 'Extra Headers (JSON)',
            name: 'extraHeaders',
            type: 'json',
            default: '{}',
            description: 'e.g. {"HTTP-Referer": "https://example.com", "X-Title": "My App"} for OpenRouter',
          },
          timeoutOption,
          maxRetriesOption,
        ],
      },
    ],
  ),
  async supplyData(ctx, itemIndex) {
    const creds = await ctx.getCredentials('openAiCompatibleApi', itemIndex);
    const options = ctx.getNodeParameter('options', itemIndex, {}) as DataObject;
    const common = readCommonOptions(options);
    const model = String(ctx.getNodeParameter('model', itemIndex, '')).trim();
    if (!model) throw new Error('Enter the model id');
    if (!creds.baseUrl) throw new Error('The credential has no base URL');
    let extraHeaders: Record<string, string> = {};
    if (options.extraHeaders) {
      const parsed =
        typeof options.extraHeaders === 'string' ? JSON.parse(options.extraHeaders) : options.extraHeaders;
      extraHeaders = Object.fromEntries(
        Object.entries(parsed as DataObject)
          .filter(([k]) => !/^(authorization|host|content-length)$/i.test(k))
          .map(([k, v]) => [k.toLowerCase(), String(v)]),
      );
    }
    const adapter = openAiAdapter({
      baseUrl: String(creds.baseUrl),
      model,
      provider: 'openai-compatible',
      credentialType: 'openAiCompatibleApi',
      maxTokensField: (options.maxTokensField as 'max_tokens' | 'max_completion_tokens') ?? 'max_tokens',
      responseFormatMode: (options.responseFormat as ResponseFormatMode) ?? 'none',
      temperature: common.temperature,
      topP: common.topP,
      maxTokens: common.maxTokens,
      extraHeaders,
    });
    return { response: new HttpChatModel(ctx, adapter, { itemIndex, ...common }) };
  },
};
