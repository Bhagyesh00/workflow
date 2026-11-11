/**
 * P6-81 (L14): the write lock on the AI paths. While any user holds a workflow's lock, the MCP write tools
 * (`publish_workflow`, `unpublish_workflow`, `update_workflow`, `archive_workflow`, `restore_workflow_version`)
 * and the Assistant's (`archive_workflow`, `publish_workflow`, `unpublish_workflow`,
 * `restore_workflow_version`) and Accept of a draft that changes the workflow answer 423 with n8n's text; read
 * tools, a version label (`update_workflow_version`), a new workflow and a workflow with no lock pass; a
 * released lock lets the same call through. No real model: the MCP client is a plain fetch, the Assistant runs
 * on the fake LLM.
 */
import { randomUUID } from 'node:crypto';
import type { AssistantConfirmation, DataObject } from '@workflow/workflow';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { MCP_KEY_AUDIENCE, MCP_KEY_LABEL } from '../src/services/mcp/types';
import {
  type AssistantHarness,
  createAssistantHarness,
  type HarnessUser,
  toolResultOf,
} from './fakes/assistant-harness';
import {
  chain,
  createWorkflow,
  node,
  setNode,
  startMcpTestServer,
  TestClient,
  type TestServer,
  waitFor,
} from './helpers';

const LOCKED = 'Cannot modify workflow while it is being edited by a user in the editor.';

// ---------------------------------------------------------------------------------------------
// MCP

describe('MCP write tools and the write lock', () => {
  let server: TestServer & { url: string };
  let tenantId: string;
  let ownerId: string;
  let key: string;
  let url: string;
  let rpc = 0;

  beforeAll(async () => {
    server = await startMcpTestServer({
      MCP_ACCESS_ENABLED: 'true',
      MCP_SERVER_RATE_LIMIT: '100000',
      LOGIN_RATE_LIMIT_MAX: '1000',
    });
    const client = new TestClient(server.app, server.url);
    const id = randomUUID().slice(0, 8);
    const res = await client.post('/rest/auth/signup', {
      email: `mcp-lock-${id}@example.com`,
      password: 'Passw0rd!',
      name: `Lock ${id}`,
      workspaceName: `Lock ${id}`,
    });
    const data = res.json().data as { user: { id: string }; tenant: { id: string; slug: string } };
    tenantId = data.tenant.id;
    ownerId = data.user.id;
    key = (await server.ctx.auth.createApiKey(tenantId, ownerId, MCP_KEY_LABEL, [], MCP_KEY_AUDIENCE)).key;
    url = `${server.url}/mcp-server/${data.tenant.slug}/http`;
  });
  afterAll(async () => {
    await server?.close();
  });

  async function call(name: string, args: DataObject = {}) {
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${key}` },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: ++rpc,
        method: 'tools/call',
        params: { name, arguments: args },
      }),
    });
    const body = (await res.json()) as {
      result?: { isError?: boolean; content?: Array<{ text?: string }> };
      error?: { message: string };
    };
    const text = body.error?.message ?? (body.result?.content ?? []).map((p) => p.text ?? '').join('');
    const isError = !!body.error || !!body.result?.isError;
    return { isError, text, value: isError ? undefined : JSON.parse(text) };
  }

  async function made() {
    const result = await call('create_workflow', {
      workflow: {
        name: `Locked ${randomUUID().slice(0, 8)}`,
        nodes: [
          node(
            'Webhook',
            'core.webhook',
            { path: `l-${randomUUID().slice(0, 8)}`, httpMethod: 'POST' },
            [0, 0],
          ),
          setNode('Set', 'greeting', 'hello'),
        ],
        connections: chain('Webhook', 'Set'),
      },
    });
    expect(result.isError, result.text).toBe(false);
    return result.value as { workflowId: string; versionId: string };
  }

  const lockBy = (workflowId: string, userId: string = randomUUID(), clientId = 'tab-x') =>
    server.ctx.collaboration.requestWrite(
      tenantId,
      workflowId,
      { id: userId, email: 'x@example.com' },
      clientId,
    );

  it('refuses the five write tools with 423 while a lock is held, and nothing changes', async () => {
    const wf = await made();
    await lockBy(wf.workflowId);
    const calls: Array<[string, DataObject]> = [
      ['publish_workflow', { workflowId: wf.workflowId }],
      ['unpublish_workflow', { workflowId: wf.workflowId }],
      [
        'update_workflow',
        {
          workflowId: wf.workflowId,
          versionId: wf.versionId,
          operations: [{ type: 'setWorkflowName', name: 'Renamed' }],
        },
      ],
      ['archive_workflow', { workflowId: wf.workflowId }],
      ['restore_workflow_version', { workflowId: wf.workflowId, versionId: wf.versionId }],
    ];
    for (const [name, args] of calls) {
      const res = await call(name, args);
      expect(res.isError, name).toBe(true);
      expect(res.text, name).toContain(LOCKED);
    }
    const row = await server.ctx.repos.workflows.get(tenantId, wf.workflowId);
    expect(row?.active).toBe(false);
    expect(row?.isArchived).toBe(false);
    expect(row?.versionId).toBe(wf.versionId);
  });

  it('read tools pass, and a new workflow passes, while a lock is held', async () => {
    const wf = await made();
    await lockBy(wf.workflowId);
    expect((await call('get_workflow_details', { workflowId: wf.workflowId })).isError).toBe(false);
    expect((await call('search_workflows', {})).isError).toBe(false);
    await made();
  });

  it('the same user holding the lock in a tab is refused too (any lock)', async () => {
    const wf = await made();
    await lockBy(wf.workflowId, ownerId, 'tab-own');
    const res = await call('publish_workflow', { workflowId: wf.workflowId });
    expect(res.isError).toBe(true);
    expect(res.text).toContain(LOCKED);
  });

  it('a released lock lets every tool through; a workflow with no lock was never refused', async () => {
    const wf = await made();
    const other = await made();
    const holder = randomUUID();
    await lockBy(wf.workflowId, holder, 'tab-y');
    // another workflow is not locked by this one's lock
    const free = await call('update_workflow', {
      workflowId: other.workflowId,
      versionId: other.versionId,
      operations: [{ type: 'setWorkflowName', name: 'Free to change' }],
    });
    expect(free.isError, free.text).toBe(false);
    await server.ctx.collaboration.release(tenantId, wf.workflowId, holder, 'tab-y');
    const updated = await call('update_workflow', {
      workflowId: wf.workflowId,
      versionId: wf.versionId,
      operations: [{ type: 'setWorkflowName', name: 'After release' }],
    });
    expect(updated.isError, updated.text).toBe(false);
    expect((await call('publish_workflow', { workflowId: wf.workflowId })).isError).toBe(false);
    expect((await call('unpublish_workflow', { workflowId: wf.workflowId })).isError).toBe(false);
    const archived = await call('archive_workflow', { workflowId: wf.workflowId });
    expect(archived.isError, archived.text).toBe(false);
  });
});

// ---------------------------------------------------------------------------------------------
// Assistant

describe('Assistant write tools, Accept and the write lock', () => {
  let h: AssistantHarness;
  let callCount = 0;

  beforeAll(async () => {
    h = await createAssistantHarness();
  });
  afterAll(async () => {
    await h?.close();
  });

  const approve = { kind: 'approval', approved: true } as const;

  async function workflow() {
    return createWorkflow(h.owner.client, {
      name: `Assistant ${randomUUID().slice(0, 8)}`,
      nodes: [
        node('Start', 'core.webhook', { path: `a-${randomUUID().slice(0, 8)}`, httpMethod: 'POST' }),
        setNode('Set', 'token', 'x'),
      ],
      connections: chain('Start', 'Set'),
    });
  }

  const lock = (workflowId: string, user: HarnessUser = h.admin, clientId = 'tab-x') =>
    h.ctx.collaboration.requestWrite(
      h.tenantId,
      workflowId,
      { id: user.userId, email: user.email },
      clientId,
    );

  /** a card call: the model calls the tool, the owner approves, the tool's result text */
  async function approved(name: string, args: DataObject): Promise<string> {
    callCount++;
    const toolCallId = `l14_call_${callCount}`;
    while (h.script.length < h.fake.requests.length) h.script.push({ status: 500, error: 'used up' });
    const at = h.fake.requests.length;
    h.script.splice(
      at,
      0,
      { toolCalls: [{ id: toolCallId, name, arguments: args as never }] },
      { text: 'Done.' },
    );
    const threadId = await h.createThread(h.owner);
    await h.chat(h.owner, threadId, `Call ${name}`);
    const status = await h.waitForStatus(
      h.owner,
      threadId,
      (s) => !s.hasActiveRun && s.pending.length > 0,
      30_000,
    );
    const card = status.pending[0] as Extract<AssistantConfirmation, { inputType: 'approval' }>;
    const before = h.fake.requests.length;
    expect((await h.confirm(h.owner, card.requestId, approve)).statusCode).toBe(200);
    await waitFor(async () => h.fake.requests.length > before, { timeout: 15_000, message: 'resumed turn' });
    await h.waitForStatus(h.owner, threadId, 'idle');
    return toolResultOf([h.fake.requests.at(-1)], toolCallId) ?? '';
  }

  it('archive, publish, unpublish and restore are refused with 423 while a lock is held', async () => {
    const wf = await workflow();
    await lock(wf.id);
    const calls: Array<[string, DataObject]> = [
      ['archive_workflow', { workflowId: wf.id }],
      ['publish_workflow', { workflowId: wf.id }],
      ['unpublish_workflow', { workflowId: wf.id }],
      ['restore_workflow_version', { workflowId: wf.id, versionId: wf.versionId }],
    ];
    for (const [name, args] of calls) {
      const text = await approved(name, args);
      expect(text, name).toContain(LOCKED);
    }
    const row = await h.ctx.repos.workflows.get(h.tenantId, wf.id);
    expect(row?.active).toBe(false);
    expect(row?.isArchived).toBe(false);
    expect(row?.versionId).toBe(wf.versionId);
  });

  it('a version label (update_workflow_version) passes while a lock is held', async () => {
    const wf = await workflow();
    await lock(wf.id);
    const text = await approved('update_workflow_version', {
      workflowId: wf.id,
      versionId: wf.versionId,
      name: 'Labelled',
    });
    expect(text).not.toContain(LOCKED);
    expect(text).toContain('Labelled');
  });

  it('a released lock lets the publish through', async () => {
    const wf = await workflow();
    await lock(wf.id, h.admin, 'tab-z');
    await h.ctx.collaboration.release(h.tenantId, wf.id, h.admin.userId, 'tab-z');
    const text = await approved('publish_workflow', { workflowId: wf.id });
    expect(text).not.toContain(LOCKED);
    expect((await h.ctx.repos.workflows.get(h.tenantId, wf.id))?.active).toBe(true);
  });

  it('Accept of a draft that changes a locked workflow is 423 and the draft stays open; free, it saves', async () => {
    const wf = await workflow();
    const row = (await h.ctx.repos.workflows.get(h.tenantId, wf.id))!;
    const threadId = await h.createThread(h.owner);
    const draftId = randomUUID();
    const createdAt = new Date().toISOString();
    await h.ctx.assistantDrafts.put(h.tenantId, threadId, {
      id: draftId,
      name: 'Draft rename',
      workflowId: wf.id,
      baseVersionId: row.versionId,
      definition: {
        name: 'Draft rename',
        nodes: row.nodes as never,
        connections: row.connections as never,
        settings: {},
      },
      createdAt,
      status: 'open',
    });
    await lock(wf.id, h.admin, 'tab-q');
    const url = `/rest/assistant/threads/${threadId}/drafts/${draftId}/accept`;
    const refused = await h.owner.client.post(url, { updatedAt: createdAt });
    expect(refused.statusCode).toBe(423);
    expect(refused.json().error.message).toBe(LOCKED);
    const stored = (await h.ctx.repos.assistantThreads.getDrafts(h.tenantId, threadId))[draftId];
    expect(stored?.status).toBe('open');
    expect((await h.ctx.repos.workflows.get(h.tenantId, wf.id))?.versionId).toBe(row.versionId);

    await h.ctx.collaboration.release(h.tenantId, wf.id, h.admin.userId, 'tab-q');
    const accepted = await h.owner.client.post(url, { updatedAt: createdAt });
    expect(accepted.statusCode, accepted.body).toBe(200);
  });

  it('Accept of a new workflow (no workflow id) has no lock to check', async () => {
    const threadId = await h.createThread(h.owner);
    const draftId = randomUUID();
    const createdAt = new Date().toISOString();
    await h.ctx.assistantDrafts.put(h.tenantId, threadId, {
      id: draftId,
      name: 'Fresh',
      workflowId: null,
      baseVersionId: null,
      definition: {
        name: 'Fresh',
        nodes: [node('Start', 'core.manualTrigger', {})] as never,
        connections: {},
        settings: {},
      },
      createdAt,
      status: 'open',
    });
    const accepted = await h.owner.client.post(
      `/rest/assistant/threads/${threadId}/drafts/${draftId}/accept`,
      {
        updatedAt: createdAt,
      },
    );
    expect(accepted.statusCode, accepted.body).toBe(200);
  });
});
