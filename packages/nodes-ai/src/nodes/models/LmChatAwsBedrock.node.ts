/** AWS Bedrock Chat Model sub-node: chat models on Bedrock through the Converse API. */
import type { DataObject, NodeType } from '@workflow/workflow';
import { type BedrockChatConfig, type BedrockGuardrailTrace, bedrockAdapter } from '../../providers/bedrock';
import {
  additionalFieldsOption,
  authenticationProperty,
  bedrockCredentialType,
  listBedrockModels,
  parseAdditionalFields,
  readBedrockCredential,
} from '../../shared/aws';
import { HttpChatModel, readCommonOptions } from '../../shared/chat-model';
import {
  maxRetriesOption,
  maxTokensOption,
  modelDescription,
  modelOptionsProperty,
  temperatureOption,
  timeoutOption,
  topPOption,
} from './model-options';

const DEFAULT_GUARDRAIL_VERSION = 'DRAFT';

function guardrailOf(options: DataObject): BedrockChatConfig['guardrail'] {
  const identifier = String(options.guardrailIdentifier ?? '').trim();
  if (!identifier) return undefined;
  return {
    identifier,
    version: String(options.guardrailVersion ?? '').trim() || DEFAULT_GUARDRAIL_VERSION,
    ...(options.guardrailTrace ? { trace: options.guardrailTrace as BedrockGuardrailTrace } : {}),
  };
}

const modelProperty = modelOptionsProperty('model', '');

export const LmChatAwsBedrockNode: NodeType = {
  description: {
    ...modelDescription(
      {
        name: 'ai.lmChatAwsBedrock',
        displayName: 'AWS Bedrock Chat Model',
        description: 'Chat models on AWS Bedrock through the Converse API',
        icon: 'simple:amazonaws',
        alias: ['bedrock', 'aws', 'titan', 'llm'],
        credential: 'aws',
        defaultsName: 'AWS Bedrock Chat Model',
      },
      [
        authenticationProperty,
        {
          ...modelProperty,
          typeOptions: { ...modelProperty.typeOptions, loadOptionsDependsOn: ['authentication'] },
          description: 'The foundation model or inference profile that generates the completion',
        },
        {
          displayName: 'Options',
          name: 'options',
          type: 'collection',
          default: {},
          placeholder: 'Add option',
          options: [
            maxTokensOption(2000),
            { ...temperatureOption, typeOptions: { minValue: 0, maxValue: 1, numberPrecision: 2 } },
            topPOption,
            maxRetriesOption,
            { ...timeoutOption, default: 60_000 },
            additionalFieldsOption,
            {
              displayName: 'Latency Optimization',
              name: 'latency',
              type: 'options',
              default: 'standard',
              options: [
                { name: 'Standard', value: 'standard' },
                { name: 'Optimized', value: 'optimized' },
              ],
              description: 'Optimized asks for lower latency on the models that offer it',
            },
            {
              displayName: 'Guardrail Identifier',
              name: 'guardrailIdentifier',
              type: 'string',
              default: '',
              description: 'The ID or ARN of a Bedrock guardrail to apply',
            },
            {
              displayName: 'Guardrail Version',
              name: 'guardrailVersion',
              type: 'string',
              default: DEFAULT_GUARDRAIL_VERSION,
              description: 'The version of the guardrail. Used with a guardrail identifier.',
            },
            {
              displayName: 'Guardrail Trace',
              name: 'guardrailTrace',
              type: 'options',
              default: 'disabled',
              options: [
                { name: 'Disabled', value: 'disabled' },
                { name: 'Enabled', value: 'enabled' },
                { name: 'Enabled (Full)', value: 'enabled_full' },
              ],
              description: 'Whether the guardrail reports its trace. Used with a guardrail identifier.',
            },
          ],
        },
      ],
    ),
    credentials: [
      { name: 'aws', required: true, displayOptions: { show: { authentication: ['iam'] } } },
      { name: 'awsAssumeRole', required: true, displayOptions: { show: { authentication: ['assumeRole'] } } },
    ],
  },
  async supplyData(ctx, itemIndex) {
    const credentialType = bedrockCredentialType(ctx.getNodeParameter('authentication', itemIndex, 'iam'));
    const { region, runtimeEndpoint } = readBedrockCredential(
      await ctx.getCredentials(credentialType, itemIndex),
    );
    const options = ctx.getNodeParameter('options', itemIndex, {}) as DataObject;
    const common = readCommonOptions(options);
    const model = String(ctx.getNodeParameter('model', itemIndex, '')).trim();
    if (!model) throw new Error('Choose a model');
    const adapter = bedrockAdapter({
      region,
      model,
      credentialType,
      endpoint: runtimeEndpoint,
      temperature: common.temperature,
      topP: common.topP,
      maxTokens: common.maxTokens,
      additionalModelRequestFields: parseAdditionalFields(options.additionalModelRequestFields),
      latency:
        options.latency === 'optimized' || options.latency === 'standard' ? options.latency : undefined,
      guardrail: guardrailOf(options),
    });
    return { response: new HttpChatModel(ctx, adapter, { itemIndex, ...common }) };
  },
  methods: {
    loadOptions: {
      async listModels(ctx) {
        return listBedrockModels(ctx, 'TEXT');
      },
    },
  },
};
