/**
 * What the Bedrock nodes share: hosts, the region of an ARN, credential fields and the model lists.
 * Only this file builds a Bedrock URL. The `aws` and `awsAssumeRole` credentials decide whether a host may
 * receive a signature: they refuse anything but https on amazonaws.com or amazonaws.com.cn.
 */
import type { DataObject, LoadOptionsContext, NodeProperty, NodePropertyOption } from '@workflow/workflow';
import { sortOptions } from '../nodes/models/model-options';
import { trimSlash } from './chat-model';

const REGION_NAME = /^[a-z]{2}(-[a-z]+)+-\d$/;
const ARN_REGION = /^arn:aws[a-z-]*:bedrock:([^:]*):/;
const EMBEDDING_MODEL = /embed/i;
const BAD_ADDITIONAL_FIELDS = 'Additional Model Request Fields must be valid JSON';

export type BedrockCredentialType = 'aws' | 'awsAssumeRole';
export type BedrockModality = 'TEXT' | 'EMBEDDING';

export interface BedrockCredentialFields {
  region: string;
  runtimeEndpoint?: string;
  controlEndpoint?: string;
}

export const authenticationProperty: NodeProperty = {
  displayName: 'Authentication',
  name: 'authentication',
  type: 'options',
  default: 'iam',
  options: [
    { name: 'IAM', value: 'iam' },
    { name: 'Assume Role', value: 'assumeRole' },
  ],
};

export const additionalFieldsOption: NodeProperty = {
  displayName: 'Additional Model Request Fields',
  name: 'additionalModelRequestFields',
  type: 'json',
  default: '{}',
  description: "Fields for the model's own API, sent as they are (a JSON object)",
};

export function bedrockCredentialType(authentication: unknown): BedrockCredentialType {
  return authentication === 'assumeRole' ? 'awsAssumeRole' : 'aws';
}

export function awsDomain(region: string): string {
  return region.startsWith('cn-') ? 'amazonaws.com.cn' : 'amazonaws.com';
}

function serviceUrl(service: string, region: string): string {
  if (!REGION_NAME.test(region)) throw new Error('The AWS region is not valid');
  return `https://${service}.${region}.${awsDomain(region)}`;
}

/** the region a model ARN names; a model id, or an ARN with anything else there, names none */
export function arnRegion(model: string): string | undefined {
  const region = ARN_REGION.exec(model)?.[1];
  return region && REGION_NAME.test(region) ? region : undefined;
}

/** a custom endpoint wins; otherwise the host of the model's region, then of the credential's */
export function bedrockRuntimeBase(config: { region: string; model: string; endpoint?: string }): string {
  return config.endpoint ?? serviceUrl('bedrock-runtime', arnRegion(config.model) ?? config.region);
}

function endpointBase(value: unknown, label: string): string | undefined {
  const text = typeof value === 'string' ? value.trim() : '';
  if (!text) return undefined;
  let url: URL;
  try {
    url = new URL(text);
  } catch {
    throw new Error(`The ${label} endpoint is not a valid URL`);
  }
  if (url.origin === 'null') throw new Error(`The ${label} endpoint is not a valid URL`);
  // user info, query and fragment have no place in a signed URL
  return trimSlash(`${url.origin}${url.pathname}`);
}

export function readBedrockCredential(credentials: DataObject): BedrockCredentialFields {
  const custom = credentials.customEndpoints === true;
  return {
    region: String(credentials.region ?? ''),
    runtimeEndpoint: custom ? endpointBase(credentials.bedrockRuntimeEndpoint, 'Bedrock Runtime') : undefined,
    controlEndpoint: custom ? endpointBase(credentials.bedrockEndpoint, 'Bedrock') : undefined,
  };
}

/** an empty object is the same as nothing set */
export function parseAdditionalFields(value: unknown): DataObject | undefined {
  if (value === undefined || value === null || value === '') return undefined;
  let parsed = value;
  if (typeof value === 'string') {
    try {
      parsed = JSON.parse(value);
    } catch {
      throw new Error(BAD_ADDITIONAL_FIELDS);
    }
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error(BAD_ADDITIONAL_FIELDS);
  return Object.keys(parsed).length ? (parsed as DataObject) : undefined;
}

interface FoundationModel {
  modelArn?: string;
  modelId?: string;
  modelName?: string;
}

interface InferenceProfile {
  inferenceProfileArn?: string;
  inferenceProfileId?: string;
  inferenceProfileName?: string;
  status?: string;
  models?: Array<{ modelArn?: string }>;
}

function isEmbeddingProfile(profile: InferenceProfile): boolean {
  const names = [profile.inferenceProfileId, ...(profile.models ?? []).map((m) => m.modelArn)];
  return names.some((name) => name !== undefined && EMBEDDING_MODEL.test(name));
}

/**
 * The foundation models of one output type plus the inference profiles, system and application ones,
 * merged by ARN. Any of the calls may fail, since an IAM policy can allow one and not another: the list
 * holds what answered, and only when nothing answered does the first error reach the person.
 */
export async function listBedrockModels(
  ctx: LoadOptionsContext,
  modality: BedrockModality,
): Promise<NodePropertyOption[]> {
  const credentialType = bedrockCredentialType(ctx.getCurrentNodeParameter('authentication'));
  const { region, controlEndpoint } = readBedrockCredential(await ctx.getCredentials(credentialType));
  const base = controlEndpoint ?? serviceUrl('bedrock', region);
  const get = (path: string, qs: DataObject) =>
    ctx.helpers.httpRequestWithAuthentication(credentialType, { url: `${base}${path}`, method: 'GET', qs });

  const [models, system, application] = await Promise.allSettled([
    get('/foundation-models', { byOutputModality: modality, byInferenceType: 'ON_DEMAND' }),
    get('/inference-profiles', { maxResults: 1000 }),
    get('/inference-profiles', { maxResults: 1000, type: 'APPLICATION' }),
  ]);
  if (models.status === 'rejected' && system.status === 'rejected' && application.status === 'rejected') {
    throw models.reason;
  }

  const byArn = new Map<string, NodePropertyOption>();
  if (models.status === 'fulfilled') {
    for (const model of (models.value as { modelSummaries?: FoundationModel[] }).modelSummaries ?? []) {
      if (!model?.modelId) continue;
      byArn.set(model.modelArn ?? model.modelId, {
        name: model.modelName || model.modelId,
        value: model.modelId,
      });
    }
  }
  for (const list of [system, application]) {
    if (list.status !== 'fulfilled') continue;
    const profiles = (list.value as { inferenceProfileSummaries?: InferenceProfile[] })
      .inferenceProfileSummaries;
    for (const profile of profiles ?? []) {
      const arn = profile?.inferenceProfileArn;
      if (!arn || (profile.status && profile.status !== 'ACTIVE')) continue;
      if (isEmbeddingProfile(profile) !== (modality === 'EMBEDDING')) continue;
      byArn.set(arn, { name: `${profile.inferenceProfileName || arn} (inference profile)`, value: arn });
    }
  }
  return sortOptions([...byArn.values()]);
}
