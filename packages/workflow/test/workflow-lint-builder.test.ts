/**
 * P5-09 builder lint: `lintForBuilder` gives every `lintWorkflow` issue a code and adds n8n's builder
 * checks (research-G section 1); `lintWorkflow` itself (the Doctor) is unchanged.
 */
import { describe, expect, it } from 'vitest';
import type { Connections, NodeTypeDescription, WorkflowNode } from '../src/interfaces';
import { type DescriptionLookup, type DoctorIssue, lintWorkflow } from '../src/workflow-lint';
import { lintForBuilder } from '../src/workflow-lint-builder';

function type(partial: Partial<NodeTypeDescription> & { name: string }): NodeTypeDescription {
  return {
    displayName: partial.name,
    description: '',
    group: ['transform'],
    version: 1,
    defaults: { name: partial.name },
    inputs: ['main'],
    outputs: ['main'],
    properties: [],
    ...partial,
  };
}

const descriptions: NodeTypeDescription[] = [
  type({ name: 'core.manualTrigger', group: ['trigger'], inputs: [], outputs: ['main'] }),
  type({
    name: 'core.set',
    properties: [
      {
        displayName: 'Mode',
        name: 'mode',
        type: 'options',
        default: 'manual',
        options: [
          { name: 'Manual Mapping', value: 'manual' },
          { name: 'JSON', value: 'raw' },
        ],
      },
      {
        displayName: 'Fields to Set',
        name: 'assignments',
        type: 'assignmentCollection',
        default: {},
        displayOptions: { show: { mode: ['manual'] } },
      },
    ],
  }),
  type({
    name: 'core.httpRequest',
    properties: [
      { displayName: 'URL', name: 'url', type: 'string', default: '', required: true },
      {
        displayName: 'Model',
        name: 'model',
        type: 'options',
        default: '',
        typeOptions: { loadOptionsMethod: 'listModels' },
        options: [],
      },
      { displayName: 'Send Headers', name: 'sendHeaders', type: 'boolean', default: false },
      {
        displayName: 'Header Parameters',
        name: 'headerParameters',
        type: 'fixedCollection',
        default: {},
        displayOptions: { show: { sendHeaders: [true] } },
        options: [],
      },
    ],
    credentials: [{ name: 'httpBasicAuth', required: true }],
  }),
  type({
    name: 'core.merge',
    inputs: `={{ Array.from({ length: Number($parameter.numberInputs ?? 2) }, () => 'main') }}`,
    properties: [{ displayName: 'Number of Inputs', name: 'numberInputs', type: 'number', default: 2 }],
  }),
  type({
    name: 'ai.agent',
    inputs: [
      'main',
      { type: 'ai_languageModel', displayName: 'Chat Model', required: true, maxConnections: 1 },
      { type: 'ai_tool', displayName: 'Tool' },
    ],
    properties: [
      {
        displayName: 'Source for Prompt',
        name: 'promptType',
        type: 'options',
        default: 'auto',
        options: [
          { name: 'Connected Chat Trigger Node', value: 'auto' },
          { name: 'Define Below', value: 'define' },
        ],
      },
      {
        displayName: 'Prompt (User Message)',
        name: 'text',
        type: 'string',
        default: '',
        required: true,
        displayOptions: { show: { promptType: ['define'] } },
      },
      { displayName: 'System Message', name: 'systemMessage', type: 'string', default: 'You help' },
    ],
  }),
  type({ name: 'ai.lmChatTest', inputs: [], outputs: ['ai_languageModel'] }),
  type({
    name: 'core.calculatorTool',
    inputs: [],
    outputs: ['ai_tool'],
    properties: [{ displayName: 'Expression', name: 'expression', type: 'string', default: '' }],
  }),
  type({
    name: 'core.webhook',
    group: ['trigger'],
    inputs: [],
    webhooks: [{ name: 'default', httpMethod: 'POST', path: 'hook', responseMode: 'onReceived' }],
    properties: [
      {
        displayName: 'Respond',
        name: 'responseMode',
        type: 'options',
        default: 'onReceived',
        options: [
          { name: 'Immediately', value: 'onReceived' },
          { name: 'Using Respond to Webhook Node', value: 'responseNode' },
        ],
      },
    ],
  }),
  type({ name: 'core.respondToWebhook' }),
  type({
    name: 'core.dataTable',
    properties: [
      {
        displayName: 'Resource',
        name: 'resource',
        type: 'options',
        default: 'row',
        options: [
          { name: 'Row', value: 'row' },
          { name: 'Table', value: 'table' },
        ],
      },
      {
        displayName: 'Operation',
        name: 'operation',
        type: 'options',
        default: 'insert',
        options: [
          { name: 'Insert', value: 'insert' },
          { name: 'Get', value: 'get' },
        ],
      },
    ],
  }),
  type({ name: 'core.once', maxNodes: 1 }),
];

const types: DescriptionLookup = {
  get: (name) => descriptions.find((d) => d.name === name),
};

let seq = 0;
function node(name: string, nodeType: string, parameters: Record<string, unknown> = {}): WorkflowNode {
  return {
    id: `n${++seq}`,
    name,
    type: nodeType,
    typeVersion: 1,
    position: [0, 0],
    parameters,
  } as WorkflowNode;
}

function main(...pairs: Array<[string, string, number?]>): Connections {
  const connections: Connections = {};
  for (const [from, to, index = 0] of pairs) {
    const list = (connections[from] ??= { main: [[]] }).main as Array<
      Array<{ node: string; type: 'main'; index: number }>
    >;
    list[0].push({ node: to, type: 'main', index });
  }
  return connections;
}

function lint(nodes: WorkflowNode[], connections: Connections = {}): DoctorIssue[] {
  return lintForBuilder({ nodes, connections }, types);
}

const codes = (issues: DoctorIssue[]) => issues.map((i) => i.code);
const byCode = (issues: DoctorIssue[], code: string) => issues.filter((i) => i.code === code);
const trigger = () => node('Start', 'core.manualTrigger');

describe('lintForBuilder: codes on the Doctor checks', () => {
  it('codes the required parameter, unknown type, missing trigger and credential issues', () => {
    const issues = lint([node('Fetch', 'core.httpRequest'), node('Odd', 'core.nope')]);
    expect(byCode(issues, 'node-missing-required-parameter')[0]).toMatchObject({
      node: 'Fetch',
      severity: 'error',
      message: '"URL" is required',
    });
    expect(byCode(issues, 'node-type-not-found')[0]).toMatchObject({ node: 'Odd', severity: 'error' });
    expect(byCode(issues, 'workflow-has-no-trigger')[0]?.severity).toBe('warning');
    // the builder never sets credentials: a missing one is only information
    expect(byCode(issues, 'node-missing-credentials')[0]).toMatchObject({ node: 'Fetch', severity: 'info' });
  });

  it('leaves lintWorkflow (the Doctor) as it was: no codes, the credential is an error there', () => {
    const graph = {
      nodes: [node('Fetch', 'core.httpRequest', { url: 'https://example.com' })],
      connections: {},
    };
    const doctor = lintWorkflow(graph, types);
    expect(doctor.every((i) => i.code === undefined)).toBe(true);
    expect(doctor.find((i) => i.message.startsWith('Needs a "httpBasicAuth"'))?.severity).toBe('error');
  });

  it('flags an empty workflow and too many nodes of a type', () => {
    expect(codes(lint([]))).toContain('workflow-has-no-nodes');
    const issues = lint(
      [trigger(), node('A', 'core.once'), node('B', 'core.once')],
      main(['Start', 'A'], ['Start', 'B']),
    );
    expect(codes(issues)).toContain('workflow-exceeds-max-nodes-limit');
  });

  it('a clean manual trigger to set workflow has no error or warning', () => {
    const issues = lint(
      [trigger(), node('Set', 'core.set', { mode: 'manual', assignments: { assignments: [] } })],
      main(['Start', 'Set']),
    );
    expect(issues.filter((i) => i.severity !== 'info')).toEqual([]);
  });
});

describe('lintForBuilder: the builder checks', () => {
  it('node-invalid-options-value: a fixed value outside the options; expressions and loaded lists pass', () => {
    const bad = lint([trigger(), node('Set', 'core.set', { mode: 'yaml' })], main(['Start', 'Set']));
    expect(byCode(bad, 'node-invalid-options-value')[0]).toMatchObject({ node: 'Set', severity: 'error' });
    const expression = lint(
      [trigger(), node('Set', 'core.set', { mode: '={{ "raw" }}' })],
      main(['Start', 'Set']),
    );
    expect(codes(expression)).not.toContain('node-invalid-options-value');
    const loaded = lint(
      [trigger(), node('Fetch', 'core.httpRequest', { url: 'https://x.test', model: 'gpt-x' })],
      main(['Start', 'Fetch']),
    );
    expect(codes(loaded)).not.toContain('node-invalid-options-value');
  });

  it('non-tool-node-uses-fromai: only a node an agent calls as a tool may use $fromAI', () => {
    const fromAi = "={{ $fromAI('city', 'the city', 'string') }}";
    const set = lint([trigger(), node('Set', 'core.set', { mode: fromAi })], main(['Start', 'Set']));
    expect(byCode(set, 'non-tool-node-uses-fromai')[0]?.node).toBe('Set');
    const tool = lint([node('Calc', 'core.calculatorTool', { expression: fromAi })]);
    expect(codes(tool)).not.toContain('non-tool-node-uses-fromai');
  });

  it('tool-node-has-no-parameters', () => {
    const issues = lint([node('Calc', 'core.calculatorTool')]);
    expect(byCode(issues, 'tool-node-has-no-parameters')[0]?.node).toBe('Calc');
  });

  it('agent-static-prompt and agent-no-system-prompt; a mapped prompt with a system message passes', () => {
    const agentIssues = (parameters: Record<string, unknown>) => {
      const nodes = [trigger(), node('Agent', 'ai.agent', parameters), node('Model', 'ai.lmChatTest')];
      const connections = main(['Start', 'Agent']);
      connections.Model = { ai_languageModel: [[{ node: 'Agent', type: 'ai_languageModel', index: 0 }]] };
      return lint(nodes, connections);
    };
    const fixed = agentIssues({ promptType: 'define', text: 'Write a poem' });
    expect(codes(fixed)).toEqual(expect.arrayContaining(['agent-static-prompt', 'agent-no-system-prompt']));
    const good = agentIssues({
      promptType: 'define',
      text: '={{ $json.text }}',
      systemMessage: 'You write poems',
    });
    expect(codes(good)).not.toContain('agent-static-prompt');
    expect(codes(good)).not.toContain('agent-no-system-prompt');
    expect(good.filter((i) => i.severity === 'error')).toEqual([]);
  });

  it('node-missing-required-input and sub-node-not-connected', () => {
    const issues = lint(
      [trigger(), node('Agent', 'ai.agent', { systemMessage: 'x' }), node('Model', 'ai.lmChatTest')],
      main(['Start', 'Agent']),
    );
    expect(byCode(issues, 'node-missing-required-input')[0]?.node).toBe('Agent');
    expect(byCode(issues, 'sub-node-not-connected')[0]?.node).toBe('Model');
  });

  it('node-unsupported-connection-input: a cable of the wrong type, and too many on a single input', () => {
    const nodes = [
      trigger(),
      node('Agent', 'ai.agent', { systemMessage: 'x' }),
      node('M1', 'ai.lmChatTest'),
      node('M2', 'ai.lmChatTest'),
    ];
    const connections = main(['Start', 'Agent']);
    connections.M1 = { ai_languageModel: [[{ node: 'Agent', type: 'ai_languageModel', index: 0 }]] };
    connections.M2 = { ai_languageModel: [[{ node: 'Agent', type: 'ai_languageModel', index: 0 }]] };
    // main into the agent's tool input
    connections.Start.main![0]!.push({ node: 'Agent', type: 'ai_tool', index: 0 });
    const issues = byCode(lint(nodes, connections), 'node-unsupported-connection-input');
    expect(issues.length).toBe(2);
    expect(issues.map((i) => i.message).join(' ')).toContain('takes 1');
  });

  it('http-request-hardcoded-credentials: a fixed authorization header; an expression passes', () => {
    const http = (value: string) =>
      lint(
        [
          trigger(),
          node('Fetch', 'core.httpRequest', {
            url: 'https://api.example.com',
            sendHeaders: true,
            headerParameters: { parameters: [{ name: 'Authorization', value }] },
          }),
        ],
        main(['Start', 'Fetch']),
      );
    expect(byCode(http('Bearer abc'), 'http-request-hardcoded-credentials')[0]?.node).toBe('Fetch');
    expect(codes(http('={{ $json.token }}'))).not.toContain('http-request-hardcoded-credentials');
  });

  it('set-node-credential-field', () => {
    const issues = lint(
      [
        trigger(),
        node('Set', 'core.set', {
          mode: 'manual',
          assignments: { assignments: [{ id: '1', name: 'apiKey', value: 'abc123', type: 'string' }] },
        }),
      ],
      main(['Start', 'Set']),
    );
    expect(byCode(issues, 'set-node-credential-field')[0]?.node).toBe('Set');
  });

  it('node-merge-single-input and node-merge-missing-input', () => {
    const single = lint([trigger(), node('Merge', 'core.merge')], main(['Start', 'Merge']));
    expect(codes(single)).toContain('node-merge-single-input');
    const three = lint(
      [trigger(), node('A', 'core.set', { mode: 'raw' }), node('Merge', 'core.merge', { numberInputs: 3 })],
      main(['Start', 'A'], ['Start', 'Merge', 0], ['A', 'Merge', 1]),
    );
    expect(byCode(three, 'node-merge-missing-input')[0]?.message).toContain('Input 3');
    const both = lint(
      [trigger(), node('A', 'core.set', { mode: 'raw' }), node('Merge', 'core.merge')],
      main(['Start', 'A'], ['Start', 'Merge', 0], ['A', 'Merge', 1]),
    );
    expect(codes(both)).not.toContain('node-merge-single-input');
    expect(codes(both)).not.toContain('node-merge-missing-input');
  });

  it('data-table-missing-set-node: a row write needs a Set node before it', () => {
    const bare = lint([trigger(), node('Table', 'core.dataTable')], main(['Start', 'Table']));
    expect(byCode(bare, 'data-table-missing-set-node')[0]?.node).toBe('Table');
    const shaped = lint(
      [trigger(), node('Set', 'core.set', { mode: 'raw' }), node('Table', 'core.dataTable')],
      main(['Start', 'Set'], ['Set', 'Table']),
    );
    expect(codes(shaped)).not.toContain('data-table-missing-set-node');
    const read = lint(
      [trigger(), node('Table', 'core.dataTable', { operation: 'get' })],
      main(['Start', 'Table']),
    );
    expect(codes(read)).not.toContain('data-table-missing-set-node');
  });

  it('webhook response: the respond node is needed and needs a webhook that waits for it', () => {
    const missing = lint([node('Hook', 'core.webhook', { responseMode: 'responseNode' })]);
    expect(byCode(missing, 'webhook-response-node-missing')[0]).toMatchObject({
      node: 'Hook',
      severity: 'error',
    });
    const lonely = lint(
      [node('Hook', 'core.webhook'), node('Reply', 'core.respondToWebhook')],
      main(['Hook', 'Reply']),
    );
    expect(codes(lonely)).toContain('respond-to-webhook-without-webhook');
    const paired = lint(
      [
        node('Hook', 'core.webhook', { responseMode: 'responseNode' }),
        node('Reply', 'core.respondToWebhook'),
      ],
      main(['Hook', 'Reply']),
    );
    expect(codes(paired)).not.toContain('webhook-response-node-missing');
    expect(codes(paired)).not.toContain('respond-to-webhook-without-webhook');
  });

  it('sorts errors first and gives every issue a unique id', () => {
    const issues = lint([node('Fetch', 'core.httpRequest'), node('Calc', 'core.calculatorTool')]);
    const ranks = issues.map((i) => ({ error: 0, warning: 1, info: 2 })[i.severity]);
    expect(ranks).toEqual([...ranks].sort((a, b) => a - b));
    expect(new Set(issues.map((i) => i.id)).size).toBe(issues.length);
  });
});
