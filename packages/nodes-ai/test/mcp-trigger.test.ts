/**
 * P5-03 MCP Server Trigger, node side: the protocol helpers of shared/mcp-server.ts, the node's `webhook`
 * (auth, `initialize`, `server/discover`, `tools/list` under MCP_TOOLS_LIST_HOOK with sub-nodes that see the base item,
 * the base item of every other message)
 * and its `execute` (one tool call inside a run, arguments as data).
 */
import { type ContextDeps, createWebhookContext, createWebhookSubNodes, NodeTypes } from '@workflow/core';
import {
  type AiTool,
  type DataObject,
  ExpressionEvaluator,
  MCP_ERRORS,
  MCP_LATEST_REVISION,
  MCP_TOOLS_LIST_HOOK,
  type McpAuthHelper,
  type NodeType,
  ToolSuspension,
  type WebhookRequest,
  type WebhookResponseData,
  Workflow,
  type WorkflowNode,
} from '@workflow/workflow';
import { describe, expect, it } from 'vitest';
import { McpTriggerNode } from '../src/nodes/trigger/McpTrigger.node';
import { callMcpTool, MCP_REDACTED, mcpToolDescriptors, redactMcpHeaders } from '../src/shared/mcp-server';
import { connect, node, run, services, toolNodeTypes } from './harness';

/** a tool that answers with the arguments it received, so a test sees exactly what reached it */
/** the items the echo tool's sub-node got, in order: what a tool sees as `$json` */
const supplied: DataObject[] = [];

const echoToolNode: NodeType = {
  description: {
    name: 'test.echoTool',
    displayName: 'Echo Tool',
    description: 'Answers with its arguments and its input item',
    icon: 'lucide:repeat',
    group: ['transform'],
    version: 1,
    defaults: { name: 'Echo' },
    inputs: [],
    outputs: ['ai_tool'],
    properties: [],
  },
  async supplyData(ctx) {
    const item = ctx.getInputData()[0]?.json ?? {};
    supplied.push(item);
    return {
      response: {
        kind: 'tool',
        name: 'echo',
        description: 'Echoes',
        parameters: { type: 'object', properties: { text: { type: 'string' } } },
        async invoke(args: DataObject) {
          return { args, item };
        },
      } satisfies AiTool,
    };
  },
};

const types = new NodeTypes([...toolNodeTypes.list(), echoToolNode]);

const TRIGGER = 'My MCP Server';

function trigger(parameters: DataObject = {}): WorkflowNode {
  return node(
    TRIGGER,
    'ai.mcpTrigger',
    { path: 'tools', ...parameters },
    {
      webhookId: 'hook-1',
      credentials: {
        httpBearerAuth: { id: 'b', name: 'b' },
        httpHeaderAuth: { id: 'h', name: 'h' },
      },
    },
  );
}

const toolNodes = [
  node('Calculator', 'ai.toolCalculator'),
  node('Shout', 'ai.toolCode', {
    toolDescription: 'Upper-cases the text',
    jsCode: 'return String(query).toUpperCase();',
  }),
  node('Echo', 'test.echoTool'),
];
const toolLinks = connect(
  ['Calculator', TRIGGER, 'ai_tool'],
  ['Shout', TRIGGER, 'ai_tool'],
  ['Echo', TRIGGER, 'ai_tool'],
);

const CREDS = {
  httpBearerAuth: { token: 'secret-bearer-token' },
  httpHeaderAuth: { name: 'X-Api-Key', value: 'secret-header-value' },
};

async function callWebhook(
  parameters: DataObject,
  request: Partial<WebhookRequest>,
  options: { webhookName?: string; toolInput?: DataObject; mcpAuth?: McpAuthHelper } = {},
): Promise<WebhookResponseData> {
  const triggerNode = trigger(parameters);
  const workflow = new Workflow(
    { id: 'wf1', name: 'mcp', nodes: [triggerNode, ...toolNodes], connections: toolLinks },
    types,
  );
  const deps: ContextDeps = {
    workflow,
    node: triggerNode,
    services: services({ creds: CREDS, mode: 'webhook', nodeTypes: types, mcpAuth: options.mcpAuth }),
    evaluator: new ExpressionEvaluator(),
    signal: new AbortController().signal,
  };
  const full: WebhookRequest = {
    method: 'POST',
    url: '/mcp/acme/tools',
    headers: { host: 'localhost:5678' },
    query: {},
    params: {},
    body: {},
    ...request,
  };
  // the server's second call for tools/list: sub-nodes that see the request's base item
  const subNodes = options.toolInput ? createWebhookSubNodes(deps, { json: options.toolInput }) : undefined;
  const webhookName = options.toolInput ? MCP_TOOLS_LIST_HOOK : (options.webhookName ?? 'default');
  try {
    const ctx = createWebhookContext(deps, full, webhookName, subNodes?.callbacks);
    return await McpTriggerNode.webhook!(ctx);
  } finally {
    await subNodes?.close();
  }
}

const rpc = (method: string, params?: DataObject, id: number | string = 1) => ({
  jsonrpc: '2.0',
  id,
  method,
  ...(params ? { params } : {}),
});

/** the JSON-RPC result of the node's own answer */
const resultOf = (response: WebhookResponseData) =>
  ((response.webhookResponse?.body ?? {}) as { result?: DataObject }).result ?? {};

/** the base item the node hands on */
const baseOf = (response: WebhookResponseData) => response.workflowData?.[0]?.[0]?.json ?? {};

const USER = { id: 'u1', email: 'ada@example.com', firstName: 'Ada', lastName: 'Lovelace' };

/** a host's workspace sign-in that accepts one token for one resource */
const signIn = (allowed = true): McpAuthHelper => ({
  verifyAccessToken: async (token) => (token === 'good-token' ? { user: USER, role: 'editor' } : null),
  canExecute: async () => allowed,
  challenge: (resource) => `Bearer resource_metadata="${resource}/meta"`,
});

describe('shared/mcp-server.ts', () => {
  const tool = (extra: Partial<AiTool> = {}): AiTool => ({
    kind: 'tool',
    name: 'add',
    description: 'Adds',
    parameters: { type: 'object', properties: { a: { type: 'number' } }, required: ['a'] },
    invoke: async () => 'ok',
    ...extra,
  });

  it('lists tools with an object input schema', () => {
    expect(mcpToolDescriptors([tool(), tool({ name: 'raw', parameters: { type: 'string' } })])).toEqual([
      {
        name: 'add',
        description: 'Adds',
        inputSchema: { type: 'object', properties: { a: { type: 'number' } }, required: ['a'] },
      },
      { name: 'raw', description: 'Adds', inputSchema: { type: 'object', properties: {} } },
    ]);
  });

  it('prefers invokeRaw, else formats the value', async () => {
    const raw = { content: [{ type: 'image', data: 'AAAA', mimeType: 'image/png' }] };
    expect(await callMcpTool(tool({ invokeRaw: async () => raw }), {})).toBe(raw);
    expect(await callMcpTool(tool(), {})).toEqual({ content: [{ type: 'text', text: 'ok' }] });
    expect(await callMcpTool(tool({ invoke: async () => ({ n: 1 }) }), {})).toEqual({
      content: [{ type: 'text', text: '{"n":1}' }],
    });
  });

  it('turns a tool failure into isError, secrets removed, and lets a suspension through', async () => {
    const failing = tool({
      invoke: async () => {
        throw new Error('bad key sk-proj-abcdefghijklmnopqrstuvwx');
      },
    });
    expect(await callMcpTool(failing, {})).toEqual({
      content: [{ type: 'text', text: 'add: bad key [redacted]' }],
      isError: true,
    });
    const waiting = tool({
      invoke: async () => {
        throw new ToolSuspension({
          toolNode: 'Add',
          waitTill: new Date(),
          toolName: 'add',
          toolCallId: 'c1',
        });
      },
    });
    await expect(callMcpTool(waiting, {})).rejects.toBeInstanceOf(ToolSuspension);
  });

  it('redacts authorization, cookie and the named headers, one string per header', () => {
    expect(
      redactMcpHeaders(
        {
          authorization: 'Bearer x',
          cookie: 'a=b',
          'x-api-key': 'secret',
          accept: ['application/json', 'text/event-stream'],
          missing: undefined,
          host: 'h',
        },
        ['X-Api-Key'],
      ),
    ).toEqual({
      authorization: MCP_REDACTED,
      cookie: MCP_REDACTED,
      'x-api-key': MCP_REDACTED,
      accept: 'application/json, text/event-stream',
      host: 'h',
    });
  });
});

describe('MCP Server Trigger webhook', () => {
  it('answers initialize with the server name from the node name and the instructions', async () => {
    const result = await callWebhook(
      { instructions: 'Use the calculator' },
      { body: rpc('initialize', { protocolVersion: '2025-06-18', capabilities: {} }) },
    );
    expect(result.workflowData).toBeUndefined();
    expect(result.webhookResponse?.statusCode).toBe(200);
    expect(result.webhookResponse?.body).toEqual({
      jsonrpc: '2.0',
      id: 1,
      result: {
        protocolVersion: '2025-06-18',
        capabilities: { tools: {} },
        serverInfo: { name: 'My_MCP_Server', version: '0.1.0' },
        instructions: 'Use the calculator',
      },
    });
    // 2026 has no initialize: a client asking for it gets the newest 2025 revision
    const latest = await callWebhook(
      {},
      { body: rpc('initialize', { protocolVersion: MCP_LATEST_REVISION }) },
    );
    expect(resultOf(latest).protocolVersion).toBe('2025-11-25');
  });

  it('answers server/discover for 2026 clients', async () => {
    const result = await callWebhook({}, { body: rpc('server/discover') });
    const body = result.webhookResponse?.body as { result: DataObject };
    expect(body.result.resultType).toBe('complete');
    expect(body.result.capabilities).toEqual({ tools: {} });
    expect(body.result._meta).toEqual({
      'io.modelcontextprotocol/serverInfo': { name: 'My_MCP_Server', version: '0.1.0' },
    });
  });

  it('lists the connected tools under the list hook; the tools see the base item, as at a call', async () => {
    const request = { body: rpc('tools/list'), headers: { host: 'h', authorization: 'Bearer abc' } };
    // the first call hands the server the base item and builds no tool
    const first = await callWebhook({}, request);
    expect(first.webhookResponse).toBeUndefined();
    const base = baseOf(first);
    expect(base).toEqual({ body: rpc('tools/list'), headers: { host: 'h', authorization: MCP_REDACTED } });
    supplied.length = 0;
    const result = await callWebhook({}, request, { toolInput: base });
    const tools = resultOf(result).tools as DataObject[];
    expect(tools.map((t) => t.name)).toEqual(['Calculator', 'Shout', 'echo']);
    expect(tools[0].inputSchema).toMatchObject({ type: 'object', required: ['input'] });
    // n8n's tool input: body and redacted headers, not the body alone
    expect(supplied).toEqual([base]);
    expect(result.customData).toEqual({ mcpSubject: '' });
  });

  it('hands every other message to the run as the base item, auth headers redacted', async () => {
    const body = rpc('tools/call', { name: 'Calculator', arguments: { input: '1+1' } });
    const result = await callWebhook(
      {},
      {
        body,
        headers: { host: 'h', authorization: 'Bearer abc', cookie: 'c=1', accept: 'application/json' },
      },
    );
    expect(result.webhookResponse).toBeUndefined();
    expect(result.workflowData).toEqual([
      [
        {
          json: {
            body,
            headers: {
              host: 'h',
              authorization: MCP_REDACTED,
              cookie: MCP_REDACTED,
              accept: 'application/json',
            },
          },
        },
      ],
    ]);
    expect(result.customData).toEqual({ mcpSubject: '' });
  });

  it('checks a Bearer token: 401 with WWW-Authenticate when missing or wrong', async () => {
    const parameters = { authentication: 'bearerAuth' };
    for (const authorization of [
      undefined,
      'Bearer wrong',
      'Basic secret-bearer-token',
      'secret-bearer-token',
    ]) {
      const result = await callWebhook(parameters, {
        body: rpc('initialize', { protocolVersion: '2025-06-18' }),
        headers: authorization ? { authorization } : {},
      });
      expect(result.workflowData).toBeUndefined();
      expect(result.webhookResponse?.statusCode).toBe(401);
      expect(result.webhookResponse?.headers?.['www-authenticate']).toBe('Bearer realm="MCP Server"');
      expect(JSON.stringify(result.webhookResponse)).not.toContain('secret-bearer-token');
    }
    const ok = await callWebhook(parameters, {
      body: rpc('ping'),
      headers: { authorization: 'Bearer secret-bearer-token' },
    });
    expect((baseOf(ok).headers as DataObject).authorization).toBe(MCP_REDACTED);
    expect(ok.customData?.mcpSubject).toMatch(/^[0-9a-f]{64}$/);
    expect(JSON.stringify(ok)).not.toContain('secret-bearer-token');
  });

  it('checks a Header Auth credential and redacts its header from the item', async () => {
    const parameters = { authentication: 'headerAuth' };
    const refused = await callWebhook(parameters, { body: rpc('ping'), headers: { 'x-api-key': 'nope' } });
    expect(refused.webhookResponse?.statusCode).toBe(401);
    expect(refused.webhookResponse?.headers?.['www-authenticate']).toBeDefined();
    const ok = await callWebhook(parameters, {
      body: rpc('ping'),
      headers: { 'x-api-key': 'secret-header-value', host: 'h' },
    });
    expect(ok.workflowData?.[0][0].json.headers).toEqual({ 'x-api-key': MCP_REDACTED, host: 'h' });
    expect(JSON.stringify(ok)).not.toContain('secret-header-value');
    // two subjects never share a hash
    const bearer = await callWebhook(
      { authentication: 'bearerAuth' },
      { body: rpc('ping'), headers: { authorization: 'Bearer secret-bearer-token' } },
    );
    expect(bearer.customData?.mcpSubject).not.toBe(ok.customData?.mcpSubject);
  });

  it('workspace sign-in: a host without the sign-in helper refuses with 401, never 500', async () => {
    const result = await callWebhook(
      { authentication: 'n8nOAuth2' },
      { body: rpc('ping'), headers: { authorization: 'Bearer good-token' } },
    );
    expect(result.workflowData).toBeUndefined();
    expect(result.webhookResponse?.statusCode).toBe(401);
    expect(result.webhookResponse?.headers?.['www-authenticate']).toBe('Bearer realm="MCP Server"');
    expect(JSON.stringify(result.webhookResponse?.body)).not.toMatch(/stack|at .*\.ts/);
  });

  it('workspace sign-in: a valid token passes, the user in the item and in what the tools see at list', async () => {
    const parameters = { authentication: 'n8nOAuth2' };
    const refused = await callWebhook(
      parameters,
      { body: rpc('ping'), headers: { authorization: 'Bearer bad-token' } },
      { mcpAuth: signIn() },
    );
    expect(refused.webhookResponse?.statusCode).toBe(401);
    const request = { body: rpc('tools/list'), headers: { authorization: 'Bearer good-token' } };
    const ok = await callWebhook(parameters, request, { mcpAuth: signIn() });
    const base = baseOf(ok);
    expect(base).toEqual({ body: rpc('tools/list'), headers: { authorization: MCP_REDACTED }, user: USER });
    expect(ok.customData?.mcpSubject).toMatch(/^[0-9a-f]{64}$/);
    supplied.length = 0;
    const listed = await callWebhook(parameters, request, { mcpAuth: signIn(), toolInput: base });
    expect((resultOf(listed).tools as DataObject[]).map((t) => t.name)).toContain('echo');
    expect(supplied).toEqual([base]);
    // without the right to run the workflow: 403
    const forbidden = await callWebhook(parameters, request, { mcpAuth: signIn(false) });
    expect(forbidden.webhookResponse?.statusCode).toBe(403);
    // the user stays out of the item when the node says so
    const hidden = await callWebhook({ ...parameters, includeUserInOutput: false }, request, {
      mcpAuth: signIn(),
    });
    expect(baseOf(hidden)).not.toHaveProperty('user');
  });

  it('refuses an unknown authentication value instead of serving it open', async () => {
    for (const authentication of ['basicAuth', 'NONE']) {
      const result = await callWebhook(
        { authentication },
        { body: rpc('tools/call', { name: 'Calculator' }) },
      );
      expect(result.workflowData).toBeUndefined();
      expect(result.webhookResponse?.statusCode).toBe(500);
      expect(result.webhookResponse?.body).toEqual({
        error: 'server_error',
        error_description: "Couldn't check the MCP client: the authentication method is unknown",
      });
    }
  });

  it('checks auth on the GET stream and the DELETE too', async () => {
    const parameters = { authentication: 'bearerAuth' };
    for (const [method, webhookName] of [
      ['GET', 'setup'],
      ['DELETE', 'sessionEnd'],
    ]) {
      const refused = await callWebhook(parameters, { method, body: {} }, { webhookName });
      expect(refused.webhookResponse?.statusCode).toBe(401);
      const ok = await callWebhook(
        parameters,
        { method, body: {}, headers: { authorization: 'Bearer secret-bearer-token' } },
        { webhookName },
      );
      expect(ok.workflowData?.[0][0].json).toMatchObject({ headers: { authorization: MCP_REDACTED } });
    }
  });
});

describe('MCP Server Trigger execute', () => {
  const callItem = (toolName: string, args: DataObject) => ({
    json: {
      body: rpc('tools/call', { name: toolName, arguments: args }, 9),
      headers: { host: 'h' },
      mcpToolCall: { toolName, arguments: args, sourceNodeName: '' },
      mcpMessageId: 9,
    },
  });

  const runCall = (toolName: string, args: DataObject) =>
    run([trigger(), ...toolNodes], toolLinks, {
      triggerItems: [callItem(toolName, args)],
      nodeTypes: types,
      services: services({ nodeTypes: types }),
    });

  it('runs the named tool and returns the item with its result', async () => {
    const calc = await runCall('Calculator', { input: '2 + 3' });
    expect(calc.status).toBe('success');
    const [item] = calc.output(TRIGGER);
    expect(item.mcpToolResult).toEqual({ content: [{ type: 'text', text: '5' }] });
    expect(item.mcpToolCall).toEqual({
      toolName: 'Calculator',
      arguments: { input: '2 + 3' },
      sourceNodeName: '',
    });
    expect(item.mcpMessageId).toBe(9);
    // the tool's own run is logged in the run data
    expect(calc.runData.Calculator).toHaveLength(1);

    const shout = await runCall('Shout', { query: 'hello' });
    expect(shout.output(TRIGGER)[0].mcpToolResult).toEqual({ content: [{ type: 'text', text: 'HELLO' }] });
  });

  it('passes arguments as data, never as expressions', async () => {
    const result = await runCall('echo', { text: '={{ $json.headers.host }}' });
    const text = (result.output(TRIGGER)[0].mcpToolResult as { content: Array<{ text: string }> }).content[0]
      .text;
    const answer = JSON.parse(text) as { args: DataObject; item: DataObject };
    expect(answer.args).toEqual({ text: '={{ $json.headers.host }}' });
    // the tool reads the trigger's item: body and redacted headers
    expect(answer.item.headers).toEqual({ host: 'h' });
  });

  it('answers an unknown tool with -32602 Tool not found', async () => {
    const result = await runCall('nope', {});
    expect(result.output(TRIGGER)[0].mcpError).toEqual({
      code: MCP_ERRORS.INVALID_PARAMS,
      message: 'Tool not found',
    });
  });

  it('passes an item without a tool call through', async () => {
    const result = await run([trigger(), ...toolNodes], toolLinks, {
      triggerItems: [{ json: { body: {}, headers: {} } }],
      nodeTypes: types,
      services: services({ nodeTypes: types }),
    });
    expect(result.output(TRIGGER)).toEqual([{ body: {}, headers: {} }]);
  });
});
