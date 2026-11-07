/**
 * Credential types for AI providers. Test requests list models; URLs and header values in
 * `test.request` are templates over `$credentials`, resolved like generic authentication.
 */
import type { CredentialType, DataObject, HttpRequestOptions, NodeProperty } from '@workflow/workflow';
import { ANTHROPIC_API_VERSION, ANTHROPIC_DEFAULT_BASE_URL } from '../providers/anthropic';
import { GEMINI_DEFAULT_HOST } from '../providers/gemini';
import { OLLAMA_DEFAULT_BASE_URL } from '../providers/ollama';
import { azureEntraCognitiveServicesOAuth2Api, azureOpenAiApi } from './azure.credentials';
import { googleVertexAiApi } from './google-vertex.credentials';
import { modelCredentials } from './models.credentials';
import { ragCredentials } from './rag.credentials';

const apiKey = (required = true) => ({
  displayName: 'API Key',
  name: 'apiKey',
  type: 'string' as const,
  default: '',
  required,
  typeOptions: { password: true },
});

function withHeaders(request: HttpRequestOptions, headers: Record<string, string>): HttpRequestOptions {
  return { ...request, headers: { ...(request.headers ?? {}), ...headers } };
}

/** Bearer token only when an API key is set (local servers often need none). */
const optionalBearer = async (credentials: DataObject, request: HttpRequestOptions) =>
  credentials.apiKey
    ? withHeaders(request, { authorization: `Bearer ${String(credentials.apiKey)}` })
    : request;

/** "Add Custom Header": sent on every request of the credential, and wins over its other headers */
const customHeaderProperties: NodeProperty[] = [
  {
    displayName: 'Add Custom Header',
    name: 'header',
    type: 'boolean',
    default: false,
    description: 'Whether to send one more header on every request, for a proxy or gateway',
  },
  {
    displayName: 'Header Name',
    name: 'headerName',
    type: 'string',
    default: '',
    displayOptions: { show: { header: [true] } },
  },
  {
    displayName: 'Header Value',
    name: 'headerValue',
    type: 'string',
    default: '',
    typeOptions: { password: true },
    displayOptions: { show: { header: [true] } },
  },
];

function customHeader(credentials: DataObject): Record<string, string> {
  const name = String(credentials.headerName ?? '')
    .trim()
    .toLowerCase();
  return credentials.header === true && name ? { [name]: String(credentials.headerValue ?? '') } : {};
}

export const openAiApi: CredentialType = {
  name: 'openAiApi',
  displayName: 'OpenAI',
  icon: 'simple:openai',
  documentationUrl: 'https://platform.openai.com/api-keys',
  properties: [
    apiKey(),
    {
      displayName: 'Organization ID',
      name: 'organization',
      type: 'string',
      default: '',
      description: 'Optional. Requests are billed to this organization.',
    },
    {
      displayName: 'Base URL',
      name: 'baseUrl',
      type: 'string',
      default: 'https://api.openai.com/v1',
      description: 'Change only for a proxy or an Azure / gateway endpoint that speaks the OpenAI API',
    },
    ...customHeaderProperties,
  ],
  authenticate: async (credentials, request) =>
    withHeaders(request, {
      authorization: `Bearer ${String(credentials.apiKey ?? '')}`,
      ...(credentials.organization ? { 'openai-organization': String(credentials.organization) } : {}),
      ...customHeader(credentials),
    }),
  test: { request: { url: '={{$credentials.baseUrl}}/models' } },
};

export const anthropicApi: CredentialType = {
  name: 'anthropicApi',
  displayName: 'Anthropic',
  icon: 'simple:anthropic',
  documentationUrl: 'https://console.anthropic.com/settings/keys',
  properties: [
    apiKey(),
    {
      displayName: 'Base URL',
      name: 'baseUrl',
      type: 'string',
      default: ANTHROPIC_DEFAULT_BASE_URL,
      description: 'Change only for a proxy or gateway in front of the Claude API',
    },
    ...customHeaderProperties,
  ],
  authenticate: async (credentials, request) =>
    withHeaders(request, { 'x-api-key': String(credentials.apiKey ?? ''), ...customHeader(credentials) }),
  test: {
    request: {
      url: '={{$credentials.baseUrl}}/v1/models',
      headers: { 'anthropic-version': ANTHROPIC_API_VERSION },
    },
  },
};

export const googleGeminiApi: CredentialType = {
  name: 'googleGeminiApi',
  displayName: 'Google Gemini (PaLM) API',
  icon: 'simple:googlegemini',
  documentationUrl: 'https://aistudio.google.com/app/apikey',
  properties: [
    {
      displayName: 'Host',
      name: 'host',
      type: 'string',
      default: GEMINI_DEFAULT_HOST,
    },
    apiKey(),
  ],
  authenticate: {
    type: 'generic',
    properties: { headers: { 'x-goog-api-key': '={{$credentials.apiKey}}' } },
  },
  test: { request: { url: '={{$credentials.host}}/v1beta/models' } },
};

export const ollamaApi: CredentialType = {
  name: 'ollamaApi',
  displayName: 'Ollama',
  icon: 'simple:ollama',
  documentationUrl: 'https://github.com/ollama/ollama/blob/main/docs/api.md',
  properties: [
    {
      displayName: 'Base URL',
      name: 'baseUrl',
      type: 'string',
      default: OLLAMA_DEFAULT_BASE_URL,
      description:
        'Private addresses are blocked by the SSRF policy unless your administrator allow-lists this host',
    },
    { ...apiKey(false), description: 'Only needed when Ollama runs behind an authenticating proxy' },
  ],
  authenticate: optionalBearer,
  test: { request: { url: '={{$credentials.baseUrl}}/api/tags' } },
};

export const openAiCompatibleApi: CredentialType = {
  name: 'openAiCompatibleApi',
  displayName: 'OpenAI-Compatible API',
  icon: 'lucide:plug-zap',
  properties: [
    {
      displayName: 'Base URL',
      name: 'baseUrl',
      type: 'string',
      default: '',
      required: true,
      placeholder: 'https://openrouter.ai/api/v1',
      description:
        'Root of an OpenAI-compatible API, e.g. https://api.groq.com/openai/v1, https://api.mistral.ai/v1, https://api.deepseek.com/v1, https://api.x.ai/v1, https://api.together.xyz/v1',
    },
    { ...apiKey(false), description: 'Sent as a Bearer token when set' },
  ],
  authenticate: optionalBearer,
  test: { request: { url: '={{$credentials.baseUrl}}/models' } },
};

export const qdrantApi: CredentialType = {
  name: 'qdrantApi',
  displayName: 'Qdrant',
  icon: 'lucide:database-zap',
  documentationUrl: 'https://qdrant.tech/documentation/cloud/authentication/',
  properties: [
    {
      displayName: 'Qdrant URL',
      name: 'url',
      type: 'string',
      default: '',
      required: true,
      placeholder: 'https://xyz.cloud.qdrant.io:6333',
    },
    { ...apiKey(false), description: 'Leave empty for an instance without authentication' },
  ],
  authenticate: async (credentials, request) =>
    credentials.apiKey ? withHeaders(request, { 'api-key': String(credentials.apiKey) }) : request,
  test: { request: { url: '={{$credentials.url}}/collections' } },
};

export const aiCredentials: CredentialType[] = [
  openAiApi,
  anthropicApi,
  googleGeminiApi,
  ollamaApi,
  openAiCompatibleApi,
  qdrantApi,
  ...modelCredentials,
  azureOpenAiApi,
  azureEntraCognitiveServicesOAuth2Api,
  googleVertexAiApi,
  ...ragCredentials,
];
