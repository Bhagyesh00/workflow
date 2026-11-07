/**
 * Phase 5 S1 P5-05: AWS Bedrock chat model and embeddings. Replies are fixtures written from the Bedrock
 * API reference; they prove the request we send and how we read the documented answer. Every request runs
 * through the real `aws` and `awsAssumeRole` credentials, so the recorded headers are the signed ones.
 */
import { crc32 } from 'node:zlib';
import { createBaseContext, type ExecutionServices, signAwsRequest } from '@workflow/core';
import {
  type AiChatMessage,
  type AiChatModel,
  type AiEmbeddings,
  type DataObject,
  ExpressionEvaluator,
  type HttpRequestOptions,
  type LoadOptionsContext,
  Workflow,
  type WorkflowNode,
} from '@workflow/workflow';
import { describe, expect, it, vi } from 'vitest';
import { bedrockAdapter } from '../src/providers/bedrock';
import { arnRegion, awsDomain, bedrockRuntimeBase } from '../src/shared/aws';
import { createEventStreamDecoder } from '../src/shared/event-stream';
import { markToolError } from '../src/shared/markers';
import {
  connect,
  FakeHttpClient,
  type FakeReply,
  node,
  run,
  sequence,
  services,
  toolNodeTypes,
} from './harness';

const KEY_ID = 'AKIDTESTKEY000000000';
const SECRET = 'test-secret-do-not-leak';
const AWS: DataObject = { region: 'us-east-1', accessKeyId: KEY_ID, secretAccessKey: SECRET };
const CREDS: Record<string, DataObject> = { aws: AWS };
const MODEL = 'anthropic.claude-3-5-sonnet-20240620-v1:0';
const RUNTIME = 'https://bedrock-runtime.us-east-1.amazonaws.com';
const ENCODED = 'anthropic.claude-3-5-sonnet-20240620-v1%3A0';

const withCreds = (n: WorkflowNode): WorkflowNode => ({
  ...n,
  credentials: {
    aws: { id: 'cred-1', name: 'aws' },
    awsAssumeRole: { id: 'cred-2', name: 'awsAssumeRole' },
  },
});

const header = (request: HttpRequestOptions, name: string) => request.headers?.[name] as string | undefined;
const jsonBody = (request: HttpRequestOptions) => JSON.parse(request.body as string);

const answer = (text: string, stopReason = 'end_turn'): FakeReply => ({
  body: {
    output: { message: { role: 'assistant', content: [{ text }] } },
    stopReason,
    usage: { inputTokens: 12, outputTokens: 4, totalTokens: 16 },
    metrics: { latencyMs: 100 },
  },
});

async function runAgent(
  http: FakeHttpClient,
  params: DataObject,
  opts: { stream?: boolean; tools?: boolean; creds?: Record<string, DataObject> } = {},
) {
  return run(
    [
      node('Trigger', 'test.trigger'),
      node('Agent', 'ai.agent', {
        promptType: 'define',
        text: 'What is 6 times 7?',
        systemMessage: 'You are a calculator assistant.',
        options: { enableStreaming: opts.stream ?? false },
      }),
      withCreds(node('Bedrock', 'ai.lmChatAwsBedrock', { model: MODEL, ...params })),
      ...(opts.tools ? [node('Calculator', 'ai.toolCalculator')] : []),
    ],
    connect(
      ['Trigger', 'Agent'],
      ['Bedrock', 'Agent', 'ai_languageModel'],
      ...(opts.tools ? [['Calculator', 'Agent', 'ai_tool'] as [string, string, 'ai_tool']] : []),
    ),
    {
      nodeTypes: toolNodeTypes,
      services: services({ creds: opts.creds ?? CREDS, http, nodeTypes: toolNodeTypes }),
    },
  );
}

function baseContext(type: string, svc: ExecutionServices, params: DataObject) {
  const n = withCreds(node('Node', type, params));
  const workflow = new Workflow({ name: 'w', nodes: [n], connections: {} }, toolNodeTypes);
  return createBaseContext({
    workflow,
    node: n,
    services: svc,
    evaluator: new ExpressionEvaluator(),
    signal: new AbortController().signal,
  });
}

async function supply<T>(
  type: string,
  http: FakeHttpClient,
  params: DataObject,
  creds: Record<string, DataObject> = CREDS,
  logSubNodeRun: (...args: unknown[]) => void = () => undefined,
): Promise<T> {
  const svc = services({ creds, http, nodeTypes: toolNodeTypes });
  const base = baseContext(type, svc, params);
  const ctx = {
    ...base,
    getInputData: () => [],
    getInputConnectionData: async () => undefined,
    runCode: async () => [],
    executeWorkflow: async () => ({ executionId: '', data: null }),
    getToolParameter: () => undefined,
    logSubNodeRun,
  };
  const { response } = await toolNodeTypes.get(type)!.supplyData!(ctx as never, 0);
  return response as T;
}

const chatModel = (http: FakeHttpClient, params: DataObject = {}, creds = CREDS) =>
  supply<AiChatModel>('ai.lmChatAwsBedrock', http, { model: MODEL, maxRetries: 0, ...params }, creds);

const embedder = (
  http: FakeHttpClient,
  params: DataObject = {},
  creds = CREDS,
  log?: (...args: unknown[]) => void,
) => supply<AiEmbeddings>('ai.embeddingsAwsBedrock', http, params, creds, log);

function loadOptionsContext(type: string, http: FakeHttpClient, params: DataObject, creds = CREDS) {
  const { getNodeParameter: _omit, ...rest } = baseContext(
    type,
    services({ creds, http, nodeTypes: toolNodeTypes }),
    params,
  );
  const ctx: LoadOptionsContext = { ...rest, getCurrentNodeParameter: (name) => params[name] };
  return ctx;
}

const USER: AiChatMessage = { role: 'user', content: 'hi' };

// ---------------------------------------------------------------------------------------------
// A test encoder for the event-stream framing, written from the AWS documentation.
// ---------------------------------------------------------------------------------------------

function u32(value: number): Uint8Array {
  const out = new Uint8Array(4);
  new DataView(out.buffer).setUint32(0, value);
  return out;
}

function concat(...parts: Uint8Array[]): Uint8Array {
  const out = new Uint8Array(parts.reduce((sum, p) => sum + p.length, 0));
  let at = 0;
  for (const part of parts) {
    out.set(part, at);
    at += part.length;
  }
  return out;
}

function stringHeader(name: string, value: string): Uint8Array {
  const n = new TextEncoder().encode(name);
  const v = new TextEncoder().encode(value);
  return concat(new Uint8Array([n.length]), n, new Uint8Array([7, v.length >> 8, v.length & 255]), v);
}

function encodeFrame(headers: Uint8Array, payload: Uint8Array): Uint8Array {
  const total = 16 + headers.length + payload.length;
  const lengths = concat(u32(total), u32(headers.length));
  const prelude = concat(lengths, u32(crc32(lengths)));
  const body = concat(prelude, headers, payload);
  return concat(body, u32(crc32(body)));
}

const eventFrame = (eventType: string, payload: unknown): Uint8Array =>
  encodeFrame(
    concat(
      stringHeader(':message-type', 'event'),
      stringHeader(':event-type', eventType),
      stringHeader(':content-type', 'application/json'),
    ),
    new TextEncoder().encode(JSON.stringify(payload)),
  );

const exceptionFrame = (type: string, message: string): Uint8Array =>
  encodeFrame(
    concat(stringHeader(':message-type', 'exception'), stringHeader(':exception-type', type)),
    new TextEncoder().encode(JSON.stringify({ message })),
  );

/** the frames as one byte string cut in pieces of `size` bytes, so frames straddle chunks */
function chunked(frames: Uint8Array[], size: number): AsyncIterable<Uint8Array> {
  const all = concat(...frames);
  return {
    async *[Symbol.asyncIterator]() {
      for (let at = 0; at < all.length; at += size) yield all.slice(at, at + size);
    },
  };
}

const TEXT_STREAM = [
  eventFrame('messageStart', { role: 'assistant', p: 'abc' }),
  eventFrame('contentBlockDelta', { contentBlockIndex: 0, delta: { text: 'The answer ' }, p: 'abcd' }),
  eventFrame('contentBlockDelta', { contentBlockIndex: 0, delta: { text: 'is 42' } }),
  eventFrame('contentBlockStop', { contentBlockIndex: 0 }),
  eventFrame('messageStop', { stopReason: 'end_turn' }),
  eventFrame('metadata', { usage: { inputTokens: 7, outputTokens: 3, totalTokens: 10 }, metrics: {} }),
];

const TOOL_STREAM = [
  eventFrame('messageStart', { role: 'assistant' }),
  eventFrame('contentBlockDelta', { contentBlockIndex: 0, delta: { text: 'Let me check. ' } }),
  eventFrame('contentBlockStop', { contentBlockIndex: 0 }),
  eventFrame('contentBlockStart', {
    contentBlockIndex: 1,
    start: { toolUse: { toolUseId: 'tooluse_9', name: 'Calculator' } },
  }),
  eventFrame('contentBlockDelta', { contentBlockIndex: 1, delta: { toolUse: { input: '{"input":' } } }),
  eventFrame('contentBlockDelta', { contentBlockIndex: 1, delta: { toolUse: { input: '"6*7"}' } } }),
  eventFrame('contentBlockStop', { contentBlockIndex: 1 }),
  eventFrame('messageStop', { stopReason: 'tool_use' }),
  eventFrame('metadata', { usage: { inputTokens: 20, outputTokens: 9 } }),
];

// ---------------------------------------------------------------------------------------------

describe('Bedrock Converse', () => {
  it('sends a recorded chat with a string body and only the options the user set', async () => {
    const http = new FakeHttpClient(sequence(answer('42')));
    const r = await runAgent(http, {});
    expect(r.status).toBe('success');
    expect(r.output('Agent')).toEqual([{ output: '42' }]);
    const [request] = http.requests;
    expect(request.url).toBe(`${RUNTIME}/model/${ENCODED}/converse`);
    expect(request.method).toBe('POST');
    expect(typeof request.body).toBe('string');
    expect(request.bodyType).toBe('raw');
    expect(jsonBody(request)).toEqual({
      system: [{ text: 'You are a calculator assistant.' }],
      messages: [{ role: 'user', content: [{ text: 'What is 6 times 7?' }] }],
    });
  });

  it('signs with the documented Authorization shape, over the body that goes out', async () => {
    const http = new FakeHttpClient(sequence(answer('42')));
    await runAgent(http, {});
    const [request] = http.requests;
    const authorization = String(header(request, 'authorization'));
    expect(authorization).toMatch(
      new RegExp(
        `^AWS4-HMAC-SHA256 Credential=${KEY_ID}/\\d{8}/us-east-1/bedrock/aws4_request, SignedHeaders=[a-z0-9;-]*host[a-z0-9;-]*, Signature=[0-9a-f]{64}$`,
      ),
    );
    expect(header(request, 'x-amz-security-token')).toBeUndefined();
    // the path holds the id encoded once; the signature's own second encoding is not in the URL
    expect(new URL(request.url).pathname).toBe(`/model/${ENCODED}/converse`);
    const stamp = String(header(request, 'x-amz-date'));
    const date = new Date(
      stamp.replace(/^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})Z$/, '$1-$2-$3T$4:$5:$6Z'),
    );
    const {
      authorization: _a,
      'x-amz-date': _d,
      ...signedHeaders
    } = request.headers as Record<string, string>;
    const again = signAwsRequest({
      method: 'POST',
      url: request.url,
      headers: signedHeaders,
      body: request.body as string,
      region: 'us-east-1',
      service: 'bedrock',
      accessKeyId: KEY_ID,
      secretAccessKey: SECRET,
      date,
    });
    expect(again.headers.authorization).toBe(authorization);
    const everything = JSON.stringify(http.requests).toLowerCase();
    expect(everything).not.toContain('openai-platform');
    expect(everything).not.toContain('n8n');
    expect(JSON.stringify(http.requests)).not.toContain(SECRET);
  });

  it('maps inference, additional fields, latency and guardrail options', async () => {
    const http = new FakeHttpClient(sequence(answer('ok')));
    await runAgent(http, {
      options: {
        maxTokens: 300,
        temperature: 0.2,
        topP: 0.9,
        additionalModelRequestFields: '{"top_k": 5}',
        latency: 'optimized',
        guardrailIdentifier: 'gr-123',
        guardrailVersion: '7',
        guardrailTrace: 'enabled_full',
      },
    });
    expect(jsonBody(http.requests[0])).toMatchObject({
      inferenceConfig: { maxTokens: 300, temperature: 0.2, topP: 0.9 },
      additionalModelRequestFields: { top_k: 5 },
      performanceConfig: { latency: 'optimized' },
      guardrailConfig: { guardrailIdentifier: 'gr-123', guardrailVersion: '7', trace: 'enabled_full' },
    });
  });

  it('defaults a guardrail to the DRAFT version and sends none without an identifier', async () => {
    const http = new FakeHttpClient(sequence(answer('a'), answer('b')));
    await runAgent(http, { options: { guardrailIdentifier: 'gr-1' } });
    await runAgent(http, { options: { guardrailVersion: '3' } });
    expect(jsonBody(http.requests[0]).guardrailConfig).toEqual({
      guardrailIdentifier: 'gr-1',
      guardrailVersion: 'DRAFT',
    });
    expect(jsonBody(http.requests[1]).guardrailConfig).toBeUndefined();
  });

  it('refuses additional model request fields that are not JSON', async () => {
    const http = new FakeHttpClient(sequence());
    const r = await runAgent(http, { options: { additionalModelRequestFields: '{nope' } });
    expect(r.status).toBe('error');
    expect(r.error?.message).toContain('Additional Model Request Fields must be valid JSON');
    const list = await runAgent(http, { options: { additionalModelRequestFields: '[1]' } });
    expect(list.error?.message).toContain('Additional Model Request Fields must be valid JSON');
    expect(http.requests).toHaveLength(0);
  });

  it('runs a tool call and sends the result back as a toolResult in a user turn', async () => {
    const http = new FakeHttpClient(
      sequence(
        {
          body: {
            output: {
              message: {
                role: 'assistant',
                content: [
                  { text: 'Let me check.' },
                  { toolUse: { toolUseId: 'tooluse_1', name: 'Calculator', input: { input: '6*7' } } },
                ],
              },
            },
            stopReason: 'tool_use',
            usage: { inputTokens: 5, outputTokens: 2 },
          },
        },
        answer('42'),
      ),
    );
    const r = await runAgent(http, {}, { tools: true });
    expect(r.status).toBe('success');
    expect(r.output('Agent')).toEqual([{ output: '42' }]);
    const first = jsonBody(http.requests[0]);
    expect(first.toolConfig.tools[0].toolSpec).toMatchObject({
      name: 'Calculator',
      inputSchema: { json: { type: 'object' } },
    });
    expect(first.toolConfig.toolChoice).toBeUndefined();
    const second = jsonBody(http.requests[1]);
    expect(second.messages.slice(1)).toEqual([
      {
        role: 'assistant',
        content: [
          { text: 'Let me check.' },
          { toolUse: { toolUseId: 'tooluse_1', name: 'Calculator', input: { input: '6*7' } } },
        ],
      },
      {
        role: 'user',
        content: [{ toolResult: { toolUseId: 'tooluse_1', content: [{ text: '42' }] } }],
      },
    ]);
  });

  it('puts every result of a turn in one user message and marks a failed tool', () => {
    const adapter = bedrockAdapter({ region: 'us-east-1', model: MODEL });
    const failed: AiChatMessage = { role: 'tool', toolCallId: 'b', content: 'boom' };
    markToolError(failed);
    const body = JSON.parse(
      adapter.buildRequest(
        {
          messages: [
            USER,
            {
              role: 'assistant',
              content: '',
              toolCalls: [
                { id: 'a', name: 't', arguments: {} },
                { id: 'b', name: 't', arguments: {} },
              ],
            },
            { role: 'tool', toolCallId: 'a', content: '' },
            failed,
            { role: 'user', content: [{ type: 'text', text: 'and then?' }] },
          ],
        },
        false,
      ).body as string,
    );
    expect(body.messages).toEqual([
      { role: 'user', content: [{ text: 'hi' }] },
      {
        role: 'assistant',
        content: [
          { toolUse: { toolUseId: 'a', name: 't', input: {} } },
          { toolUse: { toolUseId: 'b', name: 't', input: {} } },
        ],
      },
      {
        role: 'user',
        content: [
          { toolResult: { toolUseId: 'a', content: [{ text: '(empty result)' }] } },
          { toolResult: { toolUseId: 'b', content: [{ text: 'boom' }], status: 'error' } },
          { text: 'and then?' },
        ],
      },
    ]);
  });

  it('sends toolChoice.any only with tools, and no structured output', () => {
    const adapter = bedrockAdapter({ region: 'us-east-1', model: MODEL });
    const tools = [
      { name: 't', description: 'A tool', parameters: { properties: { a: { type: 'string' } } } },
    ];
    const forced = JSON.parse(
      adapter.buildRequest({ messages: [USER], tools, toolChoice: 'any' }, false).body as string,
    );
    expect(forced.toolConfig).toEqual({
      tools: [
        {
          toolSpec: {
            name: 't',
            description: 'A tool',
            inputSchema: { json: { type: 'object', properties: { a: { type: 'string' } } } },
          },
        },
      ],
      toolChoice: { any: {} },
    });
    const none = JSON.parse(
      adapter.buildRequest({ messages: [USER], toolChoice: 'any' }, false).body as string,
    );
    expect(none.toolConfig).toBeUndefined();
    expect(adapter.capabilities).toEqual({ structuredOutput: false, structuredOutputWithTools: false });
    const json = JSON.parse(
      adapter.buildRequest({ messages: [USER], responseFormat: { type: 'json' } }, false).body as string,
    );
    expect(Object.keys(json)).toEqual(['messages']);
  });

  it('maps images and documents, and refuses a type Bedrock cannot read', () => {
    const adapter = bedrockAdapter({ region: 'us-east-1', model: MODEL });
    const body = JSON.parse(
      adapter.buildRequest(
        {
          messages: [
            {
              role: 'user',
              content: [
                { type: 'text', text: 'Look' },
                { type: 'image', data: 'AAAA', mimeType: 'image/png' },
                {
                  type: 'file',
                  data: 'BBBB',
                  mimeType: 'application/pdf',
                  fileName: 'Q3_report (final).v2.pdf',
                },
                { type: 'file', data: 'CCCC', mimeType: 'text/plain; charset=utf-8' },
              ],
            },
          ],
        },
        false,
      ).body as string,
    );
    expect(body.messages[0].content).toEqual([
      { text: 'Look' },
      { image: { format: 'png', source: { bytes: 'AAAA' } } },
      { document: { format: 'pdf', name: 'Q3 report (final) v2', source: { bytes: 'BBBB' } } },
      { document: { format: 'txt', name: 'document', source: { bytes: 'CCCC' } } },
    ]);
    const bad = (part: AiChatMessage['content']) => () =>
      adapter.buildRequest({ messages: [{ role: 'user', content: part }] }, false);
    expect(bad([{ type: 'image', data: 'A', mimeType: 'image/tiff' }])).toThrow(/image/i);
    expect(bad([{ type: 'file', data: 'A', mimeType: 'application/zip' }])).toThrow(/file/i);
  });

  it('reads the stop reasons', () => {
    const adapter = bedrockAdapter({ region: 'us-east-1', model: MODEL });
    const stop = (stopReason: string) =>
      adapter.parseResponse({
        output: { message: { role: 'assistant', content: [{ text: 'x' }] } },
        stopReason,
      }).stopReason;
    expect(stop('end_turn')).toBe('end');
    expect(stop('stop_sequence')).toBe('end');
    expect(stop('tool_use')).toBe('tool_calls');
    expect(stop('max_tokens')).toBe('max_tokens');
    expect(stop('guardrail_intervened')).toBe('other');
    expect(stop('content_filtered')).toBe('other');
    expect(adapter.parseResponse(answer('x').body).usage).toEqual({ inputTokens: 12, outputTokens: 4 });
  });

  it('returns the text a guardrail answered with, and refuses a blocked empty answer', async () => {
    const http = new FakeHttpClient(
      sequence(answer('Sorry, that topic is blocked.', 'guardrail_intervened')),
    );
    const model = await chatModel(http, { options: { guardrailIdentifier: 'gr-1' } });
    const response = await model.chat({ messages: [USER] });
    expect(response.message.content).toBe('Sorry, that topic is blocked.');
    expect(response.stopReason).toBe('other');

    const empty = new FakeHttpClient(sequence(answer('', 'content_filtered')));
    const blocked = await chatModel(empty);
    await expect(blocked.chat({ messages: [USER] })).rejects.toMatchObject({ code: 'AI_REFUSAL' });
  });

  it('reports an answer with no message', () => {
    const adapter = bedrockAdapter({ region: 'us-east-1', model: MODEL });
    expect(() => adapter.parseResponse({ message: 'Too many tokens' })).toThrow('Too many tokens');
    expect(() => adapter.parseResponse({})).toThrow(/no message/);
  });

  it('replays reasoning blocks of an assistant turn unchanged in the tool loop', () => {
    const adapter = bedrockAdapter({ region: 'us-east-1', model: MODEL });
    const reasoning = { reasoningContent: { reasoningText: { text: 'Think', signature: 'sig' } } };
    const toolUse = { toolUse: { toolUseId: 'r1', name: 't', input: { a: 1 } } };
    const response = adapter.parseResponse({
      output: { message: { role: 'assistant', content: [reasoning, toolUse] } },
      stopReason: 'tool_use',
    });
    expect(response.message.content).toBe('');
    expect(response.message.toolCalls).toEqual([{ id: 'r1', name: 't', arguments: { a: 1 } }]);
    const body = JSON.parse(
      adapter.buildRequest(
        {
          messages: [USER, response.message, { role: 'tool', toolCallId: 'r1', content: 'ok' }],
        },
        false,
      ).body as string,
    );
    expect(body.messages[1].content).toEqual([reasoning, toolUse]);
  });
});

describe('Bedrock hosts and model ids', () => {
  it('encodes a model id or ARN once and takes the region of an ARN', async () => {
    const arn = 'arn:aws:bedrock:eu-west-1:123456789012:inference-profile/eu.anthropic.claude-3-haiku:0';
    const http = new FakeHttpClient(sequence(answer('ok')));
    await runAgent(http, { model: arn });
    const { url } = http.requests[0];
    expect(url).toBe(
      'https://bedrock-runtime.eu-west-1.amazonaws.com/model/arn%3Aaws%3Abedrock%3Aeu-west-1%3A123456789012%3Ainference-profile%2Feu.anthropic.claude-3-haiku%3A0/converse',
    );
    expect(String(header(http.requests[0], 'authorization'))).toContain('/eu-west-1/bedrock/aws4_request');
  });

  it('builds the China and GovCloud hosts', () => {
    expect(awsDomain('cn-north-1')).toBe('amazonaws.com.cn');
    expect(awsDomain('us-gov-west-1')).toBe('amazonaws.com');
    expect(bedrockRuntimeBase({ region: 'cn-northwest-1', model: 'm' })).toBe(
      'https://bedrock-runtime.cn-northwest-1.amazonaws.com.cn',
    );
    expect(bedrockRuntimeBase({ region: 'us-gov-east-1', model: 'm' })).toBe(
      'https://bedrock-runtime.us-gov-east-1.amazonaws.com',
    );
    expect(arnRegion('arn:aws-cn:bedrock:cn-north-1:1:foundation-model/x')).toBe('cn-north-1');
    expect(arnRegion('arn:aws-us-gov:bedrock:us-gov-west-1:1:foundation-model/x')).toBe('us-gov-west-1');
    expect(arnRegion(MODEL)).toBeUndefined();
  });

  it('never builds a host from an ARN or region that is not a region name', () => {
    expect(arnRegion('arn:aws:bedrock:evil.test#:1:x')).toBeUndefined();
    expect(bedrockRuntimeBase({ region: 'us-east-1', model: 'arn:aws:bedrock:evil.test#:1:x' })).toBe(
      RUNTIME,
    );
    expect(() => bedrockRuntimeBase({ region: 'evil.test/#', model: 'm' })).toThrow('AWS region');
  });

  it('signs a temporary credential with x-amz-security-token', async () => {
    const http = new FakeHttpClient(sequence(answer('ok')));
    await runAgent(
      http,
      {},
      { creds: { aws: { ...AWS, temporaryCredentials: true, sessionToken: 'session-1' } } },
    );
    expect(header(http.requests[0], 'x-amz-security-token')).toBe('session-1');
    expect(String(header(http.requests[0], 'authorization'))).toContain('x-amz-security-token');
  });

  it('runs on Assume Role with the temporary keys of the role', async () => {
    const sts = `<AssumeRoleResponse><AssumeRoleResult><Credentials><AccessKeyId>ASIATEMP</AccessKeyId><SecretAccessKey>temp-secret</SecretAccessKey><SessionToken>role-session</SessionToken><Expiration>2099-01-01T00:00:00Z</Expiration></Credentials></AssumeRoleResult></AssumeRoleResponse>`;
    const http = new FakeHttpClient(sequence({ body: sts }, answer('ok')));
    const r = await runAgent(
      http,
      { authentication: 'assumeRole' },
      {
        creds: {
          awsAssumeRole: {
            region: 'eu-central-1',
            stsAccessKeyId: `AKIDROLE${crypto.randomUUID().slice(0, 8)}`,
            stsSecretAccessKey: `secret-${crypto.randomUUID()}`,
            roleArn: 'arn:aws:iam::123456789012:role/r',
            externalId: 'ext',
            roleSessionName: 's',
          },
        },
      },
    );
    expect(r.status).toBe('success');
    expect(http.requests[0].url).toBe('https://sts.eu-central-1.amazonaws.com/');
    const call = http.requests[1];
    expect(call.url).toBe(`https://bedrock-runtime.eu-central-1.amazonaws.com/model/${ENCODED}/converse`);
    expect(String(header(call, 'authorization'))).toContain('Credential=ASIATEMP/');
    expect(header(call, 'x-amz-security-token')).toBe('role-session');
  });

  it.each([
    'https://vpce-0abc123-xyz.bedrock-runtime.us-east-1.vpce.amazonaws.com',
    'https://vpce-0abc123-xyz.bedrock-runtime.cn-north-1.vpce.amazonaws.com.cn',
  ])('takes the private endpoint %s and signs for its region', async (endpoint) => {
    const http = new FakeHttpClient(sequence(answer('ok')));
    const r = await runAgent(
      http,
      {},
      { creds: { aws: { ...AWS, customEndpoints: true, bedrockRuntimeEndpoint: `${endpoint}/` } } },
    );
    expect(r.status).toBe('success');
    expect(http.requests[0].url).toBe(`${endpoint}/model/${ENCODED}/converse`);
    const region = endpoint.includes('cn-north-1') ? 'cn-north-1' : 'us-east-1';
    expect(String(header(http.requests[0], 'authorization'))).toContain(`/${region}/bedrock/aws4_request`);
  });

  it.each([
    'https://my-gateway.example.com',
    'https://evilamazonaws.com',
    'https://bedrock-runtime.us-east-1.amazonaws.com.evil.test',
    'http://bedrock-runtime.us-east-1.amazonaws.com',
  ])('refuses the endpoint %s before anything is sent', async (endpoint) => {
    const http = new FakeHttpClient(sequence());
    const creds = {
      aws: { ...AWS, customEndpoints: true, bedrockRuntimeEndpoint: endpoint, bedrockEndpoint: endpoint },
    };
    const r = await runAgent(http, {}, { creds });
    expect(r.status).toBe('error');
    expect(r.error?.message).toContain('only sign https requests to amazonaws.com');
    const embeddings = await embedder(
      http,
      { model: 'amazon.titan-embed-text-v2:0', options: { maxRetries: 0 } },
      creds,
    );
    await expect(embeddings.embedQuery('x')).rejects.toThrow('only sign https requests to amazonaws.com');
    const list = toolNodeTypes.get('ai.lmChatAwsBedrock')!.methods!.loadOptions!.listModels;
    await expect(list(loadOptionsContext('ai.lmChatAwsBedrock', http, {}, creds))).rejects.toThrow(
      'only sign https requests to amazonaws.com',
    );
    expect(http.requests).toHaveLength(0);
  });

  it('ignores endpoint fields while Custom Endpoints is off and refuses one that is no URL', async () => {
    const off = new FakeHttpClient(sequence(answer('ok')));
    await runAgent(
      off,
      {},
      { creds: { aws: { ...AWS, bedrockRuntimeEndpoint: 'https://my-gateway.example.com' } } },
    );
    expect(off.requests[0].url.startsWith(RUNTIME)).toBe(true);

    const bad = new FakeHttpClient(sequence());
    const r = await runAgent(
      bad,
      {},
      { creds: { aws: { ...AWS, customEndpoints: true, bedrockRuntimeEndpoint: 'bedrock.example.com' } } },
    );
    expect(r.error?.message).toContain('Bedrock Runtime endpoint');
    expect(bad.requests).toHaveLength(0);
  });

  it('leaves user info, query and fragment of an endpoint out of the URL', async () => {
    const http = new FakeHttpClient(sequence(answer('ok')));
    await runAgent(
      http,
      {},
      {
        creds: {
          aws: {
            ...AWS,
            customEndpoints: true,
            bedrockRuntimeEndpoint: 'https://user:pw@bedrock-runtime.us-east-1.amazonaws.com/?a=1#x',
          },
        },
      },
    );
    expect(http.requests[0].url).toBe(`${RUNTIME}/model/${ENCODED}/converse`);
  });
});

describe('event-stream decoder', () => {
  it('decodes frames in any cut, with every header type', () => {
    const headers = concat(
      new Uint8Array([1, 97, 0]), // bool true
      new Uint8Array([1, 98, 1]), // bool false
      new Uint8Array([1, 99, 2, 9]), // byte
      new Uint8Array([1, 100, 3, 0, 1]), // short
      new Uint8Array([1, 101, 4, 0, 0, 0, 1]), // int
      new Uint8Array([1, 102, 5, 0, 0, 0, 0, 0, 0, 0, 1]), // long
      new Uint8Array([1, 103, 6, 0, 2, 1, 2]), // bytes
      new Uint8Array([1, 104, 8, 0, 0, 0, 0, 0, 0, 0, 1]), // timestamp
      new Uint8Array([1, 105, 9, ...new Array(16).fill(7)]), // uuid
      stringHeader(':event-type', 'messageStop'),
    );
    const frame = encodeFrame(headers, new TextEncoder().encode('{"stopReason":"end_turn"}'));
    const whole = createEventStreamDecoder();
    expect(whole.push(frame)).toEqual([{ eventType: 'messageStop', payload: { stopReason: 'end_turn' } }]);
    whole.end();

    const bytewise = createEventStreamDecoder();
    const frames = [];
    for (const byte of concat(frame, frame)) frames.push(...bytewise.push(new Uint8Array([byte])));
    expect(frames).toHaveLength(2);
    bytewise.end();
  });

  it('gives an empty payload as an empty object', () => {
    const decoder = createEventStreamDecoder();
    const frame = encodeFrame(stringHeader(':event-type', 'contentBlockStop'), new Uint8Array());
    expect(decoder.push(frame)).toEqual([{ eventType: 'contentBlockStop', payload: {} }]);
  });

  it('fails on a bad prelude checksum', () => {
    const frame = eventFrame('messageStop', {});
    frame[8] ^= 0xff;
    expect(() => createEventStreamDecoder().push(frame)).toThrow(/prelude/i);
  });

  it('fails on a bad message checksum', () => {
    const frame = eventFrame('messageStop', { stopReason: 'end_turn' });
    frame[frame.length - 6] ^= 0xff; // a payload byte
    expect(() => createEventStreamDecoder().push(frame)).toThrow(/checksum/i);
    const tail = eventFrame('messageStop', {});
    tail[tail.length - 1] ^= 0xff;
    expect(() => createEventStreamDecoder().push(tail)).toThrow(/checksum/i);
  });

  it('fails on a length no frame can have, before it waits for those bytes', () => {
    const lengths = (total: number, headers: number) => {
      const start = concat(u32(total), u32(headers));
      return concat(start, u32(crc32(start)));
    };
    expect(() => createEventStreamDecoder().push(lengths(8, 0))).toThrow(/length/i);
    expect(() => createEventStreamDecoder().push(lengths(0x7fffffff, 0))).toThrow(/length/i);
    expect(() => createEventStreamDecoder().push(lengths(32, 40))).toThrow(/length/i);
  });

  it('fails on a header that runs past its section or has an unknown type', () => {
    const overrun = encodeFrame(new Uint8Array([50, 97]), new Uint8Array());
    expect(() => createEventStreamDecoder().push(overrun)).toThrow(/header/i);
    const unknown = encodeFrame(new Uint8Array([1, 97, 42]), new Uint8Array());
    expect(() => createEventStreamDecoder().push(unknown)).toThrow(/header/i);
  });

  it('fails on a payload that is not JSON, without quoting it', () => {
    const frame = encodeFrame(stringHeader(':event-type', 'x'), new TextEncoder().encode('private text'));
    let message = '';
    try {
      createEventStreamDecoder().push(frame);
    } catch (error) {
      message = (error as Error).message;
    }
    expect(message).toMatch(/payload/i);
    expect(message).not.toContain('private text');
  });

  it('fails when the response ends inside a frame', () => {
    const decoder = createEventStreamDecoder();
    decoder.push(eventFrame('messageStop', {}).slice(0, 20));
    expect(() => decoder.end()).toThrow(/ended/i);
  });

  it('gives an exception frame its type and an error frame its code', () => {
    const decoder = createEventStreamDecoder();
    expect(decoder.push(exceptionFrame('throttlingException', 'Slow down'))).toEqual([
      { eventType: 'throttlingException', payload: { message: 'Slow down' } },
    ]);
    const error = encodeFrame(
      concat(
        stringHeader(':message-type', 'error'),
        stringHeader(':error-code', 'InternalFailure'),
        stringHeader(':error-message', 'It broke'),
      ),
      new Uint8Array(),
    );
    expect(decoder.push(error)).toEqual([
      { eventType: 'error', payload: { code: 'InternalFailure', message: 'It broke' } },
    ]);
  });
});

describe('Bedrock converse-stream', () => {
  it('streams a reply split across chunks and reports deltas as they arrive', async () => {
    const http = new FakeHttpClient(sequence({ body: chunked(TEXT_STREAM, 7) }));
    const model = await chatModel(http);
    const deltas: string[] = [];
    const response = await model.stream!({ messages: [USER] }, (d) => deltas.push(d));
    expect(deltas).toEqual(['The answer ', 'is 42']);
    expect(response).toEqual({
      message: { role: 'assistant', content: 'The answer is 42' },
      usage: { inputTokens: 7, outputTokens: 3 },
      stopReason: 'end',
    });
    const [request] = http.requests;
    expect(request.url).toBe(`${RUNTIME}/model/${ENCODED}/converse-stream`);
    expect(request.responseType).toBe('stream');
    expect(header(request, 'accept')).toBe('application/vnd.amazon.eventstream');
    expect(typeof request.body).toBe('string');
    expect(header(request, 'authorization')).toMatch(/^AWS4-HMAC-SHA256 /);
  });

  it('rebuilds a streamed tool call through the agent', async () => {
    const http = new FakeHttpClient(
      sequence({ body: chunked(TOOL_STREAM, 11) }, { body: chunked(TEXT_STREAM, 64) }),
    );
    const r = await runAgent(http, {}, { stream: true, tools: true });
    expect(r.status).toBe('success');
    expect(r.output('Agent')).toEqual([{ output: 'The answer is 42' }]);
    const second = jsonBody(http.requests[1]);
    expect(second.messages[1].content).toEqual([
      { text: 'Let me check. ' },
      { toolUse: { toolUseId: 'tooluse_9', name: 'Calculator', input: { input: '6*7' } } },
    ]);
    expect(second.messages[2].content[0].toolResult).toMatchObject({ toolUseId: 'tooluse_9' });
  });

  it('replays streamed reasoning unchanged', async () => {
    const frames = [
      eventFrame('contentBlockDelta', { contentBlockIndex: 0, delta: { reasoningContent: { text: 'Hm' } } }),
      eventFrame('contentBlockDelta', {
        contentBlockIndex: 0,
        delta: { reasoningContent: { signature: 's1' } },
      }),
      eventFrame('contentBlockStop', { contentBlockIndex: 0 }),
      eventFrame('contentBlockStart', {
        contentBlockIndex: 1,
        start: { toolUse: { toolUseId: 'r2', name: 't' } },
      }),
      eventFrame('contentBlockStop', { contentBlockIndex: 1 }),
      eventFrame('messageStop', { stopReason: 'tool_use' }),
    ];
    const adapter = bedrockAdapter({ region: 'us-east-1', model: MODEL });
    const parser = adapter.streamParser!(() => undefined);
    const decoder = createEventStreamDecoder();
    for (const frame of frames) {
      for (const { eventType, payload } of decoder.push(frame)) parser.push(eventType, payload);
    }
    const response = parser.finish();
    expect(response.message.toolCalls).toEqual([{ id: 'r2', name: 't', arguments: {} }]);
    expect(response.stopReason).toBe('tool_calls');
    const body = JSON.parse(
      adapter.buildRequest(
        { messages: [USER, response.message, { role: 'tool', toolCallId: 'r2', content: 'ok' }] },
        false,
      ).body as string,
    );
    expect(body.messages[1].content).toEqual([
      { reasoningContent: { reasoningText: { text: 'Hm', signature: 's1' } } },
      { toolUse: { toolUseId: 'r2', name: 't', input: {} } },
    ]);
  });

  it('keeps arguments that are not JSON as raw text', () => {
    const parser = bedrockAdapter({ region: 'us-east-1', model: MODEL }).streamParser!(() => undefined);
    parser.push('contentBlockStart', {
      contentBlockIndex: 0,
      start: { toolUse: { toolUseId: 'x', name: 't' } },
    });
    parser.push('contentBlockDelta', { contentBlockIndex: 0, delta: { toolUse: { input: '{"a":' } } });
    parser.push('messageStop', { stopReason: 'tool_use' });
    expect(parser.finish().message.toolCalls?.[0].arguments).toEqual({ _rawArguments: '{"a":' });
  });

  it('fails the call on a bad checksum in the stream', async () => {
    const frames = TEXT_STREAM.map((f) => f.slice());
    frames[2][frames[2].length - 6] ^= 0xff;
    const http = new FakeHttpClient(sequence({ body: chunked(frames, 9) }));
    const model = await chatModel(http);
    const deltas: string[] = [];
    await expect(model.stream!({ messages: [USER] }, (d) => deltas.push(d))).rejects.toThrow(/checksum/i);
    expect(deltas).toEqual(['The answer ']);
    expect(http.requests).toHaveLength(1);
  });

  it('fails a stream that ends with no messageStop', async () => {
    const http = new FakeHttpClient(sequence({ body: chunked(TEXT_STREAM.slice(0, 2), 50) }));
    const model = await chatModel(http);
    await expect(model.stream!({ messages: [USER] }, () => undefined)).rejects.toThrow(/before the reply/);
  });

  it('retries a throttling exception that came before any text, not one after', async () => {
    const http = new FakeHttpClient(
      sequence(
        { body: chunked([exceptionFrame('throttlingException', 'Too many requests')], 10) },
        { body: chunked(TEXT_STREAM, 10) },
      ),
    );
    const model = await chatModel(http, { options: { maxRetries: 1 } });
    const response = await model.stream!({ messages: [USER] }, () => undefined);
    expect(response.message.content).toBe('The answer is 42');
    expect(http.requests).toHaveLength(2);

    const late = new FakeHttpClient(
      sequence({
        body: chunked([TEXT_STREAM[1], exceptionFrame('serviceUnavailableException', 'Down')], 10),
      }),
    );
    const again = await chatModel(late, { options: { maxRetries: 3 } });
    await expect(again.stream!({ messages: [USER] }, () => undefined)).rejects.toThrow('Down');
    expect(late.requests).toHaveLength(1);
  });

  it('does not retry a validation exception', async () => {
    const http = new FakeHttpClient(
      sequence({ body: chunked([exceptionFrame('validationException', 'Bad')], 8) }),
    );
    const model = await chatModel(http, { options: { maxRetries: 3 } });
    await expect(model.stream!({ messages: [USER] }, () => undefined)).rejects.toThrow('Bad');
    expect(http.requests).toHaveLength(1);
  });

  it('takes a plain JSON answer from a host that ignored the stream path', async () => {
    const http = new FakeHttpClient(sequence(answer('whole')));
    const model = await chatModel(http);
    const deltas: string[] = [];
    const response = await model.stream!({ messages: [USER] }, (d) => deltas.push(d));
    expect(response.message.content).toBe('whole');
    expect(deltas).toEqual(['whole']);
  });
});

describe('Bedrock embeddings', () => {
  const TITAN = 'amazon.titan-embed-text-v2:0';
  const COHERE = 'cohere.embed-english-v3';

  it('sends a Titan body per text and replaces new lines', async () => {
    const http = new FakeHttpClient((request) => ({
      body: { embedding: [jsonBody(request).inputText.length, 1], inputTextTokenCount: 2 },
    }));
    const embeddings = await embedder(http, { model: TITAN });
    expect(await embeddings.embedDocuments(['a\nb', 'ccc\r\nd'])).toEqual([
      [3, 1],
      [5, 1],
    ]);
    expect(http.requests).toHaveLength(2);
    const [request] = http.requests;
    expect(request.url).toBe(`${RUNTIME}/model/amazon.titan-embed-text-v2%3A0/invoke`);
    expect(request.method).toBe('POST');
    expect(typeof request.body).toBe('string');
    expect(jsonBody(request)).toEqual({ inputText: 'a b' });
    expect(String(header(request, 'authorization'))).toMatch(
      /^AWS4-HMAC-SHA256 Credential=[^/]+\/\d{8}\/us-east-1\/bedrock\/aws4_request, /,
    );
  });

  it('sends a Cohere body with the input type of the purpose', async () => {
    const http = new FakeHttpClient(() => ({
      body: { embeddings: [[0.5, 0.25]], response_type: 'embeddings_floats' },
    }));
    const embeddings = await embedder(http, { model: COHERE });
    expect(await embeddings.embedDocuments(['doc'])).toEqual([[0.5, 0.25]]);
    expect(await embeddings.embedQuery('q\nq')).toEqual([0.5, 0.25]);
    expect(jsonBody(http.requests[0])).toEqual({ texts: ['doc'], input_type: 'search_document' });
    expect(jsonBody(http.requests[1])).toEqual({ texts: ['q q'], input_type: 'search_query' });
    expect(embeddings.dimensions).toBe(2);
  });

  it('knows a Cohere model behind an inference profile or ARN', async () => {
    const http = new FakeHttpClient(() => ({ body: { embeddings: { float: [[1]] } } }));
    for (const model of [
      'us.cohere.embed-v4:0',
      'arn:aws:bedrock:us-east-1::foundation-model/cohere.embed-v4:0',
    ]) {
      const embeddings = await embedder(http, { model });
      expect(await embeddings.embedQuery('x')).toEqual([1]);
      expect(jsonBody(http.requests.at(-1)!).texts).toEqual(['x']);
    }
  });

  it('reads embeddingsByType.float', async () => {
    const http = new FakeHttpClient(() => ({ body: { embeddingsByType: { float: [3, 4] } } }));
    expect(await (await embedder(http, { model: TITAN })).embedQuery('x')).toEqual([3, 4]);
  });

  it('calls in parallel and keeps the order', async () => {
    let open = 0;
    let most = 0;
    const release: Array<() => void> = [];
    const http = new FakeHttpClient(async (request) => {
      open += 1;
      most = Math.max(most, open);
      if (open === 3) for (const go of release) go();
      else await new Promise<void>((resolve) => release.push(resolve));
      open -= 1;
      return { body: { embedding: [Number(jsonBody(request).inputText)] } };
    });
    const embeddings = await embedder(http, { model: TITAN });
    expect(await embeddings.embedDocuments(['1', '2', '3'])).toEqual([[1], [2], [3]]);
    expect(most).toBe(3);
  });

  it('merges additional fields under the text, and refuses bad JSON', async () => {
    const http = new FakeHttpClient(() => ({ body: { embedding: [1] } }));
    const embeddings = await embedder(http, {
      model: TITAN,
      options: { additionalModelRequestFields: '{"dimensions":256,"inputText":"overridden"}' },
    });
    await embeddings.embedQuery('real');
    expect(jsonBody(http.requests[0])).toEqual({ dimensions: 256, inputText: 'real' });
    await expect(
      embedder(http, { model: TITAN, options: { additionalModelRequestFields: 'nope' } }),
    ).rejects.toThrow('Additional Model Request Fields must be valid JSON');
  });

  it('retries a throttled call and fails on an answer with no vector', async () => {
    const throttled = new FakeHttpClient(
      sequence({ status: 429, body: { message: 'Slow down' } }, { body: { embedding: [1] } }),
    );
    const embeddings = await embedder(throttled, { model: TITAN, options: { maxRetries: 1 } });
    expect(await embeddings.embedQuery('x')).toEqual([1]);
    expect(throttled.requests).toHaveLength(2);

    const empty = new FakeHttpClient(() => ({ body: {} }));
    await expect((await embedder(empty, { model: TITAN })).embedQuery('x')).rejects.toThrow(/no vector/);
  });

  it('asks for a model, and logs counts with no text or secret', async () => {
    const http = new FakeHttpClient(() => ({ body: { embedding: [1, 2] } }));
    await expect(embedder(http, { model: ' ' })).rejects.toThrow('Choose a model');
    const log = vi.fn();
    const embeddings = await embedder(http, { model: TITAN }, CREDS, log);
    await embeddings.embedDocuments(['private one', 'private two']);
    expect(log).toHaveBeenCalledTimes(1);
    expect(log.mock.calls[0][0]).toEqual({ model: TITAN, texts: 2, purpose: 'document' });
    expect(log.mock.calls[0][1]).toEqual({ vectors: 2, dimensions: 2 });
    const logged = JSON.stringify(log.mock.calls);
    expect(logged).not.toContain('private');
    expect(logged).not.toContain(SECRET);
    expect(await embeddings.embedDocuments([])).toEqual([]);
  });
});

describe('Bedrock nodes and model lists', () => {
  const CONTROL = 'https://bedrock.us-east-1.amazonaws.com';
  const foundation = (id: string, name: string) => ({
    modelArn: `arn:aws:bedrock:us-east-1::foundation-model/${id}`,
    modelId: id,
    modelName: name,
    providerName: 'Vendor',
  });
  const profile = (id: string, name: string, modelId = id, type = 'SYSTEM_DEFINED') => ({
    inferenceProfileArn: `arn:aws:bedrock:us-east-1:1:inference-profile/${id}`,
    inferenceProfileId: id,
    inferenceProfileName: name,
    type,
    status: 'ACTIVE',
    models: [{ modelArn: `arn:aws:bedrock:us-east-1::foundation-model/${modelId}` }],
  });
  const list = (type: string) => toolNodeTypes.get(type)!.methods!.loadOptions!.listModels;
  const route =
    (replies: {
      models?: unknown[] | 'fail';
      system?: unknown[] | 'fail';
      application?: unknown[] | 'fail';
    }) =>
    (request: HttpRequestOptions): FakeReply => {
      const url = new URL(request.url);
      const pick = (value: unknown[] | 'fail' | undefined, key: string): FakeReply =>
        value === 'fail' ? { status: 403, body: { message: 'Denied' } } : { body: { [key]: value ?? [] } };
      if (url.pathname === '/foundation-models') return pick(replies.models, 'modelSummaries');
      return pick(
        url.searchParams.get('type') === 'APPLICATION' ? replies.application : replies.system,
        'inferenceProfileSummaries',
      );
    };

  it('has the n8n options and both credentials', () => {
    const chat = toolNodeTypes.get('ai.lmChatAwsBedrock')!.description;
    const names = chat.properties.map((p) => p.name);
    expect(names.slice(0, 2)).toEqual(['authentication', 'model']);
    const auth = chat.properties.find((p) => p.name === 'authentication')!;
    expect(auth.default).toBe('iam');
    expect(auth.options?.map((o) => (o as { value: string }).value)).toEqual(['iam', 'assumeRole']);
    const options = chat.properties.find((p) => p.name === 'options')!;
    const byName = new Map(
      options.options!.map((o) => [(o as { name: string }).name, o as { default: unknown }]),
    );
    expect(byName.get('maxTokens')?.default).toBe(2000);
    expect(byName.get('temperature')?.default).toBe(0.7);
    expect(byName.get('topP')?.default).toBe(1);
    expect(byName.get('maxRetries')?.default).toBe(2);
    expect(byName.get('timeout')?.default).toBe(60_000);
    expect(byName.get('latency')?.default).toBe('standard');
    expect(byName.get('guardrailVersion')?.default).toBe('DRAFT');
    expect(byName.get('guardrailTrace')?.default).toBe('disabled');
    expect(byName.has('additionalModelRequestFields')).toBe(true);
    const embedding = toolNodeTypes.get('ai.embeddingsAwsBedrock')!.description;
    expect(embedding.properties.map((p) => p.name)).toEqual(['authentication', 'model', 'options']);
  });

  it('merges models and both profile lists by ARN', async () => {
    const http = new FakeHttpClient(
      route({
        models: [foundation('amazon.nova-pro-v1:0', 'Nova Pro')],
        system: [profile('us.anthropic.haiku:0', 'US Haiku')],
        application: [
          profile('us.anthropic.haiku:0', 'US Haiku'),
          profile('team-profile', 'Team Profile', 'anthropic.haiku:0', 'APPLICATION'),
          profile('us.cohere.embed-v4:0', 'US Embed', 'cohere.embed-v4:0'),
        ],
      }),
    );
    const options = await list('ai.lmChatAwsBedrock')(loadOptionsContext('ai.lmChatAwsBedrock', http, {}));
    expect(options).toEqual([
      { name: 'Nova Pro', value: 'amazon.nova-pro-v1:0' },
      {
        name: 'Team Profile (inference profile)',
        value: 'arn:aws:bedrock:us-east-1:1:inference-profile/team-profile',
      },
      {
        name: 'US Haiku (inference profile)',
        value: 'arn:aws:bedrock:us-east-1:1:inference-profile/us.anthropic.haiku:0',
      },
    ]);
    const urls = http.requests.map((r) => r.url).sort();
    expect(urls).toEqual([
      `${CONTROL}/foundation-models?byOutputModality=TEXT&byInferenceType=ON_DEMAND`,
      `${CONTROL}/inference-profiles?maxResults=1000`,
      `${CONTROL}/inference-profiles?maxResults=1000&type=APPLICATION`,
    ]);
    for (const request of http.requests) {
      expect(String(header(request, 'authorization'))).toContain('/us-east-1/bedrock/aws4_request');
    }
  });

  it('keeps what answered when one list fails, and reports when all fail', async () => {
    const load = (http: FakeHttpClient) =>
      list('ai.lmChatAwsBedrock')(loadOptionsContext('ai.lmChatAwsBedrock', http, {}));
    expect(
      await load(
        new FakeHttpClient(route({ models: 'fail', system: [profile('p', 'P')], application: 'fail' })),
      ),
    ).toEqual([{ name: 'P (inference profile)', value: 'arn:aws:bedrock:us-east-1:1:inference-profile/p' }]);
    expect(
      await load(
        new FakeHttpClient(route({ models: [foundation('m', 'M')], system: 'fail', application: 'fail' })),
      ),
    ).toEqual([{ name: 'M', value: 'm' }]);
    await expect(
      load(new FakeHttpClient(route({ models: 'fail', system: 'fail', application: 'fail' }))),
    ).rejects.toThrow('Denied');
  });

  it('lists embedding models and only the profiles of embedding models', async () => {
    const http = new FakeHttpClient(
      route({
        models: [foundation('amazon.titan-embed-text-v2:0', 'Titan Embeddings')],
        system: [
          profile('us.cohere.embed-v4:0', 'US Embed', 'cohere.embed-v4:0'),
          profile('us.anthropic.haiku:0', 'US Haiku'),
        ],
      }),
    );
    const options = await list('ai.embeddingsAwsBedrock')(
      loadOptionsContext('ai.embeddingsAwsBedrock', http, {}),
    );
    expect(options).toEqual([
      { name: 'Titan Embeddings', value: 'amazon.titan-embed-text-v2:0' },
      {
        name: 'US Embed (inference profile)',
        value: 'arn:aws:bedrock:us-east-1:1:inference-profile/us.cohere.embed-v4:0',
      },
    ]);
    expect(http.requests.map((r) => r.url)).toContain(
      `${CONTROL}/foundation-models?byOutputModality=EMBEDDING&byInferenceType=ON_DEMAND`,
    );
  });

  it('lists on the assume-role credential and a custom Bedrock endpoint', async () => {
    const sts = `<R><AccessKeyId>ASIALIST</AccessKeyId><SecretAccessKey>s</SecretAccessKey><SessionToken>t</SessionToken><Expiration>2099-01-01T00:00:00Z</Expiration></R>`;
    const models = route({ models: [foundation('m', 'M')] });
    const http = new FakeHttpClient((request) =>
      new URL(request.url).hostname.startsWith('sts.') ? { body: sts } : models(request),
    );
    const creds = {
      awsAssumeRole: {
        region: 'eu-west-1',
        stsAccessKeyId: `AKIDLIST${crypto.randomUUID().slice(0, 8)}`,
        stsSecretAccessKey: `secret-${crypto.randomUUID()}`,
        roleArn: 'arn:aws:iam::1:role/r',
        externalId: 'e',
        roleSessionName: 's',
        customEndpoints: true,
        bedrockEndpoint: 'https://vpce-1.bedrock.eu-west-1.vpce.amazonaws.com',
      },
    };
    const options = await list('ai.lmChatAwsBedrock')(
      loadOptionsContext('ai.lmChatAwsBedrock', http, { authentication: 'assumeRole' }, creds),
    );
    expect(options).toEqual([{ name: 'M', value: 'm' }]);
    const listed = http.requests.filter((r) => r.url.includes('vpce-1.bedrock'));
    expect(listed).toHaveLength(3);
    expect(String(header(listed[0], 'authorization'))).toContain('Credential=ASIALIST/');
  });

  it('asks for a model on the chat node', async () => {
    const http = new FakeHttpClient(sequence());
    await expect(chatModel(http, { model: '  ' })).rejects.toThrow('Choose a model');
  });
});
