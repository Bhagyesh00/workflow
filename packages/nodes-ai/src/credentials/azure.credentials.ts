/**
 * Microsoft Foundry and Azure OpenAI credentials. No `test`, as n8n: the nodes are the test.
 *
 * Two endpoint types share both credentials. Classic is `https://<resource>.openai.azure.com` with a
 * deployment in the path and an `api-version` query. Foundry is `https://<resource>.services.ai.azure.com/openai/v1`
 * with the deployment as the model, plus a project for the deployment list and `<origin>/anthropic` for Claude.
 *
 * `authenticate` signs only requests to the credential's own host: the key or the token must not follow a
 * request an author points at another server. The Entra token comes from `login.microsoftonline.com`, so
 * a credential with allowed domains must list that host too.
 */
import type { CredentialType, DataObject, HttpRequestOptions, NodeProperty } from '@workflow/workflow';

export const AZURE_DEFAULT_API_VERSION = '2025-03-01-preview';
export const AZURE_TOKEN_HOST = 'https://login.microsoftonline.com';
/** audience of a token for the chat and embeddings calls */
export const AZURE_COGNITIVE_RESOURCE = 'https://cognitiveservices.azure.com/';
/** audience of a token for the Foundry project (deployment list) */
export const AZURE_FOUNDRY_RESOURCE = 'https://ai.azure.com/';

export interface AzureTarget {
  kind: 'classic' | 'foundry';
  /** `https://host`, no path */
  origin: string;
  /** classic: the resource URL; Foundry: the URL ending `/openai/v1` */
  baseUrl: string;
  /** classic only */
  apiVersion: string;
  /** Foundry only, empty when not set */
  project: string;
}

const text = (value: unknown): string => (typeof value === 'string' ? value.trim() : '');

function parseHttps(raw: string, what: string): URL {
  let url: URL | undefined;
  try {
    url = new URL(raw);
  } catch {
    url = undefined;
  }
  if (!url || url.protocol !== 'https:' || url.username || url.password || url.search || url.hash) {
    throw new Error(`${what} must be an https URL with no credentials, query or fragment`);
  }
  return url;
}

/** where the credential's calls go; throws a plain error that holds neither key nor secret */
export function azureTarget(credentials: DataObject): AzureTarget {
  const apiVersion = text(credentials.apiVersion) || AZURE_DEFAULT_API_VERSION;
  if (text(credentials.endpointType) === 'foundry') {
    const url = parseHttps(text(credentials.foundryEndpoint), 'The Foundry endpoint');
    const path = url.pathname.replace(/\/+$/, '');
    if (!/\/openai\/v1$/.test(path)) throw new Error('The Foundry endpoint must end with /openai/v1');
    return {
      kind: 'foundry',
      origin: url.origin,
      baseUrl: `${url.origin}${path}`,
      apiVersion,
      project: text(credentials.projectName),
    };
  }
  const custom = text(credentials.endpoint);
  if (custom) {
    const url = parseHttps(custom, 'The endpoint');
    return {
      kind: 'classic',
      origin: url.origin,
      baseUrl: `${url.origin}${url.pathname.replace(/\/+$/, '')}`,
      apiVersion,
      project: '',
    };
  }
  const resource = text(credentials.resourceName);
  if (!/^[A-Za-z0-9][A-Za-z0-9-]*$/.test(resource)) {
    throw new Error('The resource name must use letters, digits and hyphens only');
  }
  const origin = `https://${resource}.openai.azure.com`;
  return { kind: 'classic', origin, baseUrl: origin, apiVersion, project: '' };
}

const endpointProperties = (): NodeProperty[] => [
  {
    displayName: 'Endpoint Type',
    name: 'endpointType',
    type: 'options',
    default: 'classic',
    options: [
      { name: 'Azure OpenAI (Classic)', value: 'classic' },
      { name: 'Microsoft Foundry', value: 'foundry' },
    ],
    description: 'Foundry is needed for Claude, the Responses API and the deployment list',
  },
  {
    displayName: 'Resource Name',
    name: 'resourceName',
    type: 'string',
    default: '',
    placeholder: 'my-resource',
    description: 'The Azure OpenAI resource, as in https://<resource>.openai.azure.com',
    displayOptions: { show: { endpointType: ['classic'] } },
  },
  {
    displayName: 'API Version',
    name: 'apiVersion',
    type: 'string',
    default: AZURE_DEFAULT_API_VERSION,
    displayOptions: { show: { endpointType: ['classic'] } },
  },
  {
    displayName: 'Custom Endpoint',
    name: 'endpoint',
    type: 'string',
    default: '',
    placeholder: 'https://my-resource.openai.azure.com',
    description:
      'Optional. Replaces the address built from the resource name, for a gateway or a private link.',
    displayOptions: { show: { endpointType: ['classic'] } },
  },
  {
    displayName: 'Foundry Endpoint',
    name: 'foundryEndpoint',
    type: 'string',
    default: '',
    placeholder: 'https://my-resource.services.ai.azure.com/openai/v1',
    description: 'The OpenAI-compatible endpoint of the resource. It ends with /openai/v1.',
    displayOptions: { show: { endpointType: ['foundry'] } },
  },
  {
    displayName: 'Project Name',
    name: 'projectName',
    type: 'string',
    default: '',
    description: 'The Foundry project. Needed only to pick a deployment from a list.',
    displayOptions: { show: { endpointType: ['foundry'] } },
  },
];

/** the request without any authorization header, whatever its case */
function withoutHeaders(request: HttpRequestOptions, names: string[]): Record<string, string | string[]> {
  return Object.fromEntries(
    Object.entries(request.headers ?? {}).filter(([name]) => !names.includes(name.toLowerCase())),
  );
}

/** refuses a request to another host than the credential's endpoint */
function assertOwnHost(target: AzureTarget, request: HttpRequestOptions): URL {
  let url: URL | undefined;
  try {
    url = new URL(request.url);
  } catch {
    url = undefined;
  }
  if (!url || url.protocol !== 'https:' || url.hostname !== new URL(target.origin).hostname) {
    throw new Error('This credential only signs https requests to its own endpoint');
  }
  return url;
}

export const azureOpenAiApi: CredentialType = {
  name: 'azureOpenAiApi',
  displayName: 'Microsoft Foundry and Azure OpenAI',
  icon: 'simple:microsoftazure',
  properties: [
    ...endpointProperties(),
    {
      displayName: 'API Key',
      name: 'apiKey',
      type: 'string',
      default: '',
      required: true,
      typeOptions: { password: true },
    },
  ],
  authenticate: async (credentials, request) => {
    const target = azureTarget(credentials);
    const key = text(credentials.apiKey);
    if (!key) throw new Error('The API key is empty');
    const url = assertOwnHost(target, request);
    // Claude on Foundry reads `x-api-key`; every other path reads `api-key`
    const claude = url.pathname.startsWith('/anthropic/');
    return {
      ...request,
      headers: {
        ...withoutHeaders(request, ['api-key', 'x-api-key']),
        'api-key': key,
        ...(claude ? { 'x-api-key': key } : {}),
      },
    };
  },
};

export const azureEntraCognitiveServicesOAuth2Api: CredentialType = {
  name: 'azureEntraCognitiveServicesOAuth2Api',
  displayName: 'Microsoft Foundry and Azure OpenAI (Entra ID)',
  icon: 'simple:microsoftazure',
  properties: [
    ...endpointProperties(),
    {
      displayName: 'Tenant ID',
      name: 'tenantId',
      type: 'string',
      default: '',
      required: true,
      description: 'The Entra directory (tenant) ID',
    },
    { displayName: 'Client ID', name: 'clientId', type: 'string', default: '', required: true },
    {
      displayName: 'Client Secret',
      name: 'clientSecret',
      type: 'string',
      default: '',
      required: true,
      typeOptions: { password: true },
    },
  ],
  authenticate: async (credentials, request, helpers) => {
    if (!helpers) throw new Error('This credential can only get a token through the workflow engine');
    const target = azureTarget(credentials);
    const tenantId = text(credentials.tenantId);
    const clientId = text(credentials.clientId);
    const clientSecret = text(credentials.clientSecret);
    if (!/^[A-Za-z0-9][A-Za-z0-9.-]*$/.test(tenantId)) {
      throw new Error('The tenant ID must be a directory ID or a domain name');
    }
    if (!clientId || !clientSecret) throw new Error('The client ID and the client secret are required');
    const url = assertOwnHost(target, request);
    // the deployment list lives on the project data plane and has its own audience
    const resource = url.pathname.startsWith('/api/projects/')
      ? AZURE_FOUNDRY_RESOURCE
      : AZURE_COGNITIVE_RESOURCE;
    const tokenUrl = `${AZURE_TOKEN_HOST}/${tenantId}/oauth2/token`;
    const token = await helpers.cachedToken(
      clientSecret,
      JSON.stringify({ tokenUrl, subject: clientId, scopes: [], resource, role: '' }),
      () => helpers.clientCredentialsToken({ tokenUrl, clientId, clientSecret, resource }),
    );
    return {
      ...request,
      headers: { ...withoutHeaders(request, ['authorization']), authorization: `Bearer ${token}` },
    };
  },
};
