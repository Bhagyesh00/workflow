/**
 * P6-51 (L6): project type policies. `composeDecisions` (the workspace AND the project; a project only
 * restricts; a workspace `delegate` is met only by an explicit project `allow` rule), the project scope
 * routes (`nodeTypePolicy:manage` and `credentialTypePolicy:manage` in the project) and the decision as the
 * available-types answer shows it.
 */
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { composeDecisions } from '../src/services/type-policies/compose';
import type { PolicyAction, PolicyKind, PolicyRule, TypeDecision } from '../src/services/type-policies/types';
import {
  addToProject,
  createTestServer,
  projectIn,
  realMember,
  resetDatabase,
  signup,
  type TestServer,
} from './helpers';

let server: TestServer;
let signups = 0;

beforeAll(async () => {
  server = await createTestServer();
});
afterAll(async () => {
  await server.close();
});
beforeEach(async () => {
  await resetDatabase(server.ctx);
});

const decision = (
  action: PolicyAction,
  scope: 'workspace' | 'project',
  matchedRuleId: string | null = null,
): TypeDecision => ({ action, scope, matchedRuleId, optInAvailable: action === 'delegate' });

describe('composeDecisions', () => {
  it('a workspace allow with no project scope allows', () => {
    expect(composeDecisions(decision('allow', 'workspace'))).toMatchObject({ action: 'allow' });
  });

  it('a workspace deny stays a workspace denial whatever the project says', () => {
    const out = composeDecisions(decision('deny', 'workspace', 'r1'), decision('allow', 'project', 'r2'));
    expect(out).toMatchObject({ action: 'deny', scope: 'workspace', matchedRuleId: 'r1' });
  });

  it('a project can only restrict: allow in the workspace and deny in the project is a project denial', () => {
    const out = composeDecisions(decision('allow', 'workspace'), decision('deny', 'project', 'p1'));
    expect(out).toEqual({ action: 'deny', scope: 'project', matchedRuleId: 'p1', optInAvailable: false });
  });

  it('a project allow changes nothing when the workspace allows', () => {
    const out = composeDecisions(decision('allow', 'workspace', 'w1'), decision('allow', 'project', 'p1'));
    expect(out).toMatchObject({ action: 'allow', scope: 'workspace' });
  });

  it('a delegate with no project scope denies, and says the project may opt in', () => {
    expect(composeDecisions(decision('delegate', 'workspace', 'w1'))).toEqual({
      action: 'deny',
      scope: 'workspace',
      matchedRuleId: 'w1',
      optInAvailable: true,
    });
  });

  it("a project's default allow never meets a delegate", () => {
    const out = composeDecisions(decision('delegate', 'workspace'), decision('allow', 'project', null));
    expect(out).toMatchObject({ action: 'deny', scope: 'workspace', optInAvailable: true });
  });

  it('an explicit project allow rule meets a delegate', () => {
    const out = composeDecisions(decision('delegate', 'workspace'), decision('allow', 'project', 'p1'));
    expect(out).toMatchObject({ action: 'allow', scope: 'project', matchedRuleId: 'p1' });
  });

  it('an explicit project deny rule on a delegated type is a project denial', () => {
    const out = composeDecisions(decision('delegate', 'workspace'), decision('deny', 'project', 'p1'));
    expect(out).toMatchObject({ action: 'deny', scope: 'project', optInAvailable: false });
  });

  it('never answers delegate', () => {
    for (const w of ['allow', 'deny', 'delegate'] as const) {
      for (const p of [undefined, 'allow', 'deny'] as const) {
        const out = composeDecisions(decision(w, 'workspace', 'w'), p && decision(p, 'project', 'p'));
        expect(['allow', 'deny']).toContain(out.action);
      }
    }
  });
});

async function newOwner() {
  signups++;
  const owner = await signup(server.app, { remoteAddress: `10.76.${signups >> 8}.${signups & 255}` });
  return { owner, tenantId: owner.tenant.id };
}

/** a document with `rules`, attached last to a scope; the scope's default stays unless `defaultAction` is given */
async function attach(
  tenantId: string,
  kind: PolicyKind,
  projectId: string | null,
  rules: PolicyRule[],
  defaultAction?: PolicyAction,
) {
  const store = server.ctx.typePolicies;
  const { policy } = await store.createPolicy(tenantId, kind, {
    name: `rules ${randomUUID().slice(0, 8)}`,
    rules,
  });
  const scope = await store.getScope(tenantId, kind, projectId);
  const priority = scope.attachments.reduce((max, a) => Math.max(max, a.priority + 1), 0);
  await store.putScope(
    tenantId,
    kind,
    projectId,
    {
      defaultAction: defaultAction ?? scope.defaultAction,
      attachments: [...scope.attachments, { policyId: policy.id, priority, isFloor: false }],
    },
    scope.version,
  );
  return policy;
}

const rule = (action: PolicyAction, name: string): PolicyRule => ({
  id: randomUUID(),
  action,
  selector: { name },
});

const availability = async (
  owner: Awaited<ReturnType<typeof newOwner>>['owner'],
  projectId: string,
  type: string,
  kind: PolicyKind = 'node',
) => {
  const path = kind === 'node' ? 'available-types' : 'available-credential-types';
  const rows = await owner.client.data<Array<{ type: string; available: boolean; scope?: string }>>(
    owner.client.get(`/rest/projects/${projectId}/${path}`),
  );
  return rows.find((row) => row.type === type);
};

describe('the decision in a project', () => {
  it('a project denial blocks only that project and names no project', async () => {
    const { owner, tenantId } = await newOwner();
    const a = await projectIn(server, tenantId, `Alpha ${randomUUID().slice(0, 6)}`);
    const b = await projectIn(server, tenantId, `Beta ${randomUUID().slice(0, 6)}`);
    await attach(tenantId, 'node', a.id, [rule('deny', 'core.set')]);
    const inA = await availability(owner, a.id, 'core.set');
    expect(inA).toMatchObject({ available: false, scope: 'project' });
    expect(JSON.stringify(inA)).not.toContain(a.name);
    expect(await availability(owner, b.id, 'core.set')).toMatchObject({ available: true });
  });

  it('a project allow cannot free a type the workspace denies', async () => {
    const { owner, tenantId } = await newOwner();
    const a = await projectIn(server, tenantId, `Alpha ${randomUUID().slice(0, 6)}`);
    await attach(tenantId, 'node', null, [rule('deny', 'core.set')]);
    await attach(tenantId, 'node', a.id, [rule('allow', 'core.set')]);
    expect(await availability(owner, a.id, 'core.set')).toMatchObject({
      available: false,
      scope: 'workspace',
    });
  });

  it('a delegated type needs the project allow rule; the project default does not meet it', async () => {
    const { owner, tenantId } = await newOwner();
    const opted = await projectIn(server, tenantId, `Opted ${randomUUID().slice(0, 6)}`);
    const plain = await projectIn(server, tenantId, `Plain ${randomUUID().slice(0, 6)}`);
    const none = await projectIn(server, tenantId, `None ${randomUUID().slice(0, 6)}`);
    await attach(tenantId, 'node', null, [rule('delegate', 'core.set')]);
    await attach(tenantId, 'node', opted.id, [rule('allow', 'core.set')], 'allow');
    // a project whose scope only has the default allow
    const scope = await server.ctx.typePolicies.getScope(tenantId, 'node', plain.id);
    await server.ctx.typePolicies.putScope(
      tenantId,
      'node',
      plain.id,
      { defaultAction: 'allow' },
      scope.version,
    );
    expect(await availability(owner, opted.id, 'core.set')).toMatchObject({ available: true });
    expect(await availability(owner, plain.id, 'core.set')).toMatchObject({
      available: false,
      scope: 'workspace',
      optInAvailable: true,
    });
    expect(await availability(owner, none.id, 'core.set')).toMatchObject({ available: false });
  });

  it('credential types compose the same way', async () => {
    const { owner, tenantId } = await newOwner();
    const a = await projectIn(server, tenantId, `Alpha ${randomUUID().slice(0, 6)}`);
    await attach(tenantId, 'credential', a.id, [rule('deny', 'testApi')]);
    expect(await availability(owner, a.id, 'testApi', 'credential')).toMatchObject({
      available: false,
      scope: 'project',
    });
  });
});

describe('project policy routes', () => {
  const NODE = (projectId: string) => `/rest/projects/${projectId}/node-type-policies/project`;
  const CRED = (projectId: string) => `/rest/projects/${projectId}/credential-type-policies/project`;

  it('GET answers an unwritten scope, PUT writes it with the version it read and audits it', async () => {
    const { owner, tenantId } = await newOwner();
    const project = await projectIn(server, tenantId, `Alpha ${randomUUID().slice(0, 6)}`);
    const read = await owner.client.data(owner.client.get(NODE(project.id)));
    expect(read).toMatchObject({ projectId: project.id, kind: 'node', defaultAction: 'allow', version: 0 });

    const wrote = await owner.client.data(
      owner.client.put(NODE(project.id), { defaultAction: 'deny', expectedVersion: 0 }),
    );
    expect(wrote).toMatchObject({ defaultAction: 'deny', version: 1 });
    expect(await availability(owner, project.id, 'core.set')).toMatchObject({
      available: false,
      scope: 'project',
    });
    const audit = (await server.ctx.repos.audit.list(tenantId, 50)).find(
      (row) => row.action === 'type_policy.scope.updated',
    );
    expect(audit?.metadata).toMatchObject({ projectId: project.id, kind: 'node' });

    const stale = await owner.client.put(NODE(project.id), { defaultAction: 'allow', expectedVersion: 0 });
    expect(stale.statusCode).toBe(409);
  });

  it('a project scope never delegates', async () => {
    const { owner, tenantId } = await newOwner();
    const project = await projectIn(server, tenantId, `Alpha ${randomUUID().slice(0, 6)}`);
    const res = await owner.client.put(NODE(project.id), { defaultAction: 'delegate', expectedVersion: 0 });
    expect(res.statusCode).toBe(400);
  });

  it('a project admin manages the scope of the project, an editor and a viewer do not', async () => {
    const { owner, tenantId } = await newOwner();
    const project = await projectIn(server, tenantId, `Alpha ${randomUUID().slice(0, 6)}`);
    const other = await projectIn(server, tenantId, `Other ${randomUUID().slice(0, 6)}`);
    const admin = await realMember(owner);
    const editor = await realMember(owner);
    const viewer = await realMember(owner);
    await addToProject(server, tenantId, project.id, admin.user.id, 'project:admin');
    await addToProject(server, tenantId, project.id, editor.user.id, 'project:editor');
    await addToProject(server, tenantId, project.id, viewer.user.id, 'project:viewer');

    for (const url of [NODE(project.id), CRED(project.id)]) {
      expect((await admin.client.get(url)).statusCode).toBe(200);
      expect((await admin.client.put(url, { defaultAction: 'allow', expectedVersion: 0 })).statusCode).toBe(
        200,
      );
      for (const lesser of [editor, viewer]) {
        const denied = await lesser.client.get(url);
        expect(denied.statusCode).toBe(403);
        expect(denied.json().error.message).toBe('User is missing a scope required to perform this action');
        expect((await lesser.client.put(url, { defaultAction: 'deny', expectedVersion: 1 })).statusCode).toBe(
          403,
        );
      }
    }
    // the admin of one project reaches no other project's scope
    expect((await admin.client.get(NODE(other.id))).statusCode).toBe(403);
  });

  it("another workspace's project and an unknown project are 404", async () => {
    const mine = await newOwner();
    const theirs = await newOwner();
    const foreign = await projectIn(server, theirs.tenantId, `Foreign ${randomUUID().slice(0, 6)}`);
    for (const id of [foreign.id, randomUUID()]) {
      expect((await mine.owner.client.get(NODE(id))).statusCode).toBe(404);
      expect(
        (await mine.owner.client.put(CRED(id), { defaultAction: 'deny', expectedVersion: 0 })).statusCode,
      ).toBe(404);
    }
  });

  it('a body that is not a scope write is 400 and a request with no session is 401', async () => {
    const { owner, tenantId } = await newOwner();
    const project = await projectIn(server, tenantId, `Alpha ${randomUUID().slice(0, 6)}`);
    expect((await owner.client.put(NODE(project.id), { defaultAction: 'sometimes' })).statusCode).toBe(400);
    const anonymous = await server.app.inject({ method: 'GET', url: NODE(project.id) });
    expect(anonymous.statusCode).toBe(401);
  });
});
