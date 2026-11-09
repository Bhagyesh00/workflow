/**
 * P6-37 (S1, L16): the Assistant by project. A real `member` of a workspace reaches only what its
 * projects give it through the Assistant: the list tools show its projects' rows, a tool on a row of
 * another project is refused with n8n's text, `projectId` on a list tool cannot widen the list, writes go
 * to a project the member may write in, a project lost while a card waits stops the approved call, and
 * `get_node_parameter_options` refuses another project's credential. The routes use scopes: the settings
 * need `instanceAi:manage` (not `aiAssistant:manage`, which belongs to /ai/usage-settings), the MCP list
 * `instanceAi:message`, a connection's credential must be usable by the admin who saves it, and a draft is
 * accepted only where the member holds `workflow:create` (or `workflow:update` on the workflow).
 * Phase 5's fake model and harness serve it; no real key.
 */
import { randomUUID } from 'node:crypto';
import type { AssistantConfirmation } from '@workflow/workflow';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { MISSING_SCOPE_MESSAGE } from '../src/services/access';
import { builtInAssistantTools } from '../src/services/assistant/tools';
import { toolAccess } from '../src/services/assistant/types';
import {
  type AssistantHarness,
  createAssistantHarness,
  type HarnessUser,
  toolResultOf,
} from './fakes/assistant-harness';
import {
  addToProject,
  credentialIn,
  dataTableIn,
  projectIn,
  realMember,
  teamProjectOf,
  waitFor,
  workflowIn,
} from './helpers';

const approve = { kind: 'approval', approved: true } as const;
type Card = Extract<AssistantConfirmation, { inputType: 'approval' }>;

let h: AssistantHarness;
let member: HarnessUser;
/** the project the member works in (the workspace's default team project) and one it does not belong to */
let mine: string;
let theirs: string;
const suffix = () => randomUUID().slice(0, 6);
let address = 0;

async function newMember(): Promise<HarnessUser> {
  address++;
  const made = await realMember(h.owner, { remoteAddress: `10.69.${address % 250}.7` });
  return {
    client: made.client,
    userId: made.user.id,
    email: made.email,
    role: 'member',
    tenantId: h.tenantId,
  };
}

beforeAll(async () => {
  h = await createAssistantHarness({});
  mine = await teamProjectOf(h.server, h.tenantId);
  theirs = (await projectIn(h.server, h.tenantId, `Other team ${suffix()}`)).id;
  member = await newMember();
  await addToProject(h.server, h.tenantId, mine, member.userId, 'project:editor');
}, 120_000);

afterAll(async () => {
  await h?.close();
});

describe('Assistant reads by project', () => {
  it('list_workflows shows the workflows of the member projects only', async () => {
    const own = await workflowIn(h.server, h.tenantId, mine, { name: `Alpha ${suffix()}` });
    const foreign = await workflowIn(h.server, h.tenantId, theirs, { name: `Bravo ${suffix()}` });
    const turn = await h.callTool(member, 'list_workflows', {});
    expect(turn.result).toContain(own.name);
    expect(turn.result).not.toContain(foreign.name);
    // the owner sees both
    const all = await h.callTool(h.owner, 'list_workflows', { limit: 100 });
    expect(all.result).toContain(own.name);
    expect(all.result).toContain(foreign.name);
  });

  it('projectId on a list tool cannot reach a project the member cannot read', async () => {
    for (const [tool, args] of [
      ['list_workflows', { projectId: theirs }],
      ['list_executions', { projectId: theirs }],
      ['list_data_tables', { projectId: theirs }],
      ['list_folders', { projectId: theirs }],
      ['list_credentials', { projectId: theirs }],
    ] as const) {
      const turn = await h.callTool(member, tool, args);
      expect(turn.result, tool).toContain(`Error: ${MISSING_SCOPE_MESSAGE}`);
    }
  });

  it('a tool on a row of another project is refused with the missing scope text', async () => {
    const foreign = await workflowIn(h.server, h.tenantId, theirs, { name: `Hidden ${suffix()}` });
    for (const tool of ['get_workflow', 'list_workflow_versions', 'validate_workflow']) {
      const turn = await h.callTool(member, tool, { workflowId: foreign.id });
      expect(turn.result, tool).toContain(MISSING_SCOPE_MESSAGE);
      expect(turn.result, tool).not.toContain(foreign.name);
    }
    const table = await dataTableIn(h.server, h.tenantId, theirs, `hidden_${suffix()}`);
    const schema = await h.callTool(member, 'get_data_table_schema', { dataTableId: table.id });
    expect(schema.result).toContain(MISSING_SCOPE_MESSAGE);
    const rows = await h.callTool(member, 'query_data_table_rows', { dataTableId: table.id });
    expect(rows.result).toContain(MISSING_SCOPE_MESSAGE);
  });

  it('list_data_tables and list_credentials show the member projects only', async () => {
    const own = await dataTableIn(h.server, h.tenantId, mine, `mine_${suffix()}`);
    const foreign = await dataTableIn(h.server, h.tenantId, theirs, `theirs_${suffix()}`);
    const tables = await h.callTool(member, 'list_data_tables', {});
    expect(tables.result).toContain(own.name);
    expect(tables.result).not.toContain(foreign.name);

    const ownCredential = await credentialIn(h.server, h.tenantId, mine, { name: `Own key ${suffix()}` });
    const foreignCredential = await credentialIn(h.server, h.tenantId, theirs, {
      name: `Foreign key ${suffix()}`,
    });
    const credentials = await h.callTool(member, 'list_credentials', {});
    expect(credentials.result).toContain(ownCredential.name);
    expect(credentials.result).not.toContain(foreignCredential.name);
    expect(credentials.result).not.toContain('secret');
  });

  it('list_projects names the member projects and not the others', async () => {
    const turn = await h.callTool(member, 'list_projects', {});
    const mineRow = await h.ctx.repos.projects.get(h.tenantId, mine);
    const theirRow = await h.ctx.repos.projects.get(h.tenantId, theirs);
    expect(turn.result).toContain(mineRow?.name as string);
    expect(turn.result).toContain(mine);
    expect(turn.result).not.toContain(theirRow?.name as string);
    expect(turn.result).not.toContain(theirs);
    // a workspace owner sees every project
    const all = await h.callTool(h.owner, 'list_projects', {});
    expect(all.result).toContain(theirs);
  });

  it('scope personal and shared only narrow the list', async () => {
    const own = await workflowIn(h.server, h.tenantId, mine, { name: `Team only ${suffix()}` });
    const personal = await h.callTool(member, 'list_workflows', { scope: 'personal' });
    expect(personal.result).not.toContain(own.name);
    const shared = await h.callTool(member, 'list_workflows', { scope: 'shared' });
    expect(shared.result).not.toContain(own.name);
    const everything = await h.callTool(member, 'list_workflows', { scope: 'all' });
    expect(everything.result).toContain(own.name);
  });
});

describe('Assistant writes by project', () => {
  it('a write tool on a workflow of another project is refused and nothing waits', async () => {
    const foreign = await workflowIn(h.server, h.tenantId, theirs, { name: `Keep ${suffix()}` });
    for (const tool of ['archive_workflow', 'publish_workflow', 'unpublish_workflow']) {
      const turn = await h.callTool(member, tool, { workflowId: foreign.id });
      expect(turn.status.isSuspended, tool).toBe(false);
      expect(turn.status.pending, tool).toEqual([]);
      expect(turn.result, tool).toContain(MISSING_SCOPE_MESSAGE);
    }
    expect((await h.ctx.repos.workflows.get(h.tenantId, foreign.id))?.isArchived).toBe(false);
  });

  it('create_data_table refuses a project the member cannot write in, with no card', async () => {
    const name = `refused_${suffix()}`;
    const turn = await h.callTool(member, 'create_data_table', { name, columns: [], projectId: theirs });
    expect(turn.status.isSuspended).toBe(false);
    expect(turn.result).toContain(MISSING_SCOPE_MESSAGE);
    const tables = await h.ctx.dataTables.list(h.tenantId, { name, take: 10 });
    expect(tables.data).toEqual([]);
  });

  it('create_data_table without a project writes to the member default project after approval', async () => {
    const name = `made_${suffix()}`;
    const turn = await h.callTool(member, 'create_data_table', { name, columns: [] });
    expect(turn.status.isSuspended).toBe(true);
    const status = await h.waitForStatus(member, turn.threadId, (s) => s.pending.length > 0);
    const card = status.pending[0] as Card;
    const res = await h.confirm(member, card.requestId, approve);
    expect(res.statusCode).toBe(200);
    await h.waitForStatus(member, turn.threadId, 'idle');
    const found = await h.ctx.dataTables.list(h.tenantId, { name, take: 10 });
    expect(found.data).toHaveLength(1);
    const row = await h.ctx.repos.dataTables.get(h.tenantId, found.data[0]?.id as string);
    // where a write without a project lands: `targetProject` (the personal project once L24 has cut over)
    const tenant = (await h.ctx.repos.tenants.get(h.tenantId))!;
    const user = (await h.ctx.repos.users.get(member.userId))!;
    expect(row?.projectId).toBe(await h.ctx.access.targetProject({ tenant, user, role: 'member' }));
  });

  it('a project lost while a card waits stops the approved call', async () => {
    const guest = await newMember();
    await addToProject(h.server, h.tenantId, mine, guest.userId, 'project:editor');
    const flow = await workflowIn(h.server, h.tenantId, mine, { name: `Lose ${suffix()}` });
    const turn = await h.callTool(guest, 'archive_workflow', { workflowId: flow.id });
    expect(turn.status.isSuspended).toBe(true);
    const status = await h.waitForStatus(guest, turn.threadId, (s) => s.pending.length > 0);
    const card = status.pending[0] as Card;
    expect(card.resourceName).toBe(flow.name);

    // the member leaves the project before the answer
    expect(await h.ctx.repos.projects.relations.remove(h.tenantId, mine, guest.userId)).toBe(true);
    const before = h.fake.requests.length;
    const res = await h.confirm(guest, card.requestId, approve);
    expect(res.statusCode).toBe(200);
    await waitFor(async () => h.fake.requests.length > before, { timeout: 15_000, message: 'resumed turn' });
    await h.waitForStatus(guest, turn.threadId, 'idle');
    expect((await h.ctx.repos.workflows.get(h.tenantId, flow.id))?.isArchived).toBe(false);
    const result = toolResultOf([h.fake.requests.at(-1)], turn.toolCallId) ?? '';
    expect(result).toMatch(/^Error: /);
    expect(result).toMatch(/no longer have access|missing a scope/);
  });

  it('the same card runs when the member keeps the project', async () => {
    const flow = await workflowIn(h.server, h.tenantId, mine, { name: `Keep going ${suffix()}` });
    const turn = await h.callTool(member, 'archive_workflow', { workflowId: flow.id });
    const status = await h.waitForStatus(member, turn.threadId, (s) => s.pending.length > 0);
    const card = status.pending[0] as Card;
    const res = await h.confirm(member, card.requestId, approve);
    expect(res.statusCode).toBe(200);
    await h.waitForStatus(member, turn.threadId, 'idle');
    expect((await h.ctx.repos.workflows.get(h.tenantId, flow.id))?.isArchived).toBe(true);
  });

  it('every built-in tool names its scope', () => {
    for (const tool of builtInAssistantTools()) {
      expect(tool.access, tool.name).toBeDefined();
      expect(tool.minRole, `${tool.name} has no minRole`).toBeUndefined();
      expect(toolAccess(tool), tool.name).toBe(tool.access);
    }
  });
});

describe('get_node_parameter_options by project', () => {
  it("refuses another project's credential before any request", async () => {
    const foreign = await credentialIn(h.server, h.tenantId, theirs, {
      name: `Models ${suffix()}`,
      type: 'openAiApi',
      data: { apiKey: 'sk-scope-test-0000000000000000', baseUrl: 'http://127.0.0.1:9/v1' },
    });
    const turn = await h.callTool(member, 'get_node_parameter_options', {
      nodeType: 'ai.lmChatOpenAi',
      version: 1,
      parameterPath: 'model',
      credentialId: foreign.id,
      projectId: mine,
    });
    expect(turn.result).toMatch(/^Error: /);
    expect(turn.result).toContain('does not have access to the credential');
    expect(JSON.stringify(h.fake.requests)).not.toContain('sk-scope-test');
  });

  it('a project the member cannot write in is refused', async () => {
    const own = await credentialIn(h.server, h.tenantId, mine, {
      name: `Own models ${suffix()}`,
      type: 'openAiApi',
      data: { apiKey: 'sk-scope-own-00000000000000000', baseUrl: 'http://127.0.0.1:9/v1' },
    });
    const turn = await h.callTool(member, 'get_node_parameter_options', {
      nodeType: 'ai.lmChatOpenAi',
      version: 1,
      parameterPath: 'model',
      credentialId: own.id,
      projectId: theirs,
    });
    expect(turn.result).toContain(MISSING_SCOPE_MESSAGE);
  });
});

describe('Assistant routes by scope', () => {
  it('settings need instanceAi:manage: a member is refused, aiAssistant:manage alone is not enough', async () => {
    expect((await member.client.get('/rest/assistant/settings')).statusCode).toBe(403);
    expect((await member.client.patch('/rest/assistant/settings', { enabled: true })).statusCode).toBe(403);
    expect((await h.admin.client.get('/rest/assistant/settings')).statusCode).toBe(200);

    // a workspace role with only aiAssistant:manage is POST /ai/usage-settings, not the Assistant settings
    const slug = `ai-usage-${suffix()}`;
    await h.ctx.repos.roles.create(h.tenantId, {
      slug,
      displayName: 'AI usage',
      roleType: 'global',
      scopes: ['aiAssistant:manage'],
    });
    const other = await newMember();
    await h.ctx.repos.memberships.updateRole(h.tenantId, other.userId, slug);
    const res = await other.client.get('/rest/assistant/settings');
    expect(res.statusCode).toBe(403);
    expect(res.json().error.message).toBe(MISSING_SCOPE_MESSAGE);
  });

  it('a member chats, lists its threads and reads the MCP list; writes stay with the admin', async () => {
    const threadId = await h.createThread(member);
    const threads = await member.client.get('/rest/assistant/threads');
    expect(threads.statusCode).toBe(200);
    expect(JSON.stringify(threads.json())).toContain(threadId);
    // the MCP connections answer 404 while MCP access is off
    expect((await member.client.get('/rest/assistant/mcp-connections')).statusCode).toBe(404);
    await h.setSettings({ mcpAccessEnabled: true });
    expect((await member.client.get('/rest/assistant/mcp-connections')).statusCode).toBe(200);
    const created = await member.client.post('/rest/assistant/mcp-connections', {
      name: 'Docs',
      url: 'https://mcp.example.com/mcp',
    });
    expect(created.statusCode).toBe(403);
    expect(created.json().error.message).toBe(MISSING_SCOPE_MESSAGE);
    await h.setSettings({});
  });

  it("an MCP connection's credential must be usable by the admin who saves it", async () => {
    await h.setSettings({ mcpAccessEnabled: true });
    try {
      const foreign = await credentialIn(h.server, h.tenantId, theirs, {
        name: `Bearer ${suffix()}`,
        type: 'httpBearerAuth',
        data: { token: 'tok-scope-test-0000' },
      });
      // the admin of the workspace works in the default team project: the other project's credential is refused
      const refused = await h.admin.client.post('/rest/assistant/mcp-connections', {
        name: `Docs ${suffix()}`,
        url: 'https://mcp.example.com/mcp',
        authentication: 'bearerAuth',
        credentialId: foreign.id,
      });
      expect(refused.statusCode).toBe(400);
      expect(refused.json().error.message).toContain('does not have access to the credential');

      const usable = await credentialIn(h.server, h.tenantId, mine, {
        name: `Bearer ${suffix()}`,
        type: 'httpBearerAuth',
        data: { token: 'tok-scope-own-0000' },
      });
      const saved = await h.admin.client.post('/rest/assistant/mcp-connections', {
        name: `Docs ${suffix()}`,
        url: 'https://mcp.example.com/mcp',
        authentication: 'bearerAuth',
        credentialId: usable.id,
      });
      expect(saved.statusCode).toBe(200);
      // every member reads the list; none of them is asked for the credential's project
      const list = await member.client.get('/rest/assistant/mcp-connections');
      expect(list.statusCode).toBe(200);
      expect(JSON.stringify(list.json())).toContain(usable.id);
    } finally {
      await h.setSettings({});
    }
  });
});

describe('drafts by project', () => {
  async function putDraft(user: HarnessUser, extra: Record<string, unknown>) {
    const threadId = await h.createThread(user);
    const id = randomUUID();
    const now = new Date().toISOString();
    await h.ctx.assistantDrafts.put(h.tenantId, threadId, {
      id,
      name: `Draft ${suffix()}`,
      workflowId: null,
      baseVersionId: null,
      definition: { name: 'Draft', nodes: [], connections: {}, settings: {} },
      createdAt: now,
      updatedAt: now,
      status: 'open',
      nodeCount: 0,
      issues: [],
      ...extra,
    });
    return { threadId, id, updatedAt: now };
  }
  const url = (threadId: string, id: string) => `/rest/assistant/threads/${threadId}/drafts/${id}`;

  it('accepts into a project where the member holds workflow:create', async () => {
    const draft = await putDraft(member, { projectId: mine });
    const res = await member.client.post(`${url(draft.threadId, draft.id)}/accept`, {
      updatedAt: draft.updatedAt,
    });
    expect(res.statusCode).toBe(200);
    const saved = await h.ctx.repos.workflows.get(h.tenantId, res.json().data.workflowId);
    expect(saved?.projectId).toBe(mine);
  });

  it('refuses a draft built for a project the member cannot write in, and the draft stays open', async () => {
    const draft = await putDraft(member, { projectId: theirs });
    const res = await member.client.post(`${url(draft.threadId, draft.id)}/accept`, {
      updatedAt: draft.updatedAt,
    });
    expect(res.statusCode).toBe(403);
    expect(res.json().error.message).toBe(MISSING_SCOPE_MESSAGE);
    const view = await member.client.data<{ draft: { status: string } }>(
      member.client.get(url(draft.threadId, draft.id)),
    );
    expect(view.draft.status).toBe('open');
  });

  it('refuses a draft of a saved workflow the member may not change', async () => {
    const foreign = await workflowIn(h.server, h.tenantId, theirs, { name: `Base ${suffix()}` });
    const draft = await putDraft(member, { workflowId: foreign.id, baseVersionId: foreign.versionId });
    const got = await member.client.get(url(draft.threadId, draft.id));
    expect(got.statusCode).toBe(403);
    const res = await member.client.post(`${url(draft.threadId, draft.id)}/accept`, {
      updatedAt: draft.updatedAt,
    });
    expect(res.statusCode).toBe(403);
  });

  it("another user's draft is 404", async () => {
    const draft = await putDraft(member, { projectId: mine });
    const stranger = await newMember();
    expect((await stranger.client.get(url(draft.threadId, draft.id))).statusCode).toBe(404);
  });

  it('a member discards its own draft', async () => {
    const draft = await putDraft(member, { projectId: mine });
    const discarded = await member.client.post(`${url(draft.threadId, draft.id)}/discard`, {});
    expect(discarded.statusCode).toBe(200);
  });
});
