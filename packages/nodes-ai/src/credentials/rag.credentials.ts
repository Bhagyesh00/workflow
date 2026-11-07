/**
 * Credential types for the RAG area: vector stores, the Xata memory and the search tools. Fields and
 * test requests follow n8n's credentials of the same names, with these differences:
 * - `weaviateApi` has one `url` field instead of the custom HTTP host, port and secure fields, and no
 *   gRPC fields (the store speaks REST and GraphQL only);
 * - `wolframAlphaApi` sends the App ID as a Bearer header, never in the query string, and tests on the
 *   LLM API with that header;
 * - Weaviate, Chroma Self-Hosted and Milvus send no Authorization header when no secret is set.
 * Header names are lower case, as in the other credential files.
 */
import type { CredentialType, HttpRequestOptions, NodeProperty } from '@workflow/workflow';

const apiKey = (required = true, description?: string): NodeProperty => ({
  displayName: 'API Key',
  name: 'apiKey',
  type: 'string',
  default: '',
  required,
  typeOptions: { password: true },
  ...(description ? { description } : {}),
});

function withHeaders(request: HttpRequestOptions, headers: Record<string, string>): HttpRequestOptions {
  return { ...request, headers: { ...(request.headers ?? {}), ...headers } };
}

function text(value: unknown): string {
  return value === undefined || value === null ? '' : String(value).trim();
}

export const pineconeApi: CredentialType = {
  name: 'pineconeApi',
  displayName: 'Pinecone API',
  icon: 'lucide:trees',
  documentationUrl: 'https://docs.pinecone.io/guides/projects/manage-api-keys',
  properties: [apiKey()],
  authenticate: {
    type: 'generic',
    properties: { headers: { 'api-key': '={{$credentials.apiKey}}' } },
  },
  test: {
    request: {
      url: 'https://api.pinecone.io/indexes',
      headers: { accept: 'application/json' },
    },
  },
};

export const weaviateApi: CredentialType = {
  name: 'weaviateApi',
  displayName: 'Weaviate',
  icon: 'lucide:boxes',
  documentationUrl: 'https://docs.weaviate.io/deploy/configuration/authentication',
  properties: [
    {
      displayName: 'Connection Type',
      name: 'connection_type',
      type: 'options',
      default: 'weaviate_cloud',
      options: [
        { name: 'Weaviate Cloud', value: 'weaviate_cloud' },
        { name: 'Custom Connection', value: 'custom_connection' },
      ],
      description: 'Whether the instance runs on Weaviate Cloud or on your own server',
    },
    {
      displayName: 'URL',
      name: 'url',
      type: 'string',
      default: '',
      required: true,
      placeholder: 'https://your-cluster.weaviate.cloud',
      description:
        'REST endpoint with scheme, and port when it is not the default (for example http://weaviate:8080). Private addresses are blocked by the SSRF policy unless your administrator allow-lists this host.',
    },
    apiKey(false, 'Leave empty for an instance without authentication'),
  ],
  authenticate: async (credentials, request) => {
    const key = text(credentials.apiKey);
    return key ? withHeaders(request, { authorization: `Bearer ${key}` }) : request;
  },
  test: { request: { url: '={{$credentials.url}}/v1/nodes' } },
};

export const azureAiSearchApi: CredentialType = {
  name: 'azureAiSearchApi',
  displayName: 'Azure AI Search API',
  icon: 'simple:microsoftazure',
  documentationUrl: 'https://learn.microsoft.com/azure/search/search-security-api-keys',
  properties: [
    {
      displayName: 'Search Endpoint',
      name: 'endpoint',
      type: 'string',
      default: '',
      required: true,
      placeholder: 'https://your-search-service.search.windows.net',
    },
    apiKey(),
  ],
  authenticate: {
    type: 'generic',
    properties: { headers: { 'api-key': '={{$credentials.apiKey}}' } },
  },
  test: {
    request: {
      url: '={{$credentials.endpoint}}/indexes',
      headers: { accept: 'application/json' },
      qs: { 'api-version': '2024-07-01' },
    },
  },
};

export const chromaSelfHostedApi: CredentialType = {
  name: 'chromaSelfHostedApi',
  displayName: 'ChromaDB Self-Hosted',
  icon: 'lucide:palette',
  documentationUrl: 'https://docs.trychroma.com/production/administration/auth',
  properties: [
    {
      displayName: 'Base URL',
      name: 'baseUrl',
      type: 'string',
      default: 'http://localhost:8000',
      placeholder: 'http://localhost:8000',
      description:
        'Root of the Chroma server (no path prefix). Private addresses are blocked by the SSRF policy unless your administrator allow-lists this host.',
    },
    {
      displayName: 'Authentication',
      name: 'authentication',
      type: 'options',
      default: 'none',
      options: [
        { name: 'None', value: 'none' },
        { name: 'API Key', value: 'apiKey' },
        { name: 'Token', value: 'token' },
      ],
    },
    {
      ...apiKey(false, 'Sent as a Bearer token'),
      displayOptions: { show: { authentication: ['apiKey'] } },
    },
    {
      displayName: 'Token',
      name: 'token',
      type: 'string',
      default: '',
      typeOptions: { password: true },
      description: 'Sent in the X-Chroma-Token header',
      displayOptions: { show: { authentication: ['token'] } },
    },
  ],
  authenticate: async (credentials, request) => {
    const mode = text(credentials.authentication) || 'none';
    const key = text(credentials.apiKey);
    const token = text(credentials.token);
    if (mode === 'apiKey' && key) return withHeaders(request, { authorization: `Bearer ${key}` });
    if (mode === 'token' && token) return withHeaders(request, { 'x-chroma-token': token });
    return request;
  },
  test: { request: { url: '={{$credentials.baseUrl}}/api/v2/heartbeat' } },
};

export const chromaCloudApi: CredentialType = {
  name: 'chromaCloudApi',
  displayName: 'ChromaDB Cloud',
  icon: 'lucide:palette',
  documentationUrl: 'https://docs.trychroma.com/cloud/getting-started',
  properties: [
    apiKey(true, 'Your Chroma Cloud API key'),
    {
      displayName: 'Tenant ID',
      name: 'tenant',
      type: 'string',
      default: '',
      description: 'Optional: found from the API key when it is scoped to one database',
    },
    {
      displayName: 'Database Name',
      name: 'database',
      type: 'string',
      default: '',
      description: 'Optional: found from the API key when it is scoped to one database',
    },
    {
      displayName: 'Base URL',
      name: 'baseUrl',
      type: 'string',
      default: 'https://api.trychroma.com',
      required: true,
    },
  ],
  authenticate: {
    type: 'generic',
    properties: { headers: { 'x-chroma-token': '={{$credentials.apiKey}}' } },
  },
  test: { request: { url: '={{$credentials.baseUrl}}/api/v2' } },
};

export const milvusApi: CredentialType = {
  name: 'milvusApi',
  displayName: 'Milvus',
  icon: 'lucide:bird',
  documentationUrl: 'https://milvus.io/docs/authenticate.md',
  properties: [
    {
      displayName: 'Base URL',
      name: 'baseUrl',
      type: 'string',
      default: 'http://localhost:19530',
      required: true,
      description:
        'Private addresses are blocked by the SSRF policy unless your administrator allow-lists this host',
    },
    { displayName: 'Username', name: 'username', type: 'string', default: '' },
    {
      displayName: 'Password',
      name: 'password',
      type: 'string',
      default: '',
      typeOptions: { password: true },
    },
  ],
  authenticate: async (credentials, request) => {
    const username = text(credentials.username);
    const password = text(credentials.password);
    return username || password
      ? withHeaders(request, { authorization: `Bearer ${username}:${password}` })
      : request;
  },
  test: { request: { url: '={{$credentials.baseUrl}}/v1/vector/collections' } },
};

export const xataApi: CredentialType = {
  name: 'xataApi',
  displayName: 'Xata API',
  icon: 'lucide:database',
  documentationUrl: 'https://xata.io/docs/getting-started/api-keys',
  properties: [
    {
      displayName: 'Database Endpoint',
      name: 'databaseEndpoint',
      type: 'string',
      default: '',
      required: true,
      placeholder: 'https://{workspace}.{region}.xata.sh/db/{database}',
    },
    { displayName: 'Branch', name: 'branch', type: 'string', default: 'main', required: true },
    apiKey(),
  ],
  authenticate: {
    type: 'generic',
    properties: { headers: { authorization: '=Bearer {{$credentials.apiKey}}' } },
  },
  test: { request: { url: '={{$credentials.databaseEndpoint}}:{{$credentials.branch}}' } },
};

/** no test request, as n8n: the instance has no endpoint that proves anything without a query */
export const searXngApi: CredentialType = {
  name: 'searXngApi',
  displayName: 'SearXNG',
  icon: 'lucide:search',
  documentationUrl: 'https://docs.searxng.org/dev/search_api.html',
  properties: [
    {
      displayName: 'API URL',
      name: 'apiUrl',
      type: 'string',
      default: '',
      required: true,
      placeholder: 'https://searx.example.com',
      description:
        'Root of the SearXNG instance, with JSON output enabled. Private addresses are blocked by the SSRF policy unless your administrator allow-lists this host.',
    },
  ],
};

export const wolframAlphaApi: CredentialType = {
  name: 'wolframAlphaApi',
  displayName: 'Wolfram Alpha API',
  icon: 'lucide:sigma',
  documentationUrl: 'https://products.wolframalpha.com/llm-api/documentation',
  properties: [
    {
      displayName: 'App ID',
      name: 'appId',
      type: 'string',
      default: '',
      required: true,
      typeOptions: { password: true },
    },
  ],
  // a header, never the query string, so the App ID stays out of URLs and logs
  authenticate: {
    type: 'generic',
    properties: { headers: { authorization: '=Bearer {{$credentials.appId}}' } },
  },
  test: { request: { url: 'https://www.wolframalpha.com/api/v1/llm-api', qs: { input: '1+1' } } },
};

export const ragCredentials: CredentialType[] = [
  pineconeApi,
  weaviateApi,
  azureAiSearchApi,
  chromaSelfHostedApi,
  chromaCloudApi,
  milvusApi,
  xataApi,
  searXngApi,
  wolframAlphaApi,
];
