/**
 * P6-53 (L8), redaction and the model: a canary in the output of a redacted run never reaches the fake model
 * through the Assistant (`run_workflow`, `verify_workflow`, `execute_node`, the execution read tools), the
 * builder's last-run context (`buildWorkflowContext`, `get_execution_schema`) or MCP (`get_workflow_execution`,
 * `test_workflow`). Each check has a control with no redaction that does show the canary, so it can fail.
 */
import { randomUUID } from 'node:crypto';
import type { DataObject, WorkflowDefinition } from '@workflow/workflow';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { executionContext } from '../src/services/ai-builder/context';
import { MCP_KEY_AUDIENCE, MCP_KEY_LABEL } from '../src/services/mcp/types';
import {
  type AssistantHarness,
  createAssistantHarness,
  type HarnessUser,
  toolResultOf,
} from './fakes/assistant-harness';
import type { FakeLlmStep } from './fakes/fake-llm';
import {
  chain,
  createWorkflow,
  node,
  setNode,
  startMcpTestServer,
  TestClient,
  type TestServer,
  waitFor,
  waitForExecution,
} from './helpers';

const CANARY = 'canary-ai-output';
const CANARY_ERROR = 'canary-ai-error';
/** a value the Set node computes, so it is in the run's output and never in the model's own arguments */
const COMPUTED = '={{ "canary" + "-ai-output" }}';

const approve = { kind: 'approval', approved: true } as const;

describe('the Assistant', () => {
  let h: AssistantHarness;
  let calls = 0;

  beforeAll(async () => {
    h = await createAssistantHarness();
  }, 120_000);
  afterAll(async () => {
    await h?.close();
  });

  const setFloor = (floor: 'off' | 'all') =>
    h.owner.client.data(h.owner.client.post('/rest/settings/security', { redaction: { floor } }));

  /** the model calls `name(args)` in a new thread; waits for the result or a card */
  async function callTool(user: HarnessUser, name: string, args: Record<string, unknown>) {
    calls += 1;
    const toolCallId = `p6_ai_${calls}`;
    while (h.script.length < h.fake.requests.length) h.script.push({ status: 500, error: 'used up' });
    const at = h.fake.requests.length;
    const steps: FakeLlmStep[] = [
      { toolCalls: [{ id: toolCallId, name, arguments: args as never }] },
      { text: 'Done.' },
    ];
    h.script.splice(at, 0, ...steps);
    const threadId = await h.createThread(user);
    await h.chat(user, threadId, `Call ${name}`);
    const status = await h.waitForStatus(
      user,
      threadId,
      (s) => !s.hasActiveRun && (s.pending.length > 0 || h.fake.requests.length >= at + 2),
      30_000,
    );
    return { threadId, toolCallId, status, result: toolResultOf(h.fake.requests, toolCallId) };
  }

  /** a card call: approves it and waits for the resumed turn */
  async function approved(name: string, args: Record<string, unknown>) {
    const call = await callTool(h.owner, name, args);
    expect(call.status.pending, `${name} waits for a card`).toHaveLength(1);
    const card = call.status.pending[0] as { requestId: string };
    const before = h.fake.requests.length;
    expect((await h.confirm(h.owner, card.requestId, approve)).statusCode).toBe(200);
    await waitFor(async () => h.fake.requests.length > before, { timeout: 30_000, message: 'resumed turn' });
    await h.waitForStatus(h.owner, call.threadId, 'idle', 30_000);
    return toolResultOf([h.fake.requests.at(-1)], call.toolCallId) ?? '';
  }

  const flow = (settings: DataObject = {}) =>
    createWorkflow(h.owner.client, {
      name: `AI flow ${randomUUID().slice(0, 6)}`,
      nodes: [node('Start', 'core.manualTrigger'), setNode('Make', 'secret', COMPUTED)],
      connections: chain('Start', 'Make'),
      settings,
    });

  const requestsText = () => JSON.stringify(h.fake.requests);

  it('run_workflow shows the output with no redaction, and never a value of a run with policy all', async () => {
    const open = await flow();
    expect(await approved('run_workflow', { workflowId: open.id })).toContain(CANARY);
    const closed = await flow({ redactionPolicy: 'all' });
    const result = await approved('run_workflow', { workflowId: closed.id });
    expect(result).toContain('status success');
    expect(result).not.toContain(CANARY);
    expect(result).toContain('redacted');
    const sent = requestsText();
    const at = sent.lastIndexOf(closed.id);
    expect(sent.slice(at)).not.toContain(CANARY);
  });

  it('execute_node returns no value with the floor on all', async () => {
    const args = {
      type: 'core.set',
      version: 1,
      config: {
        parameters: {
          mode: 'manual',
          assignments: { assignments: [{ id: 'a1', name: 'secret', value: COMPUTED, type: 'string' }] },
          includeOtherFields: true,
        },
      },
      input: [{ json: { from: 'input' } }],
    };
    expect(await approved('execute_node', args)).toContain(CANARY);
    await setFloor('all');
    try {
      const result = await approved('execute_node', args);
      expect(result).not.toContain(CANARY);
    } finally {
      await setFloor('off');
    }
  });

  it('the execution read tools show no value of a redacted run, and its error text is blank', async () => {
    const closed = await createWorkflow(h.owner.client, {
      name: 'AI failing',
      nodes: [
        node('Start', 'core.manualTrigger'),
        node('Boom', 'test.fail', { message: CANARY_ERROR }, [200, 0]),
      ],
      connections: chain('Start', 'Boom'),
      settings: { redactionPolicy: 'all' },
    });
    const { executionId } = await h.owner.client.data<{ executionId: string }>(
      h.owner.client.post(`/rest/workflows/${closed.id}/run`, {}),
    );
    await waitForExecution(h.ctx, h.tenantId, executionId);
    const listed = await callTool(h.owner, 'list_executions', { workflowId: closed.id });
    const got = await callTool(h.owner, 'get_execution', { executionId });
    for (const text of [listed.result, got.result]) {
      expect(text, 'a tool result').toBeTruthy();
      expect(text).not.toContain(CANARY_ERROR);
    }
  });

  it('verify_workflow gives the model counts and statuses only for a redacted draft', async () => {
    const draft = async (settings: DataObject) => {
      const threadId = await h.createThread(h.owner);
      const draftId = randomUUID();
      await h.ctx.assistantDrafts.put(h.tenantId, threadId, {
        id: draftId,
        name: 'Verify draft',
        workflowId: null,
        baseVersionId: null,
        definition: {
          name: 'Verify draft',
          nodes: [node('Start', 'core.manualTrigger'), setNode('Make', 'secret', COMPUTED)],
          connections: chain('Start', 'Make'),
          settings,
        } as unknown as WorkflowDefinition,
        createdAt: new Date().toISOString(),
        status: 'open',
      });
      return { threadId, draftId };
    };
    const verify = async (settings: DataObject) => {
      const { threadId, draftId } = await draft(settings);
      calls += 1;
      const id = `p6_verify_${calls}`;
      while (h.script.length < h.fake.requests.length) h.script.push({ status: 500, error: 'used up' });
      h.script.splice(
        h.fake.requests.length,
        0,
        { toolCalls: [{ id, name: 'verify_workflow', arguments: { draftId } }] },
        { text: 'Checked.' },
      );
      await h.chat(h.owner, threadId, 'Verify the draft');
      await h.waitForStatus(h.owner, threadId, 'idle', 60_000);
      return toolResultOf(h.fake.requests, id) ?? '';
    };
    expect(await verify({})).toContain(CANARY);
    const redacted = await verify({ redactionPolicy: 'all' });
    expect(redacted).not.toContain(CANARY);
    expect(redacted).toContain('"ran":true');
    expect(redacted).toContain('redacted');
  });
});

describe('the builder', () => {
  let h: AssistantHarness;

  beforeAll(async () => {
    h = await createAssistantHarness();
  }, 120_000);
  afterAll(async () => {
    await h?.close();
  });

  async function runOnce(settings: DataObject) {
    const wf = await createWorkflow(h.owner.client, {
      name: `Builder flow ${randomUUID().slice(0, 6)}`,
      nodes: [node('Start', 'core.manualTrigger'), setNode('Make', 'secret', CANARY)],
      connections: chain('Start', 'Make'),
      settings,
    });
    const { executionId } = await h.owner.client.data<{ executionId: string }>(
      h.owner.client.post(`/rest/workflows/${wf.id}/run`, {}),
    );
    await waitForExecution(h.ctx, h.tenantId, executionId);
    return wf.id;
  }

  const contextOf = async (workflowId: string, userId?: string) =>
    executionContext({
      ctx: h.ctx,
      tenant: (await h.ctx.repos.tenants.get(h.tenantId))!,
      workflowId,
      sendValues: true,
      userId,
    });

  it('a run with no redaction gives its schema and values, a redacted one the node names only', async () => {
    const open = await runOnce({});
    expect(await contextOf(open, h.owner.userId)).toContain(CANARY);
    const closed = await runOnce({ redactionPolicy: 'all' });
    const text = await contextOf(closed, h.owner.userId);
    expect(text).not.toContain(CANARY);
    expect(text).toContain('redacted');
    expect(text).toContain('Make');
    // no identified user: the same, and a floor raised later does not matter to an old run
    expect(await contextOf(closed)).not.toContain(CANARY);
  });
});

describe('MCP', () => {
  let server: TestServer & { url: string; port: number };

  beforeAll(async () => {
    server = await startMcpTestServer({ MCP_ACCESS_ENABLED: 'true' });
  });
  afterAll(async () => {
    await server?.close();
  });

  async function scene() {
    const client = new TestClient(server.app, server.url);
    const id = randomUUID().slice(0, 8);
    const res = await client.post('/rest/auth/signup', {
      email: `redact-${id}@example.com`,
      password: 'Passw0rd!',
      name: `Redact ${id}`,
      workspaceName: `Redact ${id}`,
    });
    if (res.statusCode !== 200) throw new Error(`signup failed: ${res.body}`);
    const data = res.json().data as { user: { id: string }; tenant: { id: string; slug: string } };
    const key = (
      await server.ctx.auth.createApiKey(data.tenant.id, data.user.id, MCP_KEY_LABEL, [], MCP_KEY_AUDIENCE)
    ).key;
    return { client, key, url: `${server.url}/mcp-server/${data.tenant.slug}/http` };
  }

  let rpc = 0;
  async function call(s: { url: string; key: string }, name: string, args: DataObject) {
    const res = await fetch(s.url, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${s.key}` },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: ++rpc,
        method: 'tools/call',
        params: { name, arguments: args },
      }),
    });
    const body = (await res.json()) as {
      result?: { content?: Array<{ text?: string }> };
      error?: { message: string };
    };
    return (body.result?.content ?? []).map((p) => p.text ?? '').join('') || (body.error?.message ?? '');
  }

  const hookFlow = (s: Awaited<ReturnType<typeof scene>>, settings: DataObject) =>
    createWorkflow(s.client, {
      name: `Hook ${randomUUID().slice(0, 6)}`,
      nodes: [
        node(
          'Webhook',
          'core.webhook',
          { path: `w-${randomUUID().slice(0, 8)}`, httpMethod: 'POST' },
          [0, 0],
          {
            webhookId: randomUUID(),
          },
        ),
        setNode('Set', 'greeting', CANARY),
        node('Boom', 'core.stopAndError', { errorMessage: CANARY_ERROR }, [400, 0]),
      ],
      connections: chain('Webhook', 'Set', 'Boom'),
      settings: { availableInMCP: true, ...settings },
    });

  it('test_workflow and get_workflow_execution hide the data and the error text of a redacted run', async () => {
    const s = await scene();
    const open = await hookFlow(s, {});
    const control = await call(s, 'test_workflow', {
      workflowId: open.id,
      pinData: { Webhook: [{ body: {} }] },
    });
    expect(control).toContain(CANARY_ERROR);

    const closed = await hookFlow(s, { redactionPolicy: 'all' });
    const tested = await call(s, 'test_workflow', {
      workflowId: closed.id,
      pinData: { Webhook: [{ body: {} }] },
    });
    expect(tested).not.toContain(CANARY_ERROR);
    const executionId = /"executionId":\s*"([^"]+)"/.exec(tested)?.[1];
    expect(executionId, tested).toBeTruthy();
    const read = await call(s, 'get_workflow_execution', {
      workflowId: closed.id,
      executionId: executionId as string,
      includeData: true,
    });
    expect(read).not.toContain(CANARY);
    expect(read).not.toContain(CANARY_ERROR);
    const found = await call(s, 'search_workflow_executions', { workflowId: closed.id });
    expect(found).not.toContain(CANARY_ERROR);
  });
});
