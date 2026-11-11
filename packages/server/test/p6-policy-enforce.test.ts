/**
 * P6-04 (L2): the type availability policies at save, publish, credential save, a single node's options and
 * a move, plus the check itself (deadlines, fail closed, the audit row, another workspace's policy). Save
 * judges only the types the save adds (disabled nodes count, a copy adds nothing); publish judges the whole
 * workflow; a credential create of a blocked type is refused and an edit of an existing one is kept; a
 * single node is judged before any decrypt; a failed or late check blocks with 503. Every allowed and refused
 * action is a true member's (a `project:editor` of the team project); the owner only sets up and writes policies.
 * The run paths are in p6-policy-run.test.ts.
 */
import { randomUUID } from 'node:crypto';
import type { NodePackage, NodeType } from '@workflow/workflow';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import {
  assertCredentialType,
  assertTransferAllowed,
  checkSingleNode,
  evaluateWorkflow,
  filterAvailable,
  restrictedTypes,
} from '../src/services/type-policies/enforce';
import { PolicyCheckFailedError, PolicyViolationError } from '../src/services/type-policies/errors';
import type { PolicyKind, PolicyRule } from '../src/services/type-policies/types';
import {
  addToProject,
  chain,
  createTestServer,
  createWorkflow,
  credentialIn,
  node,
  policyDeny,
  realMember,
  setNode,
  signup,
  type TestServer,
  teamProjectOf,
  workflowIn,
} from './helpers';

/** a node whose options method would decrypt its credential: it counts its calls and then fails */
let optionCalls = 0;
const optionsNode = {
  description: {
    name: 'p6enforce.options',
    displayName: 'Options probe',
    description: '',
    group: ['transform'],
    version: 1,
    defaults: { name: 'Options probe' },
    inputs: ['main'],
    outputs: ['main'],
    credentials: [{ name: 'p6EnforceApi', required: true }],
    properties: [],
  },
  methods: {
    loadOptions: {
      async list() {
        optionCalls++;
        throw new Error('The credential was decrypted');
      },
    },
  },
  async execute(ctx) {
    return [ctx.getInputData()];
  },
} as NodeType;

const probePackage: NodePackage = {
  name: 'p6-enforce-tests',
  nodes: [optionsNode],
  credentials: [
    {
      name: 'p6EnforceApi',
      displayName: 'Enforce probe',
      properties: [
        { displayName: 'Key', name: 'key', type: 'string', typeOptions: { password: true }, default: '' },
      ],
    },
  ],
};

let server: TestServer;
let signups = 0;
/** a new workspace with its team project, from its own IP (signup allows 20 an hour per IP) */
const newOwner = async () => {
  signups++;
  const owner = await signup(server.app, { remoteAddress: `10.72.${signups >> 8}.${signups & 255}` });
  return { ...owner, projectId: await teamProjectOf(server, owner.tenant.id) };
};

/** a true member of a new workspace's team project (`project:editor`), whose creates land there */
const newMember = async () => {
  const owner = await newOwner();
  const member = await realMember(owner);
  await addToProject(server, owner.tenant.id, owner.projectId, member.user.id, 'project:editor');
  member.client.defaultProjectId = owner.projectId;
  return { ...owner, client: member.client, member };
};

/** a document with `rules` attached last to the workspace scope of `kind` */
async function attach(tenantId: string, kind: PolicyKind, rules: PolicyRule[]) {
  const store = server.ctx.typePolicies;
  const { policy } = await store.createPolicy(tenantId, kind, {
    name: `rules ${randomUUID().slice(0, 8)}`,
    rules,
  });
  const scope = await store.getScope(tenantId, kind, null);
  const priority = scope.attachments.reduce((max, a) => Math.max(max, a.priority + 1), 0);
  await store.putScope(
    tenantId,
    kind,
    null,
    {
      defaultAction: scope.defaultAction,
      attachments: [...scope.attachments, { policyId: policy.id, priority, isFloor: false }],
    },
    scope.version,
  );
}

const auditOf = async (tenantId: string) =>
  (await server.ctx.repos.audit.list(tenantId, 100)).filter((row) => row.action === 'policy.blocked');

const errorOf = async (work: Promise<unknown>): Promise<unknown> => {
  try {
    await work;
  } catch (error) {
    return error;
  }
  return undefined;
};

const delayed = <T>(ms: number, value: () => Promise<T>) =>
  new Promise<T>((resolve, reject) => setTimeout(() => value().then(resolve, reject), ms));

beforeAll(async () => {
  server = await createTestServer({}, { nodePackages: [probePackage] });
}, 120_000);

afterAll(async () => {
  await server?.close();
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('save', () => {
  it('a blocked node cannot be added: 403 policy_violation, one audit row with no workflow data', async () => {
    const { client, tenant } = await newMember();
    await policyDeny(server, tenant.id, 'node', 'test.fail');
    const res = await client.post('/rest/workflows', {
      name: 'Secret plan',
      nodes: [node('Start', 'core.manualTrigger'), node('Boom', 'test.fail', {}, [200, 0])],
      connections: chain('Start', 'Boom'),
    });
    expect(res.statusCode).toBe(403);
    const { error } = res.json();
    expect(error.code).toBe('policy_violation');
    expect(error.message).toBe('Node type "test.fail" is blocked by a workspace policy');
    expect(error.details.violations).toEqual([
      expect.objectContaining({
        kind: 'node-type-unavailable',
        type: 'test.fail',
        scope: 'workspace',
        optInAvailable: false,
        nodeName: 'Boom',
      }),
    ]);
    expect(error.details.violations[0].matchedRuleId).toEqual(expect.any(String));
    const rows = await auditOf(tenant.id);
    expect(rows).toHaveLength(1);
    expect(rows[0].metadata).toMatchObject({ point: 'workflowSave', type: 'test.fail', scope: 'workspace' });
    expect(JSON.stringify(rows[0].metadata)).not.toMatch(/Boom|Secret plan|Start/);
  });

  it('an old workflow with a blocked type saves; a save that adds a blocked type, disabled or not, is refused', async () => {
    const { client, tenant, projectId } = await newMember();
    const old = await workflowIn(server, tenant.id, projectId, {
      nodes: [node('Start', 'core.manualTrigger'), node('Boom', 'test.fail', {}, [200, 0])],
      connections: chain('Start', 'Boom'),
    });
    await policyDeny(server, tenant.id, 'node', 'test.fail');
    await policyDeny(server, tenant.id, 'node', 'core.noOp');
    const current = await client.data(client.get(`/rest/workflows/${old.id}`));

    // a rename and a copy of a type it already has add nothing
    const copied = await client.data(
      client.patch(`/rest/workflows/${old.id}`, {
        versionId: current.versionId,
        name: 'Renamed',
        nodes: [...current.nodes, node('Boom copy', 'test.fail', {}, [400, 0])],
      }),
    );
    expect(copied.name).toBe('Renamed');

    // a new blocked type is refused, and a disabled node counts
    const added = await client.patch(`/rest/workflows/${old.id}`, {
      versionId: copied.versionId,
      nodes: [...copied.nodes, node('Nothing', 'core.noOp', {}, [600, 0], { disabled: true })],
    });
    expect(added.statusCode).toBe(403);
    expect(added.json().error.message).toBe('Node type "core.noOp" is blocked by a workspace policy');
    const stored = await server.ctx.repos.workflows.get(tenant.id, old.id);
    expect(((stored?.nodes ?? []) as Array<{ type: string }>).map((n) => n.type)).not.toContain('core.noOp');
  });

  it('the store failing at a save is 503 policy_check_failed and nothing is written', async () => {
    const { client, tenant } = await newMember();
    await server.ctx.policySnapshots.invalidate(tenant.id);
    vi.spyOn(server.ctx.repos.typePolicies, 'loadTenant').mockRejectedValue(new Error('database down'));
    const res = await client.post('/rest/workflows', {
      name: 'Blocked by a failure',
      nodes: [node('Start', 'core.manualTrigger')],
      connections: {},
    });
    expect(res.statusCode).toBe(503);
    expect(res.json().error).toEqual({
      code: 'policy_check_failed',
      message: 'Could not verify policy for workflowSave, so the action was blocked',
    });
    vi.restoreAllMocks();
    const list = await client.data(client.get('/rest/workflows'));
    expect(JSON.stringify(list)).not.toContain('Blocked by a failure');
  });
});

describe('publish', () => {
  it('judges the whole workflow: an old workflow with a blocked type refuses to publish', async () => {
    const { client, tenant } = await newMember();
    const wf = await createWorkflow(client, {
      nodes: [node('Interval', 'test.interval'), setNode('Set', 'a', 1)],
      connections: chain('Interval', 'Set'),
    });
    await policyDeny(server, tenant.id, 'node', 'core.set');
    const res = await client.post(`/rest/workflows/${wf.id}/activate`);
    expect(res.statusCode).toBe(403);
    expect(res.json().error.code).toBe('policy_violation');
    expect(res.json().error.message).toBe('Node type "core.set" is blocked by a workspace policy');
    expect((await server.ctx.repos.workflows.get(tenant.id, wf.id))?.active).toBe(false);
    expect((await auditOf(tenant.id)).map((row) => row.metadata)).toEqual([
      expect.objectContaining({ point: 'workflowPublish', type: 'core.set' }),
    ]);
  });
});

describe('credentials', () => {
  it('a create of a blocked type is refused; an edit of an existing one is kept', async () => {
    const { client, tenant, projectId } = await newMember();
    const existing = await credentialIn(server, tenant.id, projectId, { type: 'testApi' });
    await policyDeny(server, tenant.id, 'credential', 'testApi');
    const created = await client.post('/rest/credentials', {
      name: 'New key',
      type: 'testApi',
      data: { apiKey: 'k' },
    });
    expect(created.statusCode).toBe(403);
    expect(created.json().error.message).toBe('Credential type "testApi" is blocked by a workspace policy');
    expect(created.json().error.details.violations[0]).toMatchObject({
      kind: 'credential-type-unavailable',
      type: 'testApi',
    });
    const edited = await client.patch(`/rest/credentials/${existing.id}`, { name: 'Renamed key' });
    expect(edited.statusCode).toBe(200);
    expect((await auditOf(tenant.id)).map((row) => row.metadata)).toEqual([
      expect.objectContaining({ point: 'credentialSave', type: 'testApi', scope: 'workspace' }),
    ]);
  });

  it('an `extends` rule covers the children of a credential type', async () => {
    const { tenant, projectId } = await newOwner();
    const deps = server.ctx.serviceDeps;
    await attach(tenant.id, 'credential', [
      { id: randomUUID(), action: 'deny', selector: { extends: 'oAuth2Api' } },
    ]);
    const error = await errorOf(
      assertCredentialType(deps, 'credentialSave', {
        tenantId: tenant.id,
        projectId,
        type: 'testPkceOAuth2Api',
        isNew: true,
      }),
    );
    expect(error).toBeInstanceOf(PolicyViolationError);
    await expect(
      assertCredentialType(deps, 'credentialSave', {
        tenantId: tenant.id,
        projectId,
        type: 'testPkceOAuth2Api',
        isNew: false,
      }),
    ).resolves.toBe(undefined);
    await expect(
      assertCredentialType(deps, 'credentialSave', {
        tenantId: tenant.id,
        projectId,
        type: 'testApi',
        isNew: true,
      }),
    ).resolves.toBe(undefined);
    // a move or a decrypt judges an existing credential too
    expect(
      await errorOf(
        assertCredentialType(deps, 'credentialDecrypt', {
          tenantId: tenant.id,
          projectId,
          type: 'testPkceOAuth2Api',
        }),
      ),
    ).toBeInstanceOf(PolicyViolationError);
  });
});

describe('a single node (options loading)', () => {
  const optionsBody = (workflowId: string) => ({
    nodeType: 'p6enforce.options',
    method: 'list',
    kind: 'loadOptions',
    node: node('Options probe', 'p6enforce.options', {}, [0, 0], {
      credentials: { p6EnforceApi: { id: randomUUID(), name: 'probe' } },
    }),
    workflowId,
  });

  it('is refused before any decrypt when its credential type or its node type is blocked', async () => {
    const { client, tenant } = await newMember();
    const wf = await createWorkflow(client, { nodes: [] });
    // allowed: the method runs (and fails), which is what a refusal must prevent
    optionCalls = 0;
    const allowed = await client.post('/rest/node-types/options', optionsBody(wf.id));
    expect(allowed.statusCode).toBe(400);
    expect(optionCalls).toBe(1);

    const build = vi.spyOn(server.ctx.executions, 'buildServices');
    await policyDeny(server, tenant.id, 'credential', 'p6EnforceApi');
    const credential = await client.post('/rest/node-types/options', optionsBody(wf.id));
    expect(credential.statusCode).toBe(403);
    expect(credential.json().error.message).toBe(
      'Credential type "p6EnforceApi" is blocked by a workspace policy',
    );

    const other = await newMember();
    const otherWf = await createWorkflow(other.client, { nodes: [] });
    await policyDeny(server, other.tenant.id, 'node', 'p6enforce.options');
    const nodeType = await other.client.post('/rest/node-types/options', optionsBody(otherWf.id));
    expect(nodeType.statusCode).toBe(403);
    expect(nodeType.json().error.message).toBe(
      'Node type "p6enforce.options" is blocked by a workspace policy',
    );
    expect(build).not.toHaveBeenCalled();
    expect(optionCalls).toBe(1);
    expect((await auditOf(tenant.id)).map((row) => row.metadata)).toEqual([
      expect.objectContaining({ point: 'credentialDecrypt', type: 'p6EnforceApi' }),
    ]);
  });

  it('checkSingleNode judges the node type and every credential type', async () => {
    const { tenant, projectId } = await newOwner();
    const deps = server.ctx.serviceDeps;
    await policyDeny(server, tenant.id, 'credential', 'testApi');
    const error = await errorOf(
      checkSingleNode(deps, {
        tenantId: tenant.id,
        projectId,
        nodeType: 'test.useCredential',
        credentialTypes: ['oAuth2Api', 'testApi'],
      }),
    );
    expect(error).toBeInstanceOf(PolicyViolationError);
    expect((error as PolicyViolationError).violations.map((v) => v.type)).toEqual(['testApi']);
    await expect(
      checkSingleNode(deps, {
        tenantId: tenant.id,
        projectId,
        nodeType: 'test.useCredential',
        credentialTypes: [],
      }),
    ).resolves.toBe(undefined);
  });
});

describe('the check', () => {
  it('a deadline miss blocks: 250 ms at start and decrypt, 1000 ms at a save', async () => {
    const deps = server.ctx.serviceDeps;
    const repo = server.ctx.repos.typePolicies;
    const workflow = { nodes: [node('Start', 'core.manualTrigger')] };
    const original = repo.loadTenant.bind(repo);
    const slow = (ms: number) =>
      vi.spyOn(repo, 'loadTenant').mockImplementation((id) => delayed(ms, () => original(id)));

    const a = await newOwner();
    slow(400);
    const start = await errorOf(
      evaluateWorkflow(deps, 'workflowStart', { tenantId: a.tenant.id, projectId: a.projectId, workflow }),
    );
    expect(start).toBeInstanceOf(PolicyCheckFailedError);
    expect((start as PolicyCheckFailedError).point).toBe('workflowStart');
    const b = await newOwner();
    const decrypt = await errorOf(
      checkSingleNode(deps, {
        tenantId: b.tenant.id,
        projectId: b.projectId,
        nodeType: 'core.set',
        credentialTypes: [],
      }),
    );
    expect(decrypt).toBeInstanceOf(PolicyCheckFailedError);

    // 400 ms is within a save's 1000 ms
    const c = await newOwner();
    await expect(
      evaluateWorkflow(deps, 'workflowSave', {
        tenantId: c.tenant.id,
        projectId: c.projectId,
        workflow,
        stored: null,
      }),
    ).resolves.toBe(undefined);
    vi.restoreAllMocks();
    slow(1300);
    const d = await newOwner();
    const save = await errorOf(
      evaluateWorkflow(deps, 'workflowSave', {
        tenantId: d.tenant.id,
        projectId: d.projectId,
        workflow,
        stored: null,
      }),
    );
    expect(save).toBeInstanceOf(PolicyCheckFailedError);
    expect((save as PolicyCheckFailedError).statusCode).toBe(503);
  });

  it('a check that throws blocks (never passes), at every point', async () => {
    const { tenant, projectId } = await newOwner();
    const deps = server.ctx.serviceDeps;
    await server.ctx.policySnapshots.invalidate(tenant.id);
    vi.spyOn(server.ctx.repos.typePolicies, 'loadTenant').mockRejectedValue(new Error('boom'));
    const workflow = { nodes: [node('Set', 'core.set')] };
    for (const point of ['workflowSave', 'workflowPublish', 'workflowStart', 'contentImport'] as const) {
      const error = await errorOf(
        evaluateWorkflow(deps, point, { tenantId: tenant.id, projectId, workflow }),
      );
      expect(error).toBeInstanceOf(PolicyCheckFailedError);
      expect((error as PolicyCheckFailedError).message).toBe(
        `Could not verify policy for ${point}, so the action was blocked`,
      );
    }
    expect(
      await errorOf(
        assertCredentialType(deps, 'credentialSave', {
          tenantId: tenant.id,
          projectId,
          type: 'testApi',
          isNew: true,
        }),
      ),
    ).toBeInstanceOf(PolicyCheckFailedError);
    expect(
      await errorOf(assertTransferAllowed(deps, tenant.id, projectId, { kind: 'workflow', workflow })),
    ).toBeInstanceOf(PolicyCheckFailedError);
  });

  it("another workspace's policy has no effect", async () => {
    const mine = await newOwner();
    const theirs = await newOwner();
    await policyDeny(server, theirs.tenant.id, 'node', 'test.fail');
    await policyDeny(server, theirs.tenant.id, 'credential', 'testApi');
    const deps = server.ctx.serviceDeps;
    const workflow = {
      nodes: [
        node('Boom', 'test.fail', {}, [0, 0], { credentials: { testApi: { id: randomUUID(), name: 'k' } } }),
      ],
    };
    await expect(
      evaluateWorkflow(deps, 'workflowStart', {
        tenantId: mine.tenant.id,
        projectId: mine.projectId,
        workflow,
      }),
    ).resolves.toBe(undefined);
    await expect(restrictedTypes(deps, mine.tenant.id, mine.projectId, 'node')).resolves.toEqual([]);
    const created = await mine.client.post('/rest/workflows', {
      name: 'Mine',
      nodes: workflow.nodes,
      connections: {},
    });
    expect(created.statusCode).toBe(200);
    expect(
      await errorOf(
        evaluateWorkflow(deps, 'workflowStart', {
          tenantId: theirs.tenant.id,
          projectId: theirs.projectId,
          workflow,
        }),
      ),
    ).toBeInstanceOf(PolicyViolationError);
  });

  it('start, publish, transfer and import judge node and credential types of the whole workflow', async () => {
    const { tenant, projectId } = await newOwner();
    const deps = server.ctx.serviceDeps;
    await policyDeny(server, tenant.id, 'node', 'test.fail');
    await policyDeny(server, tenant.id, 'credential', 'testApi');
    const workflow = {
      nodes: [
        node('Start', 'core.manualTrigger'),
        node('Use', 'test.useCredential', {}, [200, 0], {
          credentials: { testApi: { id: randomUUID(), name: 'k' } },
        }),
        node('Boom', 'test.fail', {}, [400, 0], { disabled: true }),
      ],
    };
    for (const point of ['workflowStart', 'workflowPublish', 'workflowTransfer', 'contentImport'] as const) {
      const error = (await errorOf(
        evaluateWorkflow(deps, point, { tenantId: tenant.id, projectId, workflow }),
      )) as PolicyViolationError;
      expect(error).toBeInstanceOf(PolicyViolationError);
      expect(error.message).toBe(
        'Blocked by policy: Node type "test.fail" is blocked by a workspace policy; Credential type "testApi" is blocked by a workspace policy',
      );
      expect(error.violations).toEqual([
        expect.objectContaining({ kind: 'node-type-unavailable', type: 'test.fail', nodeName: 'Boom' }),
        expect.objectContaining({ kind: 'credential-type-unavailable', type: 'testApi', nodeName: 'Use' }),
      ]);
    }
    const transfer = await errorOf(
      assertTransferAllowed(deps, tenant.id, projectId, { kind: 'workflow', workflow }),
    );
    expect(transfer).toBeInstanceOf(PolicyViolationError);
    const credential = await errorOf(
      assertTransferAllowed(deps, tenant.id, projectId, { kind: 'credential', credentialType: 'testApi' }),
    );
    expect(credential).toBeInstanceOf(PolicyViolationError);
    // a save judges only what it adds, and no credential type
    await expect(
      evaluateWorkflow(deps, 'workflowSave', { tenantId: tenant.id, projectId, workflow, stored: workflow }),
    ).resolves.toBe(undefined);
    const points = (await auditOf(tenant.id)).map((row) => (row.metadata as { point: string }).point).sort();
    expect(points).toEqual(
      [
        'contentImport',
        'credentialTransfer',
        'workflowPublish',
        'workflowStart',
        'workflowTransfer',
        'workflowTransfer',
      ].sort(),
    );
  });
});

describe('available and restricted types', () => {
  it('filterAvailable and restrictedTypes name the blocked types with the violation text', async () => {
    const { tenant, projectId } = await newOwner();
    const deps = server.ctx.serviceDeps;
    await policyDeny(server, tenant.id, 'node', 'test.fail');
    await policyDeny(server, tenant.id, 'node', 'not.loaded');
    await policyDeny(server, tenant.id, 'credential', 'testApi');
    const available = await filterAvailable(deps, tenant.id, projectId, 'node', ['core.set', 'test.fail']);
    expect(available).toEqual([
      { type: 'core.set', available: true },
      {
        type: 'test.fail',
        available: false,
        reason: 'Node type "test.fail" is blocked by a workspace policy',
        scope: 'workspace',
        optInAvailable: false,
      },
    ]);
    await expect(restrictedTypes(deps, tenant.id, projectId, 'node')).resolves.toEqual([
      'not.loaded',
      'test.fail',
    ]);
    await expect(restrictedTypes(deps, tenant.id, null, 'credential')).resolves.toEqual(['testApi']);
  });

  it('a name rule on a base node blocks its tool variant; a deny-all default blocks every type', async () => {
    const { tenant, projectId } = await newOwner();
    const deps = server.ctx.serviceDeps;
    const variant = server.ctx.registries.nodeTypes
      .list()
      .map((type) => type.description.name)
      .find(
        (name) => name.endsWith('Tool') && server.ctx.registries.nodeTypes.get(name.slice(0, -'Tool'.length)),
      );
    expect(variant).toBeDefined();
    const base = (variant as string).slice(0, -'Tool'.length);
    await policyDeny(server, tenant.id, 'node', base);
    const [row] = await filterAvailable(deps, tenant.id, projectId, 'node', [variant as string]);
    expect(row.available).toBe(false);
    expect(await restrictedTypes(deps, tenant.id, projectId, 'node')).toEqual(
      expect.arrayContaining([base, variant]),
    );

    const other = await newOwner();
    const scope = await server.ctx.typePolicies.getScope(other.tenant.id, 'node', null);
    await server.ctx.typePolicies.putScope(
      other.tenant.id,
      'node',
      null,
      { defaultAction: 'deny' },
      scope.version,
    );
    const error = await errorOf(
      evaluateWorkflow(deps, 'workflowStart', {
        tenantId: other.tenant.id,
        projectId: other.projectId,
        workflow: { nodes: [node('Start', 'core.manualTrigger')] },
      }),
    );
    expect((error as PolicyViolationError).violations).toEqual([
      expect.objectContaining({ type: 'core.manualTrigger', matchedRuleId: null, scope: 'workspace' }),
    ]);
  });
});
