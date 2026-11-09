/**
 * P6-36 (L15): the AI builder routes check scopes, not roles. A true `member` builds on a workflow it can
 * update (`workflow:update` in the workflow's project) and is refused (403, n8n's text) on any other
 * project's workflow; the four session routes follow the same rule; `usage-settings` needs
 * `aiAssistant:manage`. The workspace model loads for every project (admin-set AI credential, workspace
 * wide), and a second project's workflow, data table and credential never reach the model (canary on the
 * fake LLM's request log).
 */
import { nodesAiPackage } from '@workflow/nodes-ai';
import type { BuilderChunk } from '@workflow/workflow';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { type FakeLlm, startFakeLlm } from './fakes/fake-llm';
import {
  addToProject,
  createTestServer,
  credentialIn,
  dataTableIn,
  node,
  projectIn,
  realMember,
  resetDatabase,
  signup,
  type TestClient,
  type TestServer,
  workflowIn,
} from './helpers';

const FORBIDDEN = 'User is missing a scope required to perform this action';
const BETA_WORKFLOW = 'Zebra payroll flow';
const BETA_TABLE = 'zebra_salaries_table';
const BETA_CREDENTIAL = 'Zebra bank login';
const BETA_SECRET = 'zebra-secret-value-8841';

let server: TestServer;
let fake: FakeLlm | undefined;

beforeAll(async () => {
  server = await createTestServer({ AI_ENABLED: 'true' }, { nodePackages: [nodesAiPackage] });
});
afterAll(async () => {
  await server.close();
});
beforeEach(async () => {
  await resetDatabase(server.ctx);
});
afterEach(async () => {
  await fake?.close();
  fake = undefined;
});

/** an owner whose builder model lives in the default team project; a member who is `role` in alpha only */
async function setup(role = 'project:editor') {
  fake = await startFakeLlm([{ text: 'Looked at it.' }, { text: 'Looked again.' }, { text: 'Done.' }]);
  const owner = await signup(server.app);
  const model = await owner.client.data<{ id: string }>(
    owner.client.post('/rest/credentials', {
      name: 'Builder model',
      type: 'openAiApi',
      data: { apiKey: 'sk-test-builder-key-000000000000', baseUrl: fake.baseUrl },
    }),
  );
  await owner.client.data(
    owner.client.patch('/rest/settings', {
      ai: { credentialId: model.id, nodeType: 'ai.lmChatOpenAi', model: 'gpt-4o-mini' },
    }),
  );
  const member = await realMember(owner);
  const alpha = await projectIn(server, owner.tenant.id, 'Alpha');
  const beta = await projectIn(server, owner.tenant.id, 'Beta');
  await addToProject(server, owner.tenant.id, alpha.id, member.user.id, role);
  const inAlpha = await workflowIn(server, owner.tenant.id, alpha.id, { name: 'Alpha flow' });
  const credential = await credentialIn(server, owner.tenant.id, beta.id, {
    name: BETA_CREDENTIAL,
    type: 'httpHeaderAuth',
    data: { name: 'X-Token', value: BETA_SECRET },
  });
  const inBeta = await workflowIn(server, owner.tenant.id, beta.id, {
    name: BETA_WORKFLOW,
    nodes: [
      node('Start', 'core.manualTrigger'),
      node('Fetch', 'core.httpRequest', { url: 'https://beta.example' }, [200, 0], {
        credentials: { httpHeaderAuth: { id: credential.id, name: BETA_CREDENTIAL } },
      }),
    ],
  });
  const table = await dataTableIn(server, owner.tenant.id, beta.id, BETA_TABLE);
  return { owner, member, alpha, beta, inAlpha, inBeta, credential, table };
}

/** a workflow of another workspace */
async function foreignWorkflow() {
  const stranger = await signup(server.app);
  const projectId = (await server.ctx.repos.projects.oldestTeam(stranger.tenant.id))!.id;
  return workflowIn(server, stranger.tenant.id, projectId, { name: 'Foreign' });
}

async function build(client: TestClient, body: Record<string, unknown>) {
  const res = await client.post('/rest/ai/build', body);
  const chunks =
    res.statusCode === 200
      ? res.body
          .split('\n')
          .filter((line) => line.trim())
          .map((line) => JSON.parse(line) as BuilderChunk)
      : [];
  return { res, chunks };
}

describe('POST /ai/build', () => {
  it('lets a project editor build on its own project workflow with the workspace model', async () => {
    const { member, inAlpha } = await setup();
    const { res, chunks } = await build(member.client, { workflowId: inAlpha.id, text: 'Say hello' });
    expect(res.statusCode).toBe(200);
    expect(chunks.filter((c) => c.type === 'error')).toEqual([]);
    // the model sits in a project the member does not belong to, and it still ran
    expect(fake!.requests.length).toBeGreaterThan(0);
  });

  it("refuses a workflow of another project with n8n's text, before any model call", async () => {
    const { member, inBeta } = await setup();
    const { res } = await build(member.client, { workflowId: inBeta.id, text: 'Say hello' });
    expect(res.statusCode).toBe(403);
    expect(res.json().error.message).toBe(FORBIDDEN);
    expect(fake!.requests).toHaveLength(0);
  });

  it('refuses a project viewer on its own project workflow', async () => {
    const { member, inAlpha } = await setup('project:viewer');
    const { res } = await build(member.client, { workflowId: inAlpha.id, text: 'Say hello' });
    expect(res.statusCode).toBe(403);
    expect(fake!.requests).toHaveLength(0);
  });

  it("answers 404 for another workspace's workflow; a missing id is 400 for the owner, 403 for a member", async () => {
    const { owner, member } = await setup();
    const foreign = await foreignWorkflow();
    expect((await build(member.client, { workflowId: foreign.id, text: 'Hi' })).res.statusCode).toBe(404);
    expect((await build(owner.client, { text: 'Hi' })).res.statusCode).toBe(400);
    expect((await build(member.client, { text: 'Hi' })).res.statusCode).toBe(403);
  });

  it("never sends a second project's workflow, table or credential to the model", async () => {
    const { owner, member, inAlpha, inBeta, credential, table } = await setup();
    const asMember = await build(member.client, {
      workflowId: inAlpha.id,
      text: 'List my tables and credentials',
    });
    expect(asMember.chunks.filter((c) => c.type === 'error')).toEqual([]);
    // the owner can reach both projects, still a turn on alpha holds only alpha's workflow
    const asOwner = await build(owner.client, { workflowId: inAlpha.id, text: 'What else is here?' });
    expect(asOwner.chunks.filter((c) => c.type === 'error')).toEqual([]);
    expect(fake!.requests.length).toBeGreaterThan(1);
    const sent = JSON.stringify(fake!.requests);
    for (const hidden of [
      BETA_WORKFLOW,
      inBeta.id,
      BETA_TABLE,
      table.id,
      BETA_CREDENTIAL,
      credential.id,
      BETA_SECRET,
      'beta.example',
    ]) {
      expect(sent).not.toContain(hidden);
    }
  });
});

describe('session routes', () => {
  const routes: Array<[string, Record<string, unknown>]> = [
    ['/rest/ai/sessions', {}],
    ['/rest/ai/build/truncate-messages', { messageId: 'm1' }],
    ['/rest/ai/build/clear-session', {}],
    ['/rest/ai/build/accepted-version', { versionId: 'v1' }],
  ];

  it("403 with n8n's text on another project's workflow, 200 on the member's own", async () => {
    const { member, inAlpha, inBeta } = await setup();
    for (const [path, extra] of routes) {
      const denied = await member.client.post(path, { workflowId: inBeta.id, ...extra });
      expect(denied.statusCode, path).toBe(403);
      expect(denied.json().error.message).toBe(FORBIDDEN);
    }
    const own = await member.client.post('/rest/ai/sessions', { workflowId: inAlpha.id });
    expect(own.statusCode).toBe(200);
    const cleared = await member.client.post('/rest/ai/build/clear-session', { workflowId: inAlpha.id });
    expect(cleared.statusCode).toBe(200);
  });

  it('refuses a project viewer on every route and another workspace id as 404', async () => {
    const { member, inAlpha } = await setup('project:viewer');
    for (const [path, extra] of routes) {
      expect((await member.client.post(path, { workflowId: inAlpha.id, ...extra })).statusCode, path).toBe(
        403,
      );
    }
    const foreign = await foreignWorkflow();
    for (const [path, extra] of routes) {
      expect((await member.client.post(path, { workflowId: foreign.id, ...extra })).statusCode, path).toBe(
        404,
      );
    }
  });
});

describe('POST /ai/usage-settings', () => {
  it('needs aiAssistant:manage: a project admin is refused, the owner is let in', async () => {
    const { owner, member } = await setup('project:admin');
    const denied = await member.client.post('/rest/ai/usage-settings', {
      allowSendingParameterValues: false,
    });
    expect(denied.statusCode).toBe(403);
    expect(denied.json().error.message).toBe(FORBIDDEN);
    const ok = await owner.client.post('/rest/ai/usage-settings', { allowSendingParameterValues: false });
    expect(ok.statusCode).toBe(200);
  });
});
