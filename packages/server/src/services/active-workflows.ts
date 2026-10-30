/**
 * Activation of workflows (ARCHITECTURE.md §11): validation, webhook registration in the
 * `webhooks` table, third-party webhook registration (`webhookMethods`), trigger nodes
 * (`trigger()`) and pollers (`poll()`).
 *
 * Webhooks live in the database, so every main can serve them. Triggers and pollers run only
 * on the leader (always this process in regular mode); other mains forward start/stop requests
 * over the `control` channel.
 */
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
import type { ExecutionService } from './executions';
import type { Leadership } from './queue';
import { type NodeWebhook, nodeWebhooks, workflowWebhooks } from './webhook-paths';
import { toDefinition } from './workflow-model';

export interface ValidationIssue {
  node: string | null;
  message: string;
}

type ActivationMode = 'init' | 'create' | 'update' | 'activate' | 'manual';

interface RunningTriggers {
  tenantId: string;
  workflow: Workflow;
  abort: AbortController;
  closers: Array<() => Promise<void>>;
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
}

export class ActiveWorkflowManager {
  private readonly running = new Map<string, RunningTriggers>();
  private unsubscribe?: () => void;
  private readonly evaluator = new ExpressionEvaluator({ timeoutMs: 1000 });

  constructor(private readonly deps: ActiveWorkflowDeps) {}

  /** listen for trigger start/stop requests from other mains */
  async init(): Promise<void> {
    this.unsubscribe = await this.deps.bus.subscribe(
      'control',
      (message: { type: string; tenantId?: string; workflowId?: string }) => {
        if (!this.deps.leadership.isLeader || !message?.workflowId || !message.tenantId) return;
        if (message.type === 'triggers:start') {
          void this.startTriggers(message.tenantId, message.workflowId, 'activate').catch((error) =>
            this.deps.logger.warn(
              { err: error, workflowId: message.workflowId },
              'Trigger activation failed',
            ),
          );
        } else if (message.type === 'triggers:stop') {
          void this.stopTriggers(message.workflowId);
        }
      },
    );
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

  async activate(
    tenantId: string,
    workflowId: string,
    mode: ActivationMode = 'activate',
  ): Promise<WorkflowRow> {
    const { repos, database, logger } = this.deps;
    const row = await repos.workflows.get(tenantId, workflowId);
    if (!row) throw ApiError.notFound('Workflow');
    const tenant = (await repos.tenants.get(tenantId))!;
    const definition = toDefinition(row);
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

    const workflow = new Workflow(definition, this.deps.nodeTypes);
    const hooks = workflowWebhooks(workflow);
    try {
      await database.db.transaction(async (tx) => {
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
        await r.workflows.setActive(tenantId, workflowId, true);
      });
    } catch (error) {
      if (isUniqueViolation(error)) {
        throw new ApiError(400, 'activation_failed', 'The workflow could not be activated', [
          { node: null, message: 'A webhook path is already used by another active workflow' },
        ]);
      }
      throw error;
    }

    try {
      await this.runWebhookMethods(tenant, workflow, 'create');
      if (this.deps.leadership.isLeader) await this.startTriggers(tenantId, workflowId, mode, true);
      else await this.deps.bus.publish('control', { type: 'triggers:start', tenantId, workflowId });
    } catch (error) {
      logger.warn({ err: error, tenantId, workflowId }, 'Activation failed, rolling back');
      await this.stopTriggers(workflowId);
      await repos.webhooks.deleteForWorkflow(tenantId, workflowId);
      await repos.workflows.setActive(tenantId, workflowId, false);
      throw new ApiError(400, 'activation_failed', 'The workflow could not be activated', [
        { node: (error as { node?: string }).node ?? null, message: (error as Error).message },
      ]);
    }
    return (await repos.workflows.get(tenantId, workflowId))!;
  }

  async deactivate(tenantId: string, workflowId: string): Promise<WorkflowRow> {
    const { repos, logger } = this.deps;
    const row = await repos.workflows.get(tenantId, workflowId);
    if (!row) throw ApiError.notFound('Workflow');
    await repos.webhooks.deleteForWorkflow(tenantId, workflowId);
    await repos.workflows.setActive(tenantId, workflowId, false);
    await this.stopTriggers(workflowId);
    await this.deps.bus.publish('control', { type: 'triggers:stop', tenantId, workflowId });
    if (row.active) {
      const tenant = (await repos.tenants.get(tenantId))!;
      const workflow = new Workflow(toDefinition(row), this.deps.nodeTypes);
      await this.runWebhookMethods(tenant, workflow, 'delete').catch((error) =>
        logger.warn({ err: error, tenantId, workflowId }, 'Removing third-party webhooks failed'),
      );
    }
    return (await repos.workflows.get(tenantId, workflowId))!;
  }

  /** register/unregister webhooks with third-party services, then persist their static data */
  private async runWebhookMethods(tenant: TenantRow, workflow: Workflow, action: 'create' | 'delete') {
    const before = JSON.stringify(workflow.staticData);
    for (const node of Object.values(workflow.nodes)) {
      if (node.disabled) continue;
      const type = this.deps.nodeTypes.get(node.type);
      if (!type?.webhookMethods) continue;
      for (const hook of nodeWebhooks(workflow, node, type)) {
        const methods = type.webhookMethods[hook.webhookName];
        if (!methods) continue;
        const ctx = await this.lifecycleContext(tenant, workflow, node, hook);
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
    if (workflow.id && JSON.stringify(workflow.staticData) !== before) {
      await this.deps.repos.workflows.setStaticData(tenant.id, workflow.id, workflow.staticData);
    }
  }

  private async lifecycleContext(
    tenant: TenantRow,
    workflow: Workflow,
    node: WorkflowNode,
    hook: NodeWebhook,
  ): Promise<WebhookLifecycleContext> {
    const deps = await this.contextDeps(tenant, workflow, node, new AbortController().signal);
    const base = createBaseContext(deps);
    return {
      ...base,
      getNodeWebhookUrl: (name: string) => {
        const type = this.deps.nodeTypes.get(node.type)!;
        const match = nodeWebhooks(workflow, node, type).find((h) => h.webhookName === name) ?? hook;
        return `${this.deps.config.baseUrl}/webhook/${tenant.slug}/${match.path}`;
      },
      getWebhookName: () => hook.webhookName,
    };
  }

  private async contextDeps(
    tenant: TenantRow,
    workflow: Workflow,
    node: WorkflowNode,
    signal: AbortSignal,
  ): Promise<ContextDeps> {
    const services = await this.deps.executions.buildServices({
      tenant,
      executionId: '',
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
      await this.startTriggers(tenantId, id, 'init').catch((error) =>
        this.deps.logger.warn(
          { err: error, tenantId, workflowId: id },
          'Could not start triggers on start-up',
        ),
      );
    }
  }

  async stopAll(): Promise<void> {
    await Promise.all([...this.running.keys()].map((id) => this.stopTriggers(id)));
  }

  async close(): Promise<void> {
    this.unsubscribe?.();
    await this.stopAll();
  }

  async startTriggers(
    tenantId: string,
    workflowId: string,
    mode: ActivationMode,
    rethrow = false,
  ): Promise<void> {
    await this.stopTriggers(workflowId);
    const { repos, nodeTypes, logger } = this.deps;
    const row = await repos.workflows.get(tenantId, workflowId);
    if (!row?.active) return;
    const tenant = await repos.tenants.get(tenantId);
    if (!tenant) return;
    const workflow = new Workflow(toDefinition(row), nodeTypes);
    const entry: RunningTriggers = { tenantId, workflow, abort: new AbortController(), closers: [] };
    this.running.set(workflowId, entry);
    try {
      for (const node of Object.values(workflow.nodes)) {
        if (node.disabled) continue;
        const type = nodeTypes.get(node.type);
        if (type?.trigger) await this.startTriggerNode(tenant, entry, node, type, mode);
        if (type?.poll) this.startPoller(tenant, entry, node, type, mode);
      }
    } catch (error) {
      await this.stopTriggers(workflowId);
      if (rethrow) throw error;
      logger.warn({ err: error, tenantId, workflowId }, 'Trigger failed to start');
    }
  }

  async stopTriggers(workflowId: string): Promise<void> {
    const entry = this.running.get(workflowId);
    if (!entry) return;
    this.running.delete(workflowId);
    entry.abort.abort();
    for (const close of entry.closers) {
      await close().catch((error) =>
        this.deps.logger.warn({ err: error, workflowId }, 'Trigger close function failed'),
      );
    }
  }

  private async startTriggerNode(
    tenant: TenantRow,
    entry: RunningTriggers,
    node: WorkflowNode,
    type: NodeType,
    mode: ActivationMode,
  ): Promise<void> {
    const deps = await this.contextDeps(tenant, entry.workflow, node, entry.abort.signal);
    const ctx = createTriggerContext(deps, {
      activationMode: mode,
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
      try {
        const deps = await this.contextDeps(tenant, entry.workflow, node, entry.abort.signal);
        const before = JSON.stringify(entry.workflow.staticData);
        const result = await type.poll!(createPollContext(deps, mode));
        if (entry.workflow.id && JSON.stringify(entry.workflow.staticData) !== before) {
          await this.deps.repos.workflows.setStaticData(
            tenant.id,
            entry.workflow.id,
            entry.workflow.staticData,
          );
        }
        const items = result?.[0] ?? [];
        if (items.length) await this.startFromTrigger(tenant, entry, node, items);
      } catch (error) {
        this.deps.logger.warn(
          { err: error, tenantId: tenant.id, workflowId: entry.workflow.id, node: node.name },
          'Poll failed',
        );
      } finally {
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
  ): Promise<void> {
    if (entry.abort.signal.aborted) return;
    try {
      const definition = JSON.parse(JSON.stringify(entry.workflow.definition)) as WorkflowDefinition;
      definition.staticData = JSON.parse(JSON.stringify(entry.workflow.staticData));
      const started = await this.deps.executions.start({
        tenantId: tenant.id,
        workflow: definition,
        workflowId: entry.workflow.id,
        mode: 'trigger',
        startNode: node.name,
        triggerItems: JSON.parse(JSON.stringify(items.length ? items : [{ json: {} }])),
        wait: Boolean(responsePromise),
      });
      if (responsePromise && started.finished) {
        const outcome = await started.finished;
        if (outcome.status === 'error')
          responsePromise.reject(new Error(outcome.error?.message ?? 'Execution failed'));
        else responsePromise.resolve(outcome);
      }
    } catch (error) {
      responsePromise?.reject(error as Error);
      this.deps.logger.warn(
        { err: error, tenantId: tenant.id, workflowId: entry.workflow.id, node: node.name },
        'Could not start an execution from a trigger',
      );
    }
  }
}
