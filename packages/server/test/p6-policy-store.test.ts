/**
 * P6-48 (L1): the type policy store and its snapshots on the real database. An unwritten scope reads as allow
 * at version 0 and its first write sends `expectedVersion` 0; a stale write is 409 and one write gives
 * version + 1; documents and attachments; two workspaces apart; the snapshot reloads after a write (here and
 * on a second process through the bus channel `type-policies`), after its TTL, and never keeps a load a write
 * overtook; a failing load fails closed.
 */
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { evaluateScope } from '../src/services/type-policies/evaluator';
import {
  POLICY_SNAPSHOT_TTL_MS,
  PolicySnapshots,
  TYPE_POLICIES_CHANNEL,
} from '../src/services/type-policies/snapshot';
import type { PolicyRule } from '../src/services/type-policies/types';
import { createTestServer, policyDeny, projectIn, signup, type TestServer } from './helpers';

let server: TestServer;
let signups = 0;
/** a new workspace from its own IP (signup allows 20 an hour per IP) */
const newOwner = () => {
  signups++;
  return signup(server.app, { remoteAddress: `10.97.${signups >> 8}.${signups & 255}`, projects: 'real' });
};

beforeAll(async () => {
  server = await createTestServer();
}, 120_000);

afterAll(async () => {
  await server?.close();
});

const rule = (action: PolicyRule['action'], selector: PolicyRule['selector']): PolicyRule => ({
  id: randomUUID(),
  action,
  selector,
});

const statusOf = async (work: Promise<unknown>) => {
  try {
    await work;
  } catch (error) {
    return (error as { statusCode?: number }).statusCode ?? -1;
  }
  return 0;
};

describe('scopes', () => {
  it('an unwritten scope allows all at version 0; the first write sends 0 and gives 1, then +1 each', async () => {
    const { tenant } = await newOwner();
    const store = server.ctx.typePolicies;
    const unwritten = await store.getScope(tenant.id, 'node', null);
    expect(unwritten).toMatchObject({
      id: null,
      tenantId: tenant.id,
      kind: 'node',
      projectId: null,
      defaultAction: 'allow',
      version: 0,
      attachments: [],
    });
    const first = await store.putScope(tenant.id, 'node', null, { defaultAction: 'deny' }, 0);
    expect(first).toMatchObject({ defaultAction: 'deny', version: 1 });
    expect(first.id).toEqual(expect.any(String));
    const second = await store.putScope(tenant.id, 'node', null, { defaultAction: 'delegate' }, 1);
    expect(second).toMatchObject({ id: first.id, defaultAction: 'delegate', version: 2 });
    expect(await store.getScope(tenant.id, 'node', null)).toMatchObject({
      version: 2,
      defaultAction: 'delegate',
    });
    // the credential scope is its own
    expect(await store.getScope(tenant.id, 'credential', null)).toMatchObject({ id: null, version: 0 });
  });

  it('a stale write is 409 and changes nothing, a first write sent as version 1 is 409, a second first write is 409', async () => {
    const { tenant } = await newOwner();
    const store = server.ctx.typePolicies;
    expect(await statusOf(store.putScope(tenant.id, 'node', null, { defaultAction: 'deny' }, 3))).toBe(409);
    await store.putScope(tenant.id, 'node', null, { defaultAction: 'deny' }, 0);
    expect(await statusOf(store.putScope(tenant.id, 'node', null, { defaultAction: 'allow' }, 0))).toBe(409);
    expect(await statusOf(store.putScope(tenant.id, 'node', null, { defaultAction: 'allow' }, 7))).toBe(409);
    expect(await store.getScope(tenant.id, 'node', null)).toMatchObject({
      defaultAction: 'deny',
      version: 1,
    });
  });

  it('two concurrent first writes: one wins, the other is 409', async () => {
    const { tenant } = await newOwner();
    const store = server.ctx.typePolicies;
    const results = await Promise.all([
      statusOf(store.putScope(tenant.id, 'credential', null, { defaultAction: 'deny' }, 0)),
      statusOf(store.putScope(tenant.id, 'credential', null, { defaultAction: 'allow' }, 0)),
    ]);
    expect(results.sort()).toEqual([0, 409]);
    expect((await store.getScope(tenant.id, 'credential', null)).version).toBe(1);
  });

  it('a project scope: its own row, never delegates, needs a project of the workspace', async () => {
    const owner = await newOwner();
    const other = await newOwner();
    const store = server.ctx.typePolicies;
    const project = await projectIn(server, owner.tenant.id, 'Team');
    expect(await store.getScope(owner.tenant.id, 'node', project.id)).toMatchObject({
      id: null,
      projectId: project.id,
      version: 0,
    });
    expect(
      await statusOf(store.putScope(owner.tenant.id, 'node', project.id, { defaultAction: 'delegate' }, 0)),
    ).toBe(400);
    expect(
      await statusOf(store.putScope(owner.tenant.id, 'node', randomUUID(), { defaultAction: 'deny' }, 0)),
    ).toBe(404);
    // another workspace's project is not found
    expect(
      await statusOf(store.putScope(other.tenant.id, 'node', project.id, { defaultAction: 'deny' }, 0)),
    ).toBe(404);
    const written = await store.putScope(owner.tenant.id, 'node', project.id, { defaultAction: 'deny' }, 0);
    expect(written).toMatchObject({ projectId: project.id, defaultAction: 'deny', version: 1 });
    // the workspace scope is untouched
    expect(await store.getScope(owner.tenant.id, 'node', null)).toMatchObject({ version: 0 });
  });

  it('two workspaces are apart', async () => {
    const a = await newOwner();
    const b = await newOwner();
    const store = server.ctx.typePolicies;
    await store.putScope(a.tenant.id, 'node', null, { defaultAction: 'deny' }, 0);
    expect(await store.getScope(b.tenant.id, 'node', null)).toMatchObject({
      defaultAction: 'allow',
      version: 0,
    });
    const { policy } = await store.createPolicy(a.tenant.id, 'node', {
      name: 'only a',
      rules: [rule('deny', { name: 'core.set' })],
    });
    expect(await store.listPolicies(b.tenant.id, 'node')).toEqual([]);
    expect(await statusOf(store.getPolicy(b.tenant.id, 'node', policy.id))).toBe(404);
    expect(await statusOf(store.updatePolicy(b.tenant.id, 'node', policy.id, { name: 'x' }, 1))).toBe(404);
    expect(await statusOf(store.deletePolicy(b.tenant.id, 'node', policy.id, 1))).toBe(404);
    // b cannot attach a's document
    const scope = await store.getScope(b.tenant.id, 'node', null);
    expect(
      await statusOf(
        store.putScope(
          b.tenant.id,
          'node',
          null,
          { defaultAction: 'allow', attachments: [{ policyId: policy.id, priority: 0, isFloor: false }] },
          scope.version,
        ),
      ),
    ).toBe(404);
    expect(await store.getPolicy(a.tenant.id, 'node', policy.id)).toMatchObject({ id: policy.id });
  });
});

describe('documents', () => {
  it('creates at version 1 with the rules and lint warnings, lists, gets, and refuses a duplicate name', async () => {
    const { tenant } = await newOwner();
    const store = server.ctx.typePolicies;
    const known = [...server.ctx.policySnapshots.packageIndex.nodes.keys()][0];
    const first = rule('allow', { name: known });
    const second = rule('deny', { name: known });
    const ghost = rule('deny', { name: 'core.no-such-node' });
    const { policy, warnings } = await store.createPolicy(tenant.id, 'node', {
      name: 'Base',
      description: 'a policy',
      rules: [first, second, ghost],
    });
    expect(policy).toMatchObject({
      tenantId: tenant.id,
      kind: 'node',
      name: 'Base',
      description: 'a policy',
      version: 1,
    });
    expect(policy.rules).toEqual([first, second, ghost]);
    expect(warnings.map((w) => [w.code, w.ruleId])).toEqual([
      ['shadowed', second.id],
      ['notLoaded', ghost.id],
    ]);
    expect(await store.listPolicies(tenant.id, 'node')).toHaveLength(1);
    expect(await store.listPolicies(tenant.id, 'credential')).toEqual([]);
    expect(await store.getPolicy(tenant.id, 'node', policy.id)).toMatchObject({
      id: policy.id,
      name: 'Base',
    });
    // the same name again is 409, the same name in the other kind is fine
    expect(await statusOf(store.createPolicy(tenant.id, 'node', { name: 'Base', rules: [] }))).toBe(409);
    await store.createPolicy(tenant.id, 'credential', { name: 'Base', rules: [] });
    // a kind mismatch is not found
    expect(await statusOf(store.getPolicy(tenant.id, 'credential', policy.id))).toBe(404);
  });

  it('refuses extends in a node policy, a bad rule and a bad name with 400, and keeps extends in a credential policy', async () => {
    const { tenant } = await newOwner();
    const store = server.ctx.typePolicies;
    expect(
      await statusOf(
        store.createPolicy(tenant.id, 'node', { name: 'n', rules: [rule('deny', { extends: 'oAuth2Api' })] }),
      ),
    ).toBe(400);
    expect(
      await statusOf(store.createPolicy(tenant.id, 'node', { name: 'n', rules: [rule('deny', {})] })),
    ).toBe(400);
    expect(await statusOf(store.createPolicy(tenant.id, 'node', { name: '  ', rules: [] }))).toBe(400);
    expect(await store.listPolicies(tenant.id, 'node')).toEqual([]);
    const ok = await store.createPolicy(tenant.id, 'credential', {
      name: 'oauth',
      rules: [rule('deny', { extends: 'oAuth2Api' })],
    });
    expect(ok.policy.rules[0].selector).toEqual({ extends: 'oAuth2Api' });
  });

  it('update checks the version (stale is 409), gives version + 1, keeps what the patch leaves out', async () => {
    const { tenant } = await newOwner();
    const store = server.ctx.typePolicies;
    const { policy } = await store.createPolicy(tenant.id, 'node', {
      name: 'u',
      description: 'd',
      rules: [rule('deny', { name: 'core.set' })],
    });
    expect(await statusOf(store.updatePolicy(tenant.id, 'node', policy.id, { name: 'v' }, 5))).toBe(409);
    const renamed = await store.updatePolicy(tenant.id, 'node', policy.id, { name: 'v' }, 1);
    expect(renamed.policy).toMatchObject({ name: 'v', description: 'd', version: 2 });
    expect(renamed.policy.rules).toEqual(policy.rules);
    // the old version is stale now
    expect(await statusOf(store.updatePolicy(tenant.id, 'node', policy.id, { name: 'w' }, 1))).toBe(409);
    const cleared = await store.updatePolicy(
      tenant.id,
      'node',
      policy.id,
      { description: null, rules: [] },
      2,
    );
    expect(cleared.policy).toMatchObject({ description: null, rules: [], version: 3 });
    // renaming onto another document's name is 409
    await store.createPolicy(tenant.id, 'node', { name: 'taken', rules: [] });
    expect(await statusOf(store.updatePolicy(tenant.id, 'node', policy.id, { name: 'taken' }, 3))).toBe(409);
    expect((await store.getPolicy(tenant.id, 'node', policy.id)).version).toBe(3);
  });

  it('a delete is 409 while a scope attaches the document, and works after the scope lets it go', async () => {
    const { tenant } = await newOwner();
    const store = server.ctx.typePolicies;
    const { policy } = await store.createPolicy(tenant.id, 'node', {
      name: 'attached',
      rules: [rule('deny', { name: 'core.set' })],
    });
    const scope = await store.putScope(
      tenant.id,
      'node',
      null,
      { defaultAction: 'allow', attachments: [{ policyId: policy.id, priority: 0, isFloor: false }] },
      0,
    );
    expect(await statusOf(store.deletePolicy(tenant.id, 'node', policy.id, 1))).toBe(409);
    expect(await store.getPolicy(tenant.id, 'node', policy.id)).toMatchObject({ id: policy.id });
    await store.putAttachments(tenant.id, scope.id as string, [], scope.version);
    // a stale version is 409 and leaves the document
    expect(await statusOf(store.deletePolicy(tenant.id, 'node', policy.id, 0))).toBe(409);
    expect(await store.getPolicy(tenant.id, 'node', policy.id)).toMatchObject({ id: policy.id });
    await store.deletePolicy(tenant.id, 'node', policy.id, 1);
    expect(await statusOf(store.getPolicy(tenant.id, 'node', policy.id))).toBe(404);
    expect(await statusOf(store.deletePolicy(tenant.id, 'node', policy.id, 1))).toBe(404);
  });

  it('a document update raises the version of the scopes that attach it', async () => {
    const { tenant } = await newOwner();
    const store = server.ctx.typePolicies;
    const { policy } = await store.createPolicy(tenant.id, 'node', { name: 'bump', rules: [] });
    await store.putScope(
      tenant.id,
      'node',
      null,
      { defaultAction: 'allow', attachments: [{ policyId: policy.id, priority: 0, isFloor: false }] },
      0,
    );
    await store.updatePolicy(
      tenant.id,
      'node',
      policy.id,
      { rules: [rule('deny', { name: 'core.set' })] },
      1,
    );
    expect((await store.getScope(tenant.id, 'node', null)).version).toBe(2);
  });
});

describe('attachments', () => {
  it('replace the list, keep it when a scope write leaves it out, and read floors first then by priority', async () => {
    const { tenant } = await newOwner();
    const store = server.ctx.typePolicies;
    const make = async (name: string) =>
      (await store.createPolicy(tenant.id, 'node', { name, rules: [rule('allow', { name })] })).policy;
    const [a, b, c] = [await make('a'), await make('b'), await make('c')];
    const scope = await store.putScope(
      tenant.id,
      'node',
      null,
      {
        defaultAction: 'deny',
        attachments: [
          { policyId: a.id, priority: 5, isFloor: false },
          { policyId: b.id, priority: 9, isFloor: true },
          { policyId: c.id, priority: 1, isFloor: false },
        ],
      },
      0,
    );
    expect(scope.attachments.map((x) => x.policyId)).toEqual([b.id, c.id, a.id]);
    // a write with no attachments keeps them and still raises the version
    const kept = await store.putScope(tenant.id, 'node', null, { defaultAction: 'allow' }, 1);
    expect(kept.version).toBe(2);
    expect(kept.attachments).toHaveLength(3);
    expect((await store.getAttachments(tenant.id, scope.id as string)).map((x) => x.policyId)).toEqual([
      b.id,
      c.id,
      a.id,
    ]);
    // putAttachments replaces and raises the version, and a stale version is 409
    expect(await statusOf(store.putAttachments(tenant.id, scope.id as string, [], 1))).toBe(409);
    const replaced = await store.putAttachments(
      tenant.id,
      scope.id as string,
      [{ policyId: c.id, priority: 0, isFloor: false }],
      2,
    );
    expect(replaced).toMatchObject({ version: 3 });
    expect(replaced.attachments).toEqual([{ policyId: c.id, priority: 0, isFloor: false }]);
  });

  it('refuses a repeated document, a repeated priority, a bad priority, an unknown document and one of the other kind', async () => {
    const { tenant } = await newOwner();
    const store = server.ctx.typePolicies;
    const a = (await store.createPolicy(tenant.id, 'node', { name: 'a', rules: [] })).policy;
    const b = (await store.createPolicy(tenant.id, 'node', { name: 'b', rules: [] })).policy;
    const cred = (await store.createPolicy(tenant.id, 'credential', { name: 'c', rules: [] })).policy;
    const put = (attachments: Array<{ policyId: string; priority: number; isFloor: boolean }>) =>
      statusOf(store.putScope(tenant.id, 'node', null, { defaultAction: 'allow', attachments }, 0));
    expect(
      await put([
        { policyId: a.id, priority: 0, isFloor: false },
        { policyId: a.id, priority: 1, isFloor: false },
      ]),
    ).toBe(400);
    expect(
      await put([
        { policyId: a.id, priority: 0, isFloor: false },
        { policyId: b.id, priority: 0, isFloor: false },
      ]),
    ).toBe(400);
    expect(await put([{ policyId: a.id, priority: -1, isFloor: false }])).toBe(400);
    expect(await put([{ policyId: a.id, priority: 1.5, isFloor: false }])).toBe(400);
    expect(await put([{ policyId: randomUUID(), priority: 0, isFloor: false }])).toBe(404);
    expect(await put([{ policyId: cred.id, priority: 0, isFloor: false }])).toBe(404);
    // the same priority as a floor and as a normal attachment is fine
    expect(
      await put([
        { policyId: a.id, priority: 0, isFloor: false },
        { policyId: b.id, priority: 0, isFloor: true },
      ]),
    ).toBe(0);
    // none of the refused writes made the scope
    expect((await store.getScope(tenant.id, 'node', null)).version).toBe(1);
    expect(await statusOf(store.putAttachments(tenant.id, randomUUID(), [], 0))).toBe(404);
  });

  it('a project scope cannot attach a document that delegates, nor a document it attaches be changed to delegate', async () => {
    const { tenant } = await newOwner();
    const store = server.ctx.typePolicies;
    const project = await projectIn(server, tenant.id, 'P');
    const delegating = (
      await store.createPolicy(tenant.id, 'node', {
        name: 'del',
        rules: [rule('delegate', { name: 'core.set' })],
      })
    ).policy;
    const plain = (
      await store.createPolicy(tenant.id, 'node', {
        name: 'plain',
        rules: [rule('deny', { name: 'core.set' })],
      })
    ).policy;
    expect(
      await statusOf(
        store.putScope(
          tenant.id,
          'node',
          project.id,
          { defaultAction: 'allow', attachments: [{ policyId: delegating.id, priority: 0, isFloor: false }] },
          0,
        ),
      ),
    ).toBe(400);
    // the workspace scope can attach it
    await store.putScope(
      tenant.id,
      'node',
      null,
      { defaultAction: 'allow', attachments: [{ policyId: delegating.id, priority: 0, isFloor: false }] },
      0,
    );
    // a project scope attaches the plain one; a delegate rule cannot then be added to it
    await store.putScope(
      tenant.id,
      'node',
      project.id,
      { defaultAction: 'allow', attachments: [{ policyId: plain.id, priority: 0, isFloor: false }] },
      0,
    );
    expect(
      await statusOf(
        store.updatePolicy(
          tenant.id,
          'node',
          plain.id,
          { rules: [rule('delegate', { name: 'core.set' })] },
          1,
        ),
      ),
    ).toBe(400);
    expect((await store.getPolicy(tenant.id, 'node', plain.id)).version).toBe(1);
  });
});

describe('snapshots', () => {
  it('holds a workspace scope per kind, the project scopes and the documents, and the evaluator reads them', async () => {
    const { tenant } = await newOwner();
    const project = await projectIn(server, tenant.id, 'P');
    const snapshots = server.ctx.policySnapshots;
    const empty = await snapshots.forTenant(tenant.id);
    expect(empty.tenantId).toBe(tenant.id);
    expect(empty.workspace.node).toMatchObject({ id: null, version: 0, defaultAction: 'allow' });
    expect(empty.workspace.credential).toMatchObject({ id: null, version: 0 });
    expect(empty.projects.node.size).toBe(0);
    expect(empty.policies.size).toBe(0);

    const doc = await policyDeny(server, tenant.id, 'node', 'core.set');
    await server.ctx.typePolicies.putScope(tenant.id, 'credential', project.id, { defaultAction: 'deny' }, 0);
    const snapshot = await snapshots.forTenant(tenant.id);
    expect(snapshot).not.toBe(empty);
    expect(snapshot.policies.get(doc.id)).toMatchObject({ id: doc.id, kind: 'node' });
    expect(snapshot.workspace.node.attachments).toHaveLength(1);
    expect(snapshot.projects.credential.get(project.id)).toMatchObject({ defaultAction: 'deny', version: 1 });
    const facts = { kind: 'node' as const, policies: snapshot.policies };
    expect(evaluateScope(snapshot.workspace.node, 'core.set', facts)).toMatchObject({
      action: 'deny',
      matchedRuleId: doc.rules[0].id,
    });
    expect(evaluateScope(snapshot.workspace.node, 'core.code', facts).action).toBe('allow');
  });

  it('a package rule judges through the package index', async () => {
    const { tenant } = await newOwner();
    const index = server.ctx.policySnapshots.packageIndex;
    const [type, packageName] = [...index.nodes.entries()][0];
    const store = server.ctx.typePolicies;
    const { policy } = await store.createPolicy(tenant.id, 'node', {
      name: 'pkg',
      rules: [rule('deny', { package: packageName })],
    });
    await store.putScope(
      tenant.id,
      'node',
      null,
      { defaultAction: 'allow', attachments: [{ policyId: policy.id, priority: 0, isFloor: false }] },
      0,
    );
    const snapshot = await server.ctx.policySnapshots.forTenant(tenant.id);
    const facts = { kind: 'node' as const, packageName: index.nodes.get(type), policies: snapshot.policies };
    expect(evaluateScope(snapshot.workspace.node, type, facts).action).toBe('deny');
    expect(
      evaluateScope(snapshot.workspace.node, type, { kind: 'node', policies: snapshot.policies }).action,
    ).toBe('allow');
  });

  it('a name rule on a base node denies its tool variant through factsFor', async () => {
    const { tenant } = await newOwner();
    const snapshots = server.ctx.policySnapshots;
    const [variant, base] = [...snapshots.packageIndex.bases.entries()][0];
    const doc = await policyDeny(server, tenant.id, 'node', base);
    const snapshot = await snapshots.forTenant(tenant.id);
    const facts = snapshots.factsFor(snapshot, 'node', variant);
    expect(facts.baseName).toBe(base);
    expect(evaluateScope(snapshot.workspace.node, variant, facts)).toMatchObject({
      action: 'deny',
      matchedRuleId: doc.rules[0].id,
    });
    expect(snapshots.factsFor(snapshot, 'node', base).baseName).toBeUndefined();
  });

  it('is cached until a write invalidates it, and two workspaces keep their own', async () => {
    const a = await newOwner();
    const b = await newOwner();
    const { ctx } = server;
    const spy = vi.spyOn(ctx.repos.typePolicies, 'loadTenant');
    try {
      const first = await ctx.policySnapshots.forTenant(a.tenant.id);
      expect(await ctx.policySnapshots.forTenant(a.tenant.id)).toBe(first);
      expect(spy).toHaveBeenCalledTimes(1);
      await policyDeny(server, b.tenant.id, 'node', 'core.set');
      // b's write did not drop a's snapshot
      expect(await ctx.policySnapshots.forTenant(a.tenant.id)).toBe(first);
      expect((await ctx.policySnapshots.forTenant(b.tenant.id)).workspace.node.attachments).toHaveLength(1);
      expect((await ctx.policySnapshots.forTenant(a.tenant.id)).workspace.node.attachments).toHaveLength(0);
    } finally {
      spy.mockRestore();
    }
  });

  it('is reloaded after its TTL', async () => {
    const { tenant } = await newOwner();
    const snapshots = server.ctx.policySnapshots;
    const first = await snapshots.forTenant(tenant.id);
    const real = Date.now();
    const clock = vi.spyOn(Date, 'now').mockReturnValue(real + POLICY_SNAPSHOT_TTL_MS + 1);
    try {
      const again = await snapshots.forTenant(tenant.id);
      expect(again).not.toBe(first);
      expect(await snapshots.forTenant(tenant.id)).toBe(again);
    } finally {
      clock.mockRestore();
    }
  });

  it('a second process sees a write through the type-policies channel', async () => {
    const { tenant } = await newOwner();
    const { ctx } = server;
    const second = new PolicySnapshots(ctx.serviceDeps, ctx.policySnapshots.packageIndex);
    await second.start();
    try {
      const before = await second.forTenant(tenant.id);
      expect(before.workspace.node.attachments).toHaveLength(0);
      // the write goes through the first process's store; the second still holds its copy until told
      await policyDeny(server, tenant.id, 'node', 'core.set');
      await vi.waitFor(async () => {
        const now = await second.forTenant(tenant.id);
        expect(now.workspace.node.attachments).toHaveLength(1);
      });
      // a message of another workspace drops nothing here
      const kept = await second.forTenant(tenant.id);
      await ctx.bus.publish(TYPE_POLICIES_CHANNEL, { tenantId: randomUUID(), origin: 'elsewhere' });
      await new Promise((resolve) => setTimeout(resolve, 20));
      expect(await second.forTenant(tenant.id)).toBe(kept);
      // a stopped snapshot no longer hears the channel
      await second.stop();
      await policyDeny(server, tenant.id, 'node', 'core.code');
      await new Promise((resolve) => setTimeout(resolve, 20));
      expect((await second.forTenant(tenant.id)).workspace.node.attachments).toHaveLength(2);
    } finally {
      await second.stop();
    }
  });

  it('does not keep a load that an invalidation overtook', async () => {
    const { tenant } = await newOwner();
    const { ctx } = server;
    const real = ctx.repos.typePolicies.loadTenant.bind(ctx.repos.typePolicies);
    let release: () => void = () => {};
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const spy = vi.spyOn(ctx.repos.typePolicies, 'loadTenant').mockImplementationOnce(async (id) => {
      const rows = await real(id);
      await gate;
      return rows;
    });
    try {
      const snapshots = new PolicySnapshots(ctx.serviceDeps, ctx.policySnapshots.packageIndex);
      const slow = snapshots.forTenant(tenant.id);
      await snapshots.invalidate(tenant.id);
      release();
      await slow;
      await snapshots.forTenant(tenant.id);
      // the overtaken load was returned but not cached, so the next read loaded again
      expect(spy).toHaveBeenCalledTimes(2);
    } finally {
      spy.mockRestore();
    }
  });

  it('a load that fails rejects (callers fail closed) and the next read tries again', async () => {
    const { tenant } = await newOwner();
    const { ctx } = server;
    const spy = vi.spyOn(ctx.repos.typePolicies, 'loadTenant').mockRejectedValueOnce(new Error('db down'));
    try {
      const snapshots = new PolicySnapshots(ctx.serviceDeps, ctx.policySnapshots.packageIndex);
      await expect(snapshots.forTenant(tenant.id)).rejects.toThrow('db down');
      expect((await snapshots.forTenant(tenant.id)).tenantId).toBe(tenant.id);
    } finally {
      spy.mockRestore();
    }
  });

  it('a deleted project takes its scope with it', async () => {
    const { tenant } = await newOwner();
    const project = await projectIn(server, tenant.id, 'Gone');
    const store = server.ctx.typePolicies;
    await store.putScope(tenant.id, 'node', project.id, { defaultAction: 'deny' }, 0);
    expect((await server.ctx.policySnapshots.forTenant(tenant.id)).projects.node.has(project.id)).toBe(true);
    await server.ctx.database.pool.query('delete from projects where tenant_id = $1 and id = $2', [
      tenant.id,
      project.id,
    ]);
    await server.ctx.policySnapshots.invalidate(tenant.id);
    expect((await server.ctx.policySnapshots.forTenant(tenant.id)).projects.node.has(project.id)).toBe(false);
    expect(await store.getScope(tenant.id, 'node', project.id)).toMatchObject({ id: null, version: 0 });
  });
});
