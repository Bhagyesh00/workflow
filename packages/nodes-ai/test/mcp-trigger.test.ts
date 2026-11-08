/**
 * P5-03 MCP Server Trigger, node side: the protocol helpers of shared/mcp-server.ts, the node's `webhook`
 * (auth, `initialize`, `server/discover`, `tools/list` with sub-nodes, the base item of every other message)
 * and its `execute` (one tool call inside a run, arguments as data).
 */
import { type ContextDeps, createWebhookContext, createWebhookSubNodes, NodeTypes } from '@workflow/core';
import {
  type AiTool,
  type DataObject,
  ExpressionEvaluator,
  MCP_ERRORS,
  MCP_LATEST_REVISION,
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
  options: { webhookName?: string; subNodes?: boolean } = {},
): Promise<WebhookResponseData> {
  const triggerNode = trigger(parameters);
  const workflow = new Workflow(
    { id: 'wf1', name: 'mcp', nodes: [triggerNode, ...toolNodes], connections: toolLinks },
    types,
  );
  const deps: ContextDeps = {
    workflow,
    node: triggerNode,
    services: services({ creds: CREDS, mode: 'webhook', nodeTypes: types }),
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
  const body = full.body;
  const subNodes = options.subNodes ? createWebhookSubNodes(deps, { json: { body } as DataObject }) : undefined;
  try {
    const ctx = createWebhookContext(deps, full, options.webhookName ?? 'default', subNodes?.callbacks);
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
        throw new ToolSuspension({ toolNode: 'Add', waitTill: new Date(), toolName: 'add', toolCallId: 'c1' });
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
    const latest = await callWebhook({}, { body: rpc('initialize', { protocolVersion: MCP_LATEST_REVISION }) });
    expect((latest.webhookResponse?.body as { result: DataObject }).result.protocolVersion).toBe('2025-11-25');
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

  it('lists the connected tools only with sub-nodes, seeing the body as $json.body', async () => {
    const result = await callWebhook({}, { body: rpc('tools/list') }, { subNodes: true });
    const tools = (result.webhookResponse?.body as { result: { tools: DataObject[] } }).result.tools;
    expect(tools.map((t) => t.name)).toEqual(['Calculator', 'Shout', 'echo']);
    expect(tools[0].inputSchema).toMatchObject({ type: 'object', required: ['input'] });
    // without sub-nodes (ping, notifications) the node builds no tool
    await expect(callWebhook({}, { body: rpc('tools/list') })).rejects.toThrow('Sub-nodes are not available here');
  });

  it('hands every other message to the run as the base item, auth headers redacted', async () => {
    const body = rpc('tools/call', { name: 'Calculator', arguments: { input: '1+1' } });
    const result = await callWebhook(
      {},
      { body, headers: { host: 'h', authorization: 'Bearer abc', cookie: 'c=1', accept: 'application/json' } },
    );
    expect(result.webhookResponse).toBeUndefined();
    expect(result.workflowData).toEqual([
      [
        {
          json: {
            body,
            headers: { host: 'h', authorization: MCP_REDACTED, cookie: MCP_REDACTED, accept: 'application/json' },
          },
        },
      ],
    ]);
    expect(result.customData).toEqual({ mcpSubject: '' });
  });

  it('checks a Bearer token: 401 with WWW-Authenticate when missing or wrong', async () => {
    const parameters = { authentication: 'bearerAuth' };
    for (const authorization of [undefined, 'Bearer wrong', 'Basic secret-bearer-token', 'secret-bearer-token']) {
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
    expect((ok.workflowData?.[0][0].json.headers as DataObject).authorization).toBe(MCP_REDACTED);
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

  it('refuses workspace sign-in until the OAuth check exists', async () => {
    const result = await callWebhook({ authentication: 'n8nOAuth2' }, { body: rpc('ping') });
    expect(result.workflowData).toBeUndefined();
    expect(result.webhookResponse?.statusCode).toBe(401);
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
    expect(item.mcpToolCall).toEqual({ toolName: 'Calculator', arguments: { input: '2 + 3' }, sourceNodeName: '' });
    expect(item.mcpMessageId).toBe(9);
    // the tool's own run is logged in the run data
    expect(calc.runData.Calculator).toHaveLength(1);

    const shout = await runCall('Shout', { query: 'hello' });
    expect(shout.output(TRIGGER)[0].mcpToolResult).toEqual({ content: [{ type: 'text', text: 'HELLO' }] });
  });

  it('passes arguments as data, never as expressions', async () => {
    const result = await runCall('echo', { text: '={{ $json.headers.host }}' });
    const text = (result.output(TRIGGER)[0].mcpToolResult as { content: Array<{ text: string }> }).content[0].text;
    const answer = JSON.parse(text) as { args: DataObject; item: DataObject };
    expect(answer.args).toEqual({ text: '={{ $json.headers.host }}' });
    // the tool reads the trigger's item: body and redacted headers
    expect(answer.item.headers).toEqual({ host: 'h' });
  });

  it('answers an unknown tool with -32602 Tool not found', async () => {
    const result = await runCall('nope', {});
    expect(result.output(TRIGGER)[0].mcpError).toEqual({ code: MCP_ERRORS.INVALID_PARAMS, message: 'Tool not found' });
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
