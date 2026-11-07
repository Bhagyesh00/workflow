/**
 * What the Gemini and Vertex chat nodes share: the generation options (thinking budget and a safety
 * threshold per harm category) and how they read into an adapter config.
 */
import {
  type DataObject,
  isResourceLocatorValue,
  type NodeProperty,
  type SupplyDataContext,
} from '@workflow/workflow';
import type { GeminiChatConfig, VertexTarget } from '../../providers/gemini';
import {
  maxRetriesOption,
  maxTokensOption,
  temperatureOption,
  timeoutOption,
  topPOption,
} from './model-options';

export const SAFETY_CATEGORIES = [
  { name: 'Harassment', value: 'HARM_CATEGORY_HARASSMENT' },
  { name: 'Hate Speech', value: 'HARM_CATEGORY_HATE_SPEECH' },
  { name: 'Sexually Explicit', value: 'HARM_CATEGORY_SEXUALLY_EXPLICIT' },
  { name: 'Dangerous Content', value: 'HARM_CATEGORY_DANGEROUS_CONTENT' },
] as const;

export const SAFETY_THRESHOLDS = [
  { name: 'Provider Default', value: 'HARM_BLOCK_THRESHOLD_UNSPECIFIED' },
  { name: 'Block Low and Above', value: 'BLOCK_LOW_AND_ABOVE' },
  { name: 'Block Medium and Above', value: 'BLOCK_MEDIUM_AND_ABOVE' },
  { name: 'Block Only High', value: 'BLOCK_ONLY_HIGH' },
  { name: 'Block None', value: 'BLOCK_NONE' },
] as const;

export const topKOption: NodeProperty = {
  displayName: 'Top K',
  name: 'topK',
  type: 'number',
  default: 40,
  typeOptions: { minValue: 1 },
  description: 'Consider only the K most likely tokens at each step',
};

export const thinkingBudgetOption: NodeProperty = {
  displayName: 'Thinking Budget',
  name: 'thinkingBudget',
  type: 'number',
  default: -1,
  typeOptions: { minValue: -1 },
  description:
    'Tokens the model may spend thinking before it answers. -1 lets the model decide, 0 turns thinking off (models that allow it).',
};

export const safetySettingsOption: NodeProperty = {
  displayName: 'Safety Settings',
  name: 'safetySettings',
  type: 'fixedCollection',
  default: {},
  typeOptions: { multipleValues: true },
  placeholder: 'Add safety rule',
  description: 'Block threshold per harm category; a category left out keeps the provider default',
  options: [
    {
      displayName: 'Rule',
      name: 'values',
      values: [
        {
          displayName: 'Category',
          name: 'category',
          type: 'options',
          default: 'HARM_CATEGORY_HARASSMENT',
          options: [...SAFETY_CATEGORIES],
        },
        {
          displayName: 'Threshold',
          name: 'threshold',
          type: 'options',
          default: 'HARM_BLOCK_THRESHOLD_UNSPECIFIED',
          options: [...SAFETY_THRESHOLDS],
        },
      ],
    },
  ],
};

/** options both nodes show, in the order of the Options collection */
export function geminiGenerationOptions(): NodeProperty[] {
  return [
    temperatureOption,
    maxTokensOption(8192),
    topPOption,
    topKOption,
    thinkingBudgetOption,
    safetySettingsOption,
    timeoutOption,
    maxRetriesOption,
  ];
}

const KNOWN_CATEGORIES = new Set<string>(SAFETY_CATEGORIES.map((c) => c.value));
const KNOWN_THRESHOLDS = new Set<string>(SAFETY_THRESHOLDS.map((t) => t.value));

/**
 * The settings of one safety rule list. A later rule for the same category wins; a name outside the lists
 * is refused here, so a typed or expression value cannot reach the provider as a made-up enum.
 */
export function readSafetySettings(
  options: DataObject,
  legacyThreshold?: string,
): GeminiChatConfig['safetySettings'] {
  const byCategory = new Map<string, string>();
  if (legacyThreshold && legacyThreshold !== 'default') {
    for (const c of SAFETY_CATEGORIES) byCategory.set(c.value, legacyThreshold);
  }
  const rules = (options.safetySettings as { values?: unknown } | undefined)?.values;
  for (const rule of Array.isArray(rules) ? (rules as DataObject[]) : []) {
    const category = String(rule.category ?? '');
    const threshold = String(rule.threshold ?? '');
    if (!KNOWN_CATEGORIES.has(category) || !KNOWN_THRESHOLDS.has(threshold)) {
      throw new Error('A safety rule names a category or threshold that Gemini does not know');
    }
    byCategory.set(category, threshold);
  }
  if (!byCategory.size) return undefined;
  return [...byCategory].map(([category, threshold]) => ({ category, threshold }));
}

/** the sampling, thinking and safety part of a Gemini or Vertex adapter config */
export function readGeminiGeneration(
  options: DataObject,
  common: { temperature?: number; topP?: number; maxTokens?: number },
  legacyThreshold?: string,
): Pick<
  GeminiChatConfig,
  'temperature' | 'topP' | 'topK' | 'maxTokens' | 'thinkingBudget' | 'safetySettings'
> {
  const number = (value: unknown): number | undefined => {
    if (value === undefined || value === null || value === '') return undefined;
    const n = Number(value);
    if (!Number.isFinite(n)) throw new Error('Thinking Budget and Top K must be numbers');
    return n;
  };
  const budget = number(options.thinkingBudget);
  return {
    temperature: common.temperature,
    topP: common.topP,
    topK: number(options.topK),
    maxTokens: common.maxTokens,
    thinkingBudget: budget === undefined ? undefined : Math.trunc(budget),
    safetySettings: readSafetySettings(options, legacyThreshold),
  };
}

// ---------------------------------------------------------------------------------------------
// Vertex AI: which credential, project and region a Vertex node uses
// ---------------------------------------------------------------------------------------------

export type VertexCredentialType = 'googleApi' | 'googleVertexAiApi';

export const vertexAuthenticationProperty: NodeProperty = {
  displayName: 'Authentication',
  name: 'authentication',
  type: 'options',
  default: 'googleApi',
  options: [
    { name: 'Google Service Account', value: 'googleApi' },
    { name: 'Google Vertex AI', value: 'googleVertexAiApi' },
  ],
};

export const vertexProjectProperty: NodeProperty = {
  displayName: 'Project ID',
  name: 'projectId',
  type: 'resourceLocator',
  default: { __rl: true, mode: 'list', value: '' },
  description:
    'The Google Cloud project that runs the model. Empty uses the project of a Vertex AI credential.',
  modes: [
    {
      displayName: 'From List',
      name: 'list',
      type: 'list',
      placeholder: 'Select a project...',
      typeOptions: { searchListMethod: 'searchProjects', searchable: true },
    },
    { displayName: 'By ID', name: 'id', type: 'string', placeholder: 'my-project-123456' },
  ],
};

export const vertexRegionOption: NodeProperty = {
  displayName: 'Region',
  name: 'region',
  type: 'options',
  default: '',
  description: 'Where the model runs. The multi-region endpoints keep data in the EU or the US.',
  options: [
    { name: 'Credential Default', value: '' },
    { name: 'Global', value: 'global' },
    { name: 'EU (multi-region)', value: 'eu' },
    { name: 'US (multi-region)', value: 'us' },
  ],
};

export function vertexCredentialType(authentication: unknown): VertexCredentialType {
  return authentication === 'googleVertexAiApi' ? 'googleVertexAiApi' : 'googleApi';
}

/** the id of a resource locator value, or a plain string */
export function locatorText(value: unknown): string {
  const raw = isResourceLocatorValue(value) ? value.value : value;
  return typeof raw === 'string' ? raw.trim() : '';
}

/**
 * The credential type, project and location a Vertex node calls. The project comes from the node, else
 * from a Vertex AI credential; the region from the node's option, else from the credential.
 */
export async function readVertexTarget(
  ctx: SupplyDataContext,
  itemIndex: number,
  options: DataObject,
): Promise<{ credentialType: VertexCredentialType; target: VertexTarget }> {
  const credentialType = vertexCredentialType(ctx.getNodeParameter('authentication', itemIndex, 'googleApi'));
  const creds = await ctx.getCredentials(credentialType, itemIndex);
  const project =
    locatorText(ctx.getNodeParameter('projectId', itemIndex, '')) ||
    (credentialType === 'googleVertexAiApi' && typeof creds.projectId === 'string'
      ? creds.projectId.trim()
      : '');
  if (!project) throw new Error('Select or enter a Google Cloud project ID.');
  const override = typeof options.region === 'string' ? options.region.trim() : '';
  const fromCredential = typeof creds.region === 'string' ? creds.region.trim() : '';
  return { credentialType, target: { project, location: override || fromCredential || 'global' } };
}
