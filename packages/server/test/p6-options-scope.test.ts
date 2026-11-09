/**
 * P6-27 (L7): node parameter options (`POST /rest/node-types/options`) check the caller and bind the
 * method's services to one project inside `loadNodeOptions`, so the route and the Assistant tool share it.
 * `workflowId` needs `workflow:update` on that workflow; `projectId` (a workflow not saved yet) needs
 * `workflow:create` in it. Credentials, data tables and workflow pickers are those of that project.
 */
import { randomUUID } from 'node:crypto';
import type { NodeType } from '@workflow/workflow';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { loadNodeOptions } from '../src/services/node-options';
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
  type TestServer,
  workflowIn,
} from './helpers';

const FORBIDDEN = 'User is missing a scope required to perform this action';

const optionsNode: NodeType = {
  description: {
    name: 'test.p6Options',
    displayName: 'Options',
    description: '',
    group: ['transform'],
    version: 1,
    defaults: { name: 'Options' },
    inputs: ['main'],
    outputs: ['main'],
    credentials: [{ name: 'testApi', required: false }],
    properties: [{ displayName: 'Target', name: 'targetId', type: 'string', default: '' }],
  },
  async execute(ctx) {
    return [ctx.getInputData()];
  },
  methods: {
    loadOptions: {
      async keyLength(ctx) {
        const credentials = await ctx.getCredentials<{ apiKey?: string }>('testApi');
        return [{ name: String(credentials.apiKey?.length ?? 0), value: 'length' }];
      },
      async readTarget(ctx) {
        const target = await ctx.readWorkflow?.(String(ctx.getCurrentNodeParameter('targetId')));
        return target ? [{ name: target.name, value: target.id ?? '' }] : [];
      },
    },
  },
};

let server: TestServer;

beforeAll(async () => {
  server = await createTestServer(
    { LOGIN_RATE_LIMIT_MAX: '1000' },
    { startMain: false, nodePackages: [{ name: 'p6options', nodes: [optionsNode], credentials: [] }] },
  );
});
afterAll(async () => {
  await server.close();
});
beforeEach(async () => {
  await resetDatabase(server.ctx);
});

/** an owner, a member who is `role` in Alpha and nothing in Beta, one workflow in each project */
async function setup(role = 'project:editor') {
  const owner = await signup(server.app);
  const member = await realMember(owner);
  const alpha = await projectIn(server, owner.tenant.id, 'Alpha');
  const beta = await projectIn(server, owner.tenant.id, 'Beta');
  await addToProject(server, owner.tenant.id, alpha.id, member.user.id, role);
  const inAlpha = await workflowIn(server, owner.tenant.id, alpha.id, { name: 'In alpha' });
  const inBeta = await workflowIn(server, owner.tenant.id, beta.id, { name: 'In beta' });
  return { owner, member, alpha, beta, inAlpha, inBeta, tenantId: owner.tenant.id };
}

const body = (method: string, extra: Record<string, unknown> = {}, parameters = {}) => ({
  nodeType: 'test.p6Options',
  method,
  kind: 'loadOptions',
  node: node('Options', 'test.p6Options', parameters),
  ...extra,
});

describe('the check', () => {
  it('lets a project editor ask for a workflow of their project', async () => {
    const { member, inAlpha } = await setup();
    const res = await member.client.post(
      '/rest/node-types/options',
      body('readTarget', { workflowId: inAlpha.id }, { targetId: inAlpha.id }),
    );
    expect(res.statusCode).toBe(200);
    expect(res.json().data).toEqual([{ name: 'In alpha', value: inAlpha.id }]);
  });

  it("refuses a workflow of a project the member isn't in, and a project viewer (403, n8n's text)", async () => {
    const { member, inBeta, inAlpha, alpha, tenantId } = await setup();
    const hidden = await member.client.post(
      '/rest/node-types/options',
      body('readTarget', { workflowId: inBeta.id }),
    );
    expect(hidden.statusCode).toBe(403);
    expect(hidden.json().error.message).toBe(FORBIDDEN);
    await addToProject(server, tenantId, alpha.id, member.user.id, 'project:viewer');
    const viewer = await member.client.post(
      '/rest/node-types/options',
      body('readTarget', { workflowId: inAlpha.id }),
    );
    expect(viewer.statusCode).toBe(403);
    expect(viewer.json().error.message).toBe(FORBIDDEN);
  });

  it("answers 404 to another workspace's workflow and to an id that is not a uuid", async () => {
    const { member, inAlpha } = await setup();
    const other = await signup(server.app);
    const theirs = await other.client.post(
      '/rest/node-types/options',
      body('readTarget', { workflowId: inAlpha.id }),
    );
    expect(theirs.statusCode).toBe(404);
    const notUuid = await member.client.post(
      '/rest/node-types/options',
      body('readTarget', { workflowId: 'nope' }),
    );
    expect(notUuid.statusCode).toBe(404);
  });

  it('takes projectId for a workflow not saved yet: workflow:create in it', async () => {
    const { member, alpha, beta, owner } = await setup();
    const ok = await member.client.post(
      '/rest/node-types/options',
      body('readTarget', { projectId: alpha.id }),
    );
    expect(ok.statusCode).toBe(200);
    const hidden = await member.client.post(
      '/rest/node-types/options',
      body('readTarget', { projectId: beta.id }),
    );
    expect(hidden.statusCode).toBe(403);
    const missing = await member.client.post(
      '/rest/node-types/options',
      body('readTarget', { projectId: randomUUID() }),
    );
    expect(missing.statusCode).toBe(404);
    await addToProject(server, owner.tenant.id, alpha.id, member.user.id, 'project:viewer');
    const viewer = await member.client.post(
      '/rest/node-types/options',
      body('readTarget', { projectId: alpha.id }),
    );
    expect(viewer.statusCode).toBe(403);
  });

  it('names neither: refused with 400, on the route and on the service (credentials-4)', async () => {
    const { member, owner, tenantId } = await setup();
    const NEITHER = "Couldn't load the options: the request names no workflowId and no projectId";
    const res = await member.client.post('/rest/node-types/options', body('readTarget'));
    expect(res.statusCode).toBe(400);
    expect(res.json().error.message).toBe(NEITHER);
    // the owner too, called as the Assistant tool calls it (the test client would add a projectId)
    const tenant = (await server.ctx.repos.tenants.get(tenantId))!;
    const user = (await server.ctx.repos.users.get(owner.user.id))!;
    const auth = { tenant, user, role: 'owner' } as unknown as Parameters<typeof loadNodeOptions>[1];
    await expect(loadNodeOptions(server.ctx, auth, body('readTarget'))).rejects.toMatchObject({
      statusCode: 400,
      message: NEITHER,
    });
  });

  it('refuses before it looks at the body: a member without the scope gets 403, not 400', async () => {
    const { member, inBeta } = await setup();
    const res = await member.client.post('/rest/node-types/options', { workflowId: inBeta.id });
    expect(res.statusCode).toBe(403);
  });

  it('holds when the service is called directly (the Assistant tool path)', async () => {
    const { member, inBeta, tenantId } = await setup();
    const tenant = (await server.ctx.repos.tenants.get(tenantId))!;
    const user = (await server.ctx.repos.users.get(member.user.id))!;
    const auth = { tenant, user, role: 'member' } as unknown as Parameters<typeof loadNodeOptions>[1];
    await expect(
      loadNodeOptions(server.ctx, auth, body('readTarget', { workflowId: inBeta.id })),
    ).rejects.toMatchObject({
      statusCode: 403,
    });
  });
});

describe('what the method sees', () => {
  it('uses a credential of the same project', async () => {
    const { member, alpha, inAlpha, tenantId } = await setup();
    const own = await credentialIn(server, tenantId, alpha.id, { data: { apiKey: 'abcde' } });
    const res = await member.client.post(
      '/rest/node-types/options',
      body('keyLength', {
        workflowId: inAlpha.id,
        node: {
          ...node('Options', 'test.p6Options'),
          credentials: { testApi: { id: own.id, name: own.name } },
        },
      }),
    );
    expect(res.statusCode).toBe(200);
    expect(res.json().data).toEqual([{ name: '5', value: 'length' }]);
  });

  it("refuses another project's credential, for the member and for the workspace owner", async () => {
    const { member, owner, beta, inAlpha, tenantId } = await setup();
    const theirs = await credentialIn(server, tenantId, beta.id, { data: { apiKey: 'topsecret' } });
    const request = (who: { client: { post: (url: string, body: unknown) => Promise<any> } }) =>
      who.client.post(
        '/rest/node-types/options',
        body('keyLength', {
          workflowId: inAlpha.id,
          node: {
            ...node('Options', 'test.p6Options'),
            credentials: { testApi: { id: theirs.id, name: theirs.name } },
          },
        }),
      );
    for (const who of [member, owner]) {
      const res = await request(who);
      expect(res.statusCode).toBe(400);
      expect(res.json().error.code).toBe('options_error');
      expect(res.body).not.toContain('topsecret');
      expect(res.body).not.toContain('"name":"9"');
    }
  });

  it("lists the data tables and workflows of the workflow's project only", async () => {
    const { member, alpha, beta, inAlpha, tenantId } = await setup();
    await dataTableIn(server, tenantId, alpha.id, 'orders_alpha');
    await dataTableIn(server, tenantId, beta.id, 'orders_beta');
    const tables = await member.client.data<{ results: Array<{ name: string }> }>(
      member.client.post('/rest/node-types/options', {
        nodeType: 'core.dataTable',
        kind: 'listSearch',
        method: 'tableSearch',
        node: node('Table', 'core.dataTable'),
        workflowId: inAlpha.id,
      }),
    );
    expect(tables.results.map((r) => r.name)).toEqual(['orders_alpha']);

    const workflows = await member.client.data<{ results: Array<{ name: string }> }>(
      member.client.post('/rest/node-types/options', {
        nodeType: 'core.executeWorkflow',
        kind: 'listSearch',
        method: 'searchWorkflows',
        node: node('Run', 'core.executeWorkflow', { source: 'database' }),
        workflowId: inAlpha.id,
      }),
    );
    // the open workflow is left out, the other project's workflow is not visible
    expect(workflows.results.map((r) => r.name)).toEqual([]);
  });

  it('shows the workflow pickers only what the member can list, and reads only what they can read', async () => {
    const { member, owner, alpha, inAlpha, inBeta, tenantId } = await setup();
    await workflowIn(server, tenantId, alpha.id, { name: 'Second in alpha' });
    const pick = (who: {
      client: { data: <T>(p: Promise<any>) => Promise<T>; post: (u: string, b: unknown) => Promise<any> };
    }) =>
      who.client.data<{ results: Array<{ name: string }> }>(
        who.client.post('/rest/node-types/options', {
          nodeType: 'core.executeWorkflow',
          kind: 'listSearch',
          method: 'searchWorkflows',
          node: node('Run', 'core.executeWorkflow', { source: 'database' }),
          workflowId: inAlpha.id,
        }),
      );
    expect((await pick(member)).results.map((r) => r.name)).toEqual(['Second in alpha']);
    expect((await pick(owner)).results.map((r) => r.name).sort()).toEqual(['In beta', 'Second in alpha']);

    // another project's workflow is not read through the open workflow of this one
    const read = await member.client.data<Array<{ name: string }>>(
      member.client.post(
        '/rest/node-types/options',
        body('readTarget', { workflowId: inAlpha.id }, { targetId: inBeta.id }),
      ),
    );
    expect(read).toEqual([]);
  });
});
