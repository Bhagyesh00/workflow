/**
 * Credential types for the named model providers. Every base URL sits in the field `url` (Lemonade:
 * `baseUrl`) as plain text, so nodes and test requests read one value. A hidden `url` is fixed, as
 * `CredentialService.withDefaults` always gives its default. A region is a choice of base URL: it is
 * stored in `url`, because a test request cannot derive a URL from another field, and `withDefaults`
 * resets a value outside the list.
 */
import type { CredentialType, DataObject, HttpRequestOptions, NodeProperty } from '@workflow/workflow';

const apiKey = (required = true): NodeProperty => ({
  displayName: 'API Key',
  name: 'apiKey',
  type: 'string',
  default: '',
  required,
  typeOptions: { password: true },
});

const fixedUrl = (value: string): NodeProperty => ({
  displayName: 'Base URL',
  name: 'url',
  type: 'hidden',
  default: value,
});

const baseUrl = (value: string, description?: string): NodeProperty => ({
  displayName: 'Base URL',
  name: 'url',
  type: 'string',
  default: value,
  required: true,
  description,
});

const region = (first: string, options: Array<{ name: string; value: string }>): NodeProperty => ({
  displayName: 'Region',
  name: 'url',
  type: 'options',
  default: first,
  options,
});

const bearer: NonNullable<CredentialType['authenticate']> = {
  type: 'generic',
  properties: { headers: { authorization: '=Bearer {{$credentials.apiKey}}' } },
};

/** Bearer token only when an API key is set (local servers often need none). */
const optionalBearer = async (credentials: DataObject, request: HttpRequestOptions) => {
  const key = String(credentials.apiKey ?? '').trim();
  if (!key) return request;
  return { ...request, headers: { ...(request.headers ?? {}), authorization: `Bearer ${key}` } };
};

export const mistralCloudApi: CredentialType = {
  name: 'mistralCloudApi',
  displayName: 'Mistral Cloud',
  icon: 'simple:mistralai',
  properties: [apiKey()],
  authenticate: bearer,
  test: { request: { url: 'https://api.mistral.ai/v1/models' } },
};

export const cohereApi: CredentialType = {
  name: 'cohereApi',
  displayName: 'Cohere',
  icon: 'simple:cohere',
  properties: [apiKey(), baseUrl('https://api.cohere.ai', 'Change only for a proxy or a private deployment')],
  authenticate: bearer,
  test: { request: { url: '={{$credentials.url}}/v1/models', qs: { page_size: 1 } } },
};

export const deepSeekApi: CredentialType = {
  name: 'deepSeekApi',
  displayName: 'DeepSeek',
  icon: 'simple:deepseek',
  properties: [apiKey(), fixedUrl('https://api.deepseek.com')],
  authenticate: bearer,
  test: { request: { url: '={{$credentials.url}}/models' } },
};

export const groqApi: CredentialType = {
  name: 'groqApi',
  displayName: 'Groq',
  icon: 'simple:groq',
  properties: [apiKey()],
  authenticate: bearer,
  test: { request: { url: 'https://api.groq.com/openai/v1/models' } },
};

export const xAiApi: CredentialType = {
  name: 'xAiApi',
  displayName: 'xAI',
  icon: 'simple:x',
  properties: [apiKey(), fixedUrl('https://api.x.ai/v1')],
  authenticate: bearer,
  test: { request: { url: '={{$credentials.url}}/models' } },
};

export const openRouterApi: CredentialType = {
  name: 'openRouterApi',
  displayName: 'OpenRouter',
  icon: 'simple:openrouter',
  properties: [apiKey(), fixedUrl('https://openrouter.ai/api/v1')],
  authenticate: bearer,
  test: { request: { url: '={{$credentials.url}}/key' } },
};

export const vercelAiGatewayApi: CredentialType = {
  name: 'vercelAiGatewayApi',
  displayName: 'Vercel AI Gateway',
  icon: 'simple:vercel',
  properties: [
    { ...apiKey(), displayName: 'API Key or OIDC Token' },
    baseUrl('https://ai-gateway.vercel.sh/v1'),
  ],
  authenticate: bearer,
  test: {
    request: {
      method: 'POST',
      url: '={{$credentials.url}}/chat/completions',
      body: {
        model: 'openai/gpt-4.1-nano',
        messages: [{ role: 'user', content: 'test' }],
        max_tokens: 1,
      },
    },
  },
};

export const nvidiaApi: CredentialType = {
  name: 'nvidiaApi',
  displayName: 'NVIDIA',
  icon: 'simple:nvidia',
  properties: [baseUrl('https://integrate.api.nvidia.com/v1'), apiKey(false)],
  authenticate: optionalBearer,
  test: { request: { url: '={{$credentials.url}}/models' } },
};

export const moonshotApi: CredentialType = {
  name: 'moonshotApi',
  displayName: 'Moonshot Kimi',
  icon: 'simple:moonshot',
  properties: [
    apiKey(),
    region('https://api.moonshot.ai/v1', [
      { name: 'International', value: 'https://api.moonshot.ai/v1' },
      { name: 'China', value: 'https://api.moonshot.cn/v1' },
    ]),
  ],
  authenticate: bearer,
  test: { request: { url: '={{$credentials.url}}/models' } },
};

export const minimaxApi: CredentialType = {
  name: 'minimaxApi',
  displayName: 'MiniMax',
  icon: 'simple:minimax',
  properties: [
    apiKey(),
    region('https://api.minimax.io/v1', [
      { name: 'International', value: 'https://api.minimax.io/v1' },
      { name: 'China', value: 'https://api.minimaxi.com/v1' },
    ]),
  ],
  authenticate: bearer,
  test: {
    request: { url: '={{$credentials.url}}/files/list', qs: { purpose: 'voice_clone' } },
    // MiniMax answers a bad key with HTTP 200 and a code in the body
    rules: [
      {
        type: 'responseSuccessBody',
        key: 'base_resp.status_code',
        value: 1004,
        message: 'Authentication failed. Check your API key.',
      },
      {
        type: 'responseSuccessBody',
        key: 'base_resp.status_code',
        value: 2049,
        message: 'Invalid API key. Check that your key matches the selected region.',
      },
    ],
  },
};

/** Bearer token, plus the DashScope workspace header only when a workspace is set. */
const dashScopeAuth = async (credentials: DataObject, request: HttpRequestOptions) => {
  const workspace = String(credentials.workspaceId ?? '').trim();
  return {
    ...request,
    headers: {
      ...(request.headers ?? {}),
      authorization: `Bearer ${String(credentials.apiKey ?? '')}`,
      ...(workspace ? { 'X-DashScope-WorkSpace': workspace } : {}),
    },
  };
};

/** `url` is the region's host; the OpenAI-compatible API is at `<url>/compatible-mode/v1` */
export const alibabaCloudApi: CredentialType = {
  name: 'alibabaCloudApi',
  displayName: 'Qwen Cloud',
  icon: 'simple:alibabacloud',
  properties: [
    apiKey(),
    region('https://dashscope-intl.aliyuncs.com', [
      { name: 'Singapore (International)', value: 'https://dashscope-intl.aliyuncs.com' },
      { name: 'US (Virginia)', value: 'https://dashscope-us.aliyuncs.com' },
      { name: 'China (Beijing)', value: 'https://dashscope.aliyuncs.com' },
      { name: 'Hong Kong (China)', value: 'https://cn-hongkong.dashscope.aliyuncs.com' },
    ]),
    {
      displayName: 'Workspace ID',
      name: 'workspaceId',
      type: 'string',
      default: '',
      description: 'Only for a key of a sub-workspace: sent as the X-DashScope-WorkSpace header when set',
    },
  ],
  authenticate: dashScopeAuth,
  test: { request: { url: '={{$credentials.url}}/compatible-mode/v1/models' } },
};

export const lemonadeApi: CredentialType = {
  name: 'lemonadeApi',
  displayName: 'Lemonade',
  icon: 'lucide:citrus',
  properties: [
    {
      displayName: 'Base URL',
      name: 'baseUrl',
      type: 'string',
      default: 'http://localhost:8000/api/v1',
      required: true,
      description:
        'Private addresses are blocked by the SSRF policy unless your administrator allow-lists this host',
    },
    { ...apiKey(false), description: 'Not needed for a default Lemonade installation' },
  ],
  authenticate: optionalBearer,
  test: { request: { url: '={{$credentials.baseUrl}}/models' } },
};

export const huggingFaceApi: CredentialType = {
  name: 'huggingFaceApi',
  displayName: 'Hugging Face',
  icon: 'simple:huggingface',
  properties: [apiKey()],
  authenticate: bearer,
  test: { request: { url: 'https://huggingface.co/api/whoami-v2' } },
};

export const modelCredentials: CredentialType[] = [
  mistralCloudApi,
  cohereApi,
  deepSeekApi,
  groqApi,
  xAiApi,
  openRouterApi,
  vercelAiGatewayApi,
  nvidiaApi,
  moonshotApi,
  minimaxApi,
  alibabaCloudApi,
  lemonadeApi,
  huggingFaceApi,
];
