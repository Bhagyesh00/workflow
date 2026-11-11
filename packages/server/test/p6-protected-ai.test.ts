/**
 * P6-79 (S4 L8): the protected workspace and the AI. Every caller is a true `member` (`realMember`,
 * `addToProject`), never the owner. MCP: a tool that is not read-only is refused with a read-only text and its
 * handler never runs; a read tool works; `execute_workflow` in production mode starts a run of a published
 * workflow and in manual mode is refused, and so is `test_workflow` (both with the manual run text); the
 * switch off lets a write through again; the builder's Accept save (PATCH) is refused with the update text.
 * Assistant: the 15 permission keys read `blocked` (the 7 others do not), `dto` keeps the saved modes, a write
 * tool is not offered and `gate` refuses it with the protected text before any card is stored, a read tool still
 * runs, an approved card written before the switch is refused with the protected text and runs nothing,
 * `run_workflow` and `execute_node` start no execution, `build_workflow` and `verify_workflow` refuse with the
 * protected text (an admin's block keeps the admin text), and `stop_execution` stays offered and runs.
 */
import { randomUUID } from 'node:crypto';
import type { AssistantPermissionKey } from '@workflow/workflow';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { z } from 'zod';
import { ASSISTANT_APPROVAL_TEXTS, ASSISTANT_APPROVED_TOOL_GONE } from '../src/services/assistant/approvals';
import { createRunScope } from '../src/services/assistant/run';
import { PROTECTED_PERMISSION_ACTIONS } from '../src/services/assistant/settings';
import { builtInAssistantTools } from '../src/services/assistant/tools';
import { BUILD_BLOCKED } from '../src/services/assistant/tools/build';
import type { AssistantToolDefinition } from '../src/services/assistant/types';
import { MCP_KEY_AUDIENCE, MCP_KEY_LABEL } from '../src/services/mcp/types';
import { PROTECTED_TEXT } from '../src/services/protected';
import {
  type AssistantHarness,
  createAssistantHarness,
  type HarnessUser,
  toolResultOf,
} from './fakes/assistant-harness';
import type { FakeLlmStep } from './fakes/fake-llm';
import {
  addToProject,
  chain,
  createWorkflow,
  node,
  protectWorkspace,
  realMember,
  setNode,
  startMcpTestServer,
  TestClient,
  type TestServer,
  teamProjectOf,
  waitFor,
  waitForExecution,
} from './helpers';

// ---------------------------------------------------------------------------------------------------------
// MCP

let mcp: TestServer & { url: string; port: number };

const ADDRESS = () =>
  `10.${Math.floor(Math.random() * 250) + 1}.${Math.floor(Math.random() * 250) + 1}.${Math.floor(Math.random() * 250) + 1}`;

/**
 * A new workspace with a team project, and a true member of it (`project:editor` on the team project only) with
 * its own MCP key. The owner only sets the workspace up; every case below calls as the member.
 */
async function mcpUser() {
  const owner = new TestClient(mcp.app, mcp.url, ADDRESS());
  const id = randomUUID().slice(0, 8);
  const res = await owner.post('/rest/auth/signup', {
    email: `p6-protected-ai-${id}@example.com`,
    password: 'Passw0rd!',
    name: `Protected ${id}`,
    workspaceName: `Protected ${id}`,
  });
  if (res.statusCode !== 200) throw new Error(`signup failed: ${res.body}`);
  const data = res.json().data as { user: { id: string }; tenant: { id: string; slug: string } };
  const team = await owner.data<{ id: string }>(owner.post('/rest/projects', { name: `Team ${id}` }));
  owner.defaultProjectId = team.id;
  const made = await realMember({ client: owner }, { remoteAddress: ADDRESS(), origin: mcp.url });
  await addToProject(mcp, data.tenant.id, team.id, made.user.id, 'project:editor');
  made.client.defaultProjectId = team.id;
  const key = (
    await mcp.ctx.auth.createApiKey(
      data.tenant.id,
      made.user.id,
      `${MCP_KEY_LABEL}-${id}`,
      [],
      MCP_KEY_AUDIENCE,
    )
  ).key;
  return {
    client: made.client,
    user: made.user,
    tenant: data.tenant,
    teamId: team.id,
    key,
    url: `${mcp.url}/mcp-server/${data.tenant.slug}/http`,
  };
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
    const refused = await call(user, 'create_folder', { name: 'Blocked folder', projectId: user.teamId });
    expect(refused.isError).toBe(true);
    // the protected check answers, not a scope refusal before it
    expect(refused.text).toContain('protected workspace');
    expect(refused.text).toContain('read-only mode');
    expect(refused.text).not.toContain('missing a scope');
    const found = await call(user, 'search_folders', { query: 'Blocked folder' });
    expect(found.isError).toBe(false);
    expect(JSON.stringify(found.value)).not.toContain('Blocked folder');

    await protectWorkspace(mcp, user.tenant.id, false);
    const allowed = await call(user, 'create_folder', { name: 'Open folder', projectId: user.teamId });
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

  it('execute_workflow in production mode starts a run, in manual mode (and test_workflow) is refused', async () => {
    const user = await mcpUser();
    const wf = await manualWorkflow(user);
    const hook = await createWorkflow(user.client, {
      name: `Hook ${randomUUID().slice(0, 6)}`,
      nodes: [
        node('Hook', 'core.webhook', { path: `p-${randomUUID().slice(0, 6)}`, httpMethod: 'POST' }, [0, 0], {
          webhookId: randomUUID(),
        }),
        setNode('Set', 'n', 1),
      ],
      connections: chain('Hook', 'Set'),
      settings: { availableInMCP: true },
    });
    await protectWorkspace(mcp, user.tenant.id);
    // publish works on a protected workspace, and its production run starts
    await user.client.data(user.client.post(`/rest/workflows/${hook.id}/activate`));
    const production = await call(user, 'execute_workflow', {
      workflowId: hook.id,
      executionMode: 'production',
      inputs: { type: 'webhook', webhookData: { body: { via: 'protected' } } },
    });
    expect(production.isError).toBe(false);
    const run = await waitForExecution(mcp.ctx, user.tenant.id, production.value.executionId);
    expect([run.status, run.mode]).toEqual(['success', 'webhook']);
    expect(await runsOf(mcp, user.tenant.id, hook.id)).toBe(1);
    // an unpublished workflow reaches the tool's own check in production mode
    const unpublished = await call(user, 'execute_workflow', {
      workflowId: wf.id,
      executionMode: 'production',
    });
    expect(unpublished.text).toContain('has no published (active) version');
    expect(unpublished.text).not.toContain('protected workspace');

    const manual = await call(user, 'execute_workflow', { workflowId: wf.id, executionMode: 'manual' });
    expect(manual.isError).toBe(true);
    expect(manual.text).toContain(PROTECTED_TEXT.manualRun);
    const pin = { workflowId: wf.id, pinData: { Set: [{ n: 1 }] } };
    const tested = await call(user, 'test_workflow', pin);
    expect(tested.isError).toBe(true);
    expect(tested.text).toContain(PROTECTED_TEXT.manualRun);
    expect(await runsOf(mcp, user.tenant.id, wf.id)).toBe(0);

    await protectWorkspace(mcp, user.tenant.id, false);
    const started = await call(user, 'execute_workflow', { workflowId: wf.id, executionMode: 'manual' });
    expect(started.isError).toBe(false);
    expect((await waitForExecution(mcp.ctx, user.tenant.id, started.value.executionId)).status).toBe(
      'success',
    );
    expect((await call(user, 'test_workflow', pin)).isError).toBe(false);
  });

  it('the builder Accept save (PATCH of the workflow) is refused with the update text, and passes with the switch off', async () => {
    const user = await mcpUser();
    const wf = await manualWorkflow(user);
    const body = {
      name: 'Accepted draft',
      nodes: [node('Start', 'core.manualTrigger'), setNode('Set', 'n', 2)],
      connections: chain('Start', 'Set'),
      settings: { availableInMCP: true },
      pinData: {},
      stickyNotes: [],
      versionId: wf.versionId,
    };
    await protectWorkspace(mcp, user.tenant.id);
    const refused = await user.client.patch(`/rest/workflows/${wf.id}`, body);
    expect(refused.statusCode).toBe(403);
    expect(refused.body).toContain(PROTECTED_TEXT.workflowUpdate);

    await protectWorkspace(mcp, user.tenant.id, false);
    const saved = await user.client.patch(`/rest/workflows/${wf.id}`, body);
    expect(saved.statusCode).toBe(200);
  });

  it('another workspace being protected changes nothing here', async () => {
    const one = await mcpUser();
    const two = await mcpUser();
    await protectWorkspace(mcp, one.tenant.id);
    const made = await call(two, 'create_folder', { name: 'Elsewhere', projectId: two.teamId });
    expect(made.isError).toBe(false);
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
  /** a true member: `project:editor` on the workspace's team project, never the owner */
  let member: HarnessUser;
  let address = 0;

  function queue(...steps: FakeLlmStep[]) {
    while (h.script.length < h.fake.requests.length) h.script.push({ status: 500, error: 'used up' });
    h.script.splice(h.fake.requests.length, 0, ...steps);
  }
  const tenantRow = async () => (await h.ctx.repos.tenants.get(h.tenantId))!;

  /** a workflow made by the owner in the team project, which the member works in */
  async function teamWorkflow(definition: Parameters<typeof createWorkflow>[1]) {
    const wf = await createWorkflow(h.owner.client, definition);
    const row = await h.ctx.repos.workflows.get(h.tenantId, wf.id);
    await addToProject(h.server, h.tenantId, row!.projectId, member.userId, 'project:editor');
    return wf;
  }

  /** a run scope of the member's thread, to call `gate` on a tool */
  async function scopeOf(threadId: string) {
    return createRunScope(h.ctx, {
      tenantId: h.tenantId,
      userId: member.userId,
      threadId,
      runId: `run_protected_${randomUUID().slice(0, 6)}`,
      actor: { userId: member.userId },
      signal: new AbortController().signal,
      attachments: [],
    });
  }

  beforeAll(async () => {
    h = await createAssistantHarness({ extraTools: [writeFolder, publishIt, readNote] });
    address++;
    const made = await realMember(h.owner, { remoteAddress: `10.79.${address}.7` });
    member = {
      client: made.client,
      userId: made.user.id,
      email: made.email,
      role: 'member',
      tenantId: h.tenantId,
    };
    await addToProject(
      h.server,
      h.tenantId,
      await teamProjectOf(h.server, h.tenantId),
      member.userId,
      'project:editor',
    );
  }, 120_000);
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

  it('the member is offered the write tool while the workspace is not protected', async () => {
    const threadId = await h.createThread(member);
    let offered: string[] = [];
    queue((body: Body) => {
      offered = (body.tools ?? []).map((t) => String(t.function?.name));
      return { text: 'Nothing to do.' };
    });
    await h.chat(member, threadId, 'What can you do?');
    await h.waitForStatus(member, threadId, 'idle');
    expect(offered).toContain('make_folder');
    expect(offered).toContain('stop_execution');
  });

  it('a write tool is not offered; gate refuses it with the protected text and stores no card', async () => {
    await protectWorkspace(h, h.tenantId);
    const threadId = await h.createThread(member);
    let offered: string[] = [];
    queue(
      (body: Body) => {
        offered = (body.tools ?? []).map((t) => String(t.function?.name));
        return { toolCalls: [toolCall('p1', 'make_folder', { name: 'Nope' })] };
      },
      { text: 'It is locked.' },
    );
    await h.chat(member, threadId, 'Make a folder');
    const idle = await h.waitForStatus(member, threadId, 'idle');
    expect(offered).not.toContain('make_folder');
    expect(offered).toContain('read_note');
    expect(offered).toContain('publish_it');
    for (const name of ['run_workflow', 'execute_node']) expect(offered).not.toContain(name);
    // stopping a run writes no workspace content: it stays offered
    expect(offered).toContain('stop_execution');
    expect(idle.pending).toEqual([]);
    expect(calls).toEqual([]);

    const gate = await h.ctx.assistantApprovals.gate(
      await scopeOf(threadId),
      writeFolder,
      { name: 'Nope' },
      'p2',
    );
    expect(gate).toEqual({ decision: 'refuse', reason: PROTECTED_TEXT.folderCreate });
    expect((await h.status(member, threadId)).pending).toEqual([]);
    expect(calls).toEqual([]);
  });

  it('a read tool still works on a protected workspace', async () => {
    await protectWorkspace(h, h.tenantId);
    const threadId = await h.createThread(member);
    queue({ toolCalls: [toolCall('r1', 'read_note', { url: 'https://example.com' })] }, { text: 'Read.' });
    await h.chat(member, threadId, 'Read it');
    const status = await h.waitForStatus(member, threadId, (s) => !s.hasActiveRun);
    // fetchUrl waits for a card by default: answer it if it does
    if (status.pending.length) {
      await h.confirm(member, status.pending[0].requestId, { kind: 'approval', approved: true });
      await h.waitForStatus(member, threadId, 'idle');
    }
    expect(calls).toEqual(['read_note']);
    expect(toolResultOf([h.fake.requests.at(-1)], 'r1')).toBe('note text');
  });

  it('an approved card written before the switch is refused with the protected text and runs nothing', async () => {
    const threadId = await h.createThread(member);
    queue({ toolCalls: [toolCall('c1', 'make_folder', { name: 'Late' })] }, { text: 'Waiting.' });
    await h.chat(member, threadId, 'Make a folder');
    const status = await h.waitForStatus(member, threadId, (s) => !s.hasActiveRun && s.pending.length >= 1);
    const requests = h.fake.requests.length;
    await protectWorkspace(h, h.tenantId);
    const res = await h.confirm(member, status.pending[0].requestId, { kind: 'approval', approved: true });
    expect(res.statusCode).toBe(200);
    await h.waitForStatus(member, threadId, 'idle');
    expect(h.fake.requests.length).toBeGreaterThan(requests);
    expect(calls).toEqual([]);
    const text = toolResultOf([h.fake.requests.at(-1)], 'c1');
    expect(text).toContain(PROTECTED_TEXT.folderCreate);
    expect(text).not.toContain(ASSISTANT_APPROVED_TOOL_GONE);
    expect(text).not.toContain(ASSISTANT_APPROVAL_TEXTS.blocked);
  });

  it('run_workflow and execute_node start no execution on a protected workspace', async () => {
    const wf = await teamWorkflow({
      name: `Runner ${randomUUID().slice(0, 6)}`,
      nodes: [node('Start', 'core.manualTrigger'), setNode('Set', 'n', 1)],
      connections: chain('Start', 'Set'),
    });
    await protectWorkspace(h, h.tenantId);
    const before = await runsOf(h.server, h.tenantId, wf.id);
    const threadId = await h.createThread(member);
    queue(
      {
        toolCalls: [
          toolCall('e1', 'run_workflow', { workflowId: wf.id }),
          toolCall('e2', 'execute_node', { workflowId: wf.id, nodeName: 'Set' }),
        ],
      },
      { text: 'Locked.' },
    );
    await h.chat(member, threadId, 'Run it');
    const idle = await h.waitForStatus(member, threadId, 'idle');
    expect(idle.pending).toEqual([]);
    const last = h.fake.requests.at(-1);
    expect(toolResultOf([last], 'e1')).toContain('There is no tool named "run_workflow"');
    expect(toolResultOf([last], 'e2')).toContain('There is no tool named "execute_node"');
    expect(await runsOf(h.server, h.tenantId, wf.id)).toBe(before);
  });

  it('build_workflow and verify_workflow refuse with the protected text; an admin block keeps the admin text', async () => {
    await protectWorkspace(h, h.tenantId);
    const built = await h.callTool(member, 'build_workflow', { request: 'Send me a note' });
    expect(built.result).toContain(PROTECTED_TEXT.workflowCreate);
    expect(built.result).not.toContain(BUILD_BLOCKED);
    const verified = await h.callTool(member, 'verify_workflow', { draftId: 'no-draft' });
    expect(verified.result).toContain(PROTECTED_TEXT.manualRun);
    expect(verified.result).not.toContain(BUILD_BLOCKED);

    // an admin's own block, on a workspace that is not protected, keeps the admin text
    await protectWorkspace(h, h.tenantId, false);
    await h.setSettings({ permissions: { createWorkflow: 'blocked', runWorkflow: 'blocked' } });
    try {
      const blocked = await h.callTool(member, 'build_workflow', { request: 'Send me a note' });
      expect(blocked.result).toContain(BUILD_BLOCKED);
      expect(blocked.result).not.toContain(PROTECTED_TEXT.workflowCreate);
      const blockedVerify = await h.callTool(member, 'verify_workflow', { draftId: 'no-draft' });
      expect(blockedVerify.result).toContain(BUILD_BLOCKED);
    } finally {
      await h.setSettings({});
    }
  });

  describe('stop_execution', () => {
    async function parkedRun() {
      const wf = await teamWorkflow({
        name: `Parked ${randomUUID().slice(0, 6)}`,
        nodes: [node('Start', 'core.manualTrigger'), node('Wait', 'test.wait', { ms: 3_600_000 }, [200, 0])],
        connections: chain('Start', 'Wait'),
      });
      const { executionId } = await h.owner.client.data<{ executionId: string }>(
        h.owner.client.post(`/rest/workflows/${wf.id}/run`, {}),
      );
      await waitForExecution(h.ctx, h.tenantId, executionId, ['waiting']);
      return executionId;
    }

    async function approve(threadId: string, requestId: string) {
      const before = h.fake.requests.length;
      const res = await h.confirm(member, requestId, { kind: 'approval', approved: true });
      expect(res.statusCode).toBe(200);
      await waitFor(async () => h.fake.requests.length > before, {
        timeout: 30_000,
        message: 'resumed turn',
      });
      await h.waitForStatus(member, threadId, 'idle', 30_000);
    }

    it('writes a card and stops a parked run on a protected workspace', async () => {
      const executionId = await parkedRun();
      await protectWorkspace(h, h.tenantId);
      const turn = await h.callTool(member, 'stop_execution', { executionId });
      expect(turn.status.pending).toHaveLength(1);
      await approve(turn.threadId, turn.status.pending[0].requestId);
      const text = toolResultOf([h.fake.requests.at(-1)], turn.toolCallId) ?? '';
      expect(text).toContain('"status":"canceled"');
      expect(text).not.toContain(PROTECTED_TEXT.manualRun);
      expect((await h.ctx.repos.executions.get(h.tenantId, executionId))?.status).toBe('canceled');
    });

    it('a card written before the switch still stops the run once the workspace is protected', async () => {
      const executionId = await parkedRun();
      const turn = await h.callTool(member, 'stop_execution', { executionId });
      expect(turn.status.pending).toHaveLength(1);
      await protectWorkspace(h, h.tenantId);
      await approve(turn.threadId, turn.status.pending[0].requestId);
      const text = toolResultOf([h.fake.requests.at(-1)], turn.toolCallId) ?? '';
      expect(text).toContain('"status":"canceled"');
      expect((await h.ctx.repos.executions.get(h.tenantId, executionId))?.status).toBe('canceled');
    });

    it('an admin block of running workflows still takes it away, with the admin text', async () => {
      const executionId = await parkedRun();
      await h.setSettings({ permissions: { runWorkflow: 'blocked' } });
      try {
        await protectWorkspace(h, h.tenantId);
        const turn = await h.callTool(member, 'stop_execution', { executionId });
        expect(turn.result).toContain('There is no tool named "stop_execution"');
        const stopTool = builtInAssistantTools().find((tool) => tool.name === 'stop_execution')!;
        const gate = await h.ctx.assistantApprovals.gate(
          await scopeOf(turn.threadId),
          stopTool,
          { executionId },
          'p3',
        );
        expect(gate).toEqual({ decision: 'refuse', reason: ASSISTANT_APPROVAL_TEXTS.blocked });
        expect((await h.ctx.repos.executions.get(h.tenantId, executionId))?.status).toBe('waiting');
      } finally {
        await h.setSettings({});
        await h.ctx.executions.stop(h.tenantId, executionId).catch(() => undefined);
      }
    });
  });
});
