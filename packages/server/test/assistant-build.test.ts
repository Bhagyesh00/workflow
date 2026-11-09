/**
 * P5-70 (L7): `build_workflow` and the draft routes, through the whole path on the fake LLM (thread,
 * chat, run loop, the nested builder, the draft on the thread, GET, Accept, Discard).
 *
 * A chat request gives a draft and no workflow row exists or changes before Accept; Accept saves it
 * (create, or update on the draft's base version), writes an audit row, marks the draft accepted and
 * sends a `workflow` artifact; a stale base is 409; Accept names the version the person saw, so a
 * rebuilt draft is 409 until reviewed again; two Accepts on two processes save once and a Discard
 * never overwrites an Accept; Discard leaves nothing; a credential the model
 * writes is dropped and Accept fills the first credential of a needed type; another tenant's
 * `workflowId` is not found; another user's draft is 404 and a viewer's Accept 403; a viewer has no
 * `build_workflow`; an admin's block refuses it; tool names in every request are unique and the nested
 * builder's request carries S4's own build prompt; no tool reaches Accept.
 */
import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import type { AssistantEvent, DataObject, WorkflowDefinition } from '@workflow/workflow';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { AuthContext } from '../src/http/auth';
import { builderSystemPrompt } from '../src/services/ai-builder/prompt';
import {
  ASSISTANT_DRAFT_TEXTS,
  AssistantDrafts,
  type AssistantDraftView,
} from '../src/services/assistant/drafts';
import { builtInAssistantTools } from '../src/services/assistant/tools';
import { BUILD_BLOCKED, buildTools } from '../src/services/assistant/tools/build';
import {
  type AssistantHarness,
  CANARY,
  createAssistantHarness,
  type HarnessUser,
  toolResultOf,
} from './fakes/assistant-harness';
import type { FakeLlmStep } from './fakes/fake-llm';
import { createWorkflow, node } from './helpers';

let h: AssistantHarness;
let calls = 0;

beforeAll(async () => {
  h = await createAssistantHarness();
}, 120_000);

afterAll(async () => {
  await h?.close();
});

type Body = {
  messages?: Array<{ role?: string; content?: unknown; tool_call_id?: string }>;
  tools?: Array<{ function?: { name?: string } }>;
};

/** puts `steps` at the next unused place of the script, chats, waits until the thread is idle */
async function turn(
  user: HarnessUser,
  threadId: string,
  text: string,
  steps: FakeLlmStep[],
): Promise<Body[]> {
  const before = h.fake.requests.length;
  h.script.splice(before, 0, ...steps);
  await h.chat(user, threadId, text);
  await h.waitForStatus(user, threadId, 'idle', 60_000);
  return h.fake.requests.slice(before) as Body[];
}

function callId(): string {
  calls++;
  return `build_call_${calls}`;
}

const outerCall = (id: string, name: string, args: DataObject): FakeLlmStep => ({
  toolCalls: [{ id, name, arguments: args }],
});

async function workflowCount(): Promise<number> {
  return (await h.ctx.repos.workflows.list(h.tenantId, { limit: 1000, archived: 'all' })).length;
}

async function draftsOf(threadId: string) {
  return h.ctx.repos.assistantThreads.getDrafts(h.tenantId, threadId);
}

const draftUrl = (threadId: string, draftId: string) =>
  `/rest/assistant/threads/${threadId}/drafts/${draftId}`;

const ASSISTANT_DIR = path.join(__dirname, '../src/services/assistant');

/** every .ts file under `dir` */
function assistantSources(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) return assistantSources(full);
    return entry.name.endsWith('.ts') ? [full] : [];
  });
}

/** the draft version the card shows (GET `draft.updatedAt`), which Accept sends back */
async function seen(threadId: string, draftId: string, user: HarnessUser = h.owner): Promise<string> {
  const view = await user.client.data<AssistantDraftView>(user.client.get(draftUrl(threadId, draftId)));
  return view.draft.updatedAt;
}

const SLACK_URL = 'https://hooks.example.com/services/T0/B0/xyz';

/** the scripted build: the outer call, then the nested builder adds three nodes (one with a credential) and connects them */
function buildSteps(id: string, args: DataObject): FakeLlmStep[] {
  return [
    outerCall(id, 'build_workflow', args),
    {
      toolCalls: [
        {
          id: 'nested_add',
          name: 'add_nodes',
          arguments: {
            nodes: [
              { type: 'core.manualTrigger', name: 'Start' },
              {
                type: 'core.set',
                name: 'Shape',
                parameters: {
                  mode: 'manual',
                  assignments: { assignments: [{ id: 'a1', name: 'text', value: 'hello', type: 'string' }] },
                },
              },
              {
                type: 'core.httpRequest',
                name: 'Post',
                parameters: { method: 'POST', url: SLACK_URL },
                credentials: { httpHeaderAuth: { id: 'model-made-id', name: 'Made up' } },
              },
            ],
          },
        },
      ],
    },
    {
      toolCalls: [
        {
          id: 'nested_connect',
          name: 'connect_nodes',
          arguments: {
            items: [
              { from: 'Start', to: 'Shape' },
              { from: 'Shape', to: 'Post' },
            ],
          },
        },
      ],
    },
    { text: 'The draft posts a greeting.' },
    { text: 'Your draft is ready to review.' },
  ];
}

/** one built draft on a new thread of `user` */
async function buildDraft(user: HarnessUser = h.owner) {
  const threadId = await h.createThread(user);
  const id = callId();
  const requests = await turn(
    user,
    threadId,
    'Build a workflow that posts a greeting',
    buildSteps(id, {
      request: 'Post a greeting to a webhook',
    }),
  );
  const drafts = await draftsOf(threadId);
  const [draftId] = Object.keys(drafts);
  return { threadId, draftId, draft: drafts[draftId], requests, toolCallId: id };
}

describe('build_workflow', () => {
  it('gives a draft on the thread and saves no workflow before Accept', async () => {
    const count = await workflowCount();
    const { threadId, draftId, draft, requests, toolCallId } = await buildDraft();

    expect(draftId).toBeTruthy();
    expect(draft.status).toBe('open');
    expect(draft.workflowId).toBeNull();
    expect(draft.baseVersionId).toBeNull();
    expect(draft.definition.nodes.map((n) => n.name)).toEqual(['Start', 'Shape', 'Post']);
    expect(draft.nodeCount).toBe(3);
    // the credential the model wrote is gone
    const post = draft.definition.nodes.find((n) => n.name === 'Post');
    expect(post?.credentials).toBeUndefined();
    expect(JSON.stringify(draft)).not.toContain('model-made-id');
    expect(await workflowCount()).toBe(count);

    // the nested builder: S4's own build prompt, the draft tools only, each name once
    const nested = requests[1];
    expect(nested.messages?.[0]?.role).toBe('system');
    expect(nested.messages?.[0]?.content).toBe(builderSystemPrompt('build'));
    const nestedNames = (nested.tools ?? []).map((t) => t.function?.name);
    expect(nestedNames).toContain('add_nodes');
    expect(nestedNames).toContain('validate_workflow');
    expect(nestedNames).not.toContain('build_workflow');
    expect(new Set(nestedNames).size).toBe(nestedNames.length);
    // the outer request offers build_workflow once
    const outerNames = (requests[0].tools ?? []).map((t) => t.function?.name);
    expect(outerNames.filter((n) => n === 'build_workflow')).toHaveLength(1);
    expect(new Set(outerNames).size).toBe(outerNames.length);
    h.checkRequests();

    // the outer model reads the draft's facts; nothing says it was saved
    const result = toolResultOf(h.fake.requests, toolCallId) ?? '';
    expect(result).toContain(draftId);
    expect(result).toContain('"saved":false');

    // the thread got a draft artifact
    const events = await h.events(h.owner, threadId, 0, {
      until: (list) => list.some((e) => e.type === 'run-finish'),
    });
    const artifact = events.find((e) => e.type === 'artifact') as
      | Extract<AssistantEvent, { type: 'artifact' }>
      | undefined;
    expect(artifact?.payload.artifact).toEqual({ type: 'draft', draftId, name: draft.name });
  });

  it('GET shows the draft, the diff and the credential Accept assigns', async () => {
    // P6-39: the draft lands in the owner's personal project, so the credential is one of it
    const personal = (await h.ctx.repos.projects.getPersonal(h.tenantId, h.owner.userId))!.id;
    const credential = await h.owner.client.data<{ id: string }>(
      h.owner.client.post('/rest/credentials', {
        projectId: personal,
        name: 'Hook header',
        type: 'httpHeaderAuth',
        data: { name: 'x-key', value: 'header-secret-value-1' },
      }),
    );
    const { threadId, draftId } = await buildDraft();
    // the draft's HTTP node asks for the header credential (a node with none gets the first of its type)
    const stored = (await draftsOf(threadId))[draftId];
    const post = stored.definition.nodes.find((n) => n.name === 'Post');
    if (post)
      post.parameters = {
        ...post.parameters,
        authentication: 'genericCredentialType',
        genericAuthType: 'httpHeaderAuth',
      };
    await h.ctx.assistantDrafts.put(h.tenantId, threadId, stored);

    const view = await h.owner.client.data<AssistantDraftView>(
      h.owner.client.get(draftUrl(threadId, draftId)),
    );
    expect(view.draft.id).toBe(draftId);
    expect(view.draft.nodeCount).toBe(3);
    expect(view.diff.nodes.added.map((n) => n.name)).toEqual(['Start', 'Shape', 'Post']);
    expect(view.assignments).toEqual([
      {
        nodeName: 'Post',
        credentialType: 'httpHeaderAuth',
        credentialId: credential.id,
        credentialName: 'Hook header',
      },
    ]);
    expect(JSON.stringify(view)).not.toContain('header-secret-value-1');

    // Accept saves the node with that credential
    const accepted = await h.owner.client.data<{ workflowId: string }>(
      h.owner.client.post(`${draftUrl(threadId, draftId)}/accept`, { updatedAt: view.draft.updatedAt }),
    );
    const row = await h.ctx.repos.workflows.get(h.tenantId, accepted.workflowId);
    const saved = ((row?.nodes ?? []) as WorkflowDefinition['nodes']).find((n) => n.name === 'Post');
    expect(saved?.credentials).toEqual({ httpHeaderAuth: { id: credential.id, name: 'Hook header' } });
  });

  it('Accept saves the draft once, audits it and sends a workflow artifact', async () => {
    const count = await workflowCount();
    const { threadId, draftId } = await buildDraft();
    const shown = await seen(threadId, draftId);
    const res = await h.owner.client.post(`${draftUrl(threadId, draftId)}/accept`, {
      name: 'Greeting poster',
      updatedAt: shown,
    });
    expect(res.statusCode).toBe(200);
    const body = res.json().data as { workflowId: string; draft: { status: string; workflowId: string } };
    expect(body.draft.status).toBe('accepted');
    expect(body.draft.workflowId).toBe(body.workflowId);
    expect(await workflowCount()).toBe(count + 1);
    const row = await h.ctx.repos.workflows.get(h.tenantId, body.workflowId);
    expect(row?.name).toBe('Greeting poster');
    expect(((row?.nodes ?? []) as unknown[]).length).toBe(3);

    const audit = await h.ctx.repos.audit.list(h.tenantId, 50);
    expect(
      (audit as unknown as Array<{ action: string; resourceId?: string | null }>).some(
        (entry) => entry.action === 'assistant.draft_accepted' && entry.resourceId === body.workflowId,
      ),
    ).toBe(true);

    const events = await h.events(h.owner, threadId, 0, {
      until: (list) => list.some((e) => e.type === 'artifact' && e.payload.artifact.type === 'workflow'),
    });
    const artifact = events.find((e) => e.type === 'artifact' && e.payload.artifact.type === 'workflow') as
      | Extract<AssistantEvent, { type: 'artifact' }>
      | undefined;
    expect(artifact?.payload.artifact).toEqual({
      type: 'workflow',
      id: body.workflowId,
      name: 'Greeting poster',
    });
    expect(artifact?.runId).toBeNull();

    // a second Accept saves nothing more
    const again = await h.owner.client.post(`${draftUrl(threadId, draftId)}/accept`, { updatedAt: shown });
    expect(again.statusCode).toBe(409);
    expect(again.json().error.message).toBe(ASSISTANT_DRAFT_TEXTS.notOpen);
    expect(await workflowCount()).toBe(count + 1);
  });

  it('Discard leaves nothing, and a discarded draft cannot be accepted', async () => {
    const count = await workflowCount();
    const { threadId, draftId } = await buildDraft();
    const shown = await seen(threadId, draftId);
    const res = await h.owner.client.post(`${draftUrl(threadId, draftId)}/discard`, {});
    expect(res.statusCode).toBe(200);
    expect(res.json().data).toEqual({ ok: true });
    expect((await draftsOf(threadId))[draftId].status).toBe('discarded');
    const accept = await h.owner.client.post(`${draftUrl(threadId, draftId)}/accept`, { updatedAt: shown });
    expect(accept.statusCode).toBe(409);
    expect(accept.json().error.message).toBe(ASSISTANT_DRAFT_TEXTS.notOpen);
    expect(await workflowCount()).toBe(count);
  });

  it('changes a saved workflow on its base version; a stale base is 409', async () => {
    const saved = await createWorkflow(h.owner.client, {
      name: 'Existing poster',
      nodes: [
        node('Start', 'core.manualTrigger'),
        node('Post', 'core.httpRequest', { method: 'POST', url: 'https://old.example.com/hook' }, [200, 0]),
      ],
      connections: { Start: { main: [[{ node: 'Post', type: 'main', index: 0 }]] } },
    });
    const build = async () => {
      const threadId = await h.createThread(h.owner);
      await turn(h.owner, threadId, 'Change the URL', [
        outerCall(callId(), 'build_workflow', { request: 'Post to the new URL', workflowId: saved.id }),
        {
          toolCalls: [
            {
              id: 'nested_update',
              name: 'update_node_parameters',
              arguments: { name: 'Post', parameters: { url: 'https://new.example.com/hook' } },
            },
          ],
        },
        { text: 'Changed the URL.' },
        { text: 'The draft changes the URL.' },
      ]);
      const [draftId] = Object.keys(await draftsOf(threadId));
      return { threadId, draftId };
    };

    const first = await build();
    const before = await h.ctx.repos.workflows.get(h.tenantId, saved.id);
    expect(before?.versionId).toBe(saved.versionId);
    const view = await h.owner.client.data<AssistantDraftView>(
      h.owner.client.get(draftUrl(first.threadId, first.draftId)),
    );
    expect(view.draft.workflowId).toBe(saved.id);
    expect(view.draft.baseVersionId).toBe(saved.versionId);
    const change = view.diff.nodes.changed.find((c) => c.name === 'Post');
    expect(change?.changes).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          path: 'parameters.url',
          before: 'https://old.example.com/hook',
          after: 'https://new.example.com/hook',
        }),
      ]),
    );

    // a second draft on the same base; the first Accept moves the version, so the second is stale
    const second = await build();
    const accepted = await h.owner.client.data<{ workflowId: string }>(
      h.owner.client.post(`${draftUrl(first.threadId, first.draftId)}/accept`, {
        updatedAt: await seen(first.threadId, first.draftId),
      }),
    );
    expect(accepted.workflowId).toBe(saved.id);
    const after = await h.ctx.repos.workflows.get(h.tenantId, saved.id);
    expect(after?.versionId).not.toBe(saved.versionId);
    expect(JSON.stringify(after?.nodes)).toContain('https://new.example.com/hook');

    const stale = await h.owner.client.post(`${draftUrl(second.threadId, second.draftId)}/accept`, {
      updatedAt: await seen(second.threadId, second.draftId),
    });
    expect(stale.statusCode).toBe(409);
    expect(stale.json().error.message).toBe(ASSISTANT_DRAFT_TEXTS.stale);
    expect((await draftsOf(second.threadId))[second.draftId].status).toBe('open');
  });

  it('Accept saves only the version the person saw: a rebuilt draft is 409 until it is reviewed again', async () => {
    const count = await workflowCount();
    const { threadId, draftId } = await buildDraft();
    const first = await seen(threadId, draftId);
    // the Assistant rebuilds the same draft: same id, a fourth node
    await turn(h.owner, threadId, 'Add a step', [
      outerCall(callId(), 'build_workflow', { request: 'Add a final step', draftId }),
      {
        toolCalls: [
          {
            id: 'nested_add_more',
            name: 'add_nodes',
            arguments: { nodes: [{ type: 'core.set', name: 'Finish', parameters: { mode: 'manual' } }] },
          },
        ],
      },
      { text: 'Added a step.' },
      { text: 'The draft has one more step.' },
    ]);
    const rebuilt = (await draftsOf(threadId))[draftId];
    expect(rebuilt.definition.nodes.map((n) => n.name)).toContain('Finish');
    expect(rebuilt.updatedAt).not.toBe(first);

    // the card still shows the first version: Accept is refused and nothing is saved
    const old = await h.owner.client.post(`${draftUrl(threadId, draftId)}/accept`, { updatedAt: first });
    expect(old.statusCode).toBe(409);
    expect(old.json().error.message).toBe(ASSISTANT_DRAFT_TEXTS.changed);
    expect(await workflowCount()).toBe(count);
    expect((await draftsOf(threadId))[draftId].status).toBe('open');
    // a version is required
    expect((await h.owner.client.post(`${draftUrl(threadId, draftId)}/accept`, {})).statusCode).toBe(400);

    // reviewed again: the version shown is the one saved
    const accepted = await h.owner.client.data<{ workflowId: string }>(
      h.owner.client.post(`${draftUrl(threadId, draftId)}/accept`, {
        updatedAt: await seen(threadId, draftId),
      }),
    );
    const row = await h.ctx.repos.workflows.get(h.tenantId, accepted.workflowId);
    expect(((row?.nodes ?? []) as WorkflowDefinition['nodes']).map((n) => n.name)).toContain('Finish');
    expect(await workflowCount()).toBe(count + 1);
  });

  it('two Accepts on two processes save once; Discard never overwrites an Accept', async () => {
    const count = await workflowCount();
    const auth = {
      user: { id: h.owner.userId },
      tenant: { id: h.tenantId },
      role: 'owner',
    } as unknown as AuthContext;
    // each instance stands for one main process (nothing in memory is shared)
    const one = new AssistantDrafts(h.ctx.assistantDrafts.deps);
    const two = new AssistantDrafts(h.ctx.assistantDrafts.deps);

    const a = await buildDraft();
    const version = await seen(a.threadId, a.draftId);
    const results = await Promise.allSettled([
      one.accept(auth, a.threadId, a.draftId, { updatedAt: version }),
      two.accept(auth, a.threadId, a.draftId, { updatedAt: version }),
    ]);
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    const refused = results.find((r) => r.status === 'rejected') as PromiseRejectedResult;
    expect(refused.reason).toMatchObject({ statusCode: 409, message: ASSISTANT_DRAFT_TEXTS.notOpen });
    expect(await workflowCount()).toBe(count + 1);
    expect((await draftsOf(a.threadId))[a.draftId].status).toBe('accepted');

    // Accept and Discard at once: one wins, and the draft says which
    const b = await buildDraft();
    const [accept, discard] = await Promise.allSettled([
      one.accept(auth, b.threadId, b.draftId, { updatedAt: await seen(b.threadId, b.draftId) }),
      two.discard(auth, b.threadId, b.draftId),
    ]);
    const status = (await draftsOf(b.threadId))[b.draftId].status;
    if (accept.status === 'fulfilled') {
      expect(discard.status).toBe('rejected');
      expect(status).toBe('accepted');
      expect(await workflowCount()).toBe(count + 2);
    } else {
      expect(discard.status).toBe('fulfilled');
      expect(status).toBe('discarded');
      expect(await workflowCount()).toBe(count + 1);
    }
  });

  it("another tenant's workflowId is not found and builds nothing", async () => {
    const threadId = await h.createThread(h.owner);
    const id = callId();
    const requests = await turn(h.owner, threadId, 'Change that workflow', [
      outerCall(id, 'build_workflow', { request: 'Change it', workflowId: h.other.workflowId }),
      { text: 'I could not find it.' },
    ]);
    expect(requests).toHaveLength(2);
    expect(toolResultOf(h.fake.requests, id)).toContain('Workflow not found');
    expect(await draftsOf(threadId)).toEqual({});
    // the scripted call itself names the id; nothing of that workflow came back
    const sent = JSON.stringify(h.fake.requests);
    expect(sent).not.toContain(CANARY.workflow);
    expect(sent).not.toContain(CANARY.secret);
  });

  it("another user's draft is 404 to every role (P6-39: a viewer builds in its personal project)", async () => {
    const { threadId, draftId } = await buildDraft();
    const shown = await seen(threadId, draftId);
    for (const user of [h.admin, h.editor, h.viewer]) {
      expect((await user.client.get(draftUrl(threadId, draftId))).statusCode).toBe(404);
      expect(
        (await user.client.post(`${draftUrl(threadId, draftId)}/accept`, { updatedAt: shown })).statusCode,
      ).toBe(404);
      expect((await user.client.post(`${draftUrl(threadId, draftId)}/discard`, {})).statusCode).toBe(404);
    }
    expect((await h.other.owner.client.get(draftUrl(threadId, draftId))).statusCode).toBe(404);
    expect((await h.owner.client.get(draftUrl(threadId, 'not-a-draft'))).statusCode).toBe(404);
    expect((await draftsOf(threadId))[draftId].status).toBe('open');
  });

  it('a viewer has no build_workflow or verify_workflow, and no tool reaches Accept', async () => {
    await h.expectToolRoles({ build_workflow: 'workflow:create', verify_workflow: 'workflow:create' });
    expect(buildTools.map((t) => t.name)).toEqual(['build_workflow', 'verify_workflow']);
    for (const tool of buildTools) expect(tool.permission).toBeUndefined();
    for (const tool of builtInAssistantTools()) {
      const source = [tool.handler, tool.resume, tool.suspendFor]
        .map((fn) => (fn ? String(fn) : ''))
        .join('\n');
      expect(source, `${tool.name} reaches Accept`).not.toMatch(/assistantDrafts\.accept|\.accept\(/);
      expect(source, `${tool.name} saves a workflow`).not.toMatch(/workflows\.(create|update)\(/);
    }
    // and no helper they call: every Assistant source file but drafts.ts (the routes' service), whole
    for (const file of assistantSources(ASSISTANT_DIR)) {
      if (path.relative(ASSISTANT_DIR, file) === 'drafts.ts') continue;
      const text = readFileSync(file, 'utf8');
      expect(text, `${file} reaches Accept`).not.toMatch(/assistantDrafts\.accept|\.accept\(/);
      expect(text, `${file} saves a workflow`).not.toMatch(/workflows\.(create|update)\(/);
      expect(text, `${file} imports a workflow writer`).not.toMatch(/mcp\/tools\/builder\/(create|update)'/);
    }
  });

  it('is refused while an admin blocks creating workflows', async () => {
    await h.setSettings({ permissions: { createWorkflow: 'blocked' } });
    try {
      const threadId = await h.createThread(h.owner);
      const id = callId();
      const requests = await turn(h.owner, threadId, 'Build one', [
        outerCall(id, 'build_workflow', { request: 'Anything' }),
        { text: 'It is turned off.' },
      ]);
      expect(requests).toHaveLength(2);
      expect(toolResultOf(h.fake.requests, id)).toContain(BUILD_BLOCKED);
      expect(await draftsOf(threadId)).toEqual({});
    } finally {
      await h.setSettings({});
    }
  });
});
