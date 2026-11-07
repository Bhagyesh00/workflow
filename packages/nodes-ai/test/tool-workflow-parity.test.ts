import { NodeTypes, createBaseContext, type ExecutionServices } from '@workflow/core';
import {
  type DataObject,
  ExpressionEvaluator,
  type Item,
  type LoadOptionsContext,
  Workflow,
  type WorkflowDefinition,
  type WorkflowNode,
} from '@workflow/workflow';
import { describe, expect, it } from 'vitest';
import { ToolWorkflowNode } from '../src/nodes/tools/tools.nodes';
import { connect, node, run, scriptModel, services, toolCalls } from './harness';

const SUB = (inputs: Array<{ name: string; type: string }>, inputSource = 'workflowInputs'): WorkflowDefinition => ({
  name: 'Orders',
  nodes: [
    {
      id: 't',
      name: 'When Executed',
      type: 'core.executeWorkflowTrigger',
      typeVersion: 1,
      position: [0, 0],
      parameters: { inputSource, workflowInputs: { values: inputs } },
    } as WorkflowNode,
  ],
  connections: {},
});

function loadCtx(
  current: Record<string, unknown>,
  extra: Partial<LoadOptionsContext> = {},
): LoadOptionsContext {
  const n = node('Tool', 'ai.toolWorkflow');
  const nodeTypes = new NodeTypes([ToolWorkflowNode]);
  const base = createBaseContext({
    workflow: new Workflow({ name: 'w', nodes: [n], connections: {} }, nodeTypes),
    node: n,
    services: services({ nodeTypes }),
    evaluator: new ExpressionEvaluator(),
    signal: new AbortController().signal,
  });
  const { getNodeParameter: _omit, ...rest } = base;
  return { ...rest, getCurrentNodeParameter: (name: string) => current[name], ...extra };
}

/** an agent whose scripted model calls the workflow tool with `args`, and the sub-workflow items it received */
async function callTool(parameters: DataObject, args: DataObject) {
  const received: Array<{ source: unknown; items: Item[] }> = [];
  const svc: ExecutionServices = services({
    executeSubWorkflow: async ({ source, items }) => {
      received.push({ source, items });
      return { executionId: 's1', data: [[{ json: { response: 'ok' } }]] };
    },
  });
  const requests = scriptModel('Model', [toolCalls(['Order_tool', args, 'c1']), 'done']);
  const result = await run(
    [
      node('Trigger', 'test.trigger'),
      node('Agent', 'ai.agent', { promptType: 'define', text: 'go', options: { returnIntermediateSteps: true } }),
      node('Model', 'test.fakeChatModel'),
      node('Order tool', 'ai.toolWorkflow', { toolDescription: 'Order lookup', ...parameters }),
    ],
    connect(['Trigger', 'Agent'], ['Model', 'Agent', 'ai_languageModel'], ['Order tool', 'Agent', 'ai_tool']),
    { services: svc },
  );
  return { result, received, requests };
}

const mapping = (value: DataObject | null, schema: unknown[] = []) => ({
  mappingMode: 'defineBelow',
  value,
  matchingColumns: [],
  schema,
  attemptToConvertTypes: false,
  convertFieldsToString: false,
});

describe('Call Workflow Tool parity', () => {
  it('an agent fills the sub-workflow inputs through $fromAI and the schema follows the mapping', async () => {
    const { result, received, requests } = await callTool(
      {
        workflowId: { __rl: true, mode: 'list', value: 'wf-1' },
        workflowInputs: mapping({
          orderId: "={{ $fromAI('orderId', 'The order id', 'string') }}",
          quantity: "={{ $fromAI('quantity', 'How many', 'number', 1) }}",
          channel: 'web',
        }),
      },
      { orderId: 'A1', quantity: 3, extra: 'dropped' },
    );
    expect(result.status).toBe('success');
    const tool = requests.find((r) => r.tools?.length)?.tools?.find((t) => t.name === 'Order_tool');
    expect(tool?.parameters).toEqual({
      type: 'object',
      properties: {
        orderId: { type: 'string', description: 'The order id' },
        quantity: { type: 'number', description: 'How many', default: 1 },
      },
      required: ['orderId'],
    });
    expect(received).toHaveLength(1);
    expect(received[0].source).toEqual({ source: 'database', workflowId: 'wf-1' });
    // fixed value passes, undeclared argument does not
    expect(received[0].items).toEqual([{ json: { orderId: 'A1', quantity: 3, channel: 'web' } }]);
  });

  it('keeps a model value that looks like an expression as text and drops removed fields', async () => {
    const { received } = await callTool(
      {
        workflowId: 'wf-2',
        workflowInputs: mapping(
          { note: "={{ $fromAI('note') }}", gone: "={{ $fromAI('gone') }}" },
          [{ id: 'gone', displayName: 'gone', required: false, defaultMatch: false, display: true, removed: true }],
        ),
      },
      { note: '={{ 1 + 1 }}', gone: 'x' },
    );
    expect(received[0].items).toEqual([{ json: { note: '={{ 1 + 1 }}' } }]);
  });

  it('falls back to a plain query tool when nothing is mapped, and a plain id string still works', async () => {
    const { received, requests } = await callTool({ workflowId: 'wf-plain' }, { query: 'status of A1' });
    const tool = requests.find((r) => r.tools?.length)?.tools?.find((t) => t.name === 'Order_tool');
    expect(tool?.parameters).toMatchObject({ type: 'object', properties: { query: { type: 'string' } } });
    expect(received[0].source).toEqual({ source: 'database', workflowId: 'wf-plain' });
    expect(received[0].items).toEqual([{ json: { query: 'status of A1' } }]);
  });

  it('refuses an empty workflow selection', async () => {
    const { result } = await callTool({ workflowId: { __rl: true, mode: 'list', value: '' } }, {});
    expect(result.status).not.toBe('success');
  });

  it('the picker shows only what listWorkflows returns and passes the filter and page token', async () => {
    const queries: unknown[] = [];
    const ctx = loadCtx(
      {},
      {
        listWorkflows: async (query) => {
          queries.push(query);
          return { workflows: [{ id: 'w1', name: 'Orders' }], paginationToken: 'next' };
        },
      },
    );
    const page = await ToolWorkflowNode.methods!.listSearch!.searchWorkflows(ctx, 'ord', 'p1');
    expect(page).toEqual({ results: [{ name: 'Orders', value: 'w1' }], paginationToken: 'next' });
    expect(queries).toEqual([{ filter: 'ord', paginationToken: 'p1' }]);
    await expect(ToolWorkflowNode.methods!.listSearch!.searchWorkflows(loadCtx({}))).rejects.toThrow(
      'Workflows cannot be listed here',
    );
  });

  it('the mapper lists the inputs the sub-workflow declares, read through readWorkflow', async () => {
    const reads: string[] = [];
    const ctx = loadCtx(
      { source: 'database', workflowId: { __rl: true, mode: 'list', value: 'w1' } },
      {
        readWorkflow: async (id) => {
          reads.push(id);
          return SUB([
            { name: 'orderId', type: 'string' },
            { name: 'qty', type: 'number' },
            { name: 'any', type: 'any' },
            { name: 'orderId', type: 'string' },
            { name: '', type: 'string' },
          ]);
        },
      },
    );
    const fields = await ToolWorkflowNode.methods!.resourceMapping!.loadWorkflowInputMappings(ctx);
    expect(reads).toEqual(['w1']);
    expect(fields.fields.map((f) => [f.id, f.type])).toEqual([
      ['orderId', 'string'],
      ['qty', 'number'],
      ['any', undefined],
    ]);
  });

  it('the mapper explains a passthrough sub-workflow, a missing one and no selection', async () => {
    const load = ToolWorkflowNode.methods!.resourceMapping!.loadWorkflowInputMappings;
    const pass = await load(
      loadCtx({ source: 'database', workflowId: 'w1' }, { readWorkflow: async () => SUB([], 'passthrough') }),
    );
    expect(pass.fields).toEqual([]);
    expect(pass.emptyFieldsNotice).toContain('Define Using Fields Below');
    await expect(
      load(loadCtx({ source: 'database', workflowId: 'other-tenant' }, { readWorkflow: async () => undefined })),
    ).rejects.toThrow('The workflow was not found');
    expect((await load(loadCtx({ source: 'database', workflowId: '' }))).fields).toEqual([]);
  });

  it('reads the declared inputs from the workflow JSON when the source is defined below', async () => {
    const json = JSON.stringify(SUB([{ name: 'city', type: 'string' }]));
    const fields = await ToolWorkflowNode.methods!.resourceMapping!.loadWorkflowInputMappings(
      loadCtx({ source: 'parameter', workflowJson: json }),
    );
    expect(fields.fields.map((f) => f.id)).toEqual(['city']);
  });

  it('keeps Specify Input Schema for saved nodes', async () => {
    const { received } = await callTool(
      {
        workflowId: 'wf-3',
        specifyInputSchema: true,
        jsonSchemaExample: '{"orderId": "A1"}',
      },
      { orderId: 'B7' },
    );
    expect(received[0].items).toEqual([{ json: { orderId: 'B7' } }]);
  });
});
