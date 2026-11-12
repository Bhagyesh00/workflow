/**
 * P6 S3 (C0c1): the service contracts of commit 0. Config (NODES_*, DEPRECATED_NODES_BLOCK,
 * SECURITY_AUDIT_*, INSIGHTS_*, PUBLIC_API_RATE_LIMIT_*), the four workflow settings, the policy errors'
 * codes and texts, the FULL `computeTimeSavedMinutes` and `insightRunOf`, the context's new services and
 * repositories, every stub with a pass rule passing, a credential create failing closed before
 * `setPolicyDeps`, and a save, a run, a read and a credential create behaving as before with every stub in
 * place.
 */
import { randomUUID } from 'node:crypto';
import { nodesBasePackage } from '@workflow/nodes-base';
import type { ExecutionState, RunData, TaskData, WorkflowSettings } from '@workflow/workflow';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { ExecutionRow } from '../src/db/schema';
import { settingsSchema } from '../src/http/schemas';
import { buildRegistries } from '../src/node-packages';
import { DependencyRepository } from '../src/repositories/dependencies';
import { InsightsRepository } from '../src/repositories/insights';
import { PublicIdempotencyRepository } from '../src/repositories/public-idempotency';
import { SecurityAuditRepository } from '../src/repositories/security-audit';
import { TypePolicyRepository } from '../src/repositories/type-policies';
import { CollaborationService } from '../src/services/collaboration';
import { CredentialService } from '../src/services/credentials';
import { DependencyService } from '../src/services/dependencies';
import { assertNoDeprecatedNodes, assertNoNewDeprecatedNodes } from '../src/services/deprecated-nodes';
import { InsightsCollector } from '../src/services/insights/collector';
import { InsightsCompaction } from '../src/services/insights/compaction';
import { insightRunOf, MAX_INSIGHT_RUNTIME_MS } from '../src/services/insights/rules';
import { computeTimeSavedMinutes } from '../src/services/insights/time-saved';
import { RateLimitSettingsService } from '../src/services/public-api-rate-limit';
import {
  assertRedactionChange,
  pushableError,
  pushableTaskData,
  seedRedactionSettings,
  snapshotRedaction,
} from '../src/services/redaction/policy';
import { redactExecution, redactSummaries } from '../src/services/redaction/read';
import { composeDecisions } from '../src/services/type-policies/compose';
import {
  assertCredentialType,
  assertTransferAllowed,
  checkSingleNode,
  evaluateWorkflow,
  filterAvailable,
  restrictedTypes,
} from '../src/services/type-policies/enforce';
import {
  PolicyCheckFailedError,
  PolicyViolationError,
  violationMessage,
} from '../src/services/type-policies/errors';
import { buildPackageIndex } from '../src/services/type-policies/package-index';
import { PolicySnapshots } from '../src/services/type-policies/snapshot';
import { TypePolicyStore } from '../src/services/type-policies/store';
import { policyIssues, restrictedNodeTypesView } from '../src/services/type-policies/tool-filter';
import {
  ENFORCEMENT_DEADLINE_MS,
  type TypeDecision,
  type TypePolicyViolation,
} from '../src/services/type-policies/types';
import {
  chain,
  createTestServer,
  createWorkflow,
  credentialIn,
  node,
  setNode,
  signup,
  type TestServer,
  teamProjectOf,
  testConfig,
  waitForExecution,
} from './helpers';

let server: TestServer;

beforeAll(async () => {
  server = await createTestServer();
}, 120_000);

afterAll(async () => {
  await server?.close();
});

let signups = 0;
/** a new workspace from its own IP (signup allows 20 an hour per IP) */
const newOwner = () => {
  signups++;
  return signup(server.app, { remoteAddress: `10.96.${signups >> 8}.${signups & 255}` });
};

const violation = (over: Partial<TypePolicyViolation> = {}): TypePolicyViolation => ({
  kind: 'node-type-unavailable',
  type: 'core.code',
  scope: 'workspace',
  matchedRuleId: null,
  optInAvailable: false,
  ...over,
});

function executionRow(over: Partial<ExecutionRow> = {}): ExecutionRow {
  return {
    id: randomUUID(),
    tenantId: randomUUID(),
    workflowId: randomUUID(),
    workflowName: 'Orders',
    mode: 'webhook',
    status: 'running',
    startedAt: new Date('2026-11-01T10:00:00Z'),
    stoppedAt: null,
    waitTill: null,
    retryOf: null,
    retrySuccessId: null,
    parentExecutionId: null,
    customData: {},
    errorMessage: null,
    errorNode: null,
    workflowVersionId: null,
    createdAt: new Date('2026-11-01T09:59:59Z'),
    usedPrivateCredentials: false,
    tracingContext: null,
    ...over,
  };
}

const task = (metadata?: TaskData['metadata']): TaskData => ({
  startTime: 0,
  executionTime: 1,
  executionStatus: 'success',
  source: [],
  ...(metadata ? { metadata } : {}),
});

describe('config', () => {
  it('has the S3 defaults', () => {
    const config = testConfig();
    expect(config.nodes).toEqual({ exclude: [], include: [] });
    expect(config.deprecatedNodesBlock).toBe(true);
    expect(config.securityAudit).toEqual({ daysAbandonedWorkflow: 90 });
    expect(config.insights).toEqual({
      compactionIntervalMinutes: 60,
      compactionBatchSize: 500,
      compactionHourlyToDailyThresholdDays: 90,
      compactionDailyToWeeklyThresholdDays: 180,
      flushBatchSize: 1000,
      flushIntervalSeconds: 30,
      maxAgeDays: 365,
      pruneCheckIntervalHours: 24,
      compactionMaxBatchesPerRun: 1000,
      compactionMaxRuntimeSeconds: 300,
      compactionBatchDelayMilliseconds: 100,
    });
    expect(config.publicApiRateLimit).toEqual({
      enabled: false,
      globalReadLimit: 1200,
      globalReadWindow: 60,
      globalWriteLimit: 600,
      globalWriteWindow: 60,
      endpointReadLimit: 1000,
      endpointReadWindow: 60,
      endpointWriteLimit: 500,
      endpointWriteWindow: 60,
    });
  });

  it('reads NODES_EXCLUDE and NODES_INCLUDE as JSON arrays; bad JSON gives an empty list', () => {
    const config = testConfig({ NODES_EXCLUDE: '["core.code", "core.ssh"]', NODES_INCLUDE: '["core.set"]' });
    expect(config.nodes).toEqual({ exclude: ['core.code', 'core.ssh'], include: ['core.set'] });
    expect(testConfig({ NODES_EXCLUDE: '[core.code' }).nodes.exclude).toEqual([]);
    expect(testConfig({ NODES_EXCLUDE: '{"a":1}' }).nodes.exclude).toEqual([]);
    expect(testConfig({ NODES_EXCLUDE: '' }).nodes.exclude).toEqual([]);
  });

  it('bounds INSIGHTS_MAX_AGE_DAYS as n8n', () => {
    const age = (v: string) => testConfig({ INSIGHTS_MAX_AGE_DAYS: v }).insights.maxAgeDays;
    expect(age('-1')).toBe(730);
    expect(age('1000')).toBe(730);
    expect(age('0')).toBe(365);
    expect(age('-5')).toBe(365);
    expect(age('abc')).toBe(365);
    expect(age('30')).toBe(30);
  });

  it('reads the switches and the rate limit defaults', () => {
    const config = testConfig({
      DEPRECATED_NODES_BLOCK: 'false',
      SECURITY_AUDIT_DAYS_ABANDONED_WORKFLOW: '30',
      PUBLIC_API_RATE_LIMIT_ENABLED: 'true',
      PUBLIC_API_RATE_LIMIT_ENDPOINT_WRITE_LIMIT: '0',
    });
    expect(config.deprecatedNodesBlock).toBe(false);
    expect(config.securityAudit.daysAbandonedWorkflow).toBe(30);
    expect(config.publicApiRateLimit.enabled).toBe(true);
    expect(config.publicApiRateLimit.endpointWriteLimit).toBe(0);
  });
});

describe('workflow settings', () => {
  it('takes the four S3 fields and refuses bad values', () => {
    const ok = settingsSchema.parse({
      timeSavedMode: 'dynamic',
      timeSavedPerExecution: 5,
      redactionPolicy: 'non-manual',
      redactCallerExecutions: false,
    });
    expect(ok).toMatchObject({
      timeSavedMode: 'dynamic',
      timeSavedPerExecution: 5,
      redactionPolicy: 'non-manual',
    });
    expect(settingsSchema.safeParse({ timeSavedPerExecution: -1 }).success).toBe(false);
    expect(settingsSchema.safeParse({ timeSavedPerExecution: 1.5 }).success).toBe(false);
    expect(settingsSchema.safeParse({ timeSavedMode: 'hourly' }).success).toBe(false);
    expect(settingsSchema.safeParse({ redactionPolicy: 'some' }).success).toBe(false);
    expect(settingsSchema.safeParse({ redactCallerExecutions: 'yes' }).success).toBe(false);
  });
});

describe('policy errors', () => {
  it('PolicyViolationError is 403 policy_violation with the violations in details', () => {
    const v = violation();
    const error = new PolicyViolationError([v]);
    expect(error.statusCode).toBe(403);
    expect(error.code).toBe('policy_violation');
    expect(error.details).toEqual({ violations: [v] });
    expect(error.message).toBe('Node type "core.code" is blocked by a workspace policy');
  });

  it('names the scope and the kind, never the project; several are joined', () => {
    expect(violationMessage([violation({ scope: 'project' })])).toBe(
      'Node type "core.code" is blocked by a project policy',
    );
    const credential = violation({ kind: 'credential-type-unavailable', type: 'slackApi' });
    expect(violationMessage([credential])).toBe(
      'Credential type "slackApi" is blocked by a workspace policy',
    );
    expect(violationMessage([violation(), credential])).toBe(
      'Blocked by policy: Node type "core.code" is blocked by a workspace policy; ' +
        'Credential type "slackApi" is blocked by a workspace policy',
    );
  });

  it('PolicyCheckFailedError is 503 and names the point', () => {
    const error = new PolicyCheckFailedError('workflowPublish', new Error('store down'));
    expect(error.statusCode).toBe(503);
    expect(error.code).toBe('policy_check_failed');
    expect(error.message).toBe('Could not verify policy for workflowPublish, so the action was blocked');
    expect(error.details).toBeUndefined();
  });

  it('has the deadlines of n8n: 250 ms at start and decrypt, else 1000 ms', () => {
    expect(ENFORCEMENT_DEADLINE_MS.workflowStart).toBe(250);
    expect(ENFORCEMENT_DEADLINE_MS.credentialDecrypt).toBe(250);
    expect(ENFORCEMENT_DEADLINE_MS.workflowSave).toBe(1000);
    expect(ENFORCEMENT_DEADLINE_MS.contentImport).toBe(1000);
  });
});

describe('computeTimeSavedMinutes', () => {
  const runData: RunData = {
    A: [task({ timeSaved: { minutes: 2 } }), task({ timeSaved: { minutes: 3 } })],
    B: [task({ timeSaved: { minutes: 4 } }), task()],
    C: [task({ timeSaved: { minutes: 'x' } })],
  };

  it('fixed: the workflow setting, 0 when unset, not multiplied by items', () => {
    expect(computeTimeSavedMinutes({ timeSavedPerExecution: 5 }, runData, 'success', 'webhook')).toBe(5);
    expect(
      computeTimeSavedMinutes({ timeSavedMode: 'fixed', timeSavedPerExecution: 7 }, {}, 'success', 'trigger'),
    ).toBe(7);
    expect(computeTimeSavedMinutes({}, runData, 'success', 'cli')).toBe(0);
    expect(computeTimeSavedMinutes(undefined, undefined, 'success', 'retry')).toBe(0);
  });

  it("dynamic: the sum of the nodes' timeSaved minutes, 0 when none", () => {
    expect(computeTimeSavedMinutes({ timeSavedMode: 'dynamic' }, runData, 'success', 'webhook')).toBe(9);
    expect(computeTimeSavedMinutes({ timeSavedMode: 'dynamic' }, {}, 'success', 'evaluation')).toBe(0);
    expect(computeTimeSavedMinutes({ timeSavedMode: 'dynamic' }, null, 'success', 'webhook')).toBe(0);
  });

  it('a manual, chat, sub-workflow or error workflow run saves none; a failed run saves none', () => {
    const settings: WorkflowSettings = { timeSavedPerExecution: 5 };
    for (const mode of ['manual', 'chat', 'integrated', 'internal', 'error'] as const) {
      expect(computeTimeSavedMinutes(settings, runData, 'success', mode)).toBeUndefined();
    }
    for (const status of ['error', 'crashed', 'canceled', 'waiting'] as const) {
      expect(computeTimeSavedMinutes(settings, runData, status, 'webhook')).toBeUndefined();
    }
  });
});

describe('insightRunOf', () => {
  it('builds a success from the row, the definition and the outcome, with no read and no copy', () => {
    const row = executionRow();
    const runData: RunData = { A: [task()] };
    const run = insightRunOf(
      row,
      { name: 'Definition name', settings: { timeSavedPerExecution: 3 } },
      { status: 'success', runData },
      1234.4,
    );
    expect(run).toEqual({
      tenantId: row.tenantId,
      workflowId: row.workflowId,
      workflowName: 'Orders',
      mode: 'webhook',
      status: 'success',
      startedAt: row.startedAt,
      endedAt: expect.any(Date),
      runtimeMs: 1234,
      settings: { timeSavedPerExecution: 3 },
      runData,
    });
    expect(run.runData).toBe(runData);
    expect(run).not.toHaveProperty('projectId');
  });

  it('builds a crash: no run data, the start falls back to createdAt, the runtime clamped', () => {
    const row = executionRow({ startedAt: null, workflowName: '', workflowId: null });
    const run = insightRunOf(row, { name: 'Inline' }, { status: 'crashed' }, -50);
    expect(run).toMatchObject({
      status: 'crashed',
      runData: null,
      startedAt: row.createdAt,
      runtimeMs: 0,
      workflowName: 'Inline',
      workflowId: null,
      settings: {},
    });
    expect(insightRunOf(row, { name: 'x' }, { status: 'error' }, 2 ** 40).runtimeMs).toBe(
      MAX_INSIGHT_RUNTIME_MS,
    );
    expect(insightRunOf(row, { name: 'x' }, { status: 'error' }, Number.NaN).runtimeMs).toBe(0);
  });
});

describe('context', () => {
  it('holds the S3 services, the repositories and serviceDeps', () => {
    const { ctx } = server;
    expect(ctx.serviceDeps.context()).toBe(ctx);
    expect(ctx.typePolicies).toBeInstanceOf(TypePolicyStore);
    expect(ctx.policySnapshots).toBeInstanceOf(PolicySnapshots);
    expect(ctx.insights).toBeInstanceOf(InsightsCollector);
    expect(ctx.insightsCompaction).toBeInstanceOf(InsightsCompaction);
    expect(ctx.collaboration).toBeInstanceOf(CollaborationService);
    expect(ctx.dependencies).toBeInstanceOf(DependencyService);
    expect(ctx.rateLimitSettings).toBeInstanceOf(RateLimitSettingsService);
    expect(ctx.repos.typePolicies).toBeInstanceOf(TypePolicyRepository);
    expect(ctx.repos.insights).toBeInstanceOf(InsightsRepository);
    expect(ctx.repos.publicIdempotency).toBeInstanceOf(PublicIdempotencyRepository);
    expect(ctx.repos.securityAudit).toBeInstanceOf(SecurityAuditRepository);
    expect(ctx.repos.dependencies).toBeInstanceOf(DependencyRepository);
    expect(ctx.policySnapshots.packageIndex.nodes).toBeInstanceOf(Map);
  });

  it('a second context starts as a main and closes with every stub, each twice', async () => {
    const other = await createTestServer({}, { reset: false, startMain: false });
    await other.ctx.startMain();
    await other.ctx.startMain();
    await other.close();
    await other.ctx.close();
  });

  it('buildRegistries takes the node lists', () => {
    const registries = buildRegistries([nodesBasePackage], { exclude: [], include: [] });
    expect(registries.nodeTypes.get('core.set')).toBeDefined();
    expect(buildPackageIndex([nodesBasePackage]).credentials).toBeInstanceOf(Map);
  });
});

/**
 * Each seam is called as the C0d parts wire it, on a workspace with no policy, no floor, no lock and nothing
 * redacted, so the assertions hold for the C0 stubs and for the lanes' real code alike.
 */
describe('pass seams', () => {
  it('the type policy checks pass with no policy', async () => {
    const owner = await newOwner();
    const tenantId = owner.tenant.id;
    const projectId = await teamProjectOf(server, tenantId);
    const deps = server.ctx.serviceDeps;
    const workflow = { nodes: [node('Code', 'core.code'), setNode('Set', 'a', 'b')] };
    await expect(evaluateWorkflow(deps, 'workflowStart', { tenantId, projectId, workflow })).resolves.toBe(
      undefined,
    );
    await expect(
      evaluateWorkflow(deps, 'workflowSave', { tenantId, projectId, workflow, stored: { nodes: [] } }),
    ).resolves.toBe(undefined);
    await expect(
      assertCredentialType(deps, 'credentialSave', { tenantId, projectId, type: 'testApi', isNew: true }),
    ).resolves.toBe(undefined);
    const available = await filterAvailable(deps, tenantId, projectId, 'node', ['core.set', 'core.code']);
    expect(available).toMatchObject([
      { type: 'core.set', available: true },
      { type: 'core.code', available: true },
    ]);
    await expect(restrictedTypes(deps, tenantId, projectId, 'node')).resolves.toEqual([]);
    await expect(restrictedTypes(deps, tenantId, null, 'credential')).resolves.toEqual([]);
    await expect(
      assertTransferAllowed(deps, tenantId, projectId, { kind: 'workflow', workflow }),
    ).resolves.toBe(undefined);
    await expect(
      assertTransferAllowed(deps, tenantId, projectId, { kind: 'credential', credentialType: 'testApi' }),
    ).resolves.toBe(undefined);
    await expect(
      checkSingleNode(deps, { tenantId, projectId, nodeType: 'core.code', credentialTypes: ['testApi'] }),
    ).resolves.toBe(undefined);
    const allow: TypeDecision = {
      action: 'allow',
      matchedRuleId: null,
      scope: 'workspace',
      optInAvailable: false,
    };
    expect(composeDecisions(allow, { ...allow, scope: 'project' }).action).toBe('allow');
    await expect(policyIssues(deps, tenantId, projectId, workflow)).resolves.toEqual([]);
    const view = await restrictedNodeTypesView(deps, tenantId, projectId, server.ctx.registries.nodeTypes);
    expect(view.get('core.code')).toBeDefined();
  });

  it('the deprecated node checks pass for a node that is not deprecated', async () => {
    const deps = server.ctx.serviceDeps;
    const nodes = [node('Set', 'core.set')];
    await expect(assertNoNewDeprecatedNodes(deps, { next: { nodes }, stored: null })).resolves.toBe(
      undefined,
    );
    await expect(assertNoNewDeprecatedNodes(deps, { next: { nodes }, stored: { nodes } })).resolves.toBe(
      undefined,
    );
    await expect(assertNoDeprecatedNodes(deps, nodes)).resolves.toBe(undefined);
  });

  it('the redaction seams pass with no floor and no policy', async () => {
    const owner = await newOwner();
    const tenantRow = await server.ctx.repos.tenants.get(owner.tenant.id);
    if (!tenantRow) throw new Error('no tenant row');
    const deps = server.ctx.serviceDeps;
    await expect(
      assertRedactionChange(deps, { tenantId: tenantRow.id, userId: owner.user.id }, null, undefined, {}),
    ).resolves.toBe(undefined);
    await expect(assertRedactionChange(deps, { tenantId: tenantRow.id }, null, {}, {})).resolves.toBe(
      undefined,
    );
    const settings: WorkflowSettings = { saveManualExecutions: true };
    await expect(seedRedactionSettings(deps, tenantRow, settings)).resolves.toMatchObject(settings);
    const snapshot = await snapshotRedaction(deps, tenantRow, { settings: {} });
    expect(snapshot?.manual ?? false).toBe(false);
    expect(snapshot?.production ?? false).toBe(false);
    const taskData = task();
    const state = { resultData: { runData: {} } } as unknown as ExecutionState;
    expect(pushableTaskData(snapshot, taskData, state)).toEqual(taskData);
    const error = { name: 'Error', message: 'boom' };
    expect(pushableError(snapshot, error, state)).toEqual(error);
  });

  it('a read of a run with nothing redacted keeps its data', async () => {
    const owner = await newOwner();
    const workflow = await createWorkflow(owner.client, {
      nodes: [node('Start', 'core.manualTrigger'), setNode('Mark', 'done', 'yes')],
      connections: chain('Start', 'Mark'),
    });
    const { executionId } = await owner.client.data<{ executionId: string }>(
      owner.client.post(`/rest/workflows/${workflow.id}/run`, {}),
    );
    const row = await waitForExecution(server.ctx, owner.tenant.id, executionId, ['success']);
    const data = await server.ctx.repos.executions.getData(owner.tenant.id, executionId);
    const viewer = { tenantId: owner.tenant.id, userId: owner.user.id };
    const read = await redactExecution(server.ctx.serviceDeps, viewer, row, data);
    expect(read.row.id).toBe(executionId);
    expect(read.data).toEqual(data);
    expect(read.redactionInfo?.isRedacted ?? false).toBe(false);
    const summaries = await redactSummaries(server.ctx.serviceDeps, viewer, [row]);
    expect(summaries.map((r) => r.id)).toEqual([executionId]);
  });

  it('the snapshots, the insights and the collaboration pass', async () => {
    const { ctx } = server;
    const tenantId = randomUUID();
    const snapshots = new PolicySnapshots(ctx.serviceDeps, ctx.policySnapshots.packageIndex);
    await expect(snapshots.start()).resolves.toBe(undefined);
    await expect(snapshots.invalidate(tenantId)).resolves.toBe(undefined);
    await expect(snapshots.stop()).resolves.toBe(undefined);
    // a manual run counts nothing, so the flush has nothing of this unknown workspace to write
    const run = insightRunOf(
      executionRow({ tenantId, mode: 'manual' }),
      { name: 'x' },
      { status: 'success' },
      10,
    );
    expect(ctx.insights.record(run)).toBeUndefined();
    await expect(ctx.insights.flush()).resolves.toBe(undefined);
    const collector = new InsightsCollector(ctx.serviceDeps);
    collector.start();
    await expect(collector.stop()).resolves.toBe(undefined);
    const compaction = new InsightsCompaction(ctx.serviceDeps);
    compaction.start();
    await expect(compaction.stop()).resolves.toBe(undefined);

    const c = ctx.collaboration;
    const workflowId = randomUUID();
    const user = { id: randomUUID(), email: 'a@example.com', firstName: 'A', lastName: 'B' };
    for (const state of [
      await c.opened(tenantId, workflowId, user, 'tab-1'),
      await c.heartbeat(tenantId, workflowId, user, 'tab-1'),
      await c.requestWrite(tenantId, workflowId, user, 'tab-1'),
      await c.release(tenantId, workflowId, user.id, 'tab-1'),
      await c.closed(tenantId, workflowId, user.id, 'tab-1'),
    ]) {
      expect(Array.isArray(state.collaborators)).toBe(true);
      expect(state).toHaveProperty('writeLock');
    }
    // no client id passes; no lock is held on another workflow
    await expect(c.assertWritable(user, undefined, workflowId, 'save')).resolves.toBe(undefined);
    await expect(c.assertNoLock(tenantId, randomUUID())).resolves.toBe(undefined);
    expect(c.workflowSaved(tenantId, workflowId, user.id)).toBeUndefined();
  });
});

describe('credentials', () => {
  it('a create fails closed before setPolicyDeps and writes nothing; after it, the create goes through', async () => {
    const owner = await newOwner();
    const projectId = await teamProjectOf(server, owner.tenant.id);
    const { ctx } = server;
    const service = new CredentialService(ctx.repos, ctx.cipher, ctx.registries.credentialTypes);
    const name = `Closed ${randomUUID().slice(0, 8)}`;
    const input = { name, type: 'testApi', data: { apiKey: 'secret' }, projectId };
    const refused = await service.create(owner.tenant.id, input).catch((e: unknown) => e);
    expect(refused).toBeInstanceOf(PolicyCheckFailedError);
    expect(refused).toMatchObject({
      statusCode: 503,
      message: 'Could not verify policy for credentialSave, so the action was blocked',
    });
    const rows = await ctx.repos.credentials.list(owner.tenant.id);
    expect(rows.some((r) => r.name === name)).toBe(false);

    service.setPolicyDeps(ctx.serviceDeps);
    const created = await service.create(owner.tenant.id, input);
    expect(created.name).toBe(name);
  });
});

describe('behaviour with every stub in place', () => {
  it('a save with the S3 settings, a manual run, a read and a credential create answer as before', async () => {
    const owner = await newOwner();
    const projectId = await teamProjectOf(server, owner.tenant.id);
    const workflow = await createWorkflow(owner.client, {
      name: 'S3 contracts',
      nodes: [node('Start', 'core.manualTrigger'), setNode('Mark', 'done', 'yes')],
      connections: chain('Start', 'Mark'),
      settings: { timeSavedMode: 'fixed', timeSavedPerExecution: 5, redactCallerExecutions: true },
    });
    const bad = await owner.client.post('/rest/workflows', {
      name: 'Bad',
      nodes: [node('Start', 'core.manualTrigger')],
      connections: {},
      settings: { timeSavedPerExecution: -1 },
    });
    expect(bad.statusCode).toBe(400);

    const { executionId } = await owner.client.data<{ executionId: string }>(
      owner.client.post(`/rest/workflows/${workflow.id}/run`, {}),
    );
    await waitForExecution(server.ctx, owner.tenant.id, executionId, ['success']);
    const read = await owner.client.get(`/rest/executions/${executionId}`);
    expect(read.statusCode).toBe(200);
    expect(read.json().data.status).toBe('success');

    const credential = await credentialIn(server, owner.tenant.id, projectId, { name: 'S3 credential' });
    expect(credential.type).toBe('testApi');
  });
});
