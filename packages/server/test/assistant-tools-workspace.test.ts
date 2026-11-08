/**
 * P5-69 (L5): the Assistant's tag, folder, test execution and credential tools through L1's chat and
 * L3's approvals on the C0e harness. Roles of each tool; tags (list wrapped, a card that names the new
 * tags, existing tags stay); folders (create, move, delete with a card every time); cleanup of manual
 * executions only; credentials (id, name and type only, the type search, a test that returns a scrubbed
 * message, delete with a card every time and an audit row); another workspace's ids refused for each
 * domain with no card; a seeded secret never appears in a result, an event or a request to the model.
 */
import { randomUUID } from 'node:crypto';
import type { AssistantConfirmation, AssistantEvent } from '@workflow/workflow';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { credentialsTools } from '../src/services/assistant/tools/credentials';
import { workspaceTools } from '../src/services/assistant/tools/workspace';
import {
  type AssistantHarness,
  CANARY,
  createAssistantHarness,
  type HarnessUser,
  toolResultOf,
} from './fakes/assistant-harness';
import { chain, createWorkflow, node, waitFor } from './helpers';

const approve = { kind: 'approval', approved: true } as const;
type Card = Extract<AssistantConfirmation, { inputType: 'approval' }>;
const SECRET = 'sk-proj-WorkspaceSecret0123456789abcdefXYZ';

let h: AssistantHarness;
const suffix = () => Math.random().toString(36).slice(2, 8);

beforeAll(async () => {
  h = await createAssistantHarness({});
});
afterAll(async () => {
  await h?.close();
});

async function cardFor(user: HarnessUser, name: string, args: Record<string, unknown>) {
  const turn = await h.callTool(user, name, args);
  expect(turn.status.isSuspended, `${name} waits for a person`).toBe(true);
  const status = await h.waitForStatus(user, turn.threadId, (s) => s.pending.length > 0);
  return { turn, card: status.pending[0] as Card };
}

async function approveCard(user: HarnessUser, turn: { threadId: string; toolCallId: string }, card: Card) {
  const before = h.fake.requests.length;
  const res = await h.confirm(user, card.requestId, approve);
  expect(res.statusCode).toBe(200);
  await waitFor(async () => h.fake.requests.length > before, { timeout: 15_000, message: 'resumed turn' });
  await h.waitForStatus(user, turn.threadId, 'idle');
  return toolResultOf([h.fake.requests.at(-1)], turn.toolCallId) ?? '';
}

const eventsOf = (user: HarnessUser, threadId: string): Promise<AssistantEvent[]> =>
  h.events(user, threadId, 0, { until: (list) => list.some((e) => e.type === 'run-finish') });

/** the JSON inside a wrapped read result */
function unwrap(result: string | undefined): any {
  const text = (result ?? '').split('\n').slice(1, -1).join('\n');
  return JSON.parse(text.replaceAll('&lt;', '<'));
}

const makeWorkflow = async (name = `wf_${suffix()}`) => ({
  ...(await createWorkflow(h.owner.client, {
    name,
    nodes: [node('Start', 'core.manualTrigger')],
    connections: chain('Start'),
  })),
  name,
});

const getWorkflow = (id: string) =>
  h.owner.client.data<{ id: string; folderId: string | null; tags: Array<{ id: string; name: string }> }>(
    h.owner.client.get(`/rest/workflows/${id}`),
  );

describe('Assistant workspace and credential tools (P5-69)', () => {
  it('has the roles of the REST routes, a permission on every write and untrusted on the reads', async () => {
    await h.expectToolRoles({
      list_tags: 'viewer',
      tag_workflow: 'editor',
      cleanup_test_executions: 'editor',
      list_folders: 'viewer',
      create_folder: 'editor',
      delete_folder: 'editor',
      move_workflow_to_folder: 'editor',
      list_credentials: 'viewer',
      search_credential_types: 'viewer',
      test_credential: 'editor',
      delete_credential: 'editor',
    });
    const all = [...workspaceTools, ...credentialsTools];
    expect(all).toHaveLength(11);
    const writes = all.filter((t) => t.permission !== undefined).map((t) => t.name);
    expect(writes.sort()).toEqual([
      'cleanup_test_executions',
      'create_folder',
      'delete_credential',
      'delete_folder',
      'move_workflow_to_folder',
      'tag_workflow',
    ]);
    for (const tool of all.filter((t) => t.permission === undefined)) {
      // reads and the test carry a source; only the static type search has none
      expect(tool.untrusted !== undefined, tool.name).toBe(tool.name !== 'search_credential_types');
    }
    expect(workspaceTools.find((t) => t.name === 'delete_folder')?.grantKey?.({})).toBeNull();
    expect(credentialsTools.find((t) => t.name === 'delete_credential')?.grantKey?.({})).toBeNull();
  });

  it('tags: a viewer lists them wrapped; tag_workflow shows the new tags, then adds and keeps the old ones', async () => {
    const old = `old_${suffix()}`;
    const fresh = `fresh_${suffix()}`;
    const wf = await makeWorkflow();
    await h.owner.client.data(h.owner.client.post('/rest/tags', { name: old }));
    const first = await cardFor(h.editor, 'tag_workflow', { workflowId: wf.id, tags: [old] });
    await approveCard(h.editor, first.turn, first.card);

    const { turn, card } = await cardFor(h.editor, 'tag_workflow', { workflowId: wf.id, tags: [fresh, old] });
    expect(card.allowSession).toBe(true);
    expect(card.details.facts).toEqual([
      { label: 'Workflow', value: wf.name },
      { label: 'Tags to add', value: `${fresh}, ${old}` },
      { label: 'New tags', value: fresh },
    ]);
    expect((await getWorkflow(wf.id)).tags.map((t) => t.name)).toEqual([old]);
    const result = JSON.parse(await approveCard(h.editor, turn, card));
    expect(result.tags.map((t: { name: string }) => t.name).sort()).toEqual([fresh, old].sort());
    expect((await getWorkflow(wf.id)).tags.map((t) => t.name).sort()).toEqual([fresh, old].sort());

    const listed = await h.callTool(h.viewer, 'list_tags', {});
    expect(listed.result).toContain('source="tags"');
    expect(unwrap(listed.result).data.map((t: { name: string }) => t.name)).toEqual(
      expect.arrayContaining([fresh, old]),
    );
    const audit = await h.ctx.repos.audit.list(h.tenantId, 200);
    expect(
      audit.some(
        (r) => r.action === 'workflow.updated' && r.resourceId === wf.id && r.userId === h.editor.userId,
      ),
    ).toBe(true);
  });

  it('folders: create, move a workflow in, list, delete with a card every time', async () => {
    const name = `folder_${suffix()}`;
    const made = await cardFor(h.editor, 'create_folder', { name });
    expect(made.card.details.facts).toEqual([
      { label: 'Name', value: name },
      { label: 'Inside', value: 'Top level' },
    ]);
    const folder = JSON.parse(await approveCard(h.editor, made.turn, made.card));
    expect(folder).toMatchObject({ name, parentFolderId: null });

    const wf = await makeWorkflow();
    const moved = await cardFor(h.editor, 'move_workflow_to_folder', {
      workflowId: wf.id,
      folderId: folder.id,
    });
    expect(moved.card.details.facts).toContainEqual({ label: 'Move to', value: name });
    expect((await getWorkflow(wf.id)).folderId).toBeNull();
    expect(JSON.parse(await approveCard(h.editor, moved.turn, moved.card))).toEqual({ moved: [wf.id] });
    expect((await getWorkflow(wf.id)).folderId).toBe(folder.id);

    const listed = await h.callTool(h.viewer, 'list_folders', { search: name });
    expect(listed.result).toContain('source="folders"');
    expect(unwrap(listed.result).data.map((f: { id: string }) => f.id)).toEqual([folder.id]);

    const drop = await cardFor(h.editor, 'delete_folder', {
      folderId: folder.id,
      transferToFolderId: 'root',
    });
    expect(drop.card.allowSession).toBe(false);
    expect(drop.card.details.facts).toEqual([
      { label: 'Folder', value: name },
      { label: 'Workflows inside', value: '1' },
      { label: 'What happens to them', value: 'Workflows and subfolders move to the top level' },
    ]);
    expect(JSON.parse(await approveCard(h.editor, drop.turn, drop.card))).toEqual({
      deleted: true,
      folderId: folder.id,
    });
    expect((await h.owner.client.get(`/rest/folders/${folder.id}`)).statusCode).toBe(404);
    expect((await getWorkflow(wf.id)).folderId).toBeNull();
    const audit = await h.ctx.repos.audit.list(h.tenantId, 300);
    expect(audit.some((r) => r.action === 'folder.deleted' && r.resourceId === folder.id)).toBe(true);
  });

  it('delete_folder without a target says every workflow inside is archived', async () => {
    const created = await h.owner.client.data<{ id: string }>(
      h.owner.client.post('/rest/folders', { name: `arch_${suffix()}` }),
    );
    const { card } = await cardFor(h.editor, 'delete_folder', { folderId: created.id });
    expect(card.details.facts[2].value).toContain('archived');
  });

  it('cleanup_test_executions: deletes finished manual runs of one workflow only', async () => {
    const wf = await makeWorkflow();
    const other = await makeWorkflow();
    const insert = (workflowId: string, mode: string, status: string) => {
      const id = randomUUID();
      return h.ctx.repos.executions
        .create(
          h.tenantId,
          { id, workflowId, workflowName: 'W', mode, status, startedAt: new Date() },
          {
            workflowData: { id: workflowId, name: 'W', nodes: [], connections: {}, settings: {} },
            runOptions: {},
          },
        )
        .then(() => id);
    };
    const manual1 = await insert(wf.id, 'manual', 'success');
    const manual2 = await insert(wf.id, 'manual', 'error');
    const running = await insert(wf.id, 'manual', 'running');
    const production = await insert(wf.id, 'trigger', 'success');
    const elsewhere = await insert(other.id, 'manual', 'success');

    const { turn, card } = await cardFor(h.editor, 'cleanup_test_executions', { workflowId: wf.id });
    expect(card.details.facts).toContainEqual({ label: 'Test executions to delete', value: '2' });
    expect(card.details.facts).toContainEqual({ label: 'Still running, left alone', value: '1' });
    expect(await h.ctx.repos.executions.get(h.tenantId, manual1)).toBeDefined();
    expect(JSON.parse(await approveCard(h.editor, turn, card))).toEqual({
      deleted: 2,
      skippedActive: 1,
      more: false,
    });
    expect(await h.ctx.repos.executions.get(h.tenantId, manual1)).toBeUndefined();
    expect(await h.ctx.repos.executions.get(h.tenantId, manual2)).toBeUndefined();
    for (const kept of [running, production, elsewhere]) {
      expect(await h.ctx.repos.executions.get(h.tenantId, kept)).toBeDefined();
    }
    await h.ctx.repos.executions.delete(h.tenantId, running);
  });

  it('credentials: the list holds id, name and type only; the type search is static; a viewer cannot test or delete', async () => {
    const name = `cred_${suffix()}`;
    const cred = await h.owner.client.data<{ id: string }>(
      h.owner.client.post('/rest/credentials', {
        name,
        type: 'openAiApi',
        data: { apiKey: SECRET, baseUrl: h.fake.baseUrl },
      }),
    );
    const listed = await h.callTool(h.viewer, 'list_credentials', { type: 'openAiApi' });
    expect(listed.result).toContain('source="credentials"');
    const entry = unwrap(listed.result).data.find((c: { id: string }) => c.id === cred.id);
    expect(entry).toEqual({ id: cred.id, name, type: 'openAiApi' });
    expect(listed.result).not.toContain(SECRET);
    expect(listed.result).not.toContain(CANARY.credential);

    const types = await h.callTool(h.viewer, 'search_credential_types', { query: 'openai' });
    expect(types.result).not.toContain('<untrusted');
    expect(JSON.parse(types.result ?? '{}').data.map((t: { name: string }) => t.name)).toContain('openAiApi');

    for (const tool of ['test_credential', 'delete_credential']) {
      const turn = await h.callTool(h.viewer, tool, { credentialId: cred.id });
      expect(turn.status.pending, tool).toEqual([]);
    }
    expect((await h.owner.client.get(`/rest/credentials/${cred.id}`)).statusCode).toBe(200);
  });

  it('test_credential: an editor gets a status with no card; the secret is not in the answer', async () => {
    const cred = await h.owner.client.data<{ id: string }>(
      h.owner.client.post('/rest/credentials', {
        name: `test_${suffix()}`,
        type: 'openAiApi',
        data: { apiKey: SECRET, baseUrl: h.fake.baseUrl },
      }),
    );
    const turn = await h.callTool(h.editor, 'test_credential', { credentialId: cred.id });
    expect(turn.status.pending).toEqual([]);
    expect(turn.result).toContain('source="credential-test"');
    const answer = unwrap(turn.result);
    expect(['OK', 'Error']).toContain(answer.status);
    expect(Object.keys(answer).sort()).toEqual(['message', 'status']);
    expect(turn.result).not.toContain(SECRET);
  });

  it('delete_credential: a card with the name and type, none to change the grant, then gone with an audit row', async () => {
    const name = `drop_${suffix()}`;
    const cred = await h.owner.client.data<{ id: string }>(
      h.owner.client.post('/rest/credentials', {
        name,
        type: 'openAiApi',
        data: { apiKey: SECRET, baseUrl: h.fake.baseUrl },
      }),
    );
    const { turn, card } = await cardFor(h.editor, 'delete_credential', { credentialId: cred.id });
    expect(card.allowSession).toBe(false);
    expect(card.resourceName).toBe(name);
    expect(card.details.facts).toEqual([
      { label: 'Credential', value: name },
      { label: 'Type', value: 'openAiApi' },
    ]);
    expect(JSON.stringify(card)).not.toContain(SECRET);
    expect((await h.owner.client.get(`/rest/credentials/${cred.id}`)).statusCode).toBe(200);
    expect(JSON.parse(await approveCard(h.editor, turn, card))).toEqual({
      deleted: true,
      credentialId: cred.id,
    });
    expect((await h.owner.client.get(`/rest/credentials/${cred.id}`)).statusCode).toBe(404);
    const audit = await h.ctx.repos.audit.list(h.tenantId, 300);
    const row = audit.find((r) => r.action === 'credential.deleted' && r.resourceId === cred.id);
    expect(row?.userId).toBe(h.editor.userId);
  });

  it("another workspace's workflow, folder and credential ids are refused with no card", async () => {
    const otherFolder = await h.other.owner.client.data<{ id: string }>(
      h.other.owner.client.post('/rest/folders', { name: 'Other folder' }),
    );
    const own = await makeWorkflow();
    const calls: Array<[string, Record<string, unknown>]> = [
      ['tag_workflow', { workflowId: h.other.workflowId, tags: ['x'] }],
      ['cleanup_test_executions', { workflowId: h.other.workflowId }],
      ['move_workflow_to_folder', { workflowId: h.other.workflowId, folderId: null }],
      ['move_workflow_to_folder', { workflowId: own.id, folderId: otherFolder.id }],
      ['delete_folder', { folderId: otherFolder.id }],
      ['create_folder', { name: 'x', parentFolderId: otherFolder.id }],
      ['test_credential', { credentialId: h.other.credentialId }],
      ['delete_credential', { credentialId: h.other.credentialId }],
    ];
    for (const [tool, args] of calls) {
      const turn = await h.callTool(h.owner, tool, args);
      expect(turn.status.pending, `${tool} shows no card`).toEqual([]);
      expect(turn.result, `${tool} is refused`).toMatch(/not found|could not be found/i);
    }
    const creds = await h.callTool(h.owner, 'list_credentials', {});
    const folders = await h.callTool(h.owner, 'list_folders', { limit: 100 });
    expect(creds.result).not.toContain(h.other.credentialId);
    expect(folders.result).not.toContain(otherFolder.id);
    expect((await getWorkflow(own.id)).folderId).toBeNull();
    // the id is in the model's own call; nothing else of the other workspace is in a request
    const sent = JSON.stringify(h.fake.requests);
    for (const value of [
      CANARY.workspace,
      CANARY.workflow,
      CANARY.credential,
      CANARY.secret,
      'Other folder',
    ]) {
      expect(sent, `${value} reached the model`).not.toContain(value);
    }
    expect((await h.other.owner.client.get(`/rest/credentials/${h.other.credentialId}`)).statusCode).toBe(
      200,
    );
  });

  it('a seeded secret never appears in a request to the model or in an event', async () => {
    const turn = await h.callTool(h.owner, 'list_credentials', {});
    const events = await eventsOf(h.owner, turn.threadId);
    expect(JSON.stringify(events)).not.toContain(SECRET);
    expect(JSON.stringify(h.fake.requests)).not.toContain(SECRET);
  });
});
