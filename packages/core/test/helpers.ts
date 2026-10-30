import type {
  Connections,
  CredentialType,
  DataObject,
  Item,
  NodeType,
  WorkflowDefinition,
  WorkflowNode,
} from '@workflow/workflow';
import { Workflow } from '@workflow/workflow';
import {
  CredentialTypes,
  type ExecutionServices,
  HttpClient,
  InlineBinaryDataStore,
  IsolatedVmCodeRunner,
  NodeTypes,
  silentLogger,
  WorkflowExecute,
} from '../src';

const main = ['main'] as const;

export const testNodes: NodeType[] = [
  {
    description: {
      name: 'test.trigger',
      displayName: 'Trigger',
      description: '',
      group: ['trigger'],
      version: 1,
      defaults: { name: 'Trigger' },
      inputs: [],
      outputs: [...main],
      properties: [],
    },
    async execute(ctx) {
      const items = ctx.getInputData();
      return [items.length ? items : [{ json: {} }]];
    },
  },
  {
    description: {
      name: 'test.set',
      displayName: 'Set',
      description: '',
      group: ['transform'],
      version: 1,
      defaults: { name: 'Set' },
      inputs: [...main],
      outputs: [...main],
      properties: [
        { displayName: 'Field', name: 'field', type: 'string', default: 'value' },
        { displayName: 'Value', name: 'value', type: 'string', default: '' },
      ],
    },
    async execute(ctx) {
      return [
        ctx.getInputData().map((item, i) => ({
          json: {
            ...item.json,
            [ctx.getNodeParameter('field', i) as string]: ctx.getNodeParameter('value', i),
          },
          pairedItem: { item: i },
        })),
      ];
    },
  },
  {
    description: {
      name: 'test.if',
      displayName: 'IF',
      description: '',
      group: ['transform'],
      version: 1,
      defaults: { name: 'IF' },
      inputs: [...main],
      outputs: ['main', 'main'],
      properties: [{ displayName: 'Condition', name: 'condition', type: 'boolean', default: false }],
    },
    async execute(ctx) {
      const t: Item[] = [];
      const f: Item[] = [];
      ctx.getInputData().forEach((item, i) => {
        (ctx.getNodeParameter('condition', i) ? t : f).push({ ...item, pairedItem: { item: i } });
      });
      return [t, f];
    },
  },
  {
    description: {
      name: 'test.merge',
      displayName: 'Merge',
      description: '',
      group: ['transform'],
      version: 1,
      defaults: { name: 'Merge' },
      inputs: ['main', 'main'],
      outputs: [...main],
      properties: [],
    },
    async execute(ctx) {
      return [[...ctx.getInputData(0), ...ctx.getInputData(1)]];
    },
  },
  {
    description: {
      name: 'test.fail',
      displayName: 'Fail',
      description: '',
      group: ['transform'],
      version: 1,
      defaults: { name: 'Fail' },
      inputs: [...main],
      outputs: [...main],
      properties: [{ displayName: 'Fail times', name: 'failTimes', type: 'number', default: 999 }],
    },
    async execute(ctx) {
      const state = ctx.getWorkflowStaticData('node');
      state.calls = ((state.calls as number) ?? 0) + 1;
      if ((state.calls as number) <= (ctx.getNodeParameter('failTimes', 0) as number)) {
        throw new Error(`boom ${state.calls}`);
      }
      return [ctx.getInputData()];
    },
  },
  {
    description: {
      name: 'test.wait',
      displayName: 'Wait',
      description: '',
      group: ['organization'],
      version: 1,
      defaults: { name: 'Wait' },
      inputs: [...main],
      outputs: [...main],
      properties: [],
    },
    async execute(ctx) {
      await ctx.putExecutionToWait(new Date(Date.now() + 3600_000));
      return [ctx.getInputData()];
    },
  },
  {
    description: {
      name: 'test.code',
      displayName: 'Code',
      description: '',
      group: ['transform'],
      version: 1,
      defaults: { name: 'Code' },
      inputs: [...main],
      outputs: [...main],
      properties: [
        { displayName: 'Code', name: 'code', type: 'string', default: '' },
        { displayName: 'Mode', name: 'mode', type: 'string', default: 'runOnceForAllItems' },
      ],
    },
    async execute(ctx) {
      const items = await ctx.runCode({
        code: ctx.getNodeParameter('code', 0, '', { rawExpressions: true }) as string,
        mode: ctx.getNodeParameter('mode', 0) as 'runOnceForAllItems',
      });
      return [items as Item[]];
    },
  },
  {
    description: {
      name: 'test.batches',
      displayName: 'Loop',
      description: '',
      group: ['organization'],
      version: 1,
      defaults: { name: 'Loop' },
      inputs: [...main],
      outputs: ['main', 'main'],
      outputNames: ['done', 'loop'],
      properties: [{ displayName: 'Batch size', name: 'batchSize', type: 'number', default: 1 }],
    },
    async execute(ctx) {
      const state = ctx.getContext('node');
      const size = ctx.getNodeParameter('batchSize', 0) as number;
      if (!state.items) {
        state.items = ctx.getInputData().map((i) => i.json);
        state.done = [];
      } else {
        (state.done as DataObject[]).push(...ctx.getInputData().map((i) => i.json));
      }
      const remaining = state.items as DataObject[];
      if (!remaining.length) {
        const done = state.done as DataObject[];
        return [done.map((json) => ({ json })), []];
      }
      const batch = remaining.splice(0, size);
      return [[], batch.map((json) => ({ json }))];
    },
  },
  {
    description: {
      name: 'test.model',
      displayName: 'Fake model',
      description: '',
      group: ['transform'],
      version: 1,
      defaults: { name: 'Model' },
      inputs: [],
      outputs: ['ai_languageModel'],
      properties: [{ displayName: 'Reply', name: 'reply', type: 'string', default: 'hi' }],
    },
    async supplyData(ctx, itemIndex) {
      const reply = ctx.getNodeParameter('reply', itemIndex) as string;
      return {
        response: {
          kind: 'chatModel',
          provider: 'fake',
          model: 'fake-1',
          chat: async () => {
            ctx.logSubNodeRun({ prompt: 'x' }, { reply });
            return { message: { role: 'assistant', content: reply } };
          },
        },
      };
    },
  },
  {
    description: {
      name: 'test.agent',
      displayName: 'Agent',
      description: '',
      group: ['transform'],
      version: 1,
      defaults: { name: 'Agent' },
      inputs: ['main', { type: 'ai_languageModel', required: true, maxConnections: 1 }],
      outputs: [...main],
      properties: [],
    },
    async execute(ctx) {
      const out: Item[] = [];
      for (let i = 0; i < ctx.getInputData().length; i++) {
        const model = (await ctx.getInputConnectionData('ai_languageModel', i)) as {
          chat: () => Promise<{ message: { content: string } }>;
        };
        const res = await model.chat();
        out.push({ json: { output: res.message.content }, pairedItem: { item: i } });
      }
      return [out];
    },
  },
];

testNodes.push({
  description: {
    name: 'test.credUser',
    displayName: 'Credential user',
    description: '',
    group: ['transform'],
    version: 1,
    defaults: { name: 'Credential user' },
    inputs: ['main'],
    outputs: ['main'],
    credentials: [{ name: 'apiKey', required: true }],
    properties: [],
  },
  async execute(ctx) {
    const items = ctx.getInputData();
    const out: Item[] = [];
    for (let i = 0; i < items.length; i++) {
      const creds = await ctx.getCredentials<{ key: string }>('apiKey', i);
      out.push({ json: { key: creds.key }, pairedItem: { item: i } });
    }
    return [out];
  },
});

export const testCredentialTypes: CredentialType[] = [
  {
    name: 'oAuth2Api',
    displayName: 'OAuth2',
    properties: [{ displayName: 'Client ID', name: 'clientId', type: 'string', default: '' }],
  },
  {
    name: 'apiKey',
    displayName: 'API key',
    properties: [
      { displayName: 'Key', name: 'key', type: 'string', default: '', typeOptions: { password: true } },
    ],
    authenticate: { type: 'generic', properties: { headers: { 'x-api-key': '={{$credentials.key}}' } } },
  },
];

export function node(
  name: string,
  type: string,
  position: [number, number] = [0, 0],
  extra: Partial<WorkflowNode> = {},
): WorkflowNode {
  return { id: name, name, type, typeVersion: 1, position, parameters: {}, ...extra };
}

export function connect(...pairs: Array<[string, string, number?, number?]>): Connections {
  const c: Connections = {};
  for (const [from, to, output = 0, input = 0] of pairs) {
    const outputs = ((c[from] ??= {}).main ??= []);
    while (outputs.length <= output) outputs.push([]);
    outputs[output]!.push({ node: to, type: 'main', index: input });
  }
  return c;
}

export const nodeTypes = new NodeTypes(testNodes);
export const credentialTypes = new CredentialTypes(testCredentialTypes);

export function services(overrides: Partial<ExecutionServices> = {}): ExecutionServices {
  return {
    tenantId: 't1',
    executionId: 'e1',
    mode: 'manual',
    timezone: 'UTC',
    variables: { greeting: 'hello' },
    instanceBaseUrl: 'http://localhost:5678',
    nodeTypes,
    credentialTypes,
    credentials: {
      get: async () => ({ key: 'secret' }),
      update: async () => {},
    },
    binaryData: new InlineBinaryDataStore(),
    codeRunner: new IsolatedVmCodeRunner({ timeoutMs: 2000, memoryLimitMb: 32 }),
    http: new HttpClient(),
    logger: silentLogger,
    ...overrides,
  };
}

export function execute(definition: WorkflowDefinition, overrides: Partial<ExecutionServices> = {}) {
  const workflow = new Workflow(definition, nodeTypes);
  return new WorkflowExecute(workflow, services(overrides));
}
