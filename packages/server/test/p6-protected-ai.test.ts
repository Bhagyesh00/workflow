/**
 * P6-79 (S4 L8): the protected workspace and the AI. MCP: a tool that is not read-only is refused with a
 * read-only text and its handler never runs; a read tool works; `execute_workflow` in production mode passes
 * (it reaches its own checks) and in manual mode is refused; the switch off lets a write through again.
 * Assistant: the 15 permission keys read `blocked` (the 7 others do not), `dto` keeps the saved modes, a write
 * tool is not offered and `gate` refuses it with the protected text before any card is stored, a read tool still
 * runs, an approved card written before the switch is refused with the protected text and runs nothing, and
 * `run_workflow` and `execute_node` start no execution.
 */
import { randomUUID } from 'node:crypto';
import type { AssistantPermissionKey } from '@workflow/workflow';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { z } from 'zod';
import { ASSISTANT_APPROVAL_TEXTS, ASSISTANT_APPROVED_TOOL_GONE } from '../src/services/assistant/approvals';
import { createRunScope } from '../src/services/assistant/run';
import { PROTECTED_PERMISSION_ACTIONS } from '../src/services/assistant/settings';
import type { AssistantToolDefinition } from '../src/services/assistant/types';
import { MCP_KEY_AUDIENCE, MCP_KEY_LABEL } from '../src/services/mcp/types';
import { PROTECTED_TEXT } from '../src/services/protected';
import { type AssistantHarness, createAssistantHarness, toolResultOf } from './fakes/assistant-harness';
import type { FakeLlmStep } from './fakes/fake-llm';
import {
  chain,
  createWorkflow,
  node,
  protectWorkspace,
  setNode,
  startMcpTestServer,
  TestClient,
  type TestServer,
  waitForExecution,
} from './helpers';

// ---------------------------------------------------------------------------------------------------------
// MCP

let mcp: TestServer & { url: string; port: number };

async function mcpUser() {
  const client = new TestClient(mcp.app, mcp.url);
  const id = randomUUID().slice(0, 8);
  const res = await client.post('/rest/auth/signup', {
    email: `p6-protected-ai-${id}@example.com`,
    password: 'Passw0rd!',
    name: `Protected ${id}`,
    workspaceName: `Protected ${id}`,
  });
  if (res.statusCode !== 200) throw new Error(`signup failed: ${res.body}`);
  const data = res.json().data as { user: { id: string }; tenant: { id: string; slug: string } };
  const key = (
    await mcp.ctx.auth.createApiKey(
      data.tenant.id,
      data.user.id,
      `${MCP_KEY_LABEL}-${id}`,
      [],
      MCP_KEY_AUDIENCE,
    )
  ).key;
  return { client, ...data, key, url: `${mcp.url}/mcp-server/${data.tenant.slug}/http` };
}

let rpcId = 0;
async function call(user: { url: string; key: string }, name: string, args: Record<string, unknown> = {}) {
  const res = await fetch(user.url, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${user.key}` },
    body: JSON.stringify({
      jsonrpc: '2.0',
      id: ++rpcId,
      method: 'tools/call',
      params: { name, arguments: args },
    }),
  });
  const body = (await res.json()) as { result?: any; error?: { message: string } };
  if (body.error) return { isError: true, text: body.error.message, value: undefined as any };
  const text = (body.result.content ?? []).map((p: { text?: string }) => p.text ?? '').join('');
  if (body.result.isError) return { isError: true, text, value: undefined as any };
  return { isError: false, text, value: JSON.parse(text) };
}

async function manualWorkflow(user: Awaited<ReturnType<typeof mcpUser>>) {
  return createWorkflow(user.client, {
    name: `Manual ${randomUUID().slice(0, 6)}`,
    nodes: [node('Start', 'core.manualTrigger'), setNode('Set', 'n', 1)],
    connections: chain('Start', 'Set'),
    settings: { availableInMCP: true },
  });
}

const runsOf = async (server: TestServer, tenantId: string, workflowId: string) =>
  (await server.ctx.repos.executions.list(tenantId, { workflowId, limit: 50 })).length;

describe('protected workspace and MCP (P6-79)', () => {
  beforeAll(async () => {
    mcp = await startMcpTestServer({ MCP_ACCESS_ENABLED: 'true' });
  });
  afterAll(async () => {
    await mcp?.close();
  });

  it('refuses a write tool before its handler runs, and the same call passes with the switch off', async () => {
    const user = await mcpUser();
    await protectWorkspace(mcp, user.tenant.id);
    const refused = await call(user, 'create_folder', { name: 'Blocked folder' });
    expect(refused.isError).toBe(true);
    expect(refused.text).toContain('protected workspace');
    expect(refused.text).toContain('read-only mode');
    const found = await call(user, 'search_folders', { query: 'Blocked folder' });
    expect(found.isError).toBe(false);
    expect(JSON.stringify(found.value)).not.toContain('Blocked folder');

    await protectWorkspace(mcp, user.tenant.id, false);
    const allowed = await call(user, 'create_folder', { name: 'Open folder' });
    expect(allowed.isError).toBe(false);
  });

  it('a read tool works on a protected workspace', async () => {
    const user = await mcpUser();
    const wf = await manualWorkflow(user);
    await protectWorkspace(mcp, user.tenant.id);
    const search = await call(user, 'search_workflows', {});
    expect(search.isError).toBe(false);
    expect(JSON.stringify(search.value)).toContain(wf.id);
    expect((await call(user, 'get_workflow_details', { workflowId: wf.id })).isError).toBe(false);
  });

  it('execute_workflow in production mode passes, in manual mode is refused', async () => {
    const user = await mcpUser();
    const wf = await manualWorkflow(user);
    await protectWorkspace(mcp, user.tenant.id);
    // production mode reaches the tool's own check (this workflow has no published version)
    const production = await call(user, 'execute_workflow', {
      workflowId: wf.id,
      executionMode: 'production',
    });
    expect(production.text).toContain('has no published (active) version');
    expect(production.text).not.toContain('protected workspace');

    const manual = await call(user, 'execute_workflow', { workflowId: wf.id, executionMode: 'manual' });
    expect(manual.isError).toBe(true);
    expect(manual.text).toContain(PROTECTED_TEXT.manualRun);
    expect(await runsOf(mcp, user.tenant.id, wf.id)).toBe(0);

    await protectWorkspace(mcp, user.tenant.id, false);
    const started = await call(user, 'execute_workflow', { workflowId: wf.id, executionMode: 'manual' });
    expect(started.isError).toBe(false);
    expect((await waitForExecution(mcp.ctx, user.tenant.id, started.value.executionId)).status).toBe(
      'success',
    );
  });

  it('another workspace being protected changes nothing here', async () => {
    const one = await mcpUser();
    const two = await mcpUser();
    await protectWorkspace(mcp, one.tenant.id);
    expect((await call(two, 'create_folder', { name: 'Elsewhere' })).isError).toBe(false);
  });
});

// ---------------------------------------------------------------------------------------------------------
// Assistant

const calls: string[] = [];

const writeFolder: AssistantToolDefinition<{ name: string }> = {
  name: 'make_folder',
  description: 'Make a folder',
  input: z.object({ name: z.string() }),
  access: 'workflow:update',
  permission: 'createFolder',
  async handler(_ctx, _run, input) {
    calls.push(`make_folder:${input.name}`);
    return 'made';
  },
};

const publishIt: AssistantToolDefinition<{ name: string }> = {
  name: 'publish_it',
  description: 'Publish a thing',
  input: z.object({ name: z.string() }),
  access: 'workflow:update',
  permission: 'publishWorkflow',
  async handler(_ctx, _run, input) {
    calls.push(`publish_it:${input.name}`);
    return 'published';
  },
};

const readNote: AssistantToolDefinition<{ url: string }> = {
  name: 'read_note',
  description: 'Read a note',
  input: z.object({ url: z.string() }),
  access: 'instanceAi:message',
  permission: 'fetchUrl',
  async handler() {
    calls.push('read_note');
    return 'note text';
  },
};

type Body = { tools?: Array<{ function?: { name?: string } }> };
const toolCall = (id: string, name: string, args: Record<string, unknown>) => ({
  id,
  name,
  arguments: args,
});

const BLOCKED_KEYS = Object.keys(PROTECTED_PERMISSION_ACTIONS).sort();
const OTHER_KEYS = [
  'publishWorkflow',
  'deleteCredential',
  'mutateDataTableRows',
  'cleanupTestExecutions',
  'fetchUrl',
  'webSearch',
  'mcpRead',
];

describe('protected workspace and the Assistant (P6-79)', () => {
  let h: AssistantHarness;

  function queue(...steps: FakeLlmStep[]) {
    while (h.script.length < h.fake.requests.length) h.script.push({ status: 500, error: 'used up' });
    h.script.splice(h.fake.requests.length, 0, ...steps);
  }
  const tenantRow = async () => (await h.ctx.repos.tenants.get(h.tenantId))!;

  beforeAll(async () => {
    h = await createAssistantHarness({ extraTools: [writeFolder, publishIt, readNote] });
  });
  afterAll(async () => {
    if (h) await protectWorkspace(h, h.tenantId, false);
    await h?.close();
  });
  beforeEach(async () => {
    calls.length = 0;
    await protectWorkspace(h, h.tenantId, false);
  });

  it('names the 15 keys the plan lists and never the 7 others', () => {
    expect(BLOCKED_KEYS).toEqual(
      [
        'createWorkflow',
        'updateWorkflow',
        'deleteWorkflow',
        'moveWorkflowToFolder',
        'runWorkflow',
        'executeNode',
        'createCredential',
        'createFolder',
        'deleteFolder',
        'tagWorkflow',
        'createDataTable',
        'deleteDataTable',
        'mutateDataTableSchema',
        'restoreWorkflowVersion',
        'mcpWrite',
      ].sort(),
    );
    for (const key of OTHER_KEYS) expect(BLOCKED_KEYS).not.toContain(key);
  });

  it('read returns blocked for the 15 keys on a protected workspace and dto keeps the saved modes', async () => {
    await h.setSettings({ permissions: { fetchUrl: 'always_allow', createWorkflow: 'require_approval' } });
    try {
      let effective = await h.ctx.assistantSettings.read(await tenantRow());
      expect(effective.permissions.createWorkflow).toBe('require_approval');
      await protectWorkspace(h, h.tenantId);
      effective = await h.ctx.assistantSettings.read(await tenantRow());
      for (const key of BLOCKED_KEYS) {
        expect(effective.permissions[key as AssistantPermissionKey]).toBe('blocked');
      }
      for (const key of OTHER_KEYS) {
        expect(effective.permissions[key as AssistantPermissionKey]).not.toBe('blocked');
      }
      const dto = await h.ctx.assistantSettings.dto(await tenantRow());
      expect(dto.permissions.fetchUrl).toBe('always_allow');
      expect(effective.permissions.fetchUrl).toBe('always_allow');
      expect(dto.permissions.createWorkflow).toBe('require_approval');
    } finally {
      await h.setSettings({});
    }
  });

  it('a write tool is not offered; gate refuses it with the protected text and stores no card', async () => {
    await protectWorkspace(h, h.tenantId);
    const threadId = await h.createThread(h.owner);
    let offered: string[] = [];
    queue(
      (body: Body) => {
        offered = (body.tools ?? []).map((t) => String(t.function?.name));
        return { toolCalls: [toolCall('p1', 'make_folder', { name: 'Nope' })] };
      },
      { text: 'It is locked.' },
    );
    await h.chat(h.owner, threadId, 'Make a folder');
    const idle = await h.waitForStatus(h.owner, threadId, 'idle');
    expect(offered).not.toContain('make_folder');
    expect(offered).toContain('read_note');
    expect(offered).toContain('publish_it');
    for (const name of ['run_workflow', 'execute_node']) expect(offered).not.toContain(name);
    expect(idle.pending).toEqual([]);
    expect(calls).toEqual([]);

    const controller = new AbortController();
    const run = await createRunScope(h.ctx, {
      tenantId: h.tenantId,
      userId: h.owner.userId,
      threadId,
      runId: 'run_protected_check',
      actor: { userId: h.owner.userId },
      signal: controller.signal,
      attachments: [],
    });
    const gate = await h.ctx.assistantApprovals.gate(run, writeFolder, { name: 'Nope' }, 'p2');
    expect(gate).toEqual({ decision: 'refuse', reason: PROTECTED_TEXT.folderCreate });
    expect((await h.status(h.owner, threadId)).pending).toEqual([]);
    expect(calls).toEqual([]);
  });

  it('a read tool still works on a protected workspace', async () => {
    await protectWorkspace(h, h.tenantId);
    const threadId = await h.createThread(h.owner);
    queue({ toolCalls: [toolCall('r1', 'read_note', { url: 'https://example.com' })] }, { text: 'Read.' });
    await h.chat(h.owner, threadId, 'Read it');
    const status = await h.waitForStatus(h.owner, threadId, (s) => !s.hasActiveRun);
    // fetchUrl waits for a card by default: answer it if it does
    if (status.pending.length) {
      await h.confirm(h.owner, status.pending[0].requestId, { kind: 'approval', approved: true });
      await h.waitForStatus(h.owner, threadId, 'idle');
    }
    expect(calls).toEqual(['read_note']);
    expect(toolResultOf([h.fake.requests.at(-1)], 'r1')).toBe('note text');
  });

  it('an approved card written before the switch is refused with the protected text and runs nothing', async () => {
    const threadId = await h.createThread(h.owner);
    queue({ toolCalls: [toolCall('c1', 'make_folder', { name: 'Late' })] }, { text: 'Waiting.' });
    await h.chat(h.owner, threadId, 'Make a folder');
    const status = await h.waitForStatus(h.owner, threadId, (s) => !s.hasActiveRun && s.pending.length >= 1);
    const requests = h.fake.requests.length;
    await protectWorkspace(h, h.tenantId);
    const res = await h.confirm(h.owner, status.pending[0].requestId, { kind: 'approval', approved: true });
    expect(res.statusCode).toBe(200);
    await h.waitForStatus(h.owner, threadId, 'idle');
    expect(h.fake.requests.length).toBeGreaterThan(requests);
    expect(calls).toEqual([]);
    const text = toolResultOf([h.fake.requests.at(-1)], 'c1');
    expect(text).toContain(PROTECTED_TEXT.folderCreate);
    expect(text).not.toContain(ASSISTANT_APPROVED_TOOL_GONE);
    expect(text).not.toContain(ASSISTANT_APPROVAL_TEXTS.blocked);
  });

  it('run_workflow and execute_node start no execution on a protected workspace', async () => {
    const wf = await createWorkflow(h.owner.client, {
      name: `Runner ${randomUUID().slice(0, 6)}`,
      nodes: [node('Start', 'core.manualTrigger'), setNode('Set', 'n', 1)],
      connections: chain('Start', 'Set'),
    });
    await protectWorkspace(h, h.tenantId);
    const before = await runsOf(h.server, h.tenantId, wf.id);
    const threadId = await h.createThread(h.owner);
    queue(
      {
        toolCalls: [
          toolCall('e1', 'run_workflow', { workflowId: wf.id }),
          toolCall('e2', 'execute_node', { workflowId: wf.id, nodeName: 'Set' }),
        ],
      },
      { text: 'Locked.' },
    );
    await h.chat(h.owner, threadId, 'Run it');
    const idle = await h.waitForStatus(h.owner, threadId, 'idle');
    expect(idle.pending).toEqual([]);
    const last = h.fake.requests.at(-1);
    expect(toolResultOf([last], 'e1')).toContain('There is no tool named "run_workflow"');
    expect(toolResultOf([last], 'e2')).toContain('There is no tool named "execute_node"');
    expect(await runsOf(h.server, h.tenantId, wf.id)).toBe(before);
  });
});
