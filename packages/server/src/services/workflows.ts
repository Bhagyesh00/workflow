/**
 * Workflow CRUD with optimistic concurrency and version snapshots, manual runs, test webhook
 * listeners and version diffs.
 */
import { randomUUID } from 'node:crypto';
import { type ContextDeps, createPollContext, createTriggerContext, type NodeTypes } from '@workflow/core';
import {
  ExpressionEvaluator,
  type Item,
  sortByPosition,
  Workflow,
  type WorkflowDefinition,
  type WorkflowNode,
} from '@workflow/workflow';
import type { z } from 'zod';
import type { Config } from '../config';
import type { Database } from '../db/client';
import type { TenantRow, WorkflowRow } from '../db/schema';
import { ApiError } from '../http/errors';
import { decodeCursor, encodeCursor, page } from '../http/pagination';
import type {
  runSchema,
  workflowCreateSchema,
  workflowDataSchema,
  workflowUpdateSchema,
} from '../http/schemas';
import { createRepositories, type Repositories, type TagRef } from '../repositories';
import type { ActiveWorkflowManager, ValidationIssue } from './active-workflows';
import type { ExecutionService } from './executions';
import { TEST_WEBHOOK_TTL_MS, type TestWebhookStore } from './test-webhooks';
import { nodeWebhooks } from './webhook-paths';
import { cloneDefinition, toDefinition, toDTO, type WorkflowDTO } from './workflow-model';

type CreateInput = z.output<typeof workflowCreateSchema>;
type UpdateInput = z.output<typeof workflowUpdateSchema>;
type RunInput = z.output<typeof runSchema>;
type WorkflowData = z.output<typeof workflowDataSchema>;

export const MANUAL_TRIGGER = 'core.manualTrigger';
const MANUAL_TRIGGER_WAIT_MS = 10_000;

export interface Actor {
  userId?: string;
  ip?: string;
}

export interface WorkflowServiceDeps {
  config: Config;
  database: Database;
  repos: Repositories;
  nodeTypes: NodeTypes;
  executions: ExecutionService;
  activeWorkflows: ActiveWorkflowManager;
  testWebhooks: TestWebhookStore;
}

function assertGraph(
  definition: Pick<WorkflowDefinition, 'nodes' | 'connections' | 'name'>,
  nodeTypes: NodeTypes,
) {
  try {
    return new Workflow(
      { ...definition, connections: definition.connections ?? {} } as WorkflowDefinition,
      nodeTypes,
    );
  } catch (error) {
    throw ApiError.badRequest((error as Error).message);
  }
}

export class WorkflowService {
  constructor(private readonly deps: WorkflowServiceDeps) {}

  private get repos() {
    return this.deps.repos;
  }

  async dto(tenantId: string, row: WorkflowRow): Promise<WorkflowDTO> {
    const tags = await this.repos.workflows.tagsFor(tenantId, [row.id]);
    return toDTO(row, tags.get(row.id) ?? []);
  }

  async get(tenantId: string, id: string): Promise<WorkflowRow> {
    const row = await this.repos.workflows.get(tenantId, id);
    if (!row) throw ApiError.notFound('Workflow');
    return row;
  }

  async list(
    tenantId: string,
    query: { search?: string; tagId?: string; active?: boolean; limit: number; cursor?: string },
  ) {
    const rows = await this.repos.workflows.list(tenantId, { ...query, cursor: decodeCursor(query.cursor) });
    const { data, nextCursor } = page(rows, query.limit, (r) => encodeCursor(r.updatedAt, r.id));
    const tags = await this.repos.workflows.tagsFor(
      tenantId,
      data.map((r) => r.id),
    );
    return {
      data: data.map((r) => ({
        id: r.id,
        name: r.name,
        active: r.active,
        tags: tags.get(r.id) ?? [],
        updatedAt: r.updatedAt.toISOString(),
        createdAt: r.createdAt.toISOString(),
        nodeTypes: r.nodeTypes ?? [],
      })),
      nextCursor,
    };
  }

  private async checkTags(repos: Repositories, tenantId: string, tagIds: string[]): Promise<string[]> {
    const unique = [...new Set(tagIds)];
    const existing = await repos.tags.existing(tenantId, unique);
    if (existing.length !== unique.length) throw ApiError.badRequest('Unknown tag id');
    return unique;
  }

  async create(tenantId: string, input: CreateInput, actor: Actor): Promise<WorkflowDTO> {
    assertGraph(input as unknown as WorkflowDefinition, this.deps.nodeTypes);
    const id = randomUUID();
    const versionId = randomUUID();
    const content = {
      name: input.name,
      nodes: input.nodes,
      connections: input.connections,
      settings: input.settings ?? {},
      pinData: input.pinData ?? {},
      stickyNotes: input.stickyNotes ?? [],
    };
    const row = await this.deps.database.db.transaction(async (tx) => {
      const repos = createRepositories(tx);
      const tagIds = input.tagIds ? await this.checkTags(repos, tenantId, input.tagIds) : [];
      const row = await repos.workflows.create(tenantId, {
        ...content,
        id,
        versionId,
        createdBy: actor.userId,
      });
      await repos.versions.create(tenantId, {
        id: versionId,
        workflowId: id,
        name: content.name,
        nodes: content.nodes,
        connections: content.connections,
        settings: content.settings,
        stickyNotes: content.stickyNotes,
        authorId: actor.userId ?? null,
        message: 'Created',
      });
      if (tagIds.length) await repos.workflows.setTags(tenantId, id, tagIds);
      return row;
    });
    await this.repos.audit.add(tenantId, {
      userId: actor.userId,
      action: 'workflow.created',
      resourceType: 'workflow',
      resourceId: id,
      ip: actor.ip,
    });
    return this.dto(tenantId, row);
  }

  /**
   * Save changes. `expectedVersionId` must match the stored version (409 otherwise); every save
   * creates a version snapshot. Saving an active workflow re-registers its triggers; when that
   * fails the workflow is deactivated and the reason returned in `activationError`.
   */
  async update(
    tenantId: string,
    id: string,
    input: Omit<UpdateInput, 'versionId'> & { versionId?: string },
    actor: Actor,
    message?: string,
  ): Promise<WorkflowDTO & { activationError?: { message: string; details?: unknown } }> {
    const { versionId: expected, tagIds, versionMessage, ...patch } = input;
    if (patch.nodes || patch.connections) {
      const current = await this.get(tenantId, id);
      assertGraph(
        {
          name: patch.name ?? current.name,
          nodes: (patch.nodes ?? current.nodes) as WorkflowNode[],
          connections: (patch.connections ?? current.connections) as WorkflowDefinition['connections'],
        },
        this.deps.nodeTypes,
      );
    }
    const newVersionId = randomUUID();
    let previous: WorkflowRow | undefined;
    const row = await this.deps.database.db.transaction(async (tx) => {
      const repos = createRepositories(tx);
      previous = await repos.workflows.get(tenantId, id);
      const updated = await repos.workflows.update(tenantId, id, expected, {
        ...patch,
        versionId: newVersionId,
      });
      if (!updated) throw ApiError.notFound('Workflow');
      if (updated === 'conflict') {
        const current = await repos.workflows.get(tenantId, id);
        throw ApiError.conflict(
          'The workflow was changed by someone else. Reload it to see the latest version.',
          {
            currentVersionId: current?.versionId,
          },
        );
      }
      await repos.versions.create(tenantId, {
        id: newVersionId,
        workflowId: id,
        name: updated.name,
        nodes: updated.nodes,
        connections: updated.connections,
        settings: updated.settings,
        stickyNotes: updated.stickyNotes,
        authorId: actor.userId ?? null,
        message: message ?? versionMessage ?? null,
      });
      if (tagIds) await repos.workflows.setTags(tenantId, id, await this.checkTags(repos, tenantId, tagIds));
      return updated;
    });
    await this.repos.audit.add(tenantId, {
      userId: actor.userId,
      action: 'workflow.updated',
      resourceType: 'workflow',
      resourceId: id,
      metadata: { versionId: newVersionId },
      ip: actor.ip,
    });

    let activationError: { message: string; details?: unknown } | undefined;
    let current = row;
    if (row.active && (patch.nodes || patch.connections || patch.settings)) {
      try {
        current = await this.deps.activeWorkflows.activate(tenantId, id, 'update', previous);
      } catch (error) {
        current = await this.deps.activeWorkflows.deactivate(tenantId, id);
        activationError = {
          message: (error as Error).message,
          details: error instanceof ApiError ? error.details : undefined,
        };
      }
    }
    const dto = await this.dto(tenantId, current);
    return activationError ? { ...dto, activationError } : dto;
  }

  async delete(tenantId: string, id: string, actor: Actor): Promise<void> {
    const row = await this.get(tenantId, id);
    if (row.active) await this.deps.activeWorkflows.deactivate(tenantId, id);
    const executionIds = await this.repos.executions.idsForWorkflow(tenantId, id);
    await this.repos.workflows.delete(tenantId, id);
    for (const executionId of executionIds)
      await this.deps.executions.removeBinaryData(tenantId, executionId);
    await this.repos.audit.add(tenantId, {
      userId: actor.userId,
      action: 'workflow.deleted',
      resourceType: 'workflow',
      resourceId: id,
      ip: actor.ip,
    });
  }

  async setActive(tenantId: string, id: string, active: boolean, actor: Actor): Promise<WorkflowDTO> {
    const row = active
      ? await this.deps.activeWorkflows.activate(tenantId, id)
      : await this.deps.activeWorkflows.deactivate(tenantId, id);
    await this.repos.audit.add(tenantId, {
      userId: actor.userId,
      action: active ? 'workflow.activated' : 'workflow.deactivated',
      resourceType: 'workflow',
      resourceId: id,
      ip: actor.ip,
    });
    return this.dto(tenantId, row);
  }

  // -------------------------------------------------------------------------------------------
  // versions

  async listVersions(tenantId: string, id: string, limit: number, cursor?: string) {
    await this.get(tenantId, id);
    const rows = await this.repos.versions.list(tenantId, id, limit, decodeCursor(cursor));
    const { data, nextCursor } = page(rows, limit, (r) => encodeCursor(r.createdAt, r.versionId));
    return {
      data: data.map((v) => ({
        versionId: v.versionId,
        authorName: v.authorName ?? null,
        message: v.message ?? null,
        createdAt: v.createdAt.toISOString(),
      })),
      nextCursor,
    };
  }

  async getVersion(tenantId: string, id: string, versionId: string) {
    await this.get(tenantId, id);
    const v = await this.repos.versions.get(tenantId, id, versionId);
    if (!v) throw ApiError.notFound('Version');
    return {
      versionId: v.id,
      workflowId: v.workflowId,
      name: v.name,
      nodes: v.nodes,
      connections: v.connections,
      settings: v.settings,
      stickyNotes: v.stickyNotes,
      authorName: v.authorName,
      message: v.message,
      createdAt: v.createdAt.toISOString(),
    };
  }

  async restoreVersion(tenantId: string, id: string, versionId: string, actor: Actor) {
    const snapshot = await this.getVersion(tenantId, id, versionId);
    return this.update(
      tenantId,
      id,
      {
        name: snapshot.name,
        nodes: snapshot.nodes as UpdateInput['nodes'],
        connections: snapshot.connections as UpdateInput['connections'],
        settings: snapshot.settings as UpdateInput['settings'],
        stickyNotes: snapshot.stickyNotes as UpdateInput['stickyNotes'],
      },
      actor,
      `Restored version ${versionId}`,
    );
  }

  /** structural diff between two versions (`against` = another version id or "current") */
  async diffVersions(tenantId: string, id: string, versionId: string, against: string) {
    const from = await this.getVersion(tenantId, id, versionId);
    const to =
      against === 'current'
        ? { ...toDefinition(await this.get(tenantId, id)), versionId: 'current' }
        : await this.getVersion(tenantId, id, against);
    return {
      from: versionId,
      to: against,
      ...diffDefinitions(
        {
          name: from.name,
          nodes: from.nodes as WorkflowNode[],
          connections: from.connections,
          settings: from.settings,
        },
        {
          name: to.name,
          nodes: to.nodes as WorkflowNode[],
          connections: to.connections,
          settings: to.settings ?? {},
        },
      ),
    };
  }

  // -------------------------------------------------------------------------------------------
  // runs and test webhooks

  /** the saved workflow, or the editor's unsaved copy bound to the saved id */
  private definitionFor(row: WorkflowRow, data?: WorkflowData): WorkflowDefinition {
    if (!data) return toDefinition(row);
    const definition = cloneDefinition(data as unknown as WorkflowDefinition);
    return { ...definition, id: row.id, staticData: structuredClone(row.staticData), active: row.active };
  }

  async run(tenant: TenantRow, id: string, input: RunInput, actor: Actor): Promise<{ executionId: string }> {
    const row = await this.get(tenant.id, id);
    const definition = this.definitionFor(row, input.workflowData);
    const workflow = assertGraph(definition, this.deps.nodeTypes);
    if (input.destinationNode && !workflow.nodes[input.destinationNode]) {
      throw ApiError.badRequest(`Node "${input.destinationNode}" does not exist`);
    }
    if (input.startNode && !workflow.nodes[input.startNode]) {
      throw ApiError.badRequest(`Node "${input.startNode}" does not exist`);
    }
    const start = input.startNode
      ? workflow.nodes[input.startNode]
      : chooseManualStartNode(workflow, input.destinationNode);
    if (!start) throw ApiError.badRequest('The workflow has no node to start from');

    const pinData = Object.fromEntries(
      Object.entries((input.pinData ?? definition.pinData ?? {}) as Record<string, Item[]>).filter(
        ([name]) => workflow.nodes[name],
      ),
    );
    // binary data of a trigger's sample items is stored under the id of the execution that uses it
    const executionId = randomUUID();
    let triggerItems = input.triggerItems as Item[] | undefined;
    try {
      if (!triggerItems && !pinData[start.name]) {
        triggerItems = await this.manualTriggerItems(tenant, workflow, start, executionId);
        if (!triggerItems) await this.deps.executions.removeBinaryData(tenant.id, executionId);
      }
      await this.deps.executions.start({
        tenantId: tenant.id,
        workflow: definition,
        workflowId: row.id,
        executionId,
        mode: 'manual',
        startNode: start.name,
        triggerItems,
        destinationNode: input.destinationNode,
        pinData: Object.keys(pinData).length ? pinData : undefined,
        userId: actor.userId,
      });
    } catch (error) {
      await this.deps.executions.removeBinaryData(tenant.id, executionId);
      throw error;
    }
    return { executionId };
  }

  /**
   * Manual runs of trigger/poll nodes: let the node produce sample data (manualTriggerFunction or
   * one poll) instead of starting with an empty item.
   */
  private async manualTriggerItems(
    tenant: TenantRow,
    workflow: Workflow,
    node: WorkflowNode,
    executionId: string,
  ) {
    const type = this.deps.nodeTypes.get(node.type);
    if (!type || type.execute || node.disabled || (!type.trigger && !type.poll)) return undefined;
    const services = await this.deps.executions.buildServices({
      tenant,
      executionId,
      mode: 'manual',
      workflowId: workflow.id,
    });
    const abort = new AbortController();
    const deps: ContextDeps = {
      workflow,
      node,
      services,
      evaluator: new ExpressionEvaluator({ timeoutMs: 1000 }),
      signal: abort.signal,
    };
    try {
      if (type.poll) {
        const result = await type.poll(createPollContext(deps, 'manual'));
        return result?.[0]?.length ? (JSON.parse(JSON.stringify(result[0])) as Item[]) : undefined;
      }
      let emitted: Item[] | undefined;
      let failed: Error | undefined;
      let wake!: () => void;
      const wait = new Promise<void>((r) => {
        wake = r;
      });
      const ctx = createTriggerContext(deps, {
        activationMode: 'manual',
        emit: (data) => {
          emitted ??= data?.[0] ?? [];
          wake();
        },
        emitError: (error) => {
          failed = error;
          wake();
        },
      });
      const response = await type.trigger!(ctx);
      try {
        if (!emitted && response?.manualTriggerFunction) await response.manualTriggerFunction();
        if (!emitted && !failed) {
          await Promise.race([wait, new Promise((r) => setTimeout(r, MANUAL_TRIGGER_WAIT_MS))]);
        }
      } finally {
        await response?.closeFunction?.().catch(() => {});
      }
      if (failed) throw failed;
      return emitted?.length ? (JSON.parse(JSON.stringify(emitted)) as Item[]) : undefined;
    } catch (error) {
      throw new ApiError(400, 'trigger_error', `${node.name}: ${(error as Error).message}`);
    } finally {
      abort.abort();
    }
  }

  async listenTestWebhook(
    tenant: TenantRow,
    id: string,
    input: { nodeName: string; workflowData?: WorkflowData },
    actor: Actor,
  ) {
    const row = await this.get(tenant.id, id);
    const definition = this.definitionFor(row, input.workflowData);
    const workflow = assertGraph(definition, this.deps.nodeTypes);
    const node = workflow.nodes[input.nodeName];
    if (!node) throw ApiError.badRequest(`Node "${input.nodeName}" does not exist`);
    const type = this.deps.nodeTypes.get(node.type);
    let hooks: ReturnType<typeof nodeWebhooks> = [];
    try {
      hooks = type ? nodeWebhooks(workflow, node, type) : [];
    } catch (error) {
      throw ApiError.badRequest((error as Error).message);
    }
    if (!hooks.length) throw ApiError.badRequest(`Node "${node.name}" does not receive webhooks`);
    // the provider keeps one hook per registration, so the test URL would replace the production one
    if (row.active && type?.webhookMethods) {
      throw ApiError.badRequest('Deactivate the workflow to listen for test events on this trigger');
    }
    await this.deps.activeWorkflows.registerTestWebhooks(tenant, definition, node.name);
    const expiresAt = Date.now() + TEST_WEBHOOK_TTL_MS;
    for (const hook of hooks) {
      await this.deps.testWebhooks.add({
        tenantId: tenant.id,
        workflowId: row.id,
        nodeName: node.name,
        method: hook.method,
        path: hook.path,
        workflow: definition,
        userId: actor.userId,
        expiresAt,
      });
    }
    return {
      testUrl: `${this.deps.config.baseUrl}/webhook-test/${tenant.slug}/${hooks[0].path}`,
      expiresAt: new Date(expiresAt).toISOString(),
    };
  }

  async webhookUrls(tenant: TenantRow, id: string) {
    const row = await this.get(tenant.id, id);
    const workflow = new Workflow(toDefinition(row), this.deps.nodeTypes);
    const base = this.deps.config.baseUrl;
    const urls: Array<{ nodeName: string; method: string; testUrl: string; productionUrl: string }> = [];
    for (const node of sortByPosition(Object.values(workflow.nodes))) {
      const type = this.deps.nodeTypes.get(node.type);
      if (!type?.description.webhooks?.length) continue;
      try {
        for (const hook of nodeWebhooks(workflow, node, type)) {
          urls.push({
            nodeName: node.name,
            method: hook.method,
            testUrl: `${base}/webhook-test/${tenant.slug}/${hook.path}`,
            productionUrl: `${base}/webhook/${tenant.slug}/${hook.path}`,
          });
        }
      } catch {
        /* invalid configuration: no URL to show */
      }
    }
    return urls;
  }

  /** dry-run activation checks (platform extension) */
  async validate(tenantId: string, id: string, data?: WorkflowData): Promise<ValidationIssue[]> {
    const row = await this.get(tenantId, id);
    return this.deps.activeWorkflows.validate(tenantId, this.definitionFor(row, data), row.id);
  }
}

/** manual runs prefer a Manual Trigger; partial runs start from a trigger upstream of the destination */
export function chooseManualStartNode(
  workflow: Workflow,
  destinationNode?: string,
): WorkflowNode | undefined {
  const enabled = (names: string[]) => names.map((n) => workflow.nodes[n]).filter((n) => n && !n.disabled);
  if (destinationNode) {
    const candidates = enabled([...workflow.getParentNodes(destinationNode, 'main'), destinationNode]);
    const triggers = candidates.filter((n) => workflow.isTriggerNode(n));
    const manual = triggers.filter((n) => n.type === MANUAL_TRIGGER);
    if (manual.length) return sortByPosition(manual)[0];
    if (triggers.length) return sortByPosition(triggers)[0];
    const roots = candidates.filter((n) => workflow.getMainInputs(n.name).flat().length === 0);
    return sortByPosition(roots)[0];
  }
  const manual = Object.values(workflow.nodes).filter((n) => n.type === MANUAL_TRIGGER && !n.disabled);
  if (manual.length) return sortByPosition(manual)[0];
  return workflow.getStartNode();
}

interface Comparable {
  name: string;
  nodes: WorkflowNode[];
  connections: unknown;
  settings: unknown;
}

function stable(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stable).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.keys(value)
      .sort()
      .map((k) => `${JSON.stringify(k)}:${stable((value as Record<string, unknown>)[k])}`)
      .join(',')}}`;
  }
  return JSON.stringify(value) ?? 'undefined';
}

function connectionList(connections: unknown): string[] {
  const out: string[] = [];
  for (const [source, byType] of Object.entries(
    (connections ?? {}) as Record<string, Record<string, unknown[]>>,
  )) {
    for (const [type, outputs] of Object.entries(byType ?? {})) {
      (outputs ?? []).forEach((dests, output) => {
        for (const d of (dests ?? []) as Array<{ node: string; index: number }>) {
          out.push(`${source}[${type}:${output}] -> ${d.node}[${d.index}]`);
        }
      });
    }
  }
  return out.sort();
}

export function diffDefinitions(a: Comparable, b: Comparable) {
  const byIdA = new Map(a.nodes.map((n) => [n.id, n]));
  const byIdB = new Map(b.nodes.map((n) => [n.id, n]));
  const added = b.nodes.filter((n) => !byIdA.has(n.id)).map((n) => n.name);
  const removed = a.nodes.filter((n) => !byIdB.has(n.id)).map((n) => n.name);
  const changed: Array<{ name: string; previousName?: string; fields: string[] }> = [];
  for (const [nodeId, before] of byIdA) {
    const after = byIdB.get(nodeId);
    if (!after) continue;
    const keys = new Set([...Object.keys(before), ...Object.keys(after)]);
    const fields = [...keys].filter(
      (k) =>
        stable((before as unknown as Record<string, unknown>)[k]) !==
        stable((after as unknown as Record<string, unknown>)[k]),
    );
    if (fields.length) {
      changed.push({
        name: after.name,
        ...(before.name !== after.name ? { previousName: before.name } : {}),
        fields,
      });
    }
  }
  const ca = new Set(connectionList(a.connections));
  const cb = new Set(connectionList(b.connections));
  const settingsA = (a.settings ?? {}) as Record<string, unknown>;
  const settingsB = (b.settings ?? {}) as Record<string, unknown>;
  const settingKeys = [...new Set([...Object.keys(settingsA), ...Object.keys(settingsB)])].filter(
    (k) => stable(settingsA[k]) !== stable(settingsB[k]),
  );
  return {
    name: a.name !== b.name ? { from: a.name, to: b.name } : null,
    nodes: { added, removed, changed },
    connections: { added: [...cb].filter((c) => !ca.has(c)), removed: [...ca].filter((c) => !cb.has(c)) },
    settings: { changed: settingKeys },
  };
}

export type { TagRef };
