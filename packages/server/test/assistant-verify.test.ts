/**
 * P5-70 (L7): `verify_workflow` and `planVerify`.
 *
 * `planVerify` runs only its allow list: an unknown type (also an allow-list type the registry lacks),
 * a credentialed node, a trigger, a Wait and any node whose expression text names `$vars`, `$secrets`,
 * `$credentials`, `$env` or uses `this` (also built names) are simulated. Through the whole path on the
 * fake LLM: a verify run sends nothing to a fake Slack endpoint on 127.0.0.1 (an HTTP Request POST and
 * a credentialed node are marked simulated; a normal run of the same request does hit it); a draft
 * whose `settings.errorWorkflow` posts to that endpoint fails its run and the endpoint stays at zero;
 * a Set node with `$vars` (direct or through `this`) is simulated and the value never reaches the
 * model; a Set node after a pin reads the fixture and a fixture value `={{ $env.X }}` stays literal; a
 * pinned Wait never parks; a `waiting` outcome is a failure; fixtures are checked; the admin's block
 * refuses the tool.
 */
import { randomUUID } from 'node:crypto';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import type { NodeTypeRegistry } from '@workflow/core';
import type { DataObject, WorkflowDefinition, WorkflowNode } from '@workflow/workflow';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  BUILD_BLOCKED,
  VERIFY_TEXTS,
  type VerifyWorkflowResult,
  verifyVerdict,
  verifyWorkflowTool,
} from '../src/services/assistant/tools/build';
import type { AssistantRunScope } from '../src/services/assistant/types';
import { planVerify, VERIFY_RUN_ALLOW_LIST } from '../src/services/assistant/verify-plan';
import { type AssistantHarness, createAssistantHarness, toolResultOf } from './fakes/assistant-harness';
import type { FakeLlmStep } from './fakes/fake-llm';
import { createWorkflow, executionsOf, node, setNode, waitForExecution } from './helpers';

let h: AssistantHarness;
let slack: { url: string; hits: number; server: Server };
let calls = 0;

async function startSlack() {
  const state = { url: '', hits: 0, server: undefined as unknown as Server };
  state.server = createServer((req, res) => {
    state.hits++;
    req.resume();
    res.statusCode = 200;
    res.setHeader('content-type', 'application/json');
    res.end('{"ok":true}');
  });
  await new Promise<void>((resolve) => state.server.listen(0, '127.0.0.1', resolve));
  state.url = `http://127.0.0.1:${(state.server.address() as AddressInfo).port}/api/chat.postMessage`;
  return state;
}

beforeAll(async () => {
  h = await createAssistantHarness();
  slack = await startSlack();
}, 120_000);

afterAll(async () => {
  await new Promise<void>((resolve) => slack?.server.close(() => resolve()));
  await h?.close();
});

beforeEach(() => {
  if (slack) slack.hits = 0;
});

const connect = (...names: string[]) => {
  const connections: WorkflowDefinition['connections'] = {};
  for (let i = 0; i < names.length - 1; i++) {
    connections[names[i]] = { main: [[{ node: names[i + 1], type: 'main', index: 0 }]] };
  }
  return connections;
};

const post = (name = 'Post') => node(name, 'core.httpRequest', { method: 'POST', url: slack.url }, [200, 0]);

/** a stored open draft on a new thread of the owner */
async function draftOn(definition: Omit<WorkflowDefinition, 'name'> & { name?: string }) {
  const threadId = await h.createThread(h.owner);
  const draftId = randomUUID();
  await h.ctx.assistantDrafts.put(h.tenantId, threadId, {
    id: draftId,
    name: definition.name ?? 'Verify draft',
    workflowId: null,
    baseVersionId: null,
    definition: { name: 'Verify draft', ...definition } as WorkflowDefinition,
    createdAt: new Date().toISOString(),
    status: 'open',
  });
  return { threadId, draftId };
}

/** the tool's text without its untrusted wrapper, parsed */
function parseResult(text: string | undefined): VerifyWorkflowResult {
  expect(text, 'a tool result').toBeTruthy();
  const body = String(text);
  const start = body.indexOf('\n');
  const end = body.lastIndexOf('\n</');
  return JSON.parse(body.slice(start + 1, end).replace(/&lt;/g, '<')) as VerifyWorkflowResult;
}

/** one chat turn whose model calls `verify_workflow(args)`, then answers; the raw tool result */
async function verify(threadId: string, args: DataObject): Promise<string | undefined> {
  calls++;
  const id = `verify_call_${calls}`;
  const steps: FakeLlmStep[] = [
    { toolCalls: [{ id, name: 'verify_workflow', arguments: args }] },
    { text: 'Checked.' },
  ];
  h.script.splice(h.fake.requests.length, 0, ...steps);
  await h.chat(h.owner, threadId, 'Verify the draft');
  await h.waitForStatus(h.owner, threadId, 'idle', 60_000);
  return toolResultOf(h.fake.requests, id);
}

describe('planVerify', () => {
  const registry = () => h.ctx.registries.nodeTypes;
  const plan = (nodes: WorkflowNode[], nodeTypes: NodeTypeRegistry = registry()) =>
    planVerify({ name: 'x', nodes, connections: {} }, nodeTypes);

  it('runs data-only nodes and simulates the rest', () => {
    const result = plan([
      node('Start', 'core.manualTrigger'),
      setNode('Shape', 'a', '={{ $json.a }}'),
      node('Keep', 'core.filter'),
      node('Hook', 'core.webhook', { path: 'p', httpMethod: 'POST' }),
      node('Every', 'core.scheduleTrigger'),
      node('Post', 'core.httpRequest', { method: 'POST', url: 'https://example.com' }),
      node('Wait', 'core.wait', { resume: 'webhook' }),
      node('Code', 'core.code', { jsCode: 'return []' }),
      node('Model', 'ai.lmChatOpenAi'),
    ]);
    expect(result.execute).toEqual(['Start', 'Shape', 'Keep']);
    expect(result.simulate).toEqual(['Hook', 'Every', 'Post', 'Wait', 'Code', 'Model']);
  });

  it('simulates an unknown type, also one on the list the registry does not know', () => {
    expect(plan([node('Odd', 'core.notInstalled')]).simulate).toEqual(['Odd']);
    const empty = { get: () => undefined } as unknown as NodeTypeRegistry;
    const listed = VERIFY_RUN_ALLOW_LIST.map((type, i) => node(`N${i}`, type));
    expect(plan(listed, empty).execute).toEqual([]);
    expect(plan(listed, empty).simulate).toHaveLength(VERIFY_RUN_ALLOW_LIST.length);
  });

  it('simulates a credentialed node and every risky expression, at any depth', () => {
    const risky = [
      '={{ $vars.x }}',
      '={{ this.$vars.x }}',
      "={{ this['$va' + 'rs'].x }}",
      '={{ $secrets.vault.key }}',
      '={{ $credentials.token }}',
      '={{ $env.HOME }}',
      'Hello {{ $vars.name }}',
      '={{ globalThis.x }}',
      '={{ \\u0024vars.x }}',
    ];
    const nodes = risky.map((value, i) => setNode(`Risky ${i}`, 'v', value));
    nodes.push(
      node('Deep', 'core.set', {
        mode: 'manual',
        assignments: {
          assignments: [{ id: 'a', name: 'v', value: [{ inner: { more: '={{ $secrets.x }}' } }] }],
        },
      }),
      node('Credentialed', 'core.set', {}, [0, 0], {
        credentials: { httpHeaderAuth: { id: 'c1', name: 'Header' } },
      }),
      setNode('Plain', 'v', 'this text is not an expression'),
      setNode('Safe', 'v', '={{ $json.value + 1 }}'),
    );
    const result = plan(nodes);
    expect(result.execute).toEqual(['Plain', 'Safe']);
    expect(result.simulate).toEqual([...risky.map((_, i) => `Risky ${i}`), 'Deep', 'Credentialed']);
    // every node in exactly one list
    expect(result.execute.length + result.simulate.length).toBe(nodes.length);
  });

  it('a waiting outcome is a failure', () => {
    expect(verifyVerdict({ status: 'waiting', aborted: false })).toEqual({
      success: false,
      reason: VERIFY_TEXTS.waiting,
    });
    expect(verifyVerdict({ status: 'success', aborted: false }).success).toBe(true);
    expect(verifyVerdict({ status: 'timedOut', aborted: false }).reason).toBe(VERIFY_TEXTS.timedOut);
    expect(verifyVerdict({ status: 'timedOut', aborted: true }).reason).toBe(VERIFY_TEXTS.stopped);
    expect(verifyVerdict({ status: 'error', aborted: false, error: { message: 'Boom' } })).toEqual({
      success: false,
      reason: 'Boom',
    });
  });
});

describe('verify_workflow', () => {
  it('sends nothing to the Slack endpoint: the HTTP POST and the credentialed node are simulated', async () => {
    // control: a normal run of the same POST reaches the endpoint
    const control = await createWorkflow(h.owner.client, {
      nodes: [node('Start', 'core.manualTrigger'), post()],
      connections: connect('Start', 'Post'),
    });
    const started = await h.owner.client.data<{ executionId: string }>(
      h.owner.client.post(`/rest/workflows/${control.id}/run`, {}),
    );
    await waitForExecution(h.ctx, h.tenantId, started.executionId);
    expect(slack.hits).toBe(1);
    slack.hits = 0;

    const { threadId, draftId } = await draftOn({
      nodes: [
        node('Start', 'core.manualTrigger'),
        post(),
        node(
          'Slack',
          'app.slack',
          { authentication: 'accessToken', resource: 'message', operation: 'post', text: 'hi' },
          [400, 0],
          { credentials: { slackApi: { id: randomUUID(), name: 'Slack' } } },
        ),
      ],
      connections: connect('Start', 'Post', 'Slack'),
    });
    const result = parseResult(await verify(threadId, { draftId }));
    expect(result.success).toBe(true);
    expect(result.status).toBe('success');
    expect(result.simulatedNodes).toEqual(['Post', 'Slack']);
    expect(result.executedNodes).toEqual(['Start']);
    expect(result.simulationNote).toBe(VERIFY_TEXTS.simulationNote);
    const byName = Object.fromEntries(result.nodePreviews.map((p) => [p.node, p]));
    expect(byName.Post.simulated).toBe(true);
    expect(byName.Slack.simulated).toBe(true);
    expect(byName.Start.simulated).toBe(false);
    await new Promise((r) => setTimeout(r, 300));
    expect(slack.hits).toBe(0);
    // the run was a manual one of this tenant
    const row = await h.ctx.repos.executions.get(h.tenantId, String(result.executionId));
    expect(row?.mode).toBe('manual');
  });

  it("a failing run never starts the draft's error workflow", async () => {
    const handler = await createWorkflow(h.owner.client, {
      name: 'Error handler',
      nodes: [node('On error', 'core.errorTrigger'), post('Alert')],
      connections: connect('On error', 'Alert'),
    });
    const { threadId, draftId } = await draftOn({
      nodes: [node('Start', 'core.manualTrigger'), setNode('Break', 'v', '={{ $json.missing.deep.value }}')],
      connections: connect('Start', 'Break'),
      settings: { errorWorkflow: handler.id },
    });
    const result = parseResult(await verify(threadId, { draftId }));
    expect(result.success).toBe(false);
    expect(result.status).toBe('error');
    expect(result.reason).toBeTruthy();
    await new Promise((r) => setTimeout(r, 1000));
    expect(slack.hits).toBe(0);
    expect(await executionsOf(h.ctx, h.tenantId, handler.id)).toHaveLength(0);
  });

  it('simulates $vars, also through this, and the value never reaches the model', async () => {
    const secret = `vars-canary-${randomUUID()}`;
    await h.owner.client.data(h.owner.client.post('/rest/variables', { key: 'l7x', value: secret }));
    const { threadId, draftId } = await draftOn({
      nodes: [
        node('Start', 'core.manualTrigger'),
        setNode('Vars', 'v', '={{ $vars.l7x }}'),
        setNode('Through this', 'w', '={{ this.$vars.l7x }}', [400, 0]),
      ],
      connections: connect('Start', 'Vars', 'Through this'),
    });
    const result = parseResult(await verify(threadId, { draftId }));
    expect(result.simulatedNodes).toEqual(['Vars', 'Through this']);
    expect(result.success).toBe(true);
    expect(JSON.stringify(h.fake.requests)).not.toContain(secret);
    const row = await h.ctx.repos.executions.getData(h.tenantId, String(result.executionId));
    expect(JSON.stringify(row)).not.toContain(secret);
  });

  it('a Set node after a pin reads the fixture, and a fixture expression stays literal', async () => {
    const envValue = `env-canary-${randomUUID()}`;
    process.env.L7_VERIFY_ENV = envValue;
    try {
      const { threadId, draftId } = await draftOn({
        nodes: [
          node('Hook', 'core.webhook', { path: 'l7-verify', httpMethod: 'POST' }),
          setNode('Read', 'out', '={{ $json.v }}'),
        ],
        connections: connect('Hook', 'Read'),
      });
      const result = parseResult(
        await verify(threadId, { draftId, fixtures: { Hook: [{ v: '={{ $env.L7_VERIFY_ENV }}' }] } }),
      );
      expect(result.success).toBe(true);
      expect(result.simulatedNodes).toEqual(['Hook']);
      const read = result.nodePreviews.find((p) => p.node === 'Read');
      expect(read?.ran).toBe(true);
      expect(read?.simulated).toBe(false);
      expect(((read?.outputs?.[0]?.items?.[0]?.json ?? {}) as DataObject).out).toBe(
        '={{ $env.L7_VERIFY_ENV }}',
      );
      expect(JSON.stringify(h.fake.requests)).not.toContain(envValue);

      // no fixture: the trigger gets inputData as that trigger would receive it
      const second = parseResult(await verify(threadId, { draftId, inputData: { v: 'from input' } }));
      const hook = second.nodePreviews.find((p) => p.node === 'Hook');
      expect(((hook?.outputs?.[0]?.items?.[0]?.json ?? {}) as DataObject).body).toEqual({ v: 'from input' });
    } finally {
      delete process.env.L7_VERIFY_ENV;
    }
  });

  it('a pinned Wait never parks', async () => {
    const { threadId, draftId } = await draftOn({
      nodes: [
        node('Start', 'core.manualTrigger'),
        node('Wait', 'core.wait', { resume: 'webhook' }, [200, 0]),
        setNode('After', 'done', 'yes', [400, 0]),
      ],
      connections: connect('Start', 'Wait', 'After'),
    });
    const result = parseResult(await verify(threadId, { draftId }));
    expect(result.simulatedNodes).toEqual(['Wait']);
    expect(result.status).toBe('success');
    expect(result.success).toBe(true);
    expect(result.nodePreviews.find((p) => p.node === 'After')?.ran).toBe(true);
    const row = await h.ctx.repos.executions.get(h.tenantId, String(result.executionId));
    expect(row?.status).toBe('success');
  });

  it('notes an empty output', async () => {
    const { threadId, draftId } = await draftOn({
      nodes: [
        node('Hook', 'core.webhook', { path: 'l7-empty', httpMethod: 'POST' }),
        node('Cap', 'core.limit', { maxItems: 1 }),
      ],
      connections: connect('Hook', 'Cap'),
    });
    const result = parseResult(await verify(threadId, { draftId, fixtures: { Hook: [] } }));
    expect(result.emptyOutputNote).toContain('"Hook"');
  });

  it('checks fixtures: only simulated nodes, JSON only, 256 KB', async () => {
    const { threadId, draftId } = await draftOn({
      nodes: [
        node('Hook', 'core.webhook', { path: 'l7-fixtures', httpMethod: 'POST' }),
        setNode('After', 'a', 'b'),
      ],
      connections: connect('Hook', 'After'),
    });
    expect(await verify(threadId, { draftId, fixtures: { After: [{ a: 1 }] } })).toContain(
      VERIFY_TEXTS.fixtureRuns('After'),
    );
    expect(await verify(threadId, { draftId, fixtures: { Nope: [{ a: 1 }] } })).toContain(
      VERIFY_TEXTS.fixtureNode('Nope'),
    );
    expect(
      await verify(threadId, {
        draftId,
        fixtures: { Hook: [{ json: { a: 1 }, binary: { data: { data: 'AA==' } } }] },
      }),
    ).toContain(VERIFY_TEXTS.fixtureBinary);
    expect(await verify(threadId, { draftId: 'missing' })).toContain('There is no draft');
    h.checkRequests();

    // the size limit, called on the tool itself (a 260 KB call in the chat would start compaction)
    const tenant = await h.ctx.repos.tenants.get(h.tenantId);
    const user = await h.ctx.repos.users.get(h.owner.userId);
    const settings = await h.ctx.assistantSettings.read(tenant!);
    const run: AssistantRunScope = {
      tenant: tenant!,
      user: user!,
      role: 'owner',
      actor: { userId: h.owner.userId },
      threadId,
      runId: randomUUID(),
      signal: new AbortController().signal,
      settings,
      sendValues: settings.sendValues,
      attachments: [],
      emit: () => {},
    };
    await expect(
      verifyWorkflowTool.handler(h.ctx, run, {
        draftId,
        fixtures: { Hook: [{ big: 'x'.repeat(260 * 1024) }] },
      }),
    ).rejects.toThrow(VERIFY_TEXTS.fixtureSize);
    await expect(
      verifyWorkflowTool.handler(h.ctx, run, { draftId, inputData: { big: 'x'.repeat(260 * 1024) } }),
    ).rejects.toThrow(VERIFY_TEXTS.fixtureSize);
    expect(slack.hits).toBe(0);
  });

  it('is refused while an admin blocks running workflows', async () => {
    await h.setSettings({ permissions: { runWorkflow: 'blocked' } });
    try {
      const { threadId, draftId } = await draftOn({
        nodes: [node('Start', 'core.manualTrigger'), post()],
        connections: connect('Start', 'Post'),
      });
      expect(await verify(threadId, { draftId })).toContain(BUILD_BLOCKED);
      expect(slack.hits).toBe(0);
    } finally {
      await h.setSettings({});
    }
  });
});
