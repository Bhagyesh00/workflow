/**
 * Guardrails: checks text for keywords, personal data, secrets, URLs and (with a chat model) jailbreaks,
 * unsafe content, off-topic text and custom rules; or masks what the plain-code checks find.
 */
import {
  type DataObject,
  type ExecuteContext,
  type Item,
  NodeOperationError,
  type NodeProperty,
  type NodeType,
} from '@workflow/workflow';
import { COMPLETION_MODEL_NODES, getChatModel } from '../../shared/ai-inputs';
import { collectionList, errorMessage, redactSecrets } from '../../shared/utils';
import { parseKeywords } from './keywords';
import {
  JAILBREAK_PROMPT,
  LLM_SYSTEM_RULES,
  type LlmCheckDef,
  NSFW_PROMPT,
  TOPICAL_PROMPT,
  toThreshold,
} from './llm-checks';
import { PII_ENTITIES, PII_NAME_MAP } from './pii';
import { type CheckResult, type GuardrailConfig, PARSE_CODE, runChecks } from './run-checks';
import type { SecretLevel } from './secrets';

const CHAT_MODEL_INPUT = JSON.stringify({
  type: 'ai_languageModel',
  displayName: 'Chat Model',
  required: true,
  maxConnections: 1,
  filter: { excludedNodes: COMPLETION_MODEL_NODES },
});

/** the model input exists only when a check on the node needs a model */
const inputs = `={{ ['main', ...($parameter.operation !== 'sanitize' && ['jailbreak', 'nsfw', 'topicalAlignment', 'custom'].some((check) => $parameter.guardrails?.[check] !== undefined) ? [${CHAT_MODEL_INPUT}] : [])] }}`;

const outputs = `={{ $parameter.operation === 'sanitize' ? ['main'] : [{ type: 'main', displayName: 'Pass' }, { type: 'main', displayName: 'Fail' }] }}`;

const CLASSIFY_ONLY = { show: { '/operation': ['classify'] } };

function thresholdProperty(): NodeProperty {
  return {
    displayName: 'Threshold',
    name: 'threshold',
    type: 'number',
    default: 0.7,
    typeOptions: { minValue: 0, maxValue: 1, numberPrecision: 2 },
    description: 'The model must be at least this sure (0 to 1) before the text counts as a violation',
  };
}

function modelCheck(
  name: string,
  displayName: string,
  description: string,
  prompt: string,
  options: { promptAlwaysShown?: boolean; classifyOnly?: boolean } = {},
): NodeProperty {
  const values: NodeProperty[] = [thresholdProperty()];
  if (options.promptAlwaysShown) {
    values.push({
      displayName: 'Prompt',
      name: 'prompt',
      type: 'string',
      default: prompt,
      typeOptions: { rows: 4 },
      description: `Replace ${'[INSERT BUSINESS SCOPE HERE]'} with what the text may talk about`,
    });
  } else {
    values.push(
      {
        displayName: 'Customize Prompt',
        name: 'customizePrompt',
        type: 'boolean',
        default: false,
        displayOptions: CLASSIFY_ONLY,
      },
      {
        displayName: 'Prompt',
        name: 'prompt',
        type: 'string',
        default: prompt,
        typeOptions: { rows: 4 },
        displayOptions: { show: { customizePrompt: [true] } },
      },
    );
  }
  return {
    displayName,
    name,
    type: 'fixedCollection',
    default: {},
    description,
    displayOptions: options.classifyOnly ? CLASSIFY_ONLY : undefined,
    options: [{ displayName, name: 'value', values }],
  };
}

const URL_SCHEMES = ['https', 'http', 'ftp', 'data', 'javascript', 'vbscript', 'mailto'];

const guardrailOptions: NodeProperty[] = [
  {
    displayName: 'Keywords',
    name: 'keywords',
    type: 'fixedCollection',
    default: {},
    description: 'Fails the text when it holds one of these words',
    displayOptions: CLASSIFY_ONLY,
    options: [
      {
        displayName: 'Keywords',
        name: 'value',
        values: [
          {
            displayName: 'Keywords',
            name: 'keywords',
            type: 'string',
            default: '',
            placeholder: 'e.g. refund, lawsuit',
            description: 'Comma-separated list. Matching ignores case and matches whole words only.',
          },
        ],
      },
    ],
  },
  modelCheck('jailbreak', 'Jailbreak', 'Detects attempts to make an AI ignore its rules', JAILBREAK_PROMPT),
  modelCheck('nsfw', 'NSFW', 'Detects content that is not safe for work', NSFW_PROMPT),
  modelCheck(
    'topicalAlignment',
    'Topical Alignment',
    'Detects text outside your business scope',
    TOPICAL_PROMPT,
    { promptAlwaysShown: true },
  ),
  {
    displayName: 'Personal Data (PII)',
    name: 'pii',
    type: 'fixedCollection',
    default: {},
    description: 'Finds personal data such as emails, phone numbers and ID numbers',
    options: [
      {
        displayName: 'Personal Data (PII)',
        name: 'value',
        values: [
          {
            displayName: 'Type',
            name: 'type',
            type: 'options',
            default: 'all',
            options: [
              { name: 'All', value: 'all' },
              { name: 'Selected', value: 'selected' },
            ],
          },
          {
            displayName: 'Entities',
            name: 'entities',
            type: 'multiOptions',
            default: [],
            displayOptions: { show: { type: ['selected'] } },
            options: PII_ENTITIES.map((key) => ({ name: PII_NAME_MAP[key], value: key })),
          },
        ],
      },
    ],
  },
  {
    displayName: 'Secret Keys',
    name: 'secretKeys',
    type: 'fixedCollection',
    default: {},
    description: 'Finds API keys, tokens and other secrets',
    options: [
      {
        displayName: 'Secret Keys',
        name: 'value',
        values: [
          {
            displayName: 'Permissiveness',
            name: 'permissiveness',
            type: 'options',
            default: 'balanced',
            options: [
              { name: 'Strict', value: 'strict' },
              { name: 'Balanced', value: 'balanced' },
              { name: 'Permissive', value: 'permissive' },
            ],
          },
        ],
      },
    ],
  },
  {
    displayName: 'URLs',
    name: 'urls',
    type: 'fixedCollection',
    default: {},
    description: 'Blocks URLs that are not allowed',
    options: [
      {
        displayName: 'URLs',
        name: 'value',
        values: [
          {
            displayName: 'Allowed URLs',
            name: 'allowedUrls',
            type: 'string',
            default: '',
            placeholder: 'e.g. example.com, https://docs.example.com/guide, 10.0.0.0/8',
            description:
              'Comma-separated domains, URLs with a path, IP addresses or IPv4 ranges. Empty blocks every URL.',
          },
          {
            displayName: 'Allowed Schemes',
            name: 'allowedSchemes',
            type: 'multiOptions',
            default: ['https'],
            options: URL_SCHEMES.map((scheme) => ({ name: scheme, value: scheme })),
          },
          {
            displayName: 'Block User Info',
            name: 'blockUserinfo',
            type: 'boolean',
            default: true,
            description: 'Whether to block URLs that carry a user name or password (user:pass@host)',
          },
          {
            displayName: 'Allow Subdomains',
            name: 'allowSubdomains',
            type: 'boolean',
            default: true,
          },
        ],
      },
    ],
  },
  {
    displayName: 'Custom Prompt Check',
    name: 'custom',
    type: 'fixedCollection',
    default: {},
    typeOptions: { multipleValues: true },
    description: 'Asks the model your own question about the text',
    displayOptions: CLASSIFY_ONLY,
    options: [
      {
        displayName: 'Check',
        name: 'guardrail',
        values: [
          { displayName: 'Name', name: 'name', type: 'string', default: '' },
          thresholdProperty(),
          {
            displayName: 'Prompt',
            name: 'prompt',
            type: 'string',
            default: '',
            typeOptions: { rows: 4 },
            description: 'Describe what makes the text a violation',
          },
        ],
      },
    ],
  },
  {
    displayName: 'Custom Regex',
    name: 'customRegex',
    type: 'fixedCollection',
    default: {},
    typeOptions: { multipleValues: true },
    description: 'Finds text that matches your own pattern',
    options: [
      {
        displayName: 'Pattern',
        name: 'regex',
        values: [
          { displayName: 'Name', name: 'name', type: 'string', default: '' },
          {
            displayName: 'Regex',
            name: 'regex',
            type: 'string',
            default: '',
            placeholder: '/order-\\d+/i',
            description: 'Written as /pattern/flags or as a bare pattern',
          },
        ],
      },
    ],
  },
];

const text = (value: unknown): string => (typeof value === 'string' ? value : '');
const entryValue = (entry: unknown): DataObject => {
  const value = (entry as DataObject | undefined)?.value;
  return value && typeof value === 'object' ? (value as DataObject) : {};
};

function readConfig(
  ctx: ExecuteContext,
  itemIndex: number,
  operation: 'classify' | 'sanitize',
): GuardrailConfig {
  const raw = (ctx.getNodeParameter('guardrails', itemIndex, {}) ?? {}) as DataObject;
  const classify = operation === 'classify';
  const config: GuardrailConfig = {};

  if (classify && raw.keywords !== undefined) {
    config.keywords = parseKeywords(text(entryValue(raw.keywords).keywords));
  }
  if (raw.pii !== undefined) {
    const value = entryValue(raw.pii);
    const chosen = Array.isArray(value.entities) ? value.entities.map(String) : [];
    config.pii = { entities: value.type === 'selected' ? chosen : PII_ENTITIES };
  }
  if (raw.secretKeys !== undefined) {
    const level = entryValue(raw.secretKeys).permissiveness;
    config.secretKeys = {
      level: (level === 'strict' || level === 'permissive' ? level : 'balanced') as SecretLevel,
    };
  }
  if (raw.urls !== undefined) {
    const value = entryValue(raw.urls);
    config.urls = {
      allowedUrls: text(value.allowedUrls)
        .split(',')
        .map((entry) => entry.trim())
        .filter(Boolean),
      allowedSchemes: Array.isArray(value.allowedSchemes) ? value.allowedSchemes.map(String) : ['https'],
      blockUserinfo: value.blockUserinfo !== false,
      allowSubdomains: value.allowSubdomains !== false,
    };
  }
  config.customRegex = collectionList<DataObject>(raw.customRegex, 'regex')
    .filter((entry) => text(entry.regex).trim())
    .map((entry) => ({ name: text(entry.name).trim(), regex: text(entry.regex) }));

  if (classify) {
    const llm: LlmCheckDef[] = [];
    const builtIn: Array<[key: string, prompt: string, always: boolean]> = [
      ['jailbreak', JAILBREAK_PROMPT, false],
      ['nsfw', NSFW_PROMPT, false],
      ['topicalAlignment', TOPICAL_PROMPT, true],
    ];
    for (const [key, defaultPrompt, always] of builtIn) {
      if (raw[key] === undefined) continue;
      const value = entryValue(raw[key]);
      const custom = (always || value.customizePrompt === true) && text(value.prompt).trim();
      llm.push({
        name: key,
        prompt: custom ? text(value.prompt) : defaultPrompt,
        threshold: toThreshold(value.threshold),
      });
    }
    for (const entry of collectionList<DataObject>(raw.custom, 'guardrail')) {
      if (!text(entry.prompt).trim()) continue;
      llm.push({
        name: text(entry.name).trim() || 'custom',
        prompt: text(entry.prompt),
        threshold: toThreshold(entry.threshold),
      });
    }
    config.llm = llm;
  }
  return config;
}

function resultItem(input: string, checks: CheckResult[], index: number): Item {
  return {
    json: { guardrailsInput: input, checks },
    pairedItem: { item: index },
  };
}

export const GuardrailsNode: NodeType = {
  description: {
    name: 'ai.guardrails',
    displayName: 'Guardrails',
    description: 'Checks text for keywords, PII, secrets, URLs and policy violations, or masks what it finds',
    icon: 'lucide:shield-check',
    group: ['transform'],
    version: 1,
    defaults: { name: 'Guardrails' },
    inputs,
    outputs,
    categories: ['AI', 'Guardrails'],
    alias: ['pii', 'moderation', 'jailbreak', 'nsfw', 'mask', 'sanitize', 'safety'],
    properties: [
      {
        displayName: 'Operation',
        name: 'operation',
        type: 'options',
        noDataExpression: true,
        default: 'classify',
        options: [
          {
            name: 'Check Text for Violations',
            value: 'classify',
            description: 'Sends the item to Pass or Fail',
            action: 'Check text for violations',
          },
          {
            name: 'Sanitize Text',
            value: 'sanitize',
            description: 'Replaces what the checks find with a token',
            action: 'Sanitize text',
          },
        ],
      },
      {
        displayName: 'Text To Check',
        name: 'text',
        type: 'string',
        default: '',
        required: true,
        typeOptions: { rows: 2 },
        description: 'The text the checks look at',
      },
      {
        displayName: 'Guardrails',
        name: 'guardrails',
        type: 'collection',
        default: {},
        placeholder: 'Add guardrail',
        options: guardrailOptions,
      },
      {
        displayName: 'Customize System Message',
        name: 'customizeSystemMessage',
        type: 'boolean',
        default: false,
        displayOptions: { show: { operation: ['classify'] } },
        description: 'Whether to change the rules sent to the model after each check prompt',
      },
      {
        displayName: 'System Message',
        name: 'systemMessage',
        type: 'string',
        default: LLM_SYSTEM_RULES,
        typeOptions: { rows: 4 },
        displayOptions: { show: { operation: ['classify'], customizeSystemMessage: [true] } },
      },
    ],
  },

  async execute(ctx) {
    const operation =
      ctx.getNodeParameter('operation', 0, 'classify') === 'sanitize' ? 'sanitize' : 'classify';
    const items = ctx.getInputData();
    const pass: Item[] = [];
    const fail: Item[] = [];

    for (let i = 0; i < items.length; i++) {
      try {
        const value = ctx.getNodeParameter('text', i, '');
        const input = typeof value === 'string' ? value : value == null ? '' : JSON.stringify(value);
        const systemRules =
          ctx.getNodeParameter('customizeSystemMessage', i, false) === true
            ? text(ctx.getNodeParameter('systemMessage', i, LLM_SYSTEM_RULES))
            : LLM_SYSTEM_RULES;
        const run = await runChecks({
          text: input,
          operation,
          config: readConfig(ctx, i, operation),
          systemRules,
          context: { node: ctx.getNode(), itemIndex: i, signal: ctx.signal },
          getModel: async () => {
            try {
              return await getChatModel(ctx, i, { chatOnly: true });
            } catch (error) {
              if (error instanceof NodeOperationError && /^(Connect a |A sub-node must be connected)/.test(error.message)) {
                throw new NodeOperationError(ctx.getNode(), 'Chat Model is required', { itemIndex: i });
              }
              throw error;
            }
          },
        });

        const broken = run.checks.find((check) => check.executionFailed);
        if (operation === 'sanitize') {
          if (broken) {
            throw new NodeOperationError(ctx.getNode(), 'Failed to sanitize text', {
              itemIndex: i,
              description: `Failed checks:\n${run.checks
                .filter((check) => check.executionFailed)
                .map((check) => `${check.name} - ${check.exception?.description ?? 'failed'}`)
                .join('\n')}`,
            });
          }
          pass.push(resultItem(run.maskedText, run.checks, i));
          continue;
        }

        if (broken && !ctx.continueOnFail()) {
          const message =
            broken.exception?.name === PARSE_CODE
              ? 'Failed to parse output'
              : `Guardrail validation failed: ${broken.exception?.description ?? 'a check could not run'}`;
          throw new NodeOperationError(ctx.getNode(), message, {
            itemIndex: i,
            description: `Failed check: ${broken.name}`,
          });
        }
        if (run.failing.length) fail.push(resultItem(input, run.failing, i));
        else pass.push(resultItem(input, run.checks, i));
      } catch (error) {
        if (ctx.continueOnFail()) {
          const message = redactSecrets(errorMessage(error));
          (operation === 'sanitize' ? pass : fail).push({
            json: { error: message },
            error: { message },
            pairedItem: { item: i },
          });
          continue;
        }
        if (error instanceof NodeOperationError) throw error;
        throw new NodeOperationError(ctx.getNode(), redactSecrets(errorMessage(error)), {
          itemIndex: i,
          cause: error,
        });
      }
    }
    return operation === 'sanitize' ? [pass] : [pass, fail];
  },
};
