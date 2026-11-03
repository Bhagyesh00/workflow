/**
 * Activation of workflows (ARCHITECTURE.md §11): validation, webhook registration in the
 * `webhooks` table, third-party webhook registration (`webhookMethods`), trigger nodes
 * (`trigger()`) and pollers (`poll()`).
 *
 * Webhooks live in the database, so every main can serve them. Triggers and pollers run only
 * on the leader (always this process in regular mode); other mains forward start/stop requests
 * over the `control` channel.
 */
import { randomUUID } from 'node:crypto';
import { mkdir, rename } from 'node:fs/promises';
import path from 'node:path';
import {
  type ContextDeps,
  createBaseContext,
  createPollContext,
  createTriggerContext,
  getResolvedParameters,
  type NodeTypes,
} from '@workflow/core';
import {
  type DataObject,
  ExpressionEvaluator,
  type Item,
  isParameterDisplayed,
  type NodeType,
  type WebhookLifecycleContext,
  Workflow,
  type WorkflowDefinition,
  type WorkflowNode,
} from '@workflow/workflow';
import { Cron } from 'croner';
import type { Config } from '../config';
import type { Database } from '../db/client';
import type { TenantRow, WorkflowRow } from '../db/schema';
import { ApiError } from '../http/errors';
import type { PinoLogger } from '../logger';
import { effectiveLimits, type TenantSettings } from '../plans';
import { createRepositories, isUniqueViolation, type Repositories } from '../repositories';
import type { MessageBus } from './bus';
import { binaryDirOf, type ExecutionService } from './executions';
import { loadPublishedDefinition, publishedDefinition } from './published-workflow';
import type { Leadership } from './queue';
import { TEST_WEBHOOK_TTL_MS } from './test-webhooks';
import { type NodeWebhook, nodeWebhooks, workflowWebhooks } from './webhook-paths';
import { assertNotArchived } from './workflow-rules';

export interface ValidationIssue {
  node: string | null;
  message: string;
}

type ActivationMode = 'init' | 'create' | 'update' | 'activate' | 'manual';

/** what decides whether a node's third-party hook must be registered again */
const hookSignature = (n: WorkflowNode) =>
  JSON.stringify([n.type, n.typeVersion, n.parameters, n.credentials, n.webhookId, n.disabled ?? false]);

/** how long a main that is not the leader waits for the leader to start the triggers of a workflow */
const TRIGGER_START_TIMEOUT_MS = 30_000;

/**
 * messages on the `control` channel; the leader answers a start with `triggers:started` or `triggers:failed`.
 * `test-webhooks:clear` asks every other main to remove the provider hook it registered for a test listener.
 */
interface ControlMessage {
  type: 'triggers:start' | 'triggers:stop' | 'triggers:started' | 'triggers:failed' | 'test-webhooks:clear';
  tenantId?: string;
  workflowId?: string;
  /** ties a start request to its answer */
  requestId?: string;
  /** the reason of a `triggers:failed` answer */
  message?: string;
  node?: string | null;
  /** the test listener's node of a `test-webhooks:clear` */
  nodeName?: string;
  /** the main that sent a `test-webhooks:clear`, which has already removed its own hook */
  origin?: string;
}

interface RunningTriggers {
  tenantId: string;
  workflow: Workflow;
  abort: AbortController;
  closers: Array<() => Promise<void>>;
  /** binary data of trigger() contexts is staged under this id until an emit moves it to its execution */
  stagingId: string;
}

/** a "Listen for test event" registration with a third-party service, undone when it expires */
interface TestHooks {
  workflow: Workflow;
  node: WorkflowNode;
  tenant: TenantRow;
  timer: NodeJS.Timeout;
}

export const RESPOND_TO_WEBHOOK = 'core.respondToWebhook';

/** path with parameter names erased: equal shapes match the same requests */
const shapeOf = (path: string) =>
  path
    .split('/')
    .map((s) => (s.startsWith(':') ? ':' : s))
    .join('/');

/**
 * Poll schedule of a polling node: `parameters.pollTimes` either a cron string or
 * `{ item: [{ mode, hour?, minute?, weekday?, dayOfMonth?, value?, unit?, cronExpression? }] }`.
 * Default: every minute.
 */
export function pollTimesToCron(value: unknown): string[] {
  if (typeof value === 'string' && value.trim()) return [value.trim()];
  const items = (value as { item?: DataObject[] } | undefined)?.item;
  if (!Array.isArray(items) || !items.length) return ['0 * * * * *'];
  return items.map((i) => {
    const minute = Number(i.minute ?? 0);
    const hour = Number(i.hour ?? 0);
    switch (i.mode) {
      case 'everyMinute':
        return '0 * * * * *';
      case 'everyHour':
        return `0 ${minute} * * * *`;
      case 'everyDay':
        return `0 ${minute} ${hour} * * *`;
      case 'everyWeek':
        return `0 ${minute} ${hour} * * ${Number(i.weekday ?? 1)}`;
      case 'everyMonth':
        return `0 ${minute} ${hour} ${Number(i.dayOfMonth ?? 1)} * *`;
      case 'everyX': {
        const n = Math.max(1, Number(i.value ?? 1));
        if (i.unit === 'seconds') return `*/${n} * * * * *`;
        if (i.unit === 'hours') return `0 0 */${n} * * *`;
        return `0 */${n} * * * *`;
      }
      case 'custom':
        if (!String(i.cronExpression ?? '').trim())
          throw new Error('Poll times: the cron expression is empty');
        return String(i.cronExpression).trim();
      default:
        return '0 * * * * *';
    }
  });
}

export interface ActiveWorkflowDeps {
  config: Config;
  database: Database;
  repos: Repositories;
  nodeTypes: NodeTypes;
  executions: ExecutionService;
  logger: PinoLogger;
  bus: MessageBus;
  leadership: Leadership;
  /** wait for the leader's answer to a remote trigger start (default 30 seconds) */
  triggerStartTimeoutMs?: number;
}

export class ActiveWorkflowManager {
  private readonly running = new Map<string, RunningTriggers>();
  /** tail of the start/stop chain per workflow: starts and stops of one workflow never overlap */
  private readonly locks = new Map<string, Promise<void>>();
  private readonly testHooks = new Map<string, TestHooks>();
  /** names this main on the `control` channel */
  private readonly mainId = randomUUID();
  private unsubscribe?: () => void;
  private readonly evaluator = new ExpressionEvaluator({ timeoutMs: 1000 });

  constructor(private readonly deps: ActiveWorkflowDeps) {}

  /** listen for trigger start/stop requests and stopped test listeners from other mains */
  async init(): Promise<void> {
    this.unsubscribe = await this.deps.bus.subscribe('control', (message: ControlMessage) => {
      if (!message?.workflowId || !message.tenantId) return;
      // a test listener's provider hook lives on the main that registered it, leader or not
      if (message.type === 'test-webhooks:clear') {
        if (message.origin !== this.mainId && message.nodeName) {
          void this.unregisterTestWebhooks(`${message.tenantId}:${message.workflowId}:${message.nodeName}`);
        }
        return;
      }
      if (!this.deps.leadership.isLeader) return;
      if (message.type === 'triggers:start') {
        void this.answerRemoteStart(message.tenantId, message.workflowId, message.requestId);
      } else if (message.type === 'triggers:stop') {
        void this.stopTriggers(message.workflowId);
      }
    });
  }

  /** leader: start the triggers another main asked for, log a failure and tell that main how it went */
  private async answerRemoteStart(tenantId: string, workflowId: string, requestId?: string): Promise<void> {
    const { bus, logger } = this.deps;
    const answer = await this.startTriggers(tenantId, workflowId, 'activate', true).then(
      (): Partial<ControlMessage> => ({ type: 'triggers:started' }),
      (error): Partial<ControlMessage> => {
        logger.warn({ err: error, tenantId, workflowId }, 'Trigger activation failed');
        return {
          type: 'triggers:failed',
          message: error instanceof Error ? error.message : String(error),
          node: (error as { node?: string }).node ?? null,
        };
      },
    );
    await bus
      .publish('control', { ...answer, tenantId, workflowId, requestId })
      .catch((error) =>
        logger.warn({ err: error, tenantId, workflowId }, 'Could not answer a trigger start'),
      );
  }

  /**
   * Non-leader: ask the leader to start the triggers and wait for its answer. A failure of the leader
   * throws like a trigger that fails to start on this main. No answer in time keeps the activation:
   * while a new leader is elected nobody answers, and that leader's startAll() starts the triggers.
   * The timeout also bounds a publish that stalls; a publish that fails before the answer throws.
   */
  private async startTriggersOnLeader(tenantId: string, workflowId: string): Promise<void> {
    const { bus } = this.deps;
    const requestId = randomUUID();
    const timeoutMs = this.deps.triggerStartTimeoutMs ?? TRIGGER_START_TIMEOUT_MS;
    let settle!: (answer: ControlMessage | undefined) => void;
    const answered = new Promise<ControlMessage | undefined>((resolve) => {
      settle = resolve;
    });
    const unsubscribe = await bus.subscribe('control', (message: ControlMessage) => {
      if (
        message?.requestId === requestId &&
        (message.type === 'triggers:started' || message.type === 'triggers:failed')
      ) {
        settle(message);
      }
    });
    const timer = setTimeout(() => settle(undefined), timeoutMs);
    try {
      const published = bus.publish('control', { type: 'triggers:start', tenantId, workflowId, requestId });
      published.catch(() => {});
      const answer = await Promise.race([published.then(() => answered), answered]);
      if (!answer) {
        this.deps.logger.warn({ tenantId, workflowId, timeoutMs }, 'No main answered the trigger start');
        return;
      }
      if (answer.type === 'triggers:failed') {
        throw Object.assign(new Error(answer.message ?? 'The triggers could not be started'), {
          node: answer.node ?? undefined,
        });
      }
    } finally {
      clearTimeout(timer);
      unsubscribe();
    }
  }

  get runningWorkflowIds(): string[] {
    return [...this.running.keys()];
  }

  // -------------------------------------------------------------------------------------------
  // validation

  async validate(
    tenantId: string,
    definition: WorkflowDefinition,
    workflowId?: string,
  ): Promise<ValidationIssue[]> {
    const { nodeTypes, repos } = this.deps;
    const issues: ValidationIssue[] = [];
    let workflow: Workflow;
    try {
      workflow = new Workflow(definition, nodeTypes);
    } catch (error) {
      return [{ node: null, message: (error as Error).message }];
    }

    let activatable = 0;
    for (const node of Object.values(workflow.nodes)) {
      if (node.disabled) continue;
      const type = nodeTypes.get(node.type);
      if (!type) {
        issues.push({ node: node.name, message: `Unknown node type "${node.type}"` });
        continue;
      }
      const hasHooks = (type.description.webhooks ?? []).some((w) => !w.restartWebhook);
      if (type.trigger || type.poll || hasHooks) activatable++;
      issues.push(...(await this.credentialIssues(tenantId, workflow, node, type)));
      if (type.poll) {
        try {
          for (const expr of pollTimesToCron(node.parameters.pollTimes))
            new Cron(expr, { paused: true }).stop();
        } catch (error) {
          issues.push({ node: node.name, message: `Invalid poll times: ${(error as Error).message}` });
        }
      }
    }
    if (!activatable) {
      issues.push({
        node: null,
        message: 'The workflow has no trigger, poller or webhook node that can start it automatically',
      });
    }

    let hooks: NodeWebhook[] = [];
    try {
      hooks = workflowWebhooks(workflow);
    } catch (error) {
      issues.push({ node: null, message: `Invalid webhook: ${(error as Error).message}` });
    }
    const seen = new Map<string, string>();
    for (const hook of hooks) {
      // `users/:id` and `users/:userId` match the same requests
      const key = `${hook.method} ${shapeOf(hook.path)}`;
      const other = seen.get(key);
      if (other) {
        issues.push({
          node: hook.nodeName,
          message: `The webhook path "${key}" is also used by node "${other}"`,
        });
      }
      seen.set(key, hook.nodeName);
      if (
        hook.responseMode === 'responseNode' &&
        !definition.nodes.some((n) => n.type === RESPOND_TO_WEBHOOK && !n.disabled)
      ) {
        issues.push({
          node: hook.nodeName,
          message: 'The webhook responds "Using Respond to Webhook node" but the workflow has none',
        });
      }
    }
    if (hooks.length) {
      const conflicts = await repos.webhooks.findConflicts(tenantId, workflowId ?? '', hooks);
      for (const hook of hooks.filter((h) => h.isDynamic)) {
        const same = await repos.webhooks.listDynamic(tenantId, hook.method, hook.segments);
        for (const other of same) {
          if (
            other.workflowId !== workflowId &&
            other.path !== hook.path &&
            shapeOf(other.path) === shapeOf(hook.path)
          ) {
            conflicts.push(other);
          }
        }
      }
      for (const c of conflicts) {
        const hook = hooks.find((h) => h.method === c.method && shapeOf(h.path) === shapeOf(c.path));
        issues.push({
          node: hook?.nodeName ?? null,
          message: `The webhook path "${c.method} ${c.path}" is already used by another active workflow`,
        });
      }
    }
    return issues;
  }

  private async credentialIssues(
    tenantId: string,
    workflow: Workflow,
    node: WorkflowNode,
    type: NodeType,
  ): Promise<ValidationIssue[]> {
    const issues: ValidationIssue[] = [];
    const parameters = getResolvedParameters(workflow, node);
    for (const cred of type.description.credentials ?? []) {
      if (!isParameterDisplayed(cred.displayOptions, parameters, { nodeVersion: node.typeVersion })) continue;
      const ref = node.credentials?.[cred.name];
      if (!ref?.id && !ref?.name) {
        if (cred.required)
          issues.push({ node: node.name, message: `Credentials for "${cred.name}" are not set` });
        continue;
      }
      if (ref.id && !(await this.deps.repos.credentials.get(tenantId, ref.id))) {
        issues.push({ node: node.name, message: `Credential "${ref.name || ref.id}" does not exist` });
      }
    }
    return issues;
  }

  // -------------------------------------------------------------------------------------------
  // activate / deactivate

  /**
   * Publish a version (P3-10): register its webhooks and triggers, then point the workflow at it.
   * `versionId` defaults to the current draft. When another version is published, its triggers are
   * replaced; a publish that fails restores that version, so it keeps running.
   */
  async activate(
    tenantId: string,
    workflowId: string,
    options: { versionId?: string; mode?: ActivationMode } = {},
  ): Promise<WorkflowRow> {
    const { repos, logger } = this.deps;
    const row = await repos.workflows.get(tenantId, workflowId);
    if (!row) throw ApiError.notFound('Workflow');
    assertNotArchived(row, 'activate');
    const tenant = (await repos.tenants.get(tenantId))!;
    const versionId = options.versionId ?? row.versionId;
    const version = await repos.versions.get(tenantId, workflowId, versionId);
    if (!version) throw ApiError.notFound('Version');
    const definition = publishedDefinition(row, version);
    const issues = await this.validate(tenantId, definition, workflowId);
    if (issues.length)
      throw new ApiError(400, 'activation_failed', 'The workflow could not be activated', issues);

    if (!row.active) {
      const limits = effectiveLimits(tenant.plan, tenant.settings as TenantSettings);
      if (
        limits.activeWorkflows !== null &&
        (await repos.workflows.countActive(tenantId)) >= limits.activeWorkflows
      ) {
        throw ApiError.planLimit(`The plan allows ${limits.activeWorkflows} active workflows`);
      }
    }
    // the version that runs now, restored when this publish fails
    const previous =
      row.active && row.publishedVersionId
        ? {
            versionId: row.publishedVersionId,
            definition: await loadPublishedDefinition(repos, tenantId, row).catch((error) => {
              logger.warn({ err: error, tenantId, workflowId }, 'The published version could not be loaded');
              return null;
            }),
          }
        : undefined;

    const workflow = new Workflow(definition, this.deps.nodeTypes);
    try {
      await this.storePublished(tenantId, workflowId, workflow, versionId);
    } catch (error) {
      if (isUniqueViolation(error)) {
        throw new ApiError(400, 'activation_failed', 'The workflow could not be activated', [
          { node: null, message: 'A webhook path is already used by another active workflow' },
        ]);
      }
      throw error;
    }

    try {
      // third-party hooks of removed or reconfigured nodes go before the new version registers its own
      if (previous?.definition) await this.removeStaleWebhooks(tenant, previous.definition, definition);
      await this.runWebhookMethods(tenant, workflow, 'create');
      const mode = options.mode ?? (previous ? 'update' : 'activate');
      if (this.deps.leadership.isLeader) await this.startTriggers(tenantId, workflowId, mode, true);
      else await this.startTriggersOnLeader(tenantId, workflowId);
    } catch (error) {
      logger.warn({ err: error, tenantId, workflowId }, 'Activation failed, rolling back');
      await this.stopTriggers(workflowId);
      if (previous?.definition) {
        await this.restorePublished(tenant, previous.versionId, previous.definition, workflow);
      } else {
        await repos.webhooks.deleteForWorkflow(tenantId, workflowId);
        await repos.workflows.setPublished(tenantId, workflowId, null);
        // the caller deactivates a workflow that is no longer active without looking at third-party hooks
        await this.runWebhookMethods(tenant, workflow, 'delete').catch((cleanup) =>
          logger.warn({ err: cleanup, tenantId, workflowId }, 'Removing third-party webhooks failed'),
        );
      }
      throw new ApiError(400, 'activation_failed', 'The workflow could not be activated', [
        { node: (error as { node?: string }).node ?? null, message: (error as Error).message },
      ]);
    }
    return (await repos.workflows.get(tenantId, workflowId))!;
  }

  /** the webhook rows of `workflow` and the published pointer, in one transaction */
  private async storePublished(
    tenantId: string,
    workflowId: string,
    workflow: Workflow,
    versionId: string,
  ): Promise<void> {
    const hooks = workflowWebhooks(workflow);
    await this.deps.database.db.transaction(async (tx) => {
      const r = createRepositories(tx);
      await r.webhooks.replaceForWorkflow(
        tenantId,
        workflowId,
        hooks.map((h) => ({
          nodeName: h.nodeName,
          webhookName: h.webhookName,
          method: h.method,
          path: h.path,
          isDynamic: h.isDynamic,
          segments: h.segments,
        })),
      );
      await r.workflows.setPublished(tenantId, workflowId, versionId);
    });
  }

  /**
   * A publish over a running version failed: drop the third-party hooks only the failed version
   * registered, put back the previous version's webhooks, pointer and hooks, and restart its triggers.
   */
  private async restorePublished(
    tenant: TenantRow,
    versionId: string,
    definition: WorkflowDefinition,
    failed: Workflow,
  ): Promise<void> {
    const { logger, nodeTypes } = this.deps;
    const workflowId = failed.id ?? '';
    const log = (message: string) => (error: unknown) =>
      logger.warn({ err: error, tenantId: tenant.id, workflowId }, message);
    const kept = new Map(definition.nodes.map((n) => [n.name, hookSignature(n)]));
    await this.runWebhookMethods(tenant, failed, 'delete', {
      only: (n) => kept.get(n.name) !== hookSignature(n),
    }).catch(log('Removing third-party webhooks failed'));
    // the stored static data changed while the failed version registered its hooks
    const row = await this.deps.repos.workflows.get(tenant.id, workflowId);
    const previous = new Workflow(
      { ...definition, staticData: structuredClone(row?.staticData ?? definition.staticData) },
      nodeTypes,
    );
    try {
      await this.storePublished(tenant.id, workflowId, previous, versionId);
    } catch (error) {
      log('Restoring the published version failed')(error);
      return;
    }
    const removed = new Map(failed.definition.nodes.map((n) => [n.name, hookSignature(n)]));
    await this.runWebhookMethods(tenant, previous, 'create', {
      only: (n) => removed.get(n.name) !== hookSignature(n),
    }).catch(log('Restoring third-party webhooks failed'));
    if (this.deps.leadership.isLeader) await this.startTriggers(tenant.id, workflowId, 'update');
    else await this.startTriggersOnLeader(tenant.id, workflowId).catch(log('Restarting triggers failed'));
  }

  /**
   * Restart the triggers of a published workflow whose live settings changed (P3-10: settings apply
   * without a publish). Throws when they do not start; the caller decides what happens then.
   */
  async reloadTriggers(tenantId: string, workflowId: string): Promise<void> {
    if (this.deps.leadership.isLeader) await this.startTriggers(tenantId, workflowId, 'update', true);
    else await this.startTriggersOnLeader(tenantId, workflowId);
  }

  async deactivate(tenantId: string, workflowId: string): Promise<WorkflowRow> {
    const { repos, logger } = this.deps;
    const row = await repos.workflows.get(tenantId, workflowId);
    if (!row) throw ApiError.notFound('Workflow');
    // the third-party hooks belong to the published version
    const published = row.active
      ? await loadPublishedDefinition(repos, tenantId, row).catch((error) => {
          logger.warn({ err: error, tenantId, workflowId }, 'The published version could not be loaded');
          return null;
        })
      : null;
    await repos.webhooks.deleteForWorkflow(tenantId, workflowId);
    await repos.workflows.setPublished(tenantId, workflowId, null);
    await this.stopTriggers(workflowId);
    await this.deps.bus.publish('control', { type: 'triggers:stop', tenantId, workflowId });
    if (published) {
      const tenant = (await repos.tenants.get(tenantId))!;
      const workflow = new Workflow(published, this.deps.nodeTypes);
      await this.runWebhookMethods(tenant, workflow, 'delete').catch((error) =>
        logger.warn({ err: error, tenantId, workflowId }, 'Removing third-party webhooks failed'),
      );
    }
    return (await repos.workflows.get(tenantId, workflowId))!;
  }

  /**
   * Register/unregister webhooks with third-party services, then persist their static data.
   * `only` limits it to some nodes; `testUrls` registers the "Listen for test event" URLs, whose
   * static data is not persisted.
   */
  private async runWebhookMethods(
    tenant: TenantRow,
    workflow: Workflow,
    action: 'create' | 'delete',
    options: { only?: (node: WorkflowNode) => boolean; testUrls?: boolean } = {},
  ) {
    const before = structuredClone(workflow.staticData);
    for (const node of Object.values(workflow.nodes)) {
      if (node.disabled || (options.only && !options.only(node))) continue;
      const type = this.deps.nodeTypes.get(node.type);
      if (!type?.webhookMethods) continue;
      for (const hook of nodeWebhooks(workflow, node, type)) {
        const methods = type.webhookMethods[hook.webhookName];
        if (!methods) continue;
        const ctx = await this.lifecycleContext(tenant, workflow, node, hook, options.testUrls);
        if (action === 'create') {
          if (!(await methods.checkExists(ctx))) {
            const ok = await methods.create(ctx);
            if (!ok)
              throw Object.assign(new Error('The webhook could not be registered'), { node: node.name });
          }
        } else {
          await methods.delete(ctx);
        }
      }
    }
    if (!options.testUrls && workflow.id) {
      await this.deps.repos.staticData.merge(tenant.id, workflow.id, before, workflow.staticData);
    }
  }

  /** delete the third-party hooks of `previous` nodes that the new definition removed or changed */
  private async removeStaleWebhooks(
    tenant: TenantRow,
    previous: WorkflowDefinition,
    next: WorkflowDefinition,
  ): Promise<void> {
    const kept = new Map(next.nodes.map((n) => [n.name, hookSignature(n)]));
    await this.runWebhookMethods(tenant, new Workflow(previous, this.deps.nodeTypes), 'delete', {
      only: (n) => kept.get(n.name) !== hookSignature(n),
    }).catch((error) =>
      this.deps.logger.warn(
        { err: error, tenantId: tenant.id, workflowId: previous.id },
        'Removing third-party webhooks failed',
      ),
    );
  }

  // -------------------------------------------------------------------------------------------
  // "Listen for test event" for nodes that register their webhook with a third-party service

  /**
   * Register the test URL of `node` with its provider (webhookMethods) for the duration of a
   * test listener. A listener for the same node replaces the earlier one; when the listener
   * expires the registration is removed again.
   */
  async registerTestWebhooks(
    tenant: TenantRow,
    definition: WorkflowDefinition,
    nodeName: string,
  ): Promise<void> {
    const workflow = new Workflow(definition, this.deps.nodeTypes);
    const node = workflow.nodes[nodeName];
    if (!node || !this.deps.nodeTypes.get(node.type)?.webhookMethods) return;
    const key = `${tenant.id}:${definition.id}:${nodeName}`;
    await this.unregisterTestWebhooks(key);
    try {
      await this.runWebhookMethods(tenant, workflow, 'create', { only: (n) => n === node, testUrls: true });
    } catch (error) {
      await this.runWebhookMethods(tenant, workflow, 'delete', {
        only: (n) => n === node,
        testUrls: true,
      }).catch(() => {});
      throw ApiError.badRequest(`${nodeName}: ${(error as Error).message}`);
    }
    const timer = setTimeout(() => void this.unregisterTestWebhooks(key), TEST_WEBHOOK_TTL_MS);
    timer.unref();
    this.testHooks.set(key, { tenant, workflow, node, timer });
  }

  /**
   * Remove the provider hook a test listener registered for one node of a tenant's workflow. The hook
   * may live on another main (the listen request reached that one), so every other main is asked too.
   */
  async unregisterTestWebhook(tenantId: string, workflowId: string, nodeName: string): Promise<void> {
    await this.unregisterTestWebhooks(`${tenantId}:${workflowId}:${nodeName}`);
    await this.deps.bus
      .publish('control', {
        type: 'test-webhooks:clear',
        tenantId,
        workflowId,
        nodeName,
        origin: this.mainId,
      })
      .catch((error) =>
        this.deps.logger.warn(
          { err: error, tenantId, workflowId },
          'Could not ask the other mains to stop listening',
        ),
      );
  }

  private async unregisterTestWebhooks(key: string): Promise<void> {
    const registered = this.testHooks.get(key);
    if (!registered) return;
    this.testHooks.delete(key);
    clearTimeout(registered.timer);
    await this.runWebhookMethods(registered.tenant, registered.workflow, 'delete', {
      only: (n) => n === registered.node,
      testUrls: true,
    }).catch((error) =>
      this.deps.logger.warn({ err: error, key }, 'Removing third-party test webhooks failed'),
    );
  }

  private async lifecycleContext(
    tenant: TenantRow,
    workflow: Workflow,
    node: WorkflowNode,
    hook: NodeWebhook,
    testUrls = false,
  ): Promise<WebhookLifecycleContext> {
    const deps = await this.contextDeps(tenant, workflow, node, new AbortController().signal);
    const base = createBaseContext(deps);
    return {
      ...base,
      getNodeWebhookUrl: (name: string) => {
        const type = this.deps.nodeTypes.get(node.type)!;
        const match = nodeWebhooks(workflow, node, type).find((h) => h.webhookName === name) ?? hook;
        const prefix = testUrls ? 'webhook-test' : 'webhook';
        return `${this.deps.config.baseUrl}/${prefix}/${tenant.slug}/${match.path}`;
      },
      getWebhookName: () => hook.webhookName,
    };
  }

  private async contextDeps(
    tenant: TenantRow,
    workflow: Workflow,
    node: WorkflowNode,
    signal: AbortSignal,
    executionId = '',
  ): Promise<ContextDeps> {
    const services = await this.deps.executions.buildServices({
      tenant,
      executionId,
      mode: 'trigger',
      workflowId: workflow.id,
    });
    return { workflow, node, services, evaluator: this.evaluator, signal };
  }

  // -------------------------------------------------------------------------------------------
  // triggers and pollers (leader only)

  /** leader start-up: (re)start triggers of every active workflow */
  async startAll(): Promise<void> {
    const active = await this.deps.repos.workflows.listActiveAcrossTenants();
    for (const { id, tenantId } of active) {
      // demoted part-way: the new leader starts the rest, and stopAll() has already run here
      if (!this.deps.leadership.isLeader) return;
      await this.startTriggers(tenantId, id, 'init').catch((error) =>
        this.deps.logger.warn(
          { err: error, tenantId, workflowId: id },
          'Could not start triggers on start-up',
        ),
      );
    }
  }

  async stopAll(): Promise<void> {
    // a workflow whose start is still queued or in progress is stopped once that start is done
    const ids = new Set([...this.running.keys(), ...this.locks.keys()]);
    await Promise.all([...ids].map((id) => this.stopTriggers(id)));
  }

  async close(): Promise<void> {
    this.unsubscribe?.();
    // the provider's hook id lives only in this process: remove the hooks now or never
    await Promise.all([...this.testHooks.keys()].map((key) => this.unregisterTestWebhooks(key)));
    await this.stopAll();
  }

  async startTriggers(
    tenantId: string,
    workflowId: string,
    mode: ActivationMode,
    rethrow = false,
  ): Promise<void> {
    return this.serialize(workflowId, () => this.startTriggersNow(tenantId, workflowId, mode, rethrow));
  }

  async stopTriggers(workflowId: string): Promise<void> {
    return this.serialize(workflowId, () => this.stopTriggersNow(workflowId));
  }

  /** run `task` after every start/stop of this workflow queued before it has settled */
  private serialize<T>(workflowId: string, task: () => Promise<T>): Promise<T> {
    const previous = this.locks.get(workflowId) ?? Promise.resolve();
    const result = previous.then(task);
    const tail = result.then(
      () => undefined,
      () => undefined,
    );
    this.locks.set(workflowId, tail);
    void tail.then(() => {
      if (this.locks.get(workflowId) === tail) this.locks.delete(workflowId);
    });
    return result;
  }

  private async startTriggersNow(
    tenantId: string,
    workflowId: string,
    mode: ActivationMode,
    rethrow: boolean,
  ): Promise<void> {
    await this.stopTriggersNow(workflowId);
    const { repos, nodeTypes, logger } = this.deps;
    const row = await repos.workflows.get(tenantId, workflowId);
    if (!row?.active) return;
    const tenant = await repos.tenants.get(tenantId);
    if (!tenant) return;
    const definition = await loadPublishedDefinition(repos, tenantId, row);
    if (!definition) return;
    const workflow = new Workflow(definition, nodeTypes);
    const entry: RunningTriggers = {
      tenantId,
      workflow,
      abort: new AbortController(),
      closers: [],
      stagingId: randomUUID(),
    };
    // only serialized starts and stops touch this workflow's entry, so nothing can replace or
    // abort it before this start returns: every closer pushed below stays reachable for a stop
    this.running.set(workflowId, entry);
    try {
      for (const node of Object.values(workflow.nodes)) {
        if (node.disabled) continue;
        const type = nodeTypes.get(node.type);
        if (type?.trigger) await this.startTriggerNode(tenant, entry, node, type, mode);
        if (type?.poll) this.startPoller(tenant, entry, node, type, mode);
      }
    } catch (error) {
      await this.stopTriggersNow(workflowId);
      if (rethrow) throw error;
      logger.warn({ err: error, tenantId, workflowId }, 'Trigger failed to start');
    }
  }

  private async stopTriggersNow(workflowId: string): Promise<void> {
    const entry = this.running.get(workflowId);
    if (!entry) return;
    this.running.delete(workflowId);
    entry.abort.abort();
    for (const close of entry.closers) {
      await close().catch((error) =>
        this.deps.logger.warn({ err: error, workflowId }, 'Trigger close function failed'),
      );
    }
    await this.deps.executions.removeBinaryData(entry.tenantId, entry.stagingId);
  }

  private async startTriggerNode(
    tenant: TenantRow,
    entry: RunningTriggers,
    node: WorkflowNode,
    type: NodeType,
    mode: ActivationMode,
  ): Promise<void> {
    const deps = await this.contextDeps(tenant, entry.workflow, node, entry.abort.signal, entry.stagingId);
    const workflowId = entry.workflow.id;
    const ctx = createTriggerContext(deps, {
      activationMode: mode,
      // missed schedules need a saved workflow: the slots are stored per workflow and node
      scheduleSlots: workflowId
        ? this.deps.repos.scheduleSlots.storeFor(
            tenant.id,
            workflowId,
            node.name,
            this.deps.config.scheduleMisfireGraceS,
          )
        : undefined,
      emit: (data, responsePromise) => {
        void this.startFromTrigger(tenant, entry, node, data?.[0] ?? [], responsePromise);
      },
      emitError: (error) => {
        this.deps.logger.warn(
          { err: error, tenantId: tenant.id, workflowId: entry.workflow.id, node: node.name },
          'Trigger reported an error',
        );
      },
    });
    try {
      const response = await type.trigger!(ctx);
      if (response?.closeFunction) entry.closers.push(response.closeFunction);
    } catch (error) {
      throw Object.assign(error instanceof Error ? error : new Error(String(error)), { node: node.name });
    }
  }

  /**
   * A fresh copy of a running workflow's static data as stored in the database (another run, poll or
   * main may have saved it since the triggers started), or of the in-memory one for an unsaved
   * workflow. Each poll and each emitted run gets its own copy: the scope objects of the running
   * workflow are never swapped under a poll that is still writing into them.
   */
  private async storedStaticData(tenantId: string, workflow: Workflow): Promise<DataObject> {
    if (workflow.id) {
      const stored = await this.deps.repos.staticData.get(tenantId, workflow.id);
      if (stored) return structuredClone(stored);
    }
    return structuredClone(workflow.staticData);
  }

  private startPoller(
    tenant: TenantRow,
    entry: RunningTriggers,
    node: WorkflowNode,
    type: NodeType,
    mode: ActivationMode,
  ): void {
    let busy = false;
    const timezone =
      entry.workflow.settings.timezone ?? (tenant.settings as TenantSettings).timezone ?? 'UTC';
    const tick = async () => {
      if (busy || entry.abort.signal.aborted) return;
      busy = true;
      // the poll stores its binary data under the id of the execution it starts
      const executionId = randomUUID();
      let started = false;
      try {
        const own = await this.storedStaticData(tenant.id, entry.workflow);
        const before = structuredClone(own);
        const view = withStaticData(entry.workflow, own);
        const deps = await this.contextDeps(tenant, view, node, entry.abort.signal, executionId);
        const result = await type.poll!(createPollContext(deps, mode));
        if (entry.workflow.id) {
          await this.deps.repos.staticData.merge(tenant.id, entry.workflow.id, before, own);
        }
        // keep the in-memory copy current for an unsaved workflow and for trigger contexts
        applyStaticDataChanges(entry.workflow.staticData, before, own);
        const items = result?.[0] ?? [];
        if (items.length) {
          started = await this.startFromTrigger(tenant, entry, node, items, undefined, executionId);
        }
      } catch (error) {
        this.deps.logger.warn(
          { err: error, tenantId: tenant.id, workflowId: entry.workflow.id, node: node.name },
          'Poll failed',
        );
      } finally {
        if (!started) await this.deps.executions.removeBinaryData(tenant.id, executionId);
        busy = false;
      }
    };
    for (const expression of pollTimesToCron(node.parameters.pollTimes)) {
      const job = new Cron(expression, { timezone, protect: true }, () => void tick());
      entry.closers.push(async () => job.stop());
    }
  }

  private async startFromTrigger(
    tenant: TenantRow,
    entry: RunningTriggers,
    node: WorkflowNode,
    items: Item[],
    responsePromise?: { resolve(value: unknown): void; reject(err: Error): void },
    pollExecutionId?: string,
  ): Promise<boolean> {
    if (entry.abort.signal.aborted) return false;
    // a poll already stored its binary data under its execution id; trigger() emits move theirs there
    const executionId = pollExecutionId ?? randomUUID();
    let begun = false;
    try {
      if (!pollExecutionId) await this.moveStagedBinaryData(tenant.id, entry.stagingId, executionId, items);
      // another run, poll or main may have saved static data since this trigger started
      const definition = JSON.parse(JSON.stringify(entry.workflow.definition)) as WorkflowDefinition;
      definition.staticData = await this.storedStaticData(tenant.id, entry.workflow);
      const started = await this.deps.executions.start({
        tenantId: tenant.id,
        workflow: definition,
        workflowId: entry.workflow.id,
        mode: 'trigger',
        executionId,
        startNode: node.name,
        triggerItems: JSON.parse(JSON.stringify(items.length ? items : [{ json: {} }])),
        wait: Boolean(responsePromise),
      });
      begun = true;
      if (responsePromise && started.finished) {
        const outcome = await started.finished;
        if (outcome.status === 'error')
          responsePromise.reject(new Error(outcome.error?.message ?? 'Execution failed'));
        else responsePromise.resolve(outcome);
      }
      return true;
    } catch (error) {
      if (!begun) await this.deps.executions.removeBinaryData(tenant.id, executionId);
      responsePromise?.reject(error as Error);
      this.deps.logger.warn(
        { err: error, tenantId: tenant.id, workflowId: entry.workflow.id, node: node.name },
        'Could not start an execution from a trigger',
      );
      return begun;
    }
  }

  /**
   * Move the filesystem binary files that `items` reference from the staging directory of a
   * trigger to the directory of the execution they start, and point the references (mutated in
   * place) at the new location.
   */
  private async moveStagedBinaryData(
    tenantId: string,
    stagingId: string,
    executionId: string,
    items: Item[],
  ): Promise<void> {
    const { config } = this.deps;
    if (config.binaryData.mode !== 'filesystem') return;
    const prefix = `fs:${tenantId}/${stagingId}/`;
    const walk = async (value: unknown): Promise<void> => {
      if (!value || typeof value !== 'object') return;
      const ref = value as { id?: unknown; mimeType?: unknown };
      if (typeof ref.id === 'string' && ref.id.startsWith(prefix) && typeof ref.mimeType === 'string') {
        const file = ref.id.slice(prefix.length);
        if (!file || file === '.' || file === '..' || /[\\/:]/.test(file)) return;
        const target = binaryDirOf(config, tenantId, executionId);
        await mkdir(target, { recursive: true });
        await rename(path.join(binaryDirOf(config, tenantId, stagingId), file), path.join(target, file));
        ref.id = `fs:${tenantId}/${executionId}/${file}`;
        return;
      }
      for (const child of Object.values(value)) await walk(child);
    };
    await walk(items);
  }
}

/** a view of `workflow` whose static data is `staticData` (everything else is the workflow's own) */
function withStaticData(workflow: Workflow, staticData: DataObject): Workflow {
  const view = Object.create(workflow) as Workflow;
  Object.defineProperty(view, 'staticData', { value: staticData, enumerable: true });
  return view;
}

/** copy the top-level keys a run changed (`before` -> `after`) into `target`, deleting removed keys */
function applyStaticDataChanges(target: DataObject, before: DataObject, after: DataObject): void {
  for (const key of Object.keys(before)) if (!(key in after)) delete target[key];
  for (const [key, value] of Object.entries(after)) {
    if (JSON.stringify(value) !== JSON.stringify(before[key])) target[key] = structuredClone(value);
  }
}
