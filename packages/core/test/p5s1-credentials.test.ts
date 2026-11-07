/**
 * Phase 5 S1 contract step C0b: helpers for a function `authenticate`, the client-credentials path of an
 * OAuth2 type with its own `authenticate`, token URL templates, the `$fromAI` parameter reader, and the
 * two new execute-context callbacks. The four credential files are L1's stubs, so the builders are mocked:
 * this tests how the helpers call them (L1's core/test/cloud-auth.test.ts tests what they build).
 */
import {
  type CredentialAuthHelpers,
  CredentialDomainError,
  type CredentialType,
  type DataObject,
  type ExecuteData,
  ExpressionEvaluator,
  type HttpRequestOptions,
  ToolSuspension,
  Workflow,
  type WorkflowNode,
} from '@workflow/workflow';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import * as core from '../src';
import {
  applyAuthentication,
  type ContextDeps,
  CredentialTypes,
  createBaseContext,
  createCredentialHelpers,
  createExecuteContext,
  createToolParameterReader,
  GOOGLE_TOKEN_URL,
  type HttpClient,
  type OAuth2Data,
  requestOAuth2Token,
  resolveCredentialUrl,
} from '../src';
import { nodeTypes, services } from './helpers';

const mocks = vi.hoisted(() => ({
  signAwsRequest: vi.fn(),
  googleJwtAssertion: vi.fn(),
  jwtBearerRequest: vi.fn(),
  clientCredentialsRequest: vi.fn(),
  parseAccessToken: vi.fn(),
  cacheGet: vi.fn(),
}));

vi.mock('../src/credentials/aws-sigv4', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../src/credentials/aws-sigv4')>()),
  signAwsRequest: mocks.signAwsRequest,
}));
vi.mock('../src/credentials/google-jwt', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../src/credentials/google-jwt')>()),
  googleJwtAssertion: mocks.googleJwtAssertion,
  jwtBearerRequest: mocks.jwtBearerRequest,
}));
vi.mock('../src/credentials/azure-token', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../src/credentials/azure-token')>()),
  clientCredentialsRequest: mocks.clientCredentialsRequest,
  parseAccessToken: mocks.parseAccessToken,
}));
vi.mock('../src/credentials/token-cache', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../src/credentials/token-cache')>()),
  sharedTokenCache: { get: mocks.cacheGet },
}));

/** an HttpClient that records what it was asked and answers `reply` */
function fakeHttp(reply: unknown = { ok: true }) {
  const request = vi.fn(async (_options: HttpRequestOptions, _signal?: AbortSignal) => reply);
  return {
    client: { request } as unknown as HttpClient,
    request,
    sent: () => request.mock.calls.map((call) => call[0]),
    signals: () => request.mock.calls.map((call) => call[1]),
  };
}

const oAuth2Api: CredentialType = { name: 'oAuth2Api', displayName: 'OAuth2', properties: [] };

/** a base context whose node holds one credential of `type`, on a recording HttpClient */
function credentialContext(type: CredentialType, data: DataObject) {
  const http = fakeHttp();
  const node: WorkflowNode = {
    id: 'n',
    name: 'Node',
    type: 'test.set',
    typeVersion: 1,
    position: [0, 0],
    parameters: {},
    credentials: { [type.name]: { id: 'c1', name: 'cred' } },
  };
  const signal = new AbortController().signal;
  const ctx = createBaseContext({
    workflow: new Workflow({ name: 'w', nodes: [node], connections: {} }, nodeTypes),
    node,
    services: services({
      http: http.client,
      credentialTypes: new CredentialTypes([oAuth2Api, type]),
      credentials: { get: async () => data, update: async () => {} },
    }),
    evaluator: new ExpressionEvaluator(),
    signal,
  });
  return { ctx, http, signal };
}

/** deps of a Set node whose `value` parameter is `value`, with one input item `{ topic: 'dogs' }` */
function toolDeps(value: string): ContextDeps {
  const node: WorkflowNode = {
    id: 't',
    name: 'Tool',
    type: 'test.set',
    typeVersion: 1,
    position: [0, 0],
    parameters: { value },
  };
  const executeData: ExecuteData = {
    node: 'Tool',
    data: { main: [[{ json: { topic: 'dogs' } }]] },
    source: null,
  };
  return {
    workflow: new Workflow({ name: 'w', nodes: [node], connections: {} }, nodeTypes),
    node,
    services: services(),
    evaluator: new ExpressionEvaluator(),
    signal: new AbortController().signal,
    executeData,
  };
}

const executeCallbacks = {
  getInputConnectionData: async () => undefined,
  putExecutionToWait: () => {},
  continueOnFail: () => false,
  addExecutionHints: () => {},
};

beforeEach(() => {
  vi.clearAllMocks();
});

describe('core exports', () => {
  it('exports the credential files and the engine stubs', () => {
    const exported: Record<string, unknown> = { ...core };
    for (const name of [
      'signAwsRequest',
      'amzDate',
      'signingKey',
      'googleJwtAssertion',
      'jwtBearerRequest',
      'clientCredentialsRequest',
      'parseAccessToken',
      'TokenCache',
      'createCredentialHelpers',
      'resolveCredentialUrl',
      'createToolParameterReader',
      'createNodeAsTool',
      'createHitlGate',
      'toolRootOf',
      'runToolExecutor',
    ]) {
      expect(typeof exported[name]).toBe('function');
    }
    expect(core.sharedTokenCache).toBeDefined();
    expect(GOOGLE_TOKEN_URL).toBe('https://oauth2.googleapis.com/token');
  });
});

describe('applyAuthentication', () => {
  const helpers = {} as CredentialAuthHelpers;

  it('hands the helpers to a function authenticate as its third argument', async () => {
    const authenticate = vi.fn(
      async (_credentials: DataObject, request: HttpRequestOptions, _helpers?: CredentialAuthHelpers) =>
        request,
    );
    const type: CredentialType = { name: 'own', displayName: 'Own', properties: [], authenticate };
    await applyAuthentication(type, { key: 'k' }, { url: 'https://a.test/' }, helpers);
    expect(authenticate.mock.calls[0]?.[2]).toBe(helpers);
    await applyAuthentication(type, { key: 'k' }, { url: 'https://a.test/' });
    expect(authenticate.mock.calls[1]?.[2]).toBeUndefined();
  });

  it('leaves a generic authenticate as it was', async () => {
    const type: CredentialType = {
      name: 'generic',
      displayName: 'Generic',
      properties: [],
      authenticate: {
        type: 'generic',
        properties: {
          headers: { 'x-key': '={{$credentials.key}}' },
          qs: { token: '={{$credentials.key}}' },
        },
      },
    };
    const request: HttpRequestOptions = { url: 'https://a.test/', headers: { accept: 'text/plain' } };
    const expected = {
      url: 'https://a.test/',
      headers: { accept: 'text/plain', 'x-key': 'k' },
      qs: { token: 'k' },
    };
    expect(await applyAuthentication(type, { key: 'k' }, request, helpers)).toEqual(expected);
    expect(await applyAuthentication(type, { key: 'k' }, request)).toEqual(expected);
  });
});

describe('createCredentialHelpers', () => {
  it('sends every http call with the allowed domains and the signal', async () => {
    const http = fakeHttp({ fine: 1 });
    const { signal } = new AbortController();
    const helpers = createCredentialHelpers(http.client, ['*.example.com'], signal);
    await expect(helpers.http({ url: 'https://a.example.com/one' })).resolves.toEqual({ fine: 1 });
    await helpers.http({ url: 'https://b.example.com/two', method: 'POST' });
    expect(http.sent()).toEqual([
      { url: 'https://a.example.com/one', allowedDomains: ['*.example.com'] },
      { url: 'https://b.example.com/two', method: 'POST', allowedDomains: ['*.example.com'] },
    ]);
    expect(http.signals()).toEqual([signal, signal]);
  });

  it('refuses a host outside the list without sending anything', async () => {
    const http = fakeHttp();
    const helpers = createCredentialHelpers(http.client, ['api.example.com']);
    await expect(helpers.http({ url: 'https://evil.test/token' })).rejects.toBeInstanceOf(
      CredentialDomainError,
    );
    expect(http.request).not.toHaveBeenCalled();
  });

  it("does not let a caller's own list replace the credential's", async () => {
    const http = fakeHttp();
    const helpers = createCredentialHelpers(http.client, ['api.example.com']);
    await helpers.http({ url: 'https://api.example.com/', allowedDomains: ['evil.test'] });
    expect(http.sent()[0]?.allowedDomains).toEqual(['api.example.com']);
  });

  it('sends the request as given for an unrestricted credential', async () => {
    const http = fakeHttp();
    const helpers = createCredentialHelpers(http.client, undefined);
    await helpers.http({ url: 'https://any.test/' });
    expect(http.sent()).toEqual([{ url: 'https://any.test/' }]);
  });

  it('gets a client-credentials token through the guarded call', async () => {
    const http = fakeHttp({ access_token: 'raw' });
    mocks.clientCredentialsRequest.mockReturnValue({ url: 'https://login.example.com/t', method: 'POST' });
    mocks.parseAccessToken.mockReturnValue({ token: 'tok', expiresInSeconds: 60 });
    const helpers = createCredentialHelpers(http.client, ['login.example.com']);
    const input = { tokenUrl: 'https://login.example.com/t', clientId: 'id', clientSecret: 's' };
    await expect(helpers.clientCredentialsToken(input)).resolves.toEqual({
      token: 'tok',
      expiresInSeconds: 60,
    });
    expect(mocks.clientCredentialsRequest).toHaveBeenCalledWith(input);
    expect(mocks.parseAccessToken).toHaveBeenCalledWith({ access_token: 'raw' });
    expect(http.sent()[0]?.allowedDomains).toEqual(['login.example.com']);
  });

  it('refuses a token host outside the list', async () => {
    const http = fakeHttp();
    mocks.clientCredentialsRequest.mockReturnValue({ url: 'https://evil.test/t', method: 'POST' });
    const helpers = createCredentialHelpers(http.client, ['login.example.com']);
    await expect(
      helpers.clientCredentialsToken({ tokenUrl: 'https://evil.test/t', clientId: 'id', clientSecret: 's' }),
    ).rejects.toBeInstanceOf(CredentialDomainError);
    expect(http.request).not.toHaveBeenCalled();
  });

  it('posts a JWT assertion to Google unless the input names a token URL', async () => {
    const http = fakeHttp({ access_token: 'raw' });
    mocks.googleJwtAssertion.mockReturnValue('jwt');
    mocks.jwtBearerRequest.mockImplementation((_assertion: string, tokenUrl: string) => ({
      url: tokenUrl,
      method: 'POST',
    }));
    mocks.parseAccessToken.mockReturnValue({ token: 'tok', expiresInSeconds: 60 });
    const helpers = createCredentialHelpers(http.client, undefined);
    const input = { email: 'a@b.test', privateKey: 'key', scopes: ['s'] };
    await helpers.jwtBearerToken(input);
    await helpers.jwtBearerToken({ ...input, tokenUrl: 'https://sts.test/token' });
    expect(mocks.jwtBearerRequest.mock.calls).toEqual([
      ['jwt', GOOGLE_TOKEN_URL],
      ['jwt', 'https://sts.test/token'],
    ]);
    expect(http.sent().map((r) => r.url)).toEqual([GOOGLE_TOKEN_URL, 'https://sts.test/token']);
  });

  it('returns only the headers of an AWS signature', () => {
    mocks.signAwsRequest.mockReturnValue({
      headers: { authorization: 'AWS4' },
      canonicalRequest: 'c',
      stringToSign: 's',
      signature: 'x',
    });
    const helpers = createCredentialHelpers(fakeHttp().client, undefined);
    const input = {
      method: 'GET',
      url: 'https://sts.amazonaws.com/',
      region: 'us-east-1',
      service: 'sts',
      accessKeyId: 'id',
      secretAccessKey: 'secret',
    };
    expect(helpers.signAwsV4(input)).toEqual({ headers: { authorization: 'AWS4' } });
    expect(mocks.signAwsRequest).toHaveBeenCalledWith(input);
  });

  it('keeps tokens in the shared cache', async () => {
    mocks.cacheGet.mockResolvedValue('cached');
    const helpers = createCredentialHelpers(fakeHttp().client, undefined);
    const fetchToken = async () => ({ token: 't', expiresInSeconds: 1 });
    await expect(helpers.cachedToken('secret', 'scope', fetchToken)).resolves.toBe('cached');
    expect(mocks.cacheGet).toHaveBeenCalledWith('secret', 'scope', fetchToken);
  });
});

describe('token URL templates', () => {
  it('resolves a template and leaves plain text alone', () => {
    const data = { host: 'https://db.example.com' };
    expect(resolveCredentialUrl('={{$credentials.host}}/oidc/v1/token', data)).toBe(
      'https://db.example.com/oidc/v1/token',
    );
    expect(resolveCredentialUrl('https://plain.test/token', data)).toBe('https://plain.test/token');
  });

  const oauth = (extra: DataObject = {}): OAuth2Data => ({
    grantType: 'clientCredentials',
    clientId: 'id',
    clientSecret: 'secret',
    accessTokenUrl: '={{$credentials.host}}/oidc/v1/token',
    host: 'https://db.example.com',
    ...extra,
  });

  it('requests the token at the resolved URL', async () => {
    const http = fakeHttp({ access_token: 'tok' });
    await requestOAuth2Token(http.client, oauth(), { type: 'client_credentials' });
    expect(http.sent()[0]?.url).toBe('https://db.example.com/oidc/v1/token');
  });

  it('checks the allowed domains on the resolved host', async () => {
    const http = fakeHttp({ access_token: 'tok' });
    const restricted = oauth({ allowedHttpRequestDomains: 'domains', allowedDomains: 'api.example.com' });
    await expect(
      requestOAuth2Token(http.client, restricted, { type: 'client_credentials' }),
    ).rejects.toBeInstanceOf(CredentialDomainError);
    expect(http.request).not.toHaveBeenCalled();
  });

  it('refuses a template that resolves to nothing', async () => {
    const http = fakeHttp({ access_token: 'tok' });
    const data = oauth({ accessTokenUrl: '={{$credentials.missing}}' });
    await expect(requestOAuth2Token(http.client, data, { type: 'client_credentials' })).rejects.toThrow(
      'OAuth2 credential has no access token URL',
    );
    expect(http.request).not.toHaveBeenCalled();
  });
});

describe('httpRequestWithAuthentication', () => {
  const url = 'https://db.example.com/api';
  const tokenUrl = 'https://db.example.com/oidc/v1/token';

  /** an OAuth2 type whose `authenticate` gets a token through the helpers */
  function ownFlowType() {
    const authenticate = vi.fn(
      async (_credentials: DataObject, request: HttpRequestOptions, helpers?: CredentialAuthHelpers) => {
        const token = await helpers?.http<{ access_token: string }>({ url: tokenUrl, method: 'POST' });
        return { ...request, headers: { authorization: `Bearer ${token?.access_token}` } };
      },
    );
    const type: CredentialType = {
      name: 'ownFlow',
      displayName: 'Own flow',
      extends: ['oAuth2Api'],
      properties: [],
      authenticate,
    };
    return { type, authenticate };
  }

  it('takes the authenticate path for client credentials on a type with a function authenticate', async () => {
    const { type, authenticate } = ownFlowType();
    const { ctx, http, signal } = credentialContext(type, {
      grantType: 'clientCredentials',
      allowedHttpRequestDomains: 'domains',
      allowedDomains: '*.example.com',
    });
    await ctx.helpers.httpRequestWithAuthentication('ownFlow', { url });
    expect(authenticate).toHaveBeenCalledTimes(1);
    // the token call first, then the request itself, both under the credential's list
    expect(http.sent().map((r) => r.url)).toEqual([tokenUrl, url]);
    expect(http.sent().map((r) => r.allowedDomains)).toEqual([['*.example.com'], ['*.example.com']]);
    expect(http.signals()).toEqual([signal, signal]);
  });

  it('refuses a token host outside the credential list', async () => {
    const { type } = ownFlowType();
    const { ctx, http } = credentialContext(type, {
      grantType: 'clientCredentials',
      allowedHttpRequestDomains: 'domains',
      allowedDomains: 'other.example.org',
    });
    await expect(
      ctx.helpers.httpRequestWithAuthentication('ownFlow', { url: 'https://other.example.org/api' }),
    ).rejects.toThrow('Domain not allowed');
    expect(http.request).not.toHaveBeenCalled();
  });

  it('keeps oauth2Request for another grant on the same type', async () => {
    const { type, authenticate } = ownFlowType();
    const { ctx, http } = credentialContext(type, {
      grantType: 'authorizationCode',
      oauthTokenData: { access_token: 'stored' },
    });
    await ctx.helpers.httpRequestWithAuthentication('ownFlow', { url });
    expect(authenticate).not.toHaveBeenCalled();
    expect(http.sent()).toEqual([{ url, headers: { authorization: 'Bearer stored' } }]);
  });

  it('keeps oauth2Request for client credentials without a function authenticate', async () => {
    const type: CredentialType = {
      name: 'plainFlow',
      displayName: 'Plain flow',
      extends: ['oAuth2Api'],
      properties: [],
    };
    const { ctx, http } = credentialContext(type, {
      grantType: 'clientCredentials',
      oauthTokenData: { access_token: 'stored' },
    });
    await ctx.helpers.httpRequestWithAuthentication('plainFlow', { url });
    expect(http.sent()).toEqual([{ url, headers: { authorization: 'Bearer stored' } }]);
  });

  it('gives a non-OAuth2 function authenticate the helpers too', async () => {
    const authenticate = vi.fn(
      async (_credentials: DataObject, request: HttpRequestOptions, helpers?: CredentialAuthHelpers) => {
        await helpers?.http({ url: 'https://sts.example.com/' });
        return request;
      },
    );
    const type: CredentialType = { name: 'signed', displayName: 'Signed', properties: [], authenticate };
    const { ctx, http } = credentialContext(type, {
      allowedHttpRequestDomains: 'domains',
      allowedDomains: '*.example.com',
    });
    await ctx.helpers.httpRequestWithAuthentication('signed', { url });
    expect(http.sent().map((r) => r.allowedDomains)).toEqual([['*.example.com'], ['*.example.com']]);
  });
});

describe('createToolParameterReader', () => {
  it('binds $fromAI to the arguments, not the input item', () => {
    const deps = toolDeps("={{ $fromAI('topic') }}");
    expect(createBaseContext(deps).getNodeParameter('value', 0)).toBe('dogs');
    expect(createToolParameterReader(deps)('value', 0, { topic: 'cats' })).toBe('cats');
  });

  it('binds all three spellings', () => {
    for (const spelling of ['$fromAI', '$fromAi', '$fromai']) {
      const read = createToolParameterReader(toolDeps(`={{ ${spelling}('topic') }}`));
      expect(read('value', 0, { topic: 'cats' })).toBe('cats');
    }
  });

  it('uses the default when the arguments lack the key', () => {
    const read = createToolParameterReader(toolDeps("={{ $fromAI('other', 'a text', 'string', 'none') }}"));
    expect(read('value', 0, {})).toBe('none');
  });

  it('treats a model value that looks like an expression as text', () => {
    const read = createToolParameterReader(toolDeps("={{ $fromAI('topic') }}"));
    expect(read('value', 0, { topic: '={{ $env.SECRET }}' })).toBe('={{ $env.SECRET }}');
  });

  it('refuses an unknown parameter as getNodeParameter does', () => {
    const read = createToolParameterReader(toolDeps('plain'));
    expect(() => read('nope.nothing', 0, {})).toThrow('Could not get parameter "nope.nothing"');
  });
});

describe('createExecuteContext', () => {
  it('reads tool parameters with the arguments', () => {
    const ctx = createExecuteContext(toolDeps("={{ $fromAI('topic') }}"), executeCallbacks);
    expect(ctx.getToolParameter('value', 0, { topic: 'cats' })).toBe('cats');
  });

  it('passes a tool suspension and the resume data through the callbacks', () => {
    const suspendForTool = vi.fn();
    const resume = { checkpoint: { step: 1 }, toolCallId: 'c1', answer: null };
    const ctx = createExecuteContext(toolDeps('plain'), {
      ...executeCallbacks,
      suspendForTool,
      getResumeData: () => resume,
    });
    const suspension = new ToolSuspension({
      toolNode: 'Tool',
      waitTill: new Date(0),
      toolName: 'tool',
      toolCallId: 'c1',
    });
    ctx.suspendForTool(suspension, { step: 1 });
    expect(suspendForTool).toHaveBeenCalledWith(suspension, { step: 1 });
    expect(ctx.getResumeData()).toBe(resume);
  });

  it('has no resume data and refuses a suspension without the callbacks', () => {
    const ctx = createExecuteContext(toolDeps('plain'), executeCallbacks);
    expect(ctx.getResumeData()).toBeUndefined();
    const suspension = new ToolSuspension({
      toolNode: 'Tool',
      waitTill: new Date(0),
      toolName: 'tool',
      toolCallId: 'c1',
    });
    expect(() => ctx.suspendForTool(suspension, {})).toThrow('This run cannot wait for a tool');
  });
});
