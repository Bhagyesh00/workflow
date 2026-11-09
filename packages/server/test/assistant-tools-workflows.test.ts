/**
 * P5-69 (L4): the Assistant's workflow tools through L1's chat and L3's approvals on the C0e harness.
 * Roles match routes/workflows.ts (reads viewer, writes editor); another tenant's workflow id is not
 * found and its name never reaches the model; a viewer's model gets no write tool and a forged call is
 * refused; `publish_workflow` waits, runs after approval, the workflow is active and an `artifact` event
 * follows; a secret-shaped parameter never reaches the fake LLM; values off sends structure only;
 * archive, unarchive, unpublish, restore (never publishes) and version rename go through cards.
 */
import type { AssistantConfirmation, Scope } from '@workflow/workflow';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  type AssistantHarness,
  CANARY,
  createAssistantHarness,
  type HarnessUser,
  toolResultOf,
} from './fakes/assistant-harness';
import { chain, createWorkflow, node, setNode, waitFor } from './helpers';

const SECRET = 'sk-proj-WorkflowToolSecret0123456789abcdef';

/** the route scopes (routes/workflows.ts): GET read or list, every write its own scope */
const ROLES: Record<string, Scope> = {
  list_workflows: 'workflow:list',
  get_workflow: 'workflow:read',
  list_workflow_versions: 'workflow:read',
  validate_workflow: 'workflow:read',
  archive_workflow: 'workflow:delete',
  unarchive_workflow: 'workflow:delete',
  publish_workflow: 'workflow:publish',
  unpublish_workflow: 'workflow:unpublish',
  restore_workflow_version: 'workflow:update',
  update_workflow_version: 'workflow:update',
};

type Body = { tools?: Array<{ function?: { name?: string } }> };

const approve = { kind: 'approval', approved: true } as const;

describe('Assistant workflow tools (P5-69)', () => {
  let h: AssistantHarness;
  let workflowId: string;

  beforeAll(async () => {
    h = await createAssistantHarness();
    const wf = await createWorkflow(h.owner.client, {
      name: 'Lead intake',
      nodes: [
        node('Start', 'core.webhook', { path: `lead-intake-${Date.now()}` }),
        setNode('Set token', 'token', SECRET),
      ],
      connections: chain('Start', 'Set token'),
    });
    workflowId = wf.id;
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
  async function callTool(user: HarnessUser, name: string, args: Record<string, unknown>) {
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
    const threadId = await h.createThread(user);
    const { runId } = await h.chat(user, threadId, `Call ${name}`);
    const status = await h.waitForStatus(
      user,
      threadId,
      (s) => !s.hasActiveRun && (s.pending.length > 0 || h.fake.requests.length >= at + 2),
      30_000,
    );
    return { threadId, runId, toolCallId, result: toolResultOf(h.fake.requests, toolCallId), status };
  }

  /** a card call: waits for the card, approves it, waits for the resumed turn; the tool's result */
  async function approved(user: HarnessUser, name: string, args: Record<string, unknown>) {
    const call = await callTool(user, name, args);
    expect(call.status.pending, `${name} waits for a card`).toHaveLength(1);
    const card = call.status.pending[0] as Extract<AssistantConfirmation, { inputType: 'approval' }>;
    const before = h.fake.requests.length;
    const res = await h.confirm(user, card.requestId, approve);
    expect(res.statusCode).toBe(200);
    await waitFor(async () => h.fake.requests.length > before, { timeout: 15_000, message: 'resumed turn' });
    await h.waitForStatus(user, call.threadId, 'idle');
    return { ...call, card, result: toolResultOf([h.fake.requests.at(-1)], call.toolCallId) ?? '' };
  }

  it('offers each tool from its route role up, and only those', async () => {
    await h.expectToolRoles(ROLES);
  });

  it("a viewer's write call on a team workflow is refused (P6-39: its write tools act in its personal project)", async () => {
    const call = await callTool(h.viewer, 'publish_workflow', { workflowId });
    const request = h.fake.requests.at(-2) as Body;
    const names = (request.tools ?? []).map((t) => t.function?.name);
    expect(names).toContain('list_workflows');
    expect(call.status.pending).toHaveLength(0);
    expect(call.result).toMatch(/missing a scope|publish_workflow|not found|unknown|not available/i);
    const row = await h.ctx.repos.workflows.get(h.tenantId, workflowId);
    expect(row?.active).toBe(false);
  });

  it('list_workflows shows this workspace only, wrapped as untrusted data', async () => {
    const call = await callTool(h.viewer, 'list_workflows', {});
    expect(call.result).toContain('<untrusted_data source="workflow-list">');
    expect(call.result).toContain('Lead intake');
    expect(call.result).not.toContain(CANARY.workflow);
    h.expectNoCanary();
  });

  it('get_workflow: sanitized definition, the secret never reaches the model, and an artifact event', async () => {
    const call = await callTool(h.viewer, 'get_workflow', { workflowId });
    expect(call.result).toContain('<untrusted_data source="workflow">');
    expect(call.result).toContain('Set token');
    expect(call.result).toContain('[redacted]');
    expect(JSON.stringify(h.fake.requests)).not.toContain(SECRET);
    const events = await h.events(h.viewer, call.threadId, 0, {
      until: (list) => list.some((e) => e.type === 'artifact'),
    });
    const artifact = events.find((e) => e.type === 'artifact');
    expect(artifact?.payload).toEqual({
      artifact: { type: 'workflow', id: workflowId, name: 'Lead intake' },
    });
  });

  it('values off: get_workflow sends the structure only', async () => {
    await h.setSettings({ allowSendingParameterValues: false });
    try {
      const wf = await createWorkflow(h.owner.client, {
        name: 'Values off',
        nodes: [node('Start', 'core.manualTrigger'), setNode('Greeting', 'greeting', 'hello-plain-value')],
        connections: chain('Start', 'Greeting'),
      });
      const call = await callTool(h.viewer, 'get_workflow', { workflowId: wf.id });
      expect(call.result).toContain('Greeting');
      expect(call.result).toContain('hidden by a workspace setting');
      expect(JSON.stringify(h.fake.requests)).not.toContain('hello-plain-value');
    } finally {
      await h.setSettings({});
    }
  });

  it("another tenant's workflow id is not found and its name never appears, for reads and writes", async () => {
    for (const name of ['get_workflow', 'list_workflow_versions', 'validate_workflow']) {
      const call = await callTool(h.owner, name, { workflowId: h.other.workflowId });
      // an untrusted tool's error comes back wrapped like its result (tool-adapter's shapeToolError)
      expect(call.result, name).toMatch(/^Error: .*not found/is);
    }
    // a write: the card copy reads the row, so no card is made
    const write = await callTool(h.owner, 'archive_workflow', { workflowId: h.other.workflowId });
    expect(write.status.pending).toHaveLength(0);
    expect(write.result).toMatch(/^Error: .*not found/i);
    const canary = await h.ctx.repos.workflows.get(h.other.tenantId, h.other.workflowId);
    expect(canary?.isArchived).toBe(false);
    // the id is in the model's own calls; the other workspace's names and secret never are
    const sent = JSON.stringify(h.fake.requests);
    for (const value of [CANARY.workflow, CANARY.workspace, CANARY.secret]) expect(sent).not.toContain(value);
  });

  it('publish_workflow waits and has not run; after approval the workflow is active and an artifact event follows', async () => {
    const call = await callTool(h.editor, 'publish_workflow', {
      workflowId,
      approvalSummary: 'Publishes Lead intake',
    });
    expect(call.status.pending, call.result).toHaveLength(1);
    const card = call.status.pending[0] as Extract<AssistantConfirmation, { inputType: 'approval' }>;
    expect(card).toMatchObject({
      toolName: 'publish_workflow',
      title: 'Publish workflow',
      resourceName: 'Lead intake',
      allowSession: true,
      approvalSummary: 'Publishes Lead intake',
    });
    expect(card.details.facts).toEqual(
      expect.arrayContaining([
        { label: 'Workflow', value: 'Lead intake' },
        { label: 'Published', value: 'No' },
      ]),
    );
    expect((await h.ctx.repos.workflows.get(h.tenantId, workflowId))?.active).toBe(false);

    const before = h.fake.requests.length;
    expect((await h.confirm(h.editor, card.requestId, approve)).statusCode).toBe(200);
    await waitFor(async () => h.fake.requests.length > before, { timeout: 15_000, message: 'resumed turn' });
    await h.waitForStatus(h.editor, call.threadId, 'idle');
    const result = toolResultOf([h.fake.requests.at(-1)], call.toolCallId);
    expect(result).toContain('"published":true');
    const row = await h.ctx.repos.workflows.get(h.tenantId, workflowId);
    expect(row?.active).toBe(true);
    expect(row?.publishedVersionId).toBe(row?.versionId);
    const events = await h.events(h.editor, call.threadId, 0, {
      until: (list) => list.some((e) => e.type === 'artifact'),
    });
    const types = events.map((e) => e.type);
    expect(types.indexOf('artifact')).toBeGreaterThan(types.indexOf('confirmation-resolved'));
    expect(events.find((e) => e.type === 'artifact')?.payload).toEqual({
      artifact: { type: 'workflow', id: workflowId, name: 'Lead intake' },
    });
  });

  it('unpublish, archive and unarchive go through cards; unarchive does not publish', async () => {
    const off = await approved(h.editor, 'unpublish_workflow', { workflowId });
    expect(off.result).toContain('"published":false');
    expect((await h.ctx.repos.workflows.get(h.tenantId, workflowId))?.active).toBe(false);

    const archived = await approved(h.editor, 'archive_workflow', { workflowId });
    expect(archived.card.title).toBe('Archive workflow');
    expect(archived.result).toContain('"archived":true');
    expect((await h.ctx.repos.workflows.get(h.tenantId, workflowId))?.isArchived).toBe(true);
    // the row is still there: archive never deletes
    const list = await callTool(h.viewer, 'list_workflows', { status: 'archived' });
    expect(list.result).toContain('Lead intake');

    const back = await approved(h.editor, 'unarchive_workflow', { workflowId });
    expect(back.result).toContain('"archived":false');
    const row = await h.ctx.repos.workflows.get(h.tenantId, workflowId);
    expect(row?.isArchived).toBe(false);
    expect(row?.active).toBe(false);
  });

  it('a publish blocked by an open review comes back as text, not a failure', async () => {
    const wf = await createWorkflow(h.owner.client, {
      name: 'Reviewed flow',
      nodes: [node('Start', 'core.manualTrigger')],
    });
    const spy = h.ctx.reviews.assertCanPublish.bind(h.ctx.reviews);
    const reviews = h.ctx.reviews as { assertCanPublish: typeof spy };
    const { ApiError } = await import('../src/http/errors');
    reviews.assertCanPublish = async () => {
      throw ApiError.conflict('An open review request blocks publishing this workflow');
    };
    try {
      const call = await approved(h.editor, 'publish_workflow', { workflowId: wf.id });
      expect(call.result).toContain('The workflow was not published: An open review request blocks');
      expect(call.result).not.toMatch(/^Error:/);
    } finally {
      reviews.assertCanPublish = spy;
    }
    expect((await h.ctx.repos.workflows.get(h.tenantId, wf.id))?.active).toBe(false);
  });

  it('versions: list, rename (update_workflow_version) and restore, which never publishes', async () => {
    const wf = await createWorkflow(h.owner.client, {
      name: 'Versioned',
      nodes: [node('Start', 'core.manualTrigger'), setNode('Set', 'field', 'first')],
      connections: chain('Start', 'Set'),
    });
    const firstVersion = wf.versionId;
    await h.owner.client.data(
      h.owner.client.patch(`/rest/workflows/${wf.id}`, {
        nodes: [
          node('Start', 'core.manualTrigger'),
          setNode('Set', 'field', 'second'),
          node('Extra', 'core.noOp'),
        ],
        connections: chain('Start', 'Set', 'Extra'),
        versionId: wf.versionId,
      }),
    );

    const versions = await callTool(h.viewer, 'list_workflow_versions', { workflowId: wf.id });
    expect(versions.result).toContain('<untrusted_data source="workflow-versions">');
    expect(versions.result).toContain(firstVersion);

    const renamed = await approved(h.editor, 'update_workflow_version', {
      workflowId: wf.id,
      versionId: firstVersion,
      name: 'Before the extra node',
    });
    expect(renamed.card.title).toBe('Rename a version');
    expect(renamed.result).toContain('"versionName":"Before the extra node"');

    const restored = await approved(h.editor, 'restore_workflow_version', {
      workflowId: wf.id,
      versionId: firstVersion,
    });
    expect(restored.card.details.facts).toEqual(
      expect.arrayContaining([{ label: 'Version', value: 'Before the extra node' }]),
    );
    expect(restored.result).toContain('Nothing was published');
    const row = await h.ctx.repos.workflows.get(h.tenantId, wf.id);
    expect(row?.active).toBe(false);
    expect(((row?.nodes ?? []) as Array<{ name: string }>).map((n) => n.name)).toEqual(['Start', 'Set']);
  });

  it('validate_workflow reports lint issues without running anything', async () => {
    const wf = await createWorkflow(h.owner.client, {
      name: 'Loose ends',
      nodes: [node('Start', 'core.manualTrigger'), setNode('Lonely', 'a', 'b', [400, 400])],
    });
    const runs = (await h.ctx.repos.executions.list(h.tenantId, { workflowId: wf.id, limit: 10 })).length;
    const call = await callTool(h.viewer, 'validate_workflow', { workflowId: wf.id });
    expect(call.result).toContain('<untrusted_data source="validation">');
    expect(call.result).toMatch(/"issues":\[/);
    expect(call.result).toContain('Lonely');
    expect((await h.ctx.repos.executions.list(h.tenantId, { workflowId: wf.id, limit: 10 })).length).toBe(
      runs,
    );
  });
});
