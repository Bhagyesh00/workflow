/**
 * P5-69 (L4): the Assistant's execution tools through L1's chat and L3's approvals on the C0e harness.
 * Roles match routes/executions.ts and POST /workflows/:id/run (reads viewer, runs and stop editor);
 * another tenant's execution id is not found and its names never reach the model; `run_workflow`
 * without pins always waits for a card, runs in mode manual after approval, pins the trigger from
 * `inputData`, stops on timeout and reports a parked run as waiting; data values off hides items;
 * `$env` (and `$vars`, `$secrets`, `$credentials`) is skipped in resolved parameters and a resolved key
 * is redacted; `run_node`'s chain, reused, mocked and tool modes say honestly what ran.
 */
import type { AssistantConfirmation, WorkflowDefinition } from '@workflow/workflow';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Scope } from '@workflow/workflow';
import { FORM_FIELDS_WRAPPED, triggerPinData } from '../src/services/assistant/run-helper';
import { runNodeGrantKey } from '../src/services/assistant/tools/executions';
import {
  type AssistantHarness,
  CANARY,
  createAssistantHarness,
  type HarnessUser,
  toolResultOf,
} from './fakes/assistant-harness';
import { chain, createWorkflow, node, waitFor, waitForExecution } from './helpers';

const SECRET = 'sk-proj-ExecutionToolSecret0123456789abcdef';

/** the route scopes: GET /executions list and read; run (POST /workflows/:id/run) and stop execute */
const ROLES: Record<string, Scope> = {
  list_executions: 'execution:list',
  get_execution: 'execution:read',
  debug_execution: 'execution:read',
  get_node_output: 'execution:read',
  get_resolved_node_parameters: 'execution:read',
  run_workflow: 'workflow:execute',
  run_node: 'workflow:execute',
  stop_execution: 'workflow:execute',
};

const approve = { kind: 'approval', approved: true } as const;

describe('Assistant execution tools (P5-69)', () => {
  let h: AssistantHarness;
  /** Start -> Name -> Upper (three items) */
  let flowId: string;
  /** an execution of flowId (owner run through REST) */
  let flowRun: string;
  /** Start -> Boom (test.fail) */
  let failRun: string;
  /** another tenant's execution */
  let canaryRun: string;

  async function runByRest(user: HarnessUser, id: string): Promise<string> {
    const { executionId } = await user.client.data<{ executionId: string }>(
      user.client.post(`/rest/workflows/${id}/run`, {}),
    );
    await waitForExecution(h.ctx, user.tenantId, executionId);
    return executionId;
  }

  beforeAll(async () => {
    h = await createAssistantHarness();
    const flow = await createWorkflow(h.owner.client, {
      name: 'Greeting flow',
      nodes: [
        node('Start', 'core.manualTrigger'),
        node(
          'Name',
          'core.set',
          {
            mode: 'raw',
            jsonOutput: JSON.stringify({ name: 'Ada', token: SECRET }),
            includeOtherFields: false,
          },
          [200, 0],
        ),
        node(
          'Upper',
          'core.set',
          {
            mode: 'manual',
            includeOtherFields: true,
            assignments: {
              assignments: [
                { id: 'a1', name: 'upper', value: '={{ $json.name.toUpperCase() }}', type: 'string' },
                { id: 'a2', name: 'key', value: '={{ $json.token ?? "" }}', type: 'string' },
                { id: 'a3', name: 'nothing', value: '={{ $json.missing ?? "" }}', type: 'string' },
              ],
            },
            // read only in raw mode, so the run never evaluates them; the resolver must skip both
            jsonOutput: '={{ $env.HOME }}',
            options: { note: '={{ $vars.plan }}' },
          },
          [400, 0],
        ),
      ],
      connections: chain('Start', 'Name', 'Upper'),
    });
    flowId = flow.id;
    flowRun = await runByRest(h.owner, flowId);
    const failing = await createWorkflow(h.owner.client, {
      name: 'Failing flow',
      nodes: [
        node('Start', 'core.manualTrigger'),
        node('Boom', 'test.fail', { message: 'Broke on purpose' }, [200, 0]),
      ],
      connections: chain('Start', 'Boom'),
    });
    failRun = await runByRest(h.owner, failing.id);
    canaryRun = await runByRest(h.other.owner, h.other.workflowId);
  });
  afterAll(async () => {
    await h?.close();
  });

  let callCount = 0;
  /**
   * The model calls `name(args)` in a new thread, then says "Done.". Waits until the turn ended (the
   * tool's result was sent back) or a card waits. The script is padded first, so a step never lands
   * behind a request already made.
   */
  async function callTool(user: HarnessUser, name: string, args: Record<string, unknown>, inThread?: string) {
    callCount++;
    const toolCallId = `l4_call_${callCount}`;
    while (h.script.length < h.fake.requests.length) h.script.push({ status: 500, error: 'used up' });
    const at = h.fake.requests.length;
    h.script.splice(
      at,
      0,
      { toolCalls: [{ id: toolCallId, name, arguments: args as never }] },
      { text: 'Done.' },
    );
    const threadId = inThread ?? (await h.createThread(user));
    const { runId } = await h.chat(user, threadId, `Call ${name}`);
    const status = await h.waitForStatus(
      user,
      threadId,
      (s) => !s.hasActiveRun && (s.pending.length > 0 || h.fake.requests.length >= at + 2),
      30_000,
    );
    return { threadId, runId, toolCallId, result: toolResultOf(h.fake.requests, toolCallId), status };
  }

  /** a card call: waits for the card, approves it (session scope when asked), waits for the resumed turn */
  async function approved(
    user: HarnessUser,
    name: string,
    args: Record<string, unknown>,
    scope?: 'session',
    inThread?: string,
  ) {
    const call = await callTool(user, name, args, inThread);
    expect(call.status.pending, `${name} waits for a card`).toHaveLength(1);
    const card = call.status.pending[0] as Extract<AssistantConfirmation, { inputType: 'approval' }>;
    const before = h.fake.requests.length;
    const res = await h.confirm(user, card.requestId, scope ? { ...approve, scope } : approve);
    expect(res.statusCode).toBe(200);
    await waitFor(async () => h.fake.requests.length > before, { timeout: 30_000, message: 'resumed turn' });
    await h.waitForStatus(user, call.threadId, 'idle', 30_000);
    return { ...call, card, result: toolResultOf([h.fake.requests.at(-1)], call.toolCallId) ?? '' };
  }

  const json = (result: string | undefined) => {
    const inner = /<untrusted_data source="[^"]*">\n([\s\S]*)\n<\/untrusted_data>/.exec(result ?? '')?.[1];
    return JSON.parse((inner ?? result ?? '').replace(/&lt;/g, '<'));
  };

  it('offers each tool from its route role up, and only those', async () => {
    await h.expectToolRoles(ROLES);
  });

  it("list, get and debug read this workspace only; another tenant's execution is not found", async () => {
    const list = await callTool(h.viewer, 'list_executions', { workflowId: flowId });
    expect(list.result).toContain('<untrusted_data source="execution-list">');
    expect(json(list.result).executions.map((e: { id: string }) => e.id)).toContain(flowRun);

    const got = await callTool(h.viewer, 'get_execution', { executionId: flowRun });
    const body = json(got.result);
    expect(body.status).toBe('success');
    expect(body.nodes.map((n: { node: string }) => n.node)).toEqual(['Start', 'Name', 'Upper']);
    expect(got.result).not.toContain('Ada');

    const debug = await callTool(h.viewer, 'debug_execution', { executionId: failRun });
    const report = json(debug.result);
    expect(report.failedNode.name).toBe('Boom');
    expect(report.failedNode.type).toBe('test.fail');
    expect(report.error.message).toContain('Broke on purpose');
    expect(report.trace.map((n: { node: string }) => n.node)).toEqual(['Start', 'Boom']);
    const fine = json((await callTool(h.viewer, 'debug_execution', { executionId: flowRun })).result);
    expect(fine.note).toContain('did not fail');

    for (const name of [
      'get_execution',
      'debug_execution',
      'get_node_output',
      'get_resolved_node_parameters',
    ]) {
      const call = await callTool(h.owner, name, { executionId: canaryRun, nodeName: 'Start' });
      // an untrusted tool's error comes back wrapped like its result (tool-adapter's shapeToolError)
      expect(call.result, name).toMatch(/^Error: (?:<untrusted_data source="[^"]+">\n)?Execution not found/);
    }
    const stop = await callTool(h.owner, 'stop_execution', { executionId: canaryRun });
    expect(stop.status.pending).toHaveLength(0);
    expect(stop.result).toMatch(/^Error: Execution not found/);
    const listOther = await callTool(h.owner, 'list_executions', { workflowId: h.other.workflowId });
    expect(listOther.result).toMatch(/^Error: (?:<untrusted_data source="[^"]+">\n)?Workflow not found/);
    // the ids are in the model's own calls; the other workspace's names and secret never are
    const sent = JSON.stringify(h.fake.requests);
    for (const value of [CANARY.workflow, CANARY.workspace, CANARY.secret]) expect(sent).not.toContain(value);
  });

  it('get_node_output: a window of items, values redacted; values off hides items', async () => {
    const out = await callTool(h.viewer, 'get_node_output', {
      executionId: flowRun,
      nodeName: 'Name',
      maxItems: 5,
    });
    const body = json(out.result);
    expect(body.kind).toContain('main node');
    expect(body.runs[0].outputs[0].itemCount).toBe(1);
    expect(body.runs[0].outputs[0].items[0].json).toEqual({ name: 'Ada', token: '[redacted]' });
    expect(JSON.stringify(h.fake.requests)).not.toContain(SECRET);

    await h.setSettings({ allowSendingParameterValues: false });
    try {
      const hidden = await callTool(h.viewer, 'get_node_output', { executionId: flowRun, nodeName: 'Name' });
      const hiddenBody = json(hidden.result);
      expect(hiddenBody.note).toContain('hidden');
      expect(hiddenBody.runs[0].outputs[0]).toEqual({ type: 'main', index: 0, itemCount: 1 });
      expect(hidden.result).not.toContain('Ada');
      const params = await callTool(h.viewer, 'get_resolved_node_parameters', {
        executionId: flowRun,
        nodeName: 'Upper',
      });
      expect(json(params.result).parameters).toBeUndefined();
      expect(params.result).not.toContain('ADA');
    } finally {
      await h.setSettings({});
    }
  });

  it('get_resolved_node_parameters: values resolve, $env and $vars are skipped, a key is redacted', async () => {
    const call = await callTool(h.viewer, 'get_resolved_node_parameters', {
      executionId: flowRun,
      nodeName: 'Upper',
    });
    expect(call.result).toContain('<untrusted_data source="resolved-parameters">');
    const body = json(call.result);
    const byPath = Object.fromEntries(body.expressions.map((e: { path: string }) => [e.path, e])) as Record<
      string,
      { status: string; value?: unknown; reason?: string }
    >;
    expect(byPath['assignments.assignments.0.value']).toMatchObject({ status: 'resolved', value: 'ADA' });
    expect(byPath['assignments.assignments.1.value']).toMatchObject({
      status: 'resolved',
      value: '[redacted]',
    });
    expect(byPath['assignments.assignments.2.value'].status).toBe('empty');
    expect(byPath.jsonOutput.status).toBe('skipped');
    expect(byPath.jsonOutput.reason).toContain('$env');
    expect(byPath['options.note'].status).toBe('skipped');
    expect(body.parameters.jsonOutput).toBe('[skipped]');
    expect(body.inputItemCount).toBe(1);
    expect(JSON.stringify(h.fake.requests)).not.toContain(SECRET);
  });

  it('run_workflow without pins always waits; after approval it runs once in mode manual', async () => {
    const before = (await h.ctx.repos.executions.list(h.tenantId, { workflowId: flowId, limit: 50 })).length;
    const call = await callTool(h.editor, 'run_workflow', { workflowId: flowId });
    expect(call.status.pending).toHaveLength(1);
    const card = call.status.pending[0] as Extract<AssistantConfirmation, { inputType: 'approval' }>;
    expect(card).toMatchObject({
      toolName: 'run_workflow',
      title: 'Run workflow',
      resourceName: 'Greeting flow',
    });
    expect(card.allowSession).toBe(false);
    expect(card.details.facts).toEqual(
      expect.arrayContaining([
        { label: 'Trigger', value: 'Start' },
        { label: 'Stops after', value: '5 min' },
      ]),
    );
    expect((await h.ctx.repos.executions.list(h.tenantId, { workflowId: flowId, limit: 50 })).length).toBe(
      before,
    );

    const resBefore = h.fake.requests.length;
    await h.confirm(h.editor, card.requestId, approve);
    await waitFor(async () => h.fake.requests.length > resBefore, {
      timeout: 30_000,
      message: 'resumed turn',
    });
    await h.waitForStatus(h.editor, call.threadId, 'idle', 30_000);
    const result = toolResultOf([h.fake.requests.at(-1)], call.toolCallId) ?? '';
    expect(result).toContain('The run ended with status success.');
    expect(result).toContain('<untrusted_data source="execution-output">');
    expect(result).toContain('ADA');
    expect(result).not.toContain(SECRET);
    const rows = await h.ctx.repos.executions.list(h.tenantId, { workflowId: flowId, limit: 50 });
    expect(rows.length).toBe(before + 1);
    expect(rows[0].mode).toBe('manual');
  });

  it('run_workflow: inputData pins the trigger; a timeout stops the run; a parked run is reported waiting', async () => {
    const hook = await createWorkflow(h.owner.client, {
      name: 'Hook flow',
      nodes: [
        node('Hook', 'core.webhook', { path: `hook-${Date.now()}` }),
        node('Pass', 'core.noOp', {}, [200, 0]),
      ],
      connections: chain('Hook', 'Pass'),
    });
    const pinned = await approved(h.editor, 'run_workflow', {
      workflowId: hook.id,
      inputData: { body: { customer: 'Grace' } },
    });
    expect(pinned.card.details.facts).toEqual(expect.arrayContaining([{ label: 'Trigger', value: 'Hook' }]));
    expect(pinned.result).toContain('status success');
    expect(pinned.result).toContain('Grace');

    const slow = await createWorkflow(h.owner.client, {
      name: 'Slow flow',
      nodes: [node('Start', 'core.manualTrigger'), node('Sleep', 'test.sleep', { ms: 20_000 }, [200, 0])],
      connections: chain('Start', 'Sleep'),
    });
    const timedOut = await approved(h.editor, 'run_workflow', { workflowId: slow.id, timeout: 1000 });
    expect(timedOut.result).toContain('did not finish within');
    const [slowRow] = await h.ctx.repos.executions.list(h.tenantId, { workflowId: slow.id, limit: 1 });
    expect(['canceled', 'crashed', 'error']).toContain(slowRow.status);

    const parked = await createWorkflow(h.owner.client, {
      name: 'Parked flow',
      nodes: [node('Start', 'core.manualTrigger'), node('Wait', 'test.wait', { ms: 3_600_000 }, [200, 0])],
      connections: chain('Start', 'Wait'),
    });
    const waiting = await approved(h.editor, 'run_workflow', { workflowId: parked.id });
    expect(waiting.result).toContain('The run is waiting');
    const [parkedRow] = await h.ctx.repos.executions.list(h.tenantId, { workflowId: parked.id, limit: 1 });
    expect(parkedRow.status).toBe('waiting');
  });

  it('run_node: chain, reused execution and mocked input each say what really ran', async () => {
    // one approval with "always allow this session" covers the node in this thread only, so each
    // mode is approved on its own
    const chainRun = await approved(h.editor, 'run_node', { workflowId: flowId, nodeName: 'Upper' });
    expect(chainRun.card.title).toBe('Run a node');
    expect(chainRun.card.details.facts).toEqual(expect.arrayContaining([{ label: 'Input', value: 'chain' }]));
    // the card says plainly which earlier nodes run for real (read from the saved workflow)
    expect(chainRun.card.details.facts).toEqual(
      expect.arrayContaining([
        { label: 'Also runs for real', value: 'Start, Name' },
        {
          label: 'Note',
          value: 'The 2 nodes before the target really run: what they send or change happens again',
        },
      ]),
    );
    expect(chainRun.card.allowSession).toBe(false);
    const chained = json(chainRun.result);
    expect(chained.mode).toBe('chain');
    expect(chained.status).toBe('success');
    expect(chained.target.ran).toBe(true);
    expect(chained.executedNodeNames.sort()).toEqual(['Name', 'Start', 'Upper']);

    const reusedRun = await approved(h.editor, 'run_node', {
      workflowId: flowId,
      nodeName: 'Upper',
      reuseExecutionId: flowRun,
    });
    expect(reusedRun.card.details.facts).toEqual(
      expect.arrayContaining([
        {
          label: 'Before the target',
          value: 'The nodes before it replay their output from that execution and do not run',
        },
      ]),
    );
    const reused = json(reusedRun.result);
    expect(reused.mode).toBe('reused-execution');
    expect(reused.executedNodeNames).toEqual(['Upper']);
    expect(reused.replayedNodeNames.sort()).toEqual(['Name', 'Start']);
    expect(reused.target.outputs[0].items[0].json.upper).toBe('ADA');

    const mockedRun = await approved(h.editor, 'run_node', {
      workflowId: flowId,
      nodeName: 'Upper',
      mockInput: [{ name: 'Linus' }],
    });
    expect(mockedRun.card.details.facts).toEqual(
      expect.arrayContaining([
        { label: 'Before the target', value: 'The nodes before it do not run: they get placeholder data' },
      ]),
    );
    expect(mockedRun.card.details.preview).toMatchObject({ columns: ['name'], rows: [['Linus']] });
    const mocked = json(mockedRun.result);
    expect(mocked.mode).toBe('mocked');
    expect(mocked.executedNodeNames).toEqual(['Upper']);
    expect(mocked.mockedNodeNames.sort()).toEqual(['Name', 'Start']);
    expect(mocked.notes.join(' ')).toContain('does not show that the workflow works');
    expect(mocked.target.outputs[0].items[0].json.upper).toBe('LINUS');
  });

  it('run_node: a session grant names the mode, so a mocked grant never covers a chain run', async () => {
    const runCount = async () =>
      (await h.ctx.repos.executions.list(h.tenantId, { workflowId: flowId, limit: 500 })).length;
    const mockedArgs = { workflowId: flowId, nodeName: 'Upper', mockInput: [{ name: 'Grace' }] };
    const first = await approved(h.editor, 'run_node', mockedArgs, 'session');
    expect(first.card.allowSession).toBe(true);
    expect(json(first.result).mode).toBe('mocked');

    // the same mode in the same thread runs with no card
    const again = await callTool(h.editor, 'run_node', mockedArgs, first.threadId);
    expect(again.status.pending).toEqual([]);
    expect(json(again.result).mode).toBe('mocked');

    // a chain run of the same node in the same thread runs Start and Name for real: it waits for a card
    const count = await runCount();
    const chainCall = await callTool(
      h.editor,
      'run_node',
      { workflowId: flowId, nodeName: 'Upper' },
      first.threadId,
    );
    expect(chainCall.status.pending).toHaveLength(1);
    expect(chainCall.status.pending[0].allowSession).toBe(false);
    expect(await runCount()).toBe(count);
    expect(
      (
        await h.confirm(h.editor, chainCall.status.pending[0].requestId, {
          kind: 'approval',
          approved: false,
        })
      ).statusCode,
    ).toBe(200);
    await h.waitForStatus(h.editor, first.threadId, 'idle', 30_000);
    expect(await runCount()).toBe(count);

    // the keys: chain none, reused names its execution, mocked and tool their mode
    const base = { workflowId: flowId, nodeName: 'Upper', timeout: 1000 };
    expect(runNodeGrantKey(base)).toBeNull();
    expect(runNodeGrantKey({ ...base, reuseExecutionId: flowRun })).toBe(
      `run_node:${flowId}:reused-execution:${flowRun}:Upper`,
    );
    expect(runNodeGrantKey({ ...base, mockInput: [] })).toBe(`run_node:${flowId}:mocked:Upper`);
    expect(runNodeGrantKey({ ...base, toolArguments: {} })).toBe(`run_node:${flowId}:tool:Upper`);
  });

  it('run_workflow refuses Form fields wrapped in formFields before any card', async () => {
    const form = await createWorkflow(h.owner.client, {
      name: 'Form flow',
      nodes: [node('Form', 'core.formTrigger'), node('Pass', 'core.noOp', {}, [200, 0])],
      connections: chain('Form', 'Pass'),
    });
    const call = await callTool(h.editor, 'run_workflow', {
      workflowId: form.id,
      inputData: { formFields: { email: 'ada@example.com' } },
    });
    expect(call.status.pending).toHaveLength(0);
    expect(call.result).toContain(FORM_FIELDS_WRAPPED);
  });

  it('run_node: a tool runs through agentRequest; a non-tool sub-node is refused', async () => {
    const agent = await createWorkflow(h.owner.client, {
      name: 'Agent flow',
      nodes: [
        node('Start', 'core.manualTrigger'),
        node('Agent', 'ai.agent', {}, [200, 0]),
        node('Model', 'ai.lmChatOpenAi', { model: 'gpt-4o-mini' }, [200, 200]),
        node('Calc', 'ai.toolCalculator', {}, [300, 200]),
      ],
      connections: {
        Start: { main: [[{ node: 'Agent', type: 'main', index: 0 }]] },
        Model: { ai_languageModel: [[{ node: 'Agent', type: 'ai_languageModel', index: 0 }]] },
        Calc: { ai_tool: [[{ node: 'Agent', type: 'ai_tool', index: 0 }]] },
      },
    });
    const sub = await approved(h.editor, 'run_node', { workflowId: agent.id, nodeName: 'Model' });
    expect(sub.result).toMatch(/^Error: (?:<untrusted_data source="[^"]+">\n)?'Model' is a sub-node/);

    const tool = await approved(h.editor, 'run_node', {
      workflowId: agent.id,
      nodeName: 'Calc',
      toolArguments: { input: '6 * 7' },
    });
    const body = json(tool.result);
    expect(body.mode).toBe('tool');
    expect(body.target.ran).toBe(true);
    expect(body.executedNodeNames).not.toContain('Agent');
    expect(body.notes.join(' ')).toContain('the agent it belongs to did not run');
  });

  it('stop_execution waits for a card and stops a parked run', async () => {
    const parked = await createWorkflow(h.owner.client, {
      name: 'Parked again',
      nodes: [node('Start', 'core.manualTrigger'), node('Wait', 'test.wait', { ms: 3_600_000 }, [200, 0])],
      connections: chain('Start', 'Wait'),
    });
    const id = await (async () => {
      const { executionId } = await h.owner.client.data<{ executionId: string }>(
        h.owner.client.post(`/rest/workflows/${parked.id}/run`, {}),
      );
      await waitForExecution(h.ctx, h.tenantId, executionId, ['waiting']);
      return executionId;
    })();
    const stopped = await approved(h.editor, 'stop_execution', { executionId: id });
    expect(stopped.card.details.facts).toEqual(
      expect.arrayContaining([
        { label: 'Workflow', value: 'Parked again' },
        { label: 'Status', value: 'waiting' },
      ]),
    );
    expect(stopped.result).toContain('"status":"canceled"');
    expect((await h.ctx.repos.executions.get(h.tenantId, id))?.status).toBe('canceled');
  });
});

describe('run_workflow trigger data (n8n parity)', () => {
  const definition: WorkflowDefinition = {
    name: 'Triggers',
    nodes: [node('Chat', 'ai.chatTrigger'), node('Form', 'core.formTrigger')],
    connections: {},
  };

  it('a Chat Trigger gets other data as a JSON message, never an empty one', () => {
    const chat = (data: unknown) => triggerPinData(definition, 'Chat', data).Chat[0].json.chatInput;
    expect(chat('hello')).toBe('hello');
    expect(chat({ chatInput: 'hi', sessionId: 's1' })).toBe('hi');
    expect(chat({ question: 'Where is my order?' })).toBe('{"question":"Where is my order?"}');
    expect(chat({ chatInput: 7 })).toBe('{"chatInput":7}');
    expect(chat(undefined)).toBe('');
  });

  it('a Form Trigger takes a flat map and refuses fields inside formFields', () => {
    expect(triggerPinData(definition, 'Form', { email: 'a@b.c' }).Form[0].json).toMatchObject({
      email: 'a@b.c',
      formMode: 'test',
    });
    expect(() => triggerPinData(definition, 'Form', { formFields: { email: 'a@b.c' } })).toThrow(
      FORM_FIELDS_WRAPPED,
    );
    expect(() => triggerPinData(definition, 'Form', [{ formFields: { email: 'a@b.c' } }])).toThrow(
      FORM_FIELDS_WRAPPED,
    );
    // a field that happens to be named formFields with a plain value is still a field
    expect(triggerPinData(definition, 'Form', { formFields: 'x' }).Form[0].json.formFields).toBe('x');
  });
});
