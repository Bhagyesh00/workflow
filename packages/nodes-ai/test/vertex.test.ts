/**
 * Phase 5 S1 P5-21: Google Vertex AI chat and embeddings, and the Gemini options (thinking budget, safety per
 * category). Replies are fixtures written from the Vertex AI and Gemini API references; they prove the request
 * we send and how we read the documented answer. Every request runs through the real credential types, so the
 * recorded headers are the authenticated ones.
 */

import { generateKeyPairSync } from 'node:crypto';
import { EventEmitter } from 'node:events';
import https from 'node:https';
import { Readable } from 'node:stream';
import { createBaseContext } from '@workflow/core';
import {
  type AiChatMessage,
  type AiChatModel,
  type AiEmbeddings,
  type CredentialTestContext,
  type DataObject,
  ExpressionEvaluator,
  type HttpRequestOptions,
  type LoadOptionsContext,
  Workflow,
  type WorkflowNode,
} from '@workflow/workflow';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { googleVertexAiApi } from '../src/credentials/google-vertex.credentials';
import { readSafetySettings } from '../src/nodes/models/gemini-options';
import { vertexHost, vertexModelBase } from '../src/providers/gemini';
import { FakeHttpClient, type FakeReply, node, services, toolNodeTypes } from './harness';

const SECRET_MARK = 'vertex-secret-do-not-leak';

function serviceAccount(email: string) {
  const { privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
  return {
    email,
    privateKey: privateKey.export({ type: 'pkcs8', format: 'pem' }).toString(),
  };
}

const vertexCreds = (over: DataObject = {}): Record<string, DataObject> => ({
  googleVertexAiApi: {
    projectId: 'cred-project',
    region: 'global',
    scopes: 'https://www.googleapis.com/auth/cloud-platform',
    ...serviceAccount(`vertex-${Math.random().toString(36).slice(2)}@cred-project.iam.gserviceaccount.com`),
    ...over,
  },
});

const saCreds = (over: DataObject = {}): Record<string, DataObject> => ({
  googleApi: {
    region: 'global',
    scopes: 'https://www.googleapis.com/auth/cloud-platform',
    ...serviceAccount(`sa-${Math.random().toString(36).slice(2)}@node-project.iam.gserviceaccount.com`),
    ...over,
  },
});

const TOKEN: FakeReply = {
  body: { access_token: 'ya29.test-token', expires_in: 3599, token_type: 'Bearer' },
};

const GENERATE: FakeReply = {
  body: {
    candidates: [{ finishReason: 'STOP', content: { role: 'model', parts: [{ text: 'It is 42.' }] } }],
    usageMetadata: { promptTokenCount: 12, candidatesTokenCount: 4, thoughtsTokenCount: 2 },
    modelVersion: 'gemini-2.5-flash',
  },
};

/** the token request first, then whatever follows */
const afterToken =
  (...replies: FakeReply[]) =>
  (_request: HttpRequestOptions, index: number): FakeReply =>
    index === 0 ? TOKEN : (replies[index - 1] ?? replies[replies.length - 1]);

const withCreds = (n: WorkflowNode): WorkflowNode => ({
  ...n,
  credentials: {
    googleApi: { id: 'cred-1', name: 'googleApi' },
    googleVertexAiApi: { id: 'cred-2', name: 'googleVertexAiApi' },
    googleGeminiApi: { id: 'cred-3', name: 'googleGeminiApi' },
  },
});

function baseContext(
  type: string,
  http: FakeHttpClient,
  params: DataObject,
  creds: Record<string, DataObject>,
) {
  const n = withCreds(node('Node', type, params));
  const workflow = new Workflow({ name: 'w', nodes: [n], connections: {} }, toolNodeTypes);
  return createBaseContext({
    workflow,
    node: n,
    services: services({ creds, http, nodeTypes: toolNodeTypes }),
    evaluator: new ExpressionEvaluator(),
    signal: new AbortController().signal,
  });
}

async function supply<T>(
  type: string,
  http: FakeHttpClient,
  params: DataObject,
  creds: Record<string, DataObject>,
): Promise<T> {
  const ctx = {
    ...baseContext(type, http, params, creds),
    getInputData: () => [],
    getInputConnectionData: async () => undefined,
    runCode: async () => [],
    executeWorkflow: async () => ({ executionId: '', data: null }),
    getToolParameter: () => undefined,
    logSubNodeRun: () => undefined,
  };
  const { response } = await toolNodeTypes.get(type)!.supplyData!(ctx as never, 0);
  return response as T;
}

const vertexChat = (http: FakeHttpClient, params: DataObject = {}, creds = vertexCreds()) =>
  supply<AiChatModel>(
    'ai.lmChatGoogleVertex',
    http,
    { authentication: 'googleVertexAiApi', options: { maxRetries: 0 }, ...params },
    creds,
  );

const USER: AiChatMessage = { role: 'user', content: 'What is 6 times 7?' };

const authorization = (r: HttpRequestOptions) => r.headers?.authorization as string | undefined;

/** no partner or n8n header may ever leave */
function expectNoPartnerHeaders(requests: HttpRequestOptions[]) {
  for (const r of requests) {
    for (const [name, value] of Object.entries(r.headers ?? {})) {
      expect(`${name} ${String(value)}`).not.toMatch(/openai-platform|n8n/i);
    }
  }
}

function jwtClaims(assertion: string): DataObject {
  return JSON.parse(Buffer.from(assertion.split('.')[1]!, 'base64url').toString('utf8'));
}

describe('Vertex hosts and paths', () => {
  it('builds the host of global, the multi-regions and a region', () => {
    expect(vertexHost('global')).toBe('https://aiplatform.googleapis.com');
    expect(vertexHost('eu')).toBe('https://aiplatform.eu.rep.googleapis.com');
    expect(vertexHost('us')).toBe('https://aiplatform.us.rep.googleapis.com');
    expect(vertexHost('europe-west4')).toBe('https://europe-west4-aiplatform.googleapis.com');
  });

  it('refuses a location that could move the call to another host', () => {
    for (const bad of ['evil.com/x', 'a b', 'us-central1.evil.com', '', '../x', 'US']) {
      expect(() => vertexHost(bad), bad).toThrow('region');
    }
  });

  it('builds the model path with the project and the encoded model', () => {
    expect(vertexModelBase({ project: 'p1', location: 'eu' }, 'models/gemini-2.5-pro')).toBe(
      'https://aiplatform.eu.rep.googleapis.com/v1/projects/p1/locations/eu/publishers/google/models/gemini-2.5-pro',
    );
    expect(() => vertexModelBase({ project: 'p1/../x', location: 'global' }, 'm')).toThrow('project');
  });
});

describe('Vertex chat model', () => {
  it('generates with a token minted from the service account', async () => {
    const creds = vertexCreds();
    const http = new FakeHttpClient(afterToken(GENERATE));
    const model = await vertexChat(http, { modelName: 'gemini-2.5-flash' }, creds);
    const response = await model.chat({ messages: [{ role: 'system', content: 'Be brief.' }, USER] });

    expect(response.message.content).toBe('It is 42.');
    expect(response.usage).toEqual({ inputTokens: 12, outputTokens: 6 });
    const [token, call] = http.requests;
    // the token request: the JWT bearer grant on Google's token host
    expect(token.url).toBe('https://oauth2.googleapis.com/token');
    const assertion = (token.body as DataObject).assertion as string;
    expect((token.body as DataObject).grant_type).toBe('urn:ietf:params:oauth:grant-type:jwt-bearer');
    expect(jwtClaims(assertion)).toMatchObject({
      iss: creds.googleVertexAiApi.email,
      scope: 'https://www.googleapis.com/auth/cloud-platform',
      aud: 'https://oauth2.googleapis.com/token',
    });
    // the model call: the Vertex path, the bearer token, no API key
    expect(call.url).toBe(
      'https://aiplatform.googleapis.com/v1/projects/cred-project/locations/global/publishers/google/models/gemini-2.5-flash:generateContent',
    );
    expect(call.method).toBe('POST');
    expect(authorization(call)).toBe('Bearer ya29.test-token');
    expect(call.headers?.['x-goog-api-key']).toBeUndefined();
    expect(call.body).toMatchObject({
      systemInstruction: { parts: [{ text: 'Be brief.' }] },
      contents: [{ role: 'user', parts: [{ text: 'What is 6 times 7?' }] }],
    });
    expectNoPartnerHeaders(http.requests);
    expect(JSON.stringify(http.requests.map((r) => r.url))).not.toContain(creds.googleVertexAiApi.privateKey);
  });

  it('uses the node project and the multi-region endpoint with a service account', async () => {
    const http = new FakeHttpClient(afterToken(GENERATE));
    const model = await supply<AiChatModel>(
      'ai.lmChatGoogleVertex',
      http,
      {
        authentication: 'googleApi',
        projectId: { __rl: true, mode: 'id', value: 'node-project' },
        modelName: 'gemini-2.5-pro',
        options: { region: 'eu', maxRetries: 0 },
      },
      saCreds(),
    );
    await model.chat({ messages: [USER] });
    expect(http.requests[1].url).toBe(
      'https://aiplatform.eu.rep.googleapis.com/v1/projects/node-project/locations/eu/publishers/google/models/gemini-2.5-pro:generateContent',
    );
    expect(authorization(http.requests[1])).toBe('Bearer ya29.test-token');
  });

  it('takes the region of the credential when the node names none', async () => {
    const http = new FakeHttpClient(afterToken(GENERATE));
    const model = await vertexChat(http, {}, vertexCreds({ region: 'europe-west4' }));
    await model.chat({ messages: [USER] });
    expect(http.requests[1].url).toMatch(
      /^https:\/\/europe-west4-aiplatform\.googleapis\.com\/v1\/projects\/cred-project\/locations\/europe-west4\//,
    );
  });

  it('asks for a project when neither the node nor the credential has one', async () => {
    const http = new FakeHttpClient(afterToken(GENERATE));
    await expect(vertexChat(http, {}, vertexCreds({ projectId: '' }))).rejects.toThrow(
      'Select or enter a Google Cloud project ID.',
    );
    expect(http.requests).toHaveLength(0);
  });

  it('streams with streamGenerateContent and reports deltas', async () => {
    const sse =
      `data: ${JSON.stringify({ candidates: [{ content: { role: 'model', parts: [{ text: 'It is ' }] } }] })}\r\n\r\n` +
      `data: ${JSON.stringify({
        candidates: [{ finishReason: 'STOP', content: { role: 'model', parts: [{ text: '42.' }] } }],
        usageMetadata: { promptTokenCount: 9, candidatesTokenCount: 3 },
      })}\r\n\r\n`;
    const http = new FakeHttpClient(afterToken({ body: sse }));
    const model = await vertexChat(http);
    const deltas: string[] = [];
    const response = await model.stream!({ messages: [USER] }, (d) => deltas.push(d));
    expect(deltas).toEqual(['It is ', '42.']);
    expect(response.message.content).toBe('It is 42.');
    expect(response.stopReason).toBe('end');
    const call = http.requests[1];
    expect(call.url).toBe(
      'https://aiplatform.googleapis.com/v1/projects/cred-project/locations/global/publishers/google/models/gemini-2.5-flash:streamGenerateContent',
    );
    expect(call.qs).toEqual({ alt: 'sse' });
    expect(call.responseType).toBe('stream');
  });

  it('sends the thinking budget and one threshold per category', async () => {
    const http = new FakeHttpClient(afterToken(GENERATE));
    const model = await vertexChat(http, {
      options: {
        maxRetries: 0,
        temperature: 0.2,
        topK: 20,
        thinkingBudget: 1024,
        safetySettings: {
          values: [
            { category: 'HARM_CATEGORY_HARASSMENT', threshold: 'BLOCK_ONLY_HIGH' },
            { category: 'HARM_CATEGORY_DANGEROUS_CONTENT', threshold: 'BLOCK_NONE' },
          ],
        },
      },
    });
    await model.chat({ messages: [USER] });
    const body = http.requests[1].body as DataObject;
    expect(body.generationConfig).toEqual({
      temperature: 0.2,
      topK: 20,
      thinkingConfig: { thinkingBudget: 1024 },
    });
    expect(body.safetySettings).toEqual([
      { category: 'HARM_CATEGORY_HARASSMENT', threshold: 'BLOCK_ONLY_HIGH' },
      { category: 'HARM_CATEGORY_DANGEROUS_CONTENT', threshold: 'BLOCK_NONE' },
    ]);
  });

  it('sends a thinking budget of 0 and leaves the config out when no option is set', async () => {
    const off = new FakeHttpClient(afterToken(GENERATE));
    await (await vertexChat(off, { options: { maxRetries: 0, thinkingBudget: 0 } })).chat({
      messages: [USER],
    });
    expect((off.requests[1].body as DataObject).generationConfig).toEqual({
      thinkingConfig: { thinkingBudget: 0 },
    });

    const none = new FakeHttpClient(afterToken(GENERATE));
    await (await vertexChat(none)).chat({ messages: [USER] });
    const body = none.requests[1].body as DataObject;
    expect(body.generationConfig).toBeUndefined();
    expect(body.safetySettings).toBeUndefined();
  });

  it('maps tools and tool choice on the Vertex path', async () => {
    const http = new FakeHttpClient(
      afterToken({
        body: {
          candidates: [
            {
              finishReason: 'STOP',
              content: {
                role: 'model',
                parts: [{ functionCall: { name: 'Calculator', args: { input: '6*7' } } }],
              },
            },
          ],
        },
      }),
    );
    const model = await vertexChat(http);
    const response = await model.chat({
      messages: [USER],
      toolChoice: 'any',
      tools: [
        {
          name: 'Calculator',
          description: 'Does maths',
          parameters: { type: 'object', properties: { input: { type: 'string' } }, required: ['input'] },
        },
      ],
    });
    expect(response.stopReason).toBe('tool_calls');
    expect(response.message.toolCalls?.[0]).toMatchObject({
      name: 'Calculator',
      arguments: { input: '6*7' },
    });
    const body = http.requests[1].body as DataObject;
    expect(body.toolConfig).toEqual({ functionCallingConfig: { mode: 'ANY' } });
    expect((body.tools as DataObject[])[0].functionDeclarations).toHaveLength(1);
  });

  it('keeps the credential out of the request URL and body', async () => {
    const creds = vertexCreds({ privateKey: undefined });
    creds.googleVertexAiApi.privateKey = serviceAccount('x@y.iam.gserviceaccount.com').privateKey;
    const http = new FakeHttpClient(afterToken(GENERATE));
    await (await vertexChat(http, {}, creds)).chat({ messages: [USER] });
    const call = http.requests[1];
    expect(JSON.stringify([call.url, call.body, call.qs])).not.toContain('PRIVATE KEY');
    expect(JSON.stringify(call.headers)).not.toContain(SECRET_MARK);
  });
});

describe('Vertex AI credential', () => {
  const helpers = {
    http: vi.fn(),
    signAwsV4: vi.fn(),
    clientCredentialsToken: vi.fn(),
    jwtBearerToken: vi.fn(async (_input: DataObject) => ({ token: 't', expiresInSeconds: 3600 })),
    cachedToken: vi.fn(
      async (_secret: string, _scope: string, load: () => Promise<{ token: string }>) =>
        (await load()).token,
    ),
  };
  const sa = serviceAccount('svc@p.iam.gserviceaccount.com');
  const authenticate = (url: string, data: DataObject = {}) =>
    (googleVertexAiApi.authenticate as (...args: unknown[]) => Promise<HttpRequestOptions>)(
      { ...sa, ...data },
      { url, headers: { Authorization: 'old' } },
      helpers,
    );

  it('signs a request to a Google API host only', async () => {
    const request = await authenticate('https://us-central1-aiplatform.googleapis.com/v1/x');
    expect(request.headers).toEqual({ authorization: 'Bearer t' });
    for (const url of [
      'https://evil.example.com/v1/x',
      'https://googleapis.com.evil.example.com/v1/x',
      'http://aiplatform.googleapis.com/v1/x',
      'https://aiplatform.googleapis.com.evil.com/',
    ]) {
      await expect(authenticate(url), url).rejects.toThrow('Google API host over https');
    }
  });

  it('mints with the cloud-platform scope when none is set, and impersonates when asked', async () => {
    helpers.jwtBearerToken.mockClear();
    await authenticate('https://aiplatform.googleapis.com/v1/x', { scopes: '' });
    await authenticate('https://aiplatform.googleapis.com/v1/x', {
      inpersonate: true,
      delegatedEmail: 'boss@example.com',
      scopes: 'https://www.googleapis.com/auth/cloud-platform',
    });
    expect(helpers.jwtBearerToken.mock.calls[0]![0]).toMatchObject({
      scopes: ['https://www.googleapis.com/auth/cloud-platform'],
      tokenUrl: 'https://oauth2.googleapis.com/token',
    });
    expect(helpers.jwtBearerToken.mock.calls[1]![0]).toMatchObject({ subject: 'boss@example.com' });
  });

  it('has no test request: the node tests it', () => {
    expect(googleVertexAiApi.test).toBeUndefined();
    const description = toolNodeTypes.get('ai.lmChatGoogleVertex')!.description;
    const entry = description.credentials!.find((c) => c.name === 'googleVertexAiApi')!;
    expect(toolNodeTypes.get('ai.lmChatGoogleVertex')!.methods!.credentialTest![entry.testedBy!]).toBeTypeOf(
      'function',
    );
  });
});

describe('Vertex AI credential test', () => {
  afterEach(() => vi.restoreAllMocks());

  const test =
    toolNodeTypes.get('ai.lmChatGoogleVertex')!.methods!.credentialTest!.googleVertexAiCredentialTest!;
  const resolveAllowedHost = vi.fn(async (host: string) => ({
    addresses: [{ address: '203.0.113.7', family: 4 }],
    lookup: (_h: string, _o: unknown, cb: (e: null, a: string, f: number) => void) =>
      cb(null, '203.0.113.7', 4),
    host,
  }));
  const ctx = (): CredentialTestContext =>
    ({
      helpers: { resolveAllowedHost, assertHostAllowed: vi.fn() },
      logger: { debug() {}, info() {}, warn() {}, error() {} },
      signal: new AbortController().signal,
      getTenantId: () => 't1',
    }) as never;
  const data = (over: DataObject = {}): DataObject => ({
    projectId: 'my-project-1',
    ...serviceAccount('svc@my-project-1.iam.gserviceaccount.com'),
    ...over,
  });

  interface Seen {
    url: string;
    method?: string;
    headers: Record<string, string>;
    body: string;
  }

  /** answers the https calls of the test in order, recording what was sent */
  function fakeHttps(replies: Array<{ status: number; body: unknown }>) {
    const seen: Seen[] = [];
    vi.spyOn(https, 'request').mockImplementation(((
      url: string,
      options: DataObject,
      callback: (response: Readable) => void,
    ) => {
      const request = new EventEmitter() as EventEmitter & { end(body?: string): void; destroy(): void };
      const entry: Seen = {
        url,
        method: options.method as string,
        headers: options.headers as never,
        body: '',
      };
      seen.push(entry);
      request.destroy = () => undefined;
      request.end = (body?: string) => {
        entry.body = body ?? '';
        const reply = replies[seen.length - 1]!;
        const response = Readable.from([Buffer.from(JSON.stringify(reply.body))]) as Readable & {
          statusCode?: number;
        };
        response.statusCode = reply.status;
        callback(response);
      };
      return request;
    }) as never);
    return seen;
  }

  it('mints a token, lists the locations and reports OK', async () => {
    const seen = fakeHttps([
      { status: 200, body: { access_token: 'ya29.tok', expires_in: 3599 } },
      { status: 200, body: { locations: [{ locationId: 'us-central1' }] } },
    ]);
    const result = await test(ctx(), { type: 'googleVertexAiApi', data: data() });
    expect(result.status).toBe('OK');
    expect(seen[0].url).toBe('https://oauth2.googleapis.com/token');
    expect(seen[0].method).toBe('POST');
    const form = new URLSearchParams(seen[0].body);
    expect(form.get('grant_type')).toBe('urn:ietf:params:oauth:grant-type:jwt-bearer');
    expect(jwtClaims(form.get('assertion')!).aud).toBe('https://oauth2.googleapis.com/token');
    expect(seen[1].url).toBe(
      'https://aiplatform.googleapis.com/v1/projects/my-project-1/locations?pageSize=1',
    );
    expect(seen[1].method).toBe('GET');
    expect(seen[1].headers.authorization).toBe('Bearer ya29.tok');
    // both hosts went through the guard before any socket
    expect(resolveAllowedHost.mock.calls.map((c) => c[0])).toEqual([
      'oauth2.googleapis.com',
      'aiplatform.googleapis.com',
    ]);
  });

  it('asks for a project before it connects anywhere', async () => {
    const seen = fakeHttps([]);
    const result = await test(ctx(), { type: 'googleVertexAiApi', data: data({ projectId: ' ' }) });
    expect(result).toEqual({ status: 'Error', message: 'Select or enter a Google Cloud project ID.' });
    expect(seen).toHaveLength(0);
  });

  it('reports one plain message when the token or the locations call fails, with no detail', async () => {
    fakeHttps([{ status: 400, body: { error: 'invalid_grant', error_description: SECRET_MARK } }]);
    const denied = await test(ctx(), { type: 'googleVertexAiApi', data: data() });
    vi.restoreAllMocks();
    fakeHttps([
      { status: 200, body: { access_token: 'tok' } },
      { status: 403, body: { error: { message: SECRET_MARK } } },
    ]);
    const forbidden = await test(ctx(), { type: 'googleVertexAiApi', data: data() });
    for (const result of [denied, forbidden]) {
      expect(result.status).toBe('Error');
      expect(result.message).toBe(
        'Could not connect to Vertex AI. Check the service account details, project ID, and Vertex AI permissions.',
      );
    }
  });

  it('does not connect when the guard refuses the host, and does not quote the key', async () => {
    resolveAllowedHost.mockRejectedValueOnce(new Error('blocked address'));
    const seen = fakeHttps([]);
    const d = data();
    const result = await test(ctx(), { type: 'googleVertexAiApi', data: d });
    expect(seen).toHaveLength(0);
    expect(result.status).toBe('Error');
    expect(result.message).not.toContain('PRIVATE KEY');
    // a key that is not a key
    const bad = await test(ctx(), { type: 'googleVertexAiApi', data: data({ privateKey: 'not a key' }) });
    expect(bad.status).toBe('Error');
    expect(bad.message).not.toContain('not a key');
  });
});

describe('Vertex project list', () => {
  const loadContext = (http: FakeHttpClient, params: DataObject, creds: Record<string, DataObject>) => {
    const { getNodeParameter: _omit, ...rest } = baseContext('ai.lmChatGoogleVertex', http, params, creds);
    return { ...rest, getCurrentNodeParameter: (name: string) => params[name] } as LoadOptionsContext;
  };
  const search = toolNodeTypes.get('ai.lmChatGoogleVertex')!.methods!.listSearch!.searchProjects!;

  it('searches the Cloud Resource Manager with the chosen credential and pages', async () => {
    const http = new FakeHttpClient(
      afterToken({
        body: {
          projects: [
            { projectId: 'alpha-1', displayName: 'Alpha', state: 'ACTIVE' },
            { projectId: 'beta-2', displayName: 'beta-2', state: 'ACTIVE' },
            { projectId: 'gone-3', displayName: 'Gone', state: 'DELETE_REQUESTED' },
          ],
          nextPageToken: 'next-1',
        },
      }),
    );
    const result = await search(
      loadContext(http, { authentication: 'googleApi' }, saCreds()),
      'alp"ha: x',
      'page-0',
    );
    expect(result).toEqual({
      results: [
        { name: 'Alpha (alpha-1)', value: 'alpha-1' },
        { name: 'beta-2', value: 'beta-2' },
      ],
      paginationToken: 'next-1',
    });
    const call = http.requests[1];
    expect(call.url).toBe('https://cloudresourcemanager.googleapis.com/v3/projects:search');
    expect(call.qs).toEqual({ pageSize: 50, query: 'alp ha  x', pageToken: 'page-0' });
    expect(authorization(call)).toBe('Bearer ya29.test-token');
  });
});

describe('Vertex embeddings', () => {
  const embedder = (http: FakeHttpClient, params: DataObject = {}, creds = vertexCreds()) =>
    supply<AiEmbeddings>(
      'ai.embeddingsGoogleVertex',
      http,
      { authentication: 'googleVertexAiApi', ...params },
      creds,
    );
  const predictions = (...vectors: number[][]): FakeReply => ({
    body: {
      predictions: vectors.map((values) => ({ embeddings: { values, statistics: { token_count: 3 } } })),
    },
  });

  it('calls :predict on text-embedding-005 with a task type per purpose', async () => {
    const http = new FakeHttpClient(afterToken(predictions([0.1, 0.2], [0.3, 0.4]), predictions([0.5, 0.6])));
    const embeddings = await embedder(http);
    const docs = await embeddings.embedDocuments(['one', 'two']);
    const query = await embeddings.embedQuery('three');
    expect(docs).toEqual([
      [0.1, 0.2],
      [0.3, 0.4],
    ]);
    expect(query).toEqual([0.5, 0.6]);
    const [, first, second] = http.requests;
    expect(first.url).toBe(
      'https://aiplatform.googleapis.com/v1/projects/cred-project/locations/global/publishers/google/models/text-embedding-005:predict',
    );
    expect(first.method).toBe('POST');
    expect(authorization(first)).toBe('Bearer ya29.test-token');
    expect(first.body).toEqual({
      instances: [
        { content: 'one', task_type: 'RETRIEVAL_DOCUMENT' },
        { content: 'two', task_type: 'RETRIEVAL_DOCUMENT' },
      ],
    });
    expect(second.body).toEqual({ instances: [{ content: 'three', task_type: 'RETRIEVAL_QUERY' }] });
    // one token for the three calls
    expect(http.requests.filter((r) => r.url.includes('oauth2'))).toHaveLength(1);
    expectNoPartnerHeaders(http.requests);
  });

  it('sends dimensions, a named model, the node region and batches the texts', async () => {
    const http = new FakeHttpClient(afterToken(predictions([1], [2]), predictions([3])));
    const embeddings = await embedder(
      http,
      {
        authentication: 'googleApi',
        projectId: { __rl: true, mode: 'id', value: 'node-project' },
        model: 'text-multilingual-embedding-002',
        options: { region: 'us', dimensions: 256, batchSize: 2, maxRetries: 0 },
      },
      saCreds(),
    );
    expect(await embeddings.embedDocuments(['a', 'b', 'c'])).toEqual([[1], [2], [3]]);
    const calls = http.requests.filter((r) => r.url.includes(':predict'));
    expect(calls).toHaveLength(2);
    expect(calls[0].url).toBe(
      'https://aiplatform.us.rep.googleapis.com/v1/projects/node-project/locations/us/publishers/google/models/text-multilingual-embedding-002:predict',
    );
    expect((calls[0].body as DataObject).parameters).toEqual({ outputDimensionality: 256 });
    expect(((calls[0].body as DataObject).instances as unknown[]).length).toBe(2);
  });

  it('fails clearly when the answer has fewer vectors than texts', async () => {
    const http = new FakeHttpClient(afterToken(predictions([1])));
    const embeddings = await embedder(http, { options: { maxRetries: 0 } });
    await expect(embeddings.embedDocuments(['a', 'b'])).rejects.toThrow();
  });
});

describe('Gemini options on the Gemini node', () => {
  const GEMINI_CREDS = {
    googleGeminiApi: { apiKey: 'gem-test-key', host: 'https://generativelanguage.googleapis.com' },
  };
  const geminiChat = (http: FakeHttpClient, options: DataObject) =>
    supply<AiChatModel>(
      'ai.lmChatGoogleGemini',
      http,
      { options: { maxRetries: 0, ...options } },
      GEMINI_CREDS,
    );

  it('sends thinkingConfig and one threshold per category', async () => {
    const http = new FakeHttpClient(() => GENERATE);
    await (
      await geminiChat(http, {
        thinkingBudget: -1,
        safetySettings: {
          values: [{ category: 'HARM_CATEGORY_HATE_SPEECH', threshold: 'BLOCK_LOW_AND_ABOVE' }],
        },
      })
    ).chat({ messages: [USER] });
    const call = http.requests[0];
    expect(call.url).toBe(
      'https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent',
    );
    expect(call.headers?.['x-goog-api-key']).toBe('gem-test-key');
    expect((call.body as DataObject).generationConfig).toEqual({ thinkingConfig: { thinkingBudget: -1 } });
    expect((call.body as DataObject).safetySettings).toEqual([
      { category: 'HARM_CATEGORY_HATE_SPEECH', threshold: 'BLOCK_LOW_AND_ABOVE' },
    ]);
  });

  it('keeps the one-threshold option and lets a category rule override it', async () => {
    const http = new FakeHttpClient(() => GENERATE);
    await (
      await geminiChat(http, {
        safetyThreshold: 'BLOCK_MEDIUM_AND_ABOVE',
        safetySettings: { values: [{ category: 'HARM_CATEGORY_HARASSMENT', threshold: 'BLOCK_NONE' }] },
      })
    ).chat({ messages: [USER] });
    expect((http.requests[0].body as DataObject).safetySettings).toEqual([
      { category: 'HARM_CATEGORY_HARASSMENT', threshold: 'BLOCK_NONE' },
      { category: 'HARM_CATEGORY_HATE_SPEECH', threshold: 'BLOCK_MEDIUM_AND_ABOVE' },
      { category: 'HARM_CATEGORY_SEXUALLY_EXPLICIT', threshold: 'BLOCK_MEDIUM_AND_ABOVE' },
      { category: 'HARM_CATEGORY_DANGEROUS_CONTENT', threshold: 'BLOCK_MEDIUM_AND_ABOVE' },
    ]);
  });

  it('refuses a category or threshold outside the lists', () => {
    expect(() =>
      readSafetySettings({
        safetySettings: { values: [{ category: 'HARM_CATEGORY_X', threshold: 'BLOCK_NONE' }] },
      }),
    ).toThrow('does not know');
    expect(() =>
      readSafetySettings({
        safetySettings: { values: [{ category: 'HARM_CATEGORY_HARASSMENT', threshold: 'ALLOW_ALL' }] },
      }),
    ).toThrow('does not know');
    expect(readSafetySettings({})).toBeUndefined();
  });

  it('sends no thinking or safety fields when the options are not set', async () => {
    const http = new FakeHttpClient(() => GENERATE);
    await (await geminiChat(http, {})).chat({ messages: [USER] });
    const body = http.requests[0].body as DataObject;
    expect(body.safetySettings).toBeUndefined();
    expect(body.generationConfig).toBeUndefined();
  });
});
