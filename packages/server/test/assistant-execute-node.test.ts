/**
 * P5-69 (L6): `execute_node` through chat and approvals. It waits for its card and runs nothing before; on
 * approval a real local node runs as a one-node manual run with no workflow id and the output comes back
 * redacted and wrapped; "always allow this session" covers that operation only; a long URL offers no session
 * grant; another workspace's credential, a trigger and a webhook node are refused before any card; a node
 * that starts waiting is stopped and reported as an error; a slow node is stopped at its timeout.
 */
import { randomUUID } from 'node:crypto';
import type { AssistantConfirmAnswer, AssistantConfirmation, DataObject } from '@workflow/workflow';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { executeNodeScope } from '../src/services/assistant/tools/nodes';
import {
  type AssistantHarness,
  CANARY,
  createAssistantHarness,
  type HarnessUser,
  toolResultOf,
} from './fakes/assistant-harness';
import type { FakeLlmStep } from './fakes/fake-llm';
import { waitFor } from './helpers';

const SECRET = 'sk-proj-abcdefghijklmnopqrstuvwxyz0123456789';

function queue(h: AssistantHarness, ...steps: FakeLlmStep[]) {
  while (h.script.length < h.fake.requests.length) h.script.push({ status: 500, error: 'used up' });
  h.script.splice(h.fake.requests.length, 0, ...steps);
}

function lastResult(h: AssistantHarness, toolCallId: string): string | undefined {
  for (let i = h.fake.requests.length - 1; i >= 0; i--) {
    const found = toolResultOf([h.fake.requests[i]], toolCallId);
    if (found !== undefined) return found;
  }
  return undefined;
}

async function turn(h: AssistantHarness, user: HarnessUser, args: DataObject, threadId?: string) {
  const toolCallId = `run_${randomUUID().slice(0, 8)}`;
  const id = threadId ?? (await h.createThread(user));
  queue(h, { toolCalls: [{ id: toolCallId, name: 'execute_node', arguments: args }] }, { text: 'Done.' });
  await h.chat(user, id, 'Run the node');
  const status = await h.waitForStatus(user, id, (s) => !s.hasActiveRun);
  return { threadId: id, toolCallId, status, result: lastResult(h, toolCallId) };
}

async function answer(
  h: AssistantHarness,
  user: HarnessUser,
  threadId: string,
  card: AssistantConfirmation,
  body: AssistantConfirmAnswer,
) {
  const before = h.fake.requests.length;
  expect((await h.confirm(user, card.requestId, body)).statusCode).toBe(200);
  await waitFor(async () => h.fake.requests.length > before, {
    timeout: 30_000,
    message: 'the resumed turn',
  });
  await h.waitForStatus(user, threadId, 'idle', 30_000);
  return lastResult(h, card.toolCallId);
}

/** the JSON inside the `execution-output` wrapper */
function preview(text: string | undefined) {
  const match = /^<untrusted_data source="execution-output">\n([\s\S]*)\n<\/untrusted_data>$/.exec(
    text ?? '',
  );
  expect(match, `wrapped output: ${text}`).not.toBeNull();
  return JSON.parse(match?.[1] ?? '{}');
}

const setArgs = (value: string, mode = 'manual') => ({
  type: 'core.set',
  version: 1,
  config: {
    parameters:
      mode === 'manual'
        ? {
            mode,
            assignments: { assignments: [{ id: 'a1', name: 'greeting', value, type: 'string' }] },
            includeOtherFields: true,
          }
        : { mode, jsonOutput: `{"greeting": "${value}"}` },
  },
  input: [{ json: { from: 'input' } }],
});

const approve = { kind: 'approval', approved: true } as const;
const approveSession = { kind: 'approval', approved: true, scope: 'session' } as const;

const executionCount = async (h: AssistantHarness) =>
  (await h.ctx.repos.executions.list(h.tenantId, { limit: 500 })).length;

describe('execute_node (P5-69)', () => {
  let h: AssistantHarness;

  beforeAll(async () => {
    h = await createAssistantHarness();
  });
  afterAll(async () => {
    await h?.close();
  });

  it('is offered from editor up', async () => {
    await h.expectToolRoles({ execute_node: 'editor' });
  });

  it('waits for its card, then runs a real Set node once as a manual run with no workflow id', async () => {
    const before = await executionCount(h);
    const { threadId, status, result } = await turn(h, h.editor, setArgs(`hello ${SECRET}`));
    expect(result).toBeUndefined();
    expect(status.pending).toHaveLength(1);
    const card = status.pending[0] as Extract<AssistantConfirmation, { inputType: 'approval' }>;
    expect(card).toMatchObject({
      toolName: 'execute_node',
      title: 'Run a node',
      resourceName: 'Edit Fields (Set) node',
      allowSession: true,
    });
    const facts = Object.fromEntries(card.details.facts.map((f) => [f.label, f.value]));
    expect(facts.Node).toBe('Edit Fields (Set) (core.set v1)');
    expect(facts.Operation).toBe('Manual Mapping');
    expect(facts['Input items']).toBe('1');
    expect(JSON.stringify(card)).not.toContain(SECRET);
    // nothing ran before the approval
    expect(await executionCount(h)).toBe(before);

    const text = await answer(h, h.editor, threadId, card, approve);
    expect(text).not.toContain(SECRET);
    const output = preview(text);
    expect(output.status).toBe('success');
    const item = output.nodes[0].outputs[0].items[0];
    expect(item.json.from).toBe('input');
    expect(item.json.greeting).toMatch(/^hello /);
    const row = await h.ctx.repos.executions.get(h.tenantId, output.executionId);
    expect(row?.mode).toBe('manual');
    expect(row?.workflowId ?? null).toBeNull();
    expect(await executionCount(h)).toBe(before + 1);
  });

  it('"always allow this session" covers only that operation', async () => {
    const first = await turn(h, h.editor, setArgs('one'));
    expect(first.status.pending[0].allowSession).toBe(true);
    expect(
      preview(await answer(h, h.editor, first.threadId, first.status.pending[0], approveSession)).status,
    ).toBe('success');

    // the same operation in the same thread runs without a card
    const again = await turn(h, h.editor, setArgs('two'), first.threadId);
    expect(again.status.pending).toEqual([]);
    expect(preview(again.result).nodes[0].outputs[0].items[0].json.greeting).toBe('two');

    // another operation (JSON mode) of the same node asks again
    const other = await turn(h, h.editor, setArgs('three', 'raw'), first.threadId);
    expect(other.status.pending).toHaveLength(1);
    await answer(h, h.editor, other.threadId, other.status.pending[0], { kind: 'approval', approved: false });

    // the grant is of that thread only
    const elsewhere = await turn(h, h.editor, setArgs('four'));
    expect(elsewhere.status.pending).toHaveLength(1);
    await answer(h, h.editor, elsewhere.threadId, elsewhere.status.pending[0], {
      kind: 'approval',
      approved: false,
    });
  });

  it('offers no session grant for a long URL', async () => {
    const url = `http://127.0.0.1:9/${'a'.repeat(300)}`;
    const { threadId, status } = await turn(h, h.editor, {
      type: 'core.httpRequest',
      version: 1,
      config: { parameters: { method: 'GET', url } },
    });
    expect(status.pending).toHaveLength(1);
    expect(status.pending[0].allowSession).toBe(false);
    const denied = await answer(h, h.editor, threadId, status.pending[0], {
      kind: 'approval',
      approved: false,
    });
    expect(denied).toBe('The person refused this');
  });

  it('scopes the grant key by resource and operation, or the first fallback parameter', () => {
    const http = h.ctx.registries.nodeTypes.get('core.httpRequest');
    const set = h.ctx.registries.nodeTypes.get('core.set');
    if (!http || !set) throw new Error('core nodes missing');
    expect(executeNodeScope(set, {}).grantKey).toBe('nodes:execute:core.set:manual');
    expect(executeNodeScope(set, { mode: 'raw' }).grantKey).toBe('nodes:execute:core.set:raw');
    expect(executeNodeScope(http, { url: 'https://a.example/x:y' }).grantKey).toBe(
      `nodes:execute:core.httpRequest:${encodeURIComponent('https://a.example/x:y')}`,
    );
    expect(executeNodeScope(http, { url: `https://a.example/${'b'.repeat(200)}` }).grantKey).toBeNull();
  });

  it("refuses another workspace's credential before any card", async () => {
    const before = await executionCount(h);
    const { status, result } = await turn(h, h.editor, {
      type: 'core.httpRequest',
      version: 1,
      config: {
        parameters: { method: 'GET', url: 'http://127.0.0.1:9/' },
        credentials: { openAiApi: { id: h.other.credentialId, name: 'Mine' } },
      },
    });
    expect(status.pending).toEqual([]);
    expect(result).toBe('Error: A credential this node uses is not in this workspace, so it was refused');
    expect(await executionCount(h)).toBe(before);
    // the id is in the model's own call; the credential's name and secret never reach it
    expect(JSON.stringify(h.fake.requests)).not.toContain(CANARY.credential);
    expect(JSON.stringify(h.fake.requests)).not.toContain(CANARY.secret);
  });

  it('refuses a trigger and a webhook node before any card', async () => {
    const manual = await turn(h, h.editor, {
      type: 'core.manualTrigger',
      version: 1,
      config: { parameters: {} },
    });
    expect(manual.status.pending).toEqual([]);
    expect(manual.result).toMatch(/^Error: A trigger node cannot run on its own/);
    const webhook = await turn(h, h.editor, { type: 'core.webhook', version: 1, config: { parameters: {} } });
    expect(webhook.status.pending).toEqual([]);
    expect(webhook.result).toMatch(/^Error: A trigger node cannot run on its own/);
  });

  it('stops a node that starts waiting and reports it as an error', async () => {
    const { threadId, status } = await turn(h, h.editor, {
      type: 'core.wait',
      version: 1,
      config: { parameters: { resume: 'webhook' } },
    });
    const text = await answer(h, h.editor, threadId, status.pending[0], approve);
    const result = JSON.parse(text ?? '{}');
    expect(result.status).toBe('error');
    expect(result.error.message).toContain('started waiting');
    const rows = await h.ctx.repos.executions.list(h.tenantId, { limit: 500 });
    expect(rows.some((row) => row.status === 'waiting')).toBe(false);
  });

  it('stops a node at its timeout', async () => {
    const { threadId, status } = await turn(h, h.editor, {
      type: 'test.sleep',
      version: 1,
      config: { parameters: { ms: 20_000 } },
      timeoutMs: 300,
    });
    const started = Date.now();
    const text = await answer(h, h.editor, threadId, status.pending[0], approve);
    expect(JSON.parse(text ?? '{}')).toEqual({
      status: 'error',
      error: { message: 'The node did not finish within 300 ms, so the run was stopped' },
    });
    expect(Date.now() - started).toBeLessThan(15_000);
  });
});
