/** Phase 5 S4 contract step, C0a: MCP protocol, builder contracts, lint move, context and type additions. */
import { describe, expect, expectTypeOf, it } from 'vitest';
import {
  AI_PORT_LABELS,
  type AiTool,
  BUILDER_COMPACT_TOKENS,
  BUILDER_CONTEXT_TOKENS,
  BUILDER_EXECUTION_DATA_LIMIT,
  BUILDER_MAX_ITERATIONS,
  BUILDER_MAX_VALIDATE_ATTEMPTS,
  BUILDER_PROMPT_LIMIT,
  BUILDER_PROMPT_TOO_LONG,
  BUILDER_TRIM_STEPS,
  BUILDER_VALUE_LIMIT,
  BUILDER_WEB_FETCH,
  type BuilderChunk,
  type BuilderMessage,
  type BuilderMode,
  type BuilderResume,
  type BuildRequest,
  canConnect,
  checkMcpRoutingHeaders,
  type DescriptionLookup,
  type DoctorInput,
  type DoctorIssue,
  deriveNodePorts,
  type GraphConnectionRef,
  getAncestors,
  getMainParents,
  issuesByNode,
  type JsonRpcNotification,
  type JsonRpcRequest,
  type JsonRpcResponse,
  type LintGraph,
  lintForBuilder,
  lintWorkflow,
  listConnections,
  MCP_ERRORS,
  MCP_LATEST_REVISION,
  MCP_LEGACY_REVISIONS,
  type McpAuthHelper,
  type McpCallResult,
  type McpMessage,
  type McpToolDescriptor,
  mcpDiscoverResult,
  mcpError,
  mcpErrorResult,
  mcpInitializeResult,
  mcpResult,
  mcpResultFromValue,
  type NodeTypeDescription,
  negotiateMcpVersion,
  parseMcpMessage,
  type WebhookContext,
  type WebhookDescription,
  type WorkflowDefinition,
  type WorkflowNode,
  type WorkflowSettings,
} from '../src';

/** reads a source file of this package; `process.getBuiltinModule` keeps the test free of Node type imports */
function readSource(file: string): string {
  const proc = (globalThis as { process?: { getBuiltinModule(id: string): unknown } }).process;
  const fs = proc?.getBuiltinModule('node:fs') as { readFileSync(path: URL, encoding: 'utf8'): string };
  return fs.readFileSync(new URL(`../src/${file}`, import.meta.url), 'utf8');
}

describe('workflow settings and webhook types', () => {
  it('carries availableInMCP on a typed WorkflowSettings value', () => {
    const settings: WorkflowSettings = { executionOrder: 'v1', availableInMCP: true };
    expect(settings.availableInMCP).toBe(true);
    expectTypeOf<WorkflowSettings['availableInMCP']>().toEqualTypeOf<boolean | undefined>();
  });

  it('allows the mcp webhook node type', () => {
    expectTypeOf<WebhookDescription['nodeType']>().toEqualTypeOf<'form' | 'mcp' | undefined>();
  });

  it('has an optional getMcpAuth on WebhookContext and the McpAuthHelper shape', () => {
    expectTypeOf<WebhookContext['getMcpAuth']>().toEqualTypeOf<
      (() => McpAuthHelper | undefined) | undefined
    >();
    expectTypeOf<McpAuthHelper['verifyAccessToken']>().returns.resolves.toEqualTypeOf<{
      user: { id: string; email: string; firstName: string; lastName: string };
      role: string;
    } | null>();
    expectTypeOf<McpAuthHelper['canExecute']>().returns.resolves.toEqualTypeOf<boolean>();
    expectTypeOf<McpAuthHelper['challenge']>().returns.toEqualTypeOf<string>();
  });

  it('has an optional invokeRaw on AiTool that keeps the content array', () => {
    expectTypeOf<AiTool['invokeRaw']>().toEqualTypeOf<
      | ((
          args: Record<string, unknown>,
          options?: { signal?: AbortSignal; toolCallId?: string },
        ) => Promise<McpCallResult>)
      | undefined
    >();
  });
});

describe('mcp protocol contracts', () => {
  it('exports the revisions and error codes', () => {
    expect(MCP_LATEST_REVISION).toBe('2026-07-28');
    expect(MCP_LEGACY_REVISIONS).toEqual(['2025-11-25', '2025-06-18', '2025-03-26', '2024-11-05']);
    expect(MCP_ERRORS).toEqual({
      PARSE: -32700,
      INVALID_REQUEST: -32600,
      METHOD_NOT_FOUND: -32601,
      INVALID_PARAMS: -32602,
      INTERNAL: -32603,
      HEADER_MISMATCH: -32020,
    });
  });

  it('exports the protocol functions and message types', () => {
    for (const fn of [
      parseMcpMessage,
      negotiateMcpVersion,
      mcpResult,
      mcpError,
      mcpInitializeResult,
      mcpDiscoverResult,
      checkMcpRoutingHeaders,
      mcpResultFromValue,
      mcpErrorResult,
    ]) {
      expect(typeof fn).toBe('function');
    }
    expectTypeOf<McpMessage['kind']>().toEqualTypeOf<'request' | 'notification' | 'response' | 'invalid'>();
    expectTypeOf<Extract<McpMessage, { kind: 'request' }>['message']>().toEqualTypeOf<JsonRpcRequest>();
    expectTypeOf<
      Extract<McpMessage, { kind: 'notification' }>['message']
    >().toEqualTypeOf<JsonRpcNotification>();
    expectTypeOf<Extract<McpMessage, { kind: 'invalid' }>['id']>().toEqualTypeOf<string | number | null>();
    expectTypeOf(mcpResult).returns.toEqualTypeOf<JsonRpcResponse>();
    expectTypeOf(mcpErrorResult).returns.toEqualTypeOf<McpCallResult>();
    expectTypeOf(checkMcpRoutingHeaders).returns.toEqualTypeOf<{ code: number; text: string } | null>();
    const tool: McpToolDescriptor = { name: 'run', inputSchema: { type: 'object' } };
    const result: McpCallResult = { content: [{ type: 'text', text: 'ok' }], isError: false };
    expect(tool.name).toBe('run');
    expect(result.content[0].type).toBe('text');
  });
});

describe('builder contracts', () => {
  it('exports the limits', () => {
    expect(BUILDER_PROMPT_LIMIT).toBe(5000);
    expect(BUILDER_PROMPT_TOO_LONG).toBe('Message exceeds maximum length of 5000 characters');
    expect(BUILDER_MAX_ITERATIONS).toBe(50);
    expect(BUILDER_MAX_VALIDATE_ATTEMPTS).toBe(10);
    expect(BUILDER_CONTEXT_TOKENS).toBe(30000);
    expect(BUILDER_TRIM_STEPS).toEqual([10000, 5000, 2000, 1000]);
    expect(BUILDER_VALUE_LIMIT).toBe(30000);
    expect(BUILDER_EXECUTION_DATA_LIMIT).toBe(10000);
    expect(BUILDER_COMPACT_TOKENS).toBe(150000);
    expect(BUILDER_WEB_FETCH).toEqual({ perTurn: 3, timeoutMs: 20000, maxBytes: 2097152, maxChars: 30000 });
  });

  it('types the request, resume data, messages and chunks', () => {
    expectTypeOf<BuilderMode>().toEqualTypeOf<'build' | 'plan'>();
    const request: BuildRequest = {
      workflowId: 'wf',
      text: 'Build a webhook flow',
      mode: 'plan',
      resumeData: { planDecision: 'modify', feedback: 'Add a Slack step' },
    };
    const resumes: BuilderResume[] = [
      { answers: [{ id: 'q1', answer: 'Daily' }] },
      { planDecision: 'approve' },
      { webFetch: { url: 'https://example.com/docs', decision: 'deny' } },
    ];
    const message: BuilderMessage = {
      id: 'm1',
      role: 'assistant',
      text: 'Here is the plan',
      createdAt: '2026-11-08T00:00:00.000Z',
      plan: { summary: 'Sync', steps: [{ description: 'Read rows', nodeTypes: ['core.set'] }] },
      questions: [{ id: 'q1', question: 'How often?', type: 'single', options: ['Daily', 'Hourly'] }],
    };
    expect(request.resumeData).toEqual({ planDecision: 'modify', feedback: 'Add a Slack step' });
    expect(resumes).toHaveLength(3);
    expect(message.plan?.steps).toHaveLength(1);
    expectTypeOf<BuilderChunk['type']>().toEqualTypeOf<
      | 'message'
      | 'tool'
      | 'workflow-updated'
      | 'execution-requested'
      | 'questions'
      | 'plan'
      | 'session-messages'
      | 'web-fetch-approval'
      | 'error'
    >();
    expectTypeOf<
      Extract<BuilderChunk, { type: 'workflow-updated' }>['workflow']
    >().toEqualTypeOf<WorkflowDefinition>();
    expectTypeOf<Extract<BuilderChunk, { type: 'session-messages' }>['messages']>().toEqualTypeOf<
      BuilderMessage[]
    >();
  });
});

describe('the three new files use no Node API', () => {
  it.each(['mcp-protocol.ts', 'ai-builder.ts', 'workflow-lint.ts', 'workflow-lint-builder.ts'])(
    '%s',
    (file) => {
      const source = readSource(file);
      expect(source).not.toMatch(/from\s+['"]node:/);
      expect(source).not.toMatch(/require\(/);
      expect(source).not.toMatch(/\bprocess\./);
      expect(source).not.toMatch(/\bBuffer\b/);
      expect(source).not.toMatch(
        /from\s+['"](fs|path|os|crypto|http|https|net|url|stream|child_process)['"]/,
      );
    },
  );
});

const description: NodeTypeDescription = {
  name: 'test.send',
  displayName: 'Send',
  description: 'Sends a message',
  group: ['output'],
  version: 1,
  defaults: { name: 'Send' },
  inputs: ['main'],
  outputs: ['main'],
  properties: [{ displayName: 'Channel', name: 'channel', type: 'string', default: '', required: true }],
};
const trigger: NodeTypeDescription = {
  name: 'test.trigger',
  displayName: 'Start',
  description: 'Starts the flow',
  group: ['trigger'],
  version: 1,
  defaults: { name: 'Start' },
  inputs: [],
  outputs: ['main'],
  properties: [],
};
const lookup: DescriptionLookup = {
  get: (type) => [description, trigger].find((d) => d.name === type),
};
const node = (name: string, type: string, parameters: Record<string, unknown> = {}): WorkflowNode => ({
  id: name,
  name,
  type,
  typeVersion: 1,
  position: [0, 0],
  parameters,
});
const graph: DoctorInput = {
  nodes: [node('Start', 'test.trigger'), node('Send', 'test.send')],
  connections: { Start: { main: [[{ node: 'Send', type: 'main', index: 0 }]] } },
};

describe('workflow lint (moved from the editor)', () => {
  it('reports a missing required parameter', () => {
    const issues = lintWorkflow(graph, lookup);
    expect(issues).toEqual([
      expect.objectContaining({ severity: 'error', node: 'Send', message: '"Channel" is required' }),
    ]);
    expect(issuesByNode(issues).get('Send')).toHaveLength(1);
    const filled = lintWorkflow(
      { ...graph, nodes: [graph.nodes[0], node('Send', 'test.send', { channel: '#ops' })] },
      lookup,
    );
    expect(filled).toEqual([]);
  });

  it('lintForBuilder gives the lintWorkflow issues in C0', () => {
    expect(lintForBuilder(graph, lookup)).toEqual(lintWorkflow(graph, lookup));
  });

  it('keeps the port and graph helpers', () => {
    const refs: GraphConnectionRef[] = listConnections(graph.connections);
    expect(refs).toEqual([
      {
        source: 'Start',
        sourceType: 'main',
        sourceIndex: 0,
        target: 'Send',
        targetType: 'main',
        targetIndex: 0,
      },
    ]);
    expect(getMainParents(graph.connections, 'Send')).toEqual([
      { node: 'Start', outputIndex: 0, inputIndex: 0 },
    ]);
    expect(getAncestors(graph.connections, 'Send')).toEqual(['Start']);
    expect(AI_PORT_LABELS.ai_reranker).toBe('Reranker');
    const ports = deriveNodePorts(graph.nodes[1], description);
    expect(ports.nodeType).toBe('test.send');
    expect(ports.inputs[0].filter).toBeUndefined();
    expect(
      canConnect(
        { source: 'Send', sourceHandle: 'out:main:0', target: 'Send', targetHandle: 'in:main:0' },
        graph.connections,
        () => ports,
      ),
    ).toBe(false);
    const lintGraph: LintGraph = { nodes: graph.nodes, connections: graph.connections };
    expect(lintGraph.nodes).toHaveLength(2);
    expectTypeOf<DoctorIssue['code']>().toEqualTypeOf<string | undefined>();
  });
});
