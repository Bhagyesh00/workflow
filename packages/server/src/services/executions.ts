/**
 * Runs workflows: creates execution rows, builds `ExecutionServices` for the engine, persists
 * results according to workflow settings, publishes push events, and implements sub-workflows,
 * error workflows, retry, stop and wait/resume.
 *
 * Regular mode runs executions in this process. Queue mode enqueues them; a worker process calls
 * `runQueued`. Sub-workflows always run inline in the process running their parent.
 */
import { randomUUID } from 'node:crypto';
import { rm } from 'node:fs/promises';
import path from 'node:path';
import {
  type BinaryDataStore,
  type CodeRunner,
  createInitialState,
  type ExecutionHooks,
  type ExecutionServices,
  FileSystemBinaryDataStore,
  type HttpClient,
  InlineBinaryDataStore,
  type NodeTypes,
  type SubWorkflowRequest,
  WorkflowExecute,
} from '@workflow/core';
import {
  type ExecutionErrorShape,
  type ExecutionMode,
  type ExecutionResult,
  type ExecutionState,
  type ExecutionStatus,
  type Item,
  serializeError,
  sortByPosition,
  type WebhookResponse,
  Workflow,
  type WorkflowDefinition,
  type WorkflowNode,
} from '@workflow/workflow';
import type { Config } from '../config';
import type { ExecutionRow, TenantRow } from '../db/schema';
import { ApiError } from '../http/errors';
import type { PinoLogger } from '../logger';
import { toWorkflowLogger } from '../logger';
import { currentPeriod, effectiveLimits, executionTimeoutMs, type TenantSettings } from '../plans';
import type { Repositories } from '../repositories';
import type { MessageBus, PushService } from './bus';
import type { CredentialService } from './credentials';
import type { Metrics } from './metrics';
import type { ExecutionJob, ExecutionQueue } from './queue';
import { cloneDefinition, toDefinition } from './workflow-model';

export const EXECUTE_WORKFLOW_TRIGGER = 'core.executeWorkflowTrigger';
export const ERROR_TRIGGER = 'core.errorTrigger';
const MAX_SUB_WORKFLOW_DEPTH = 20;
/** modes that consume the monthly execution quota */
const BILLABLE_MODES = new Set<ExecutionMode>(['webhook', 'trigger', 'retry', 'internal', 'cli', 'chat']);

export interface StoredRunOptions {
  startNode?: string;
  triggerItems?: Item[];
  destinationNode?: string;
  pinData?: Record<string, Item[]>;
  /** output of the waiting node for the next resume (null = keep its own output) */
  resumeOutput?: Item[][] | null;
  depth?: number;
  userId?: string;
}

export interface ExecutionOutcome {
  executionId: string;
  status: ExecutionStatus;
  error?: ExecutionErrorShape;
  lastNodeExecuted?: string;
  lastNodeOutput?: Item[][] | null;
}

export interface ExecutionObserver {
  /** `Respond to Webhook` node output (responseNode mode) */
  onResponse?(response: WebhookResponse): void;
  onFinished?(outcome: ExecutionOutcome): void;
}

export interface StartExecutionInput {
  tenantId: string;
  workflow: WorkflowDefinition;
  /** id of the `workflows` row, when the definition is a saved workflow */
  workflowId?: string;
  mode: ExecutionMode;
  startNode?: string;
  triggerItems?: Item[];
  destinationNode?: string;
  pinData?: Record<string, Item[]>;
  executionId?: string;
  retryOf?: string;
  parentExecutionId?: string;
  depth?: number;
  userId?: string;
  /** run in this process even in queue mode */
  inline?: boolean;
  /** resolve `finished` when the execution stops (webhook responses, sub-workflows) */
  wait?: boolean;
  observer?: ExecutionObserver;
}

export interface StartedExecution {
  executionId: string;
  finished?: Promise<ExecutionOutcome>;
}

type Delivery = 'local' | 'bus' | 'none';

interface Waiter {
  observers: ExecutionObserver[];
  resolve: (outcome: ExecutionOutcome) => void;
  promise: Promise<ExecutionOutcome>;
}

export interface ExecutionServiceDeps {
  config: Config;
  repos: Repositories;
  nodeTypes: NodeTypes;
  credentials: CredentialService;
  http: HttpClient;
  codeRunner: CodeRunner;
  logger: PinoLogger;
  push: PushService;
  bus: MessageBus;
  metrics: Metrics;
  queue?: ExecutionQueue;
}

/** binary data of one execution lives in `<dir>/<tenantId>/<executionId>` */
export function binaryDirOf(config: Config, tenantId: string, executionId: string): string {
  return path.join(config.binaryData.dir, tenantId, executionId);
}

export class ExecutionService {
  private readonly running = new Map<string, { engine: WorkflowExecute; done: Promise<void> }>();
  private readonly waiters = new Map<string, Waiter>();
  private readonly unsubscribers: Array<() => void> = [];

  constructor(private readonly deps: ExecutionServiceDeps) {}

  /** wire cross-process events; call once per process */
  async init(): Promise<void> {
    const { bus } = this.deps;
    this.unsubscribers.push(
      await bus.subscribe('control', (message: { type: string; executionId?: string }) => {
        if (message?.type === 'cancel' && message.executionId) {
          this.running.get(message.executionId)?.engine.cancel('Execution was stopped');
        }
      }),
    );
    if (this.deps.queue) {
      this.unsubscribers.push(
        await bus.subscribe('exec-events', (message: ExecEvent) => this.handleExecEvent(message)),
      );
    }
  }

  async close(timeoutMs = 10_000): Promise<void> {
    for (const unsubscribe of this.unsubscribers.splice(0)) unsubscribe();
    const pending = [...this.running.values()].map((r) => r.done);
    if (pending.length) {
      await Promise.race([Promise.allSettled(pending), new Promise((r) => setTimeout(r, timeoutMs))]);
    }
    for (const { engine } of this.running.values()) engine.cancel('The server is shutting down');
  }

  get runningCount(): number {
    return this.running.size;
  }

  // -------------------------------------------------------------------------------------------
  // starting executions

  async start(input: StartExecutionInput): Promise<StartedExecution> {
    const { repos } = this.deps;
    const tenant = await repos.tenants.get(input.tenantId);
    if (!tenant) throw ApiError.notFound('Tenant');
    if (input.mode !== 'integrated' && input.mode !== 'error') await this.checkLimits(tenant, input.mode);

    const executionId = input.executionId ?? randomUUID();
    const workflowData = cloneDefinition(input.workflow);
    const runOptions: StoredRunOptions = {
      startNode: input.startNode,
      triggerItems: input.triggerItems,
      destinationNode: input.destinationNode,
      pinData: input.pinData,
      depth: input.depth ?? 0,
      userId: input.userId,
    };
    await repos.executions.create(
      tenant.id,
      {
        id: executionId,
        workflowId: input.workflowId ?? null,
        workflowName: input.workflow.name ?? '',
        mode: input.mode,
        status: 'new',
        startedAt: new Date(),
        retryOf: input.retryOf ?? null,
        parentExecutionId: input.parentExecutionId ?? null,
      },
      {
        workflowData: workflowData as unknown as Record<string, unknown>,
        runOptions: JSON.parse(JSON.stringify(runOptions)),
      },
    );
    // only production executions count towards the monthly quota
    if (BILLABLE_MODES.has(input.mode)) await repos.usage.increment(tenant.id, currentPeriod(), 1, 0);
    this.deps.push.send(tenant.id, 'executionStarted', {
      executionId,
      workflowId: input.workflowId ?? input.workflow.id ?? null,
      mode: input.mode,
    });

    const finished = input.wait || input.observer ? this.addWaiter(executionId, input.observer) : undefined;
    if (this.deps.queue && !input.inline) {
      await this.deps.queue.enqueue({
        executionId,
        tenantId: tenant.id,
        kind: 'run',
        notify: Boolean(finished),
      });
    } else {
      this.runInBackground(tenant.id, executionId, 'run', 'local');
    }
    return { executionId, finished };
  }

  private async checkLimits(tenant: TenantRow, mode: ExecutionMode): Promise<void> {
    const limits = effectiveLimits(tenant.plan, tenant.settings as TenantSettings);
    const { repos } = this.deps;
    if (limits.concurrentExecutions !== null) {
      const running = await repos.executions.countRunning(tenant.id);
      if (running >= limits.concurrentExecutions) {
        throw ApiError.tooMany(`The plan allows ${limits.concurrentExecutions} concurrent executions`);
      }
    }
    if (limits.executionsPerMonth !== null && BILLABLE_MODES.has(mode)) {
      const usage = await repos.usage.get(tenant.id, currentPeriod());
      if (usage.executions >= limits.executionsPerMonth) {
        throw ApiError.planLimit(`The monthly limit of ${limits.executionsPerMonth} executions is reached`);
      }
    }
  }

  private addWaiter(executionId: string, observer?: ExecutionObserver): Promise<ExecutionOutcome> {
    let waiter = this.waiters.get(executionId);
    if (!waiter) {
      let resolve!: (o: ExecutionOutcome) => void;
      const promise = new Promise<ExecutionOutcome>((r) => {
        resolve = r;
      });
      waiter = { observers: [], resolve, promise };
      this.waiters.set(executionId, waiter);
    }
    if (observer) waiter.observers.push(observer);
    return waiter.promise;
  }

  /** wait for an execution started elsewhere (e.g. a resumed one) */
  waitFor(executionId: string, observer?: ExecutionObserver): Promise<ExecutionOutcome> {
    return this.addWaiter(executionId, observer);
  }

  /** stop waiting for an execution (e.g. the HTTP request that waited for it timed out) */
  discardWaiter(executionId: string): void {
    this.waiters.delete(executionId);
  }

  private deliverResponse(executionId: string, response: WebhookResponse): void {
    for (const o of this.waiters.get(executionId)?.observers ?? []) o.onResponse?.(response);
  }

  private deliverFinished(outcome: ExecutionOutcome): void {
    const waiter = this.waiters.get(outcome.executionId);
    if (!waiter) return;
    this.waiters.delete(outcome.executionId);
    for (const o of waiter.observers) o.onFinished?.(outcome);
    waiter.resolve(outcome);
  }

  private handleExecEvent(message: ExecEvent): void {
    if (!message?.executionId || !this.waiters.has(message.executionId)) return;
    if (message.type === 'response')
      this.deliverResponse(message.executionId, decodeResponse(message.response));
    else if (message.type === 'finished') this.deliverFinished(message.outcome);
  }

  // -------------------------------------------------------------------------------------------
  // running

  /** queue worker entry point */
  async runQueued(job: ExecutionJob): Promise<void> {
    await this.run(job.tenantId, job.executionId, job.kind, job.notify ? 'bus' : 'none');
  }

  private runInBackground(tenantId: string, executionId: string, kind: 'run' | 'resume', delivery: Delivery) {
    void this.run(tenantId, executionId, kind, delivery).catch((error) => {
      this.deps.logger.error({ err: error, tenantId, executionId }, 'Execution failed to run');
    });
  }

  private async run(tenantId: string, executionId: string, kind: 'run' | 'resume', delivery: Delivery) {
    const { repos, nodeTypes, logger } = this.deps;
    const row = await repos.executions.get(tenantId, executionId);
    const data = await repos.executions.getData(tenantId, executionId);
    if (!row || !data) return;
    const emit = (outcome: ExecutionOutcome) => this.emitFinished(outcome, delivery);
    if (row.status === 'canceled' || (kind === 'run' && row.status !== 'new')) {
      emit({ executionId, status: row.status as ExecutionStatus });
      return;
    }
    const tenant = await repos.tenants.get(tenantId);
    if (!tenant) return;

    const definition = data.workflowData as unknown as WorkflowDefinition;
    const options = (data.runOptions ?? {}) as StoredRunOptions;
    const staticBefore = JSON.stringify(definition.staticData ?? {});
    const limits = effectiveLimits(tenant.plan, tenant.settings as TenantSettings);
    const timeoutMs = executionTimeoutMs(this.deps.config, limits, definition.settings?.executionTimeout);

    let workflow: Workflow;
    let engine: WorkflowExecute;
    try {
      workflow = new Workflow(definition, nodeTypes);
      const services = await this.buildServices({
        tenant,
        executionId,
        mode: row.mode as ExecutionMode,
        workflowId: row.workflowId ?? undefined,
        depth: options.depth ?? 0,
        hooks: this.hooks(tenant.id, row, definition, delivery),
      });
      engine = new WorkflowExecute(
        workflow,
        services,
        kind === 'resume' ? ((data.state as unknown as ExecutionState) ?? undefined) : undefined,
      );
    } catch (error) {
      const state = createInitialState();
      state.resultData.error = serializeError(error);
      await this.finish(tenant, row, definition, staticBefore, failedResult(state), delivery);
      return;
    }

    let release!: () => void;
    const done = new Promise<void>((r) => {
      release = r;
    });
    this.running.set(executionId, { engine, done });
    try {
      await repos.executions.update(tenantId, executionId, { status: 'running', waitTill: null });
      let result: ExecutionResult;
      try {
        result =
          kind === 'run'
            ? await engine.run({
                startNode: options.startNode,
                triggerItems: options.triggerItems,
                destinationNode: options.destinationNode,
                pinData: options.pinData,
                timeoutMs,
              })
            : await engine.resume({ output: options.resumeOutput ?? undefined, timeoutMs });
      } catch (error) {
        // run()/resume() reject only before processing starts (no start node, not waiting...)
        engine.state.resultData.error = serializeError(error);
        result = failedResult(engine.state);
      }
      await this.finish(tenant, row, definition, staticBefore, result, delivery);
    } catch (error) {
      logger.error({ err: error, tenantId, executionId }, 'Could not persist execution result');
      emit({ executionId, status: 'crashed', error: serializeError(error) });
    } finally {
      this.running.delete(executionId);
      release();
    }
  }

  private emitFinished(outcome: ExecutionOutcome, delivery: Delivery): void {
    if (delivery === 'local') this.deliverFinished(outcome);
    else if (delivery === 'bus') {
      void this.deps.bus
        .publish('exec-events', { type: 'finished', executionId: outcome.executionId, outcome })
        .catch(() => {});
    }
  }

  private hooks(
    tenantId: string,
    row: ExecutionRow,
    definition: WorkflowDefinition,
    delivery: Delivery,
  ): ExecutionHooks {
    const { push, repos } = this.deps;
    const manual = row.mode === 'manual';
    const executionId = row.id;
    return {
      nodeExecuteBefore: (nodeName) => {
        if (manual) push.send(tenantId, 'nodeExecuteBefore', { executionId, nodeName });
      },
      nodeExecuteAfter: async (nodeName, runIndex, taskData, state) => {
        if (manual) push.send(tenantId, 'nodeExecuteAfter', { executionId, nodeName, runIndex, taskData });
        if (definition.settings?.saveExecutionProgress) {
          await repos.executions.saveState(tenantId, executionId, state);
        }
      },
      sendResponse: (response) => {
        if (delivery === 'local') this.deliverResponse(executionId, response);
        else if (delivery === 'bus') {
          void this.deps.bus
            .publish('exec-events', { type: 'response', executionId, response: encodeResponse(response) })
            .catch(() => {});
        }
      },
      sendMessageToUI: (nodeName, args) => {
        push.send(tenantId, 'consoleMessage', { executionId, nodeName, args });
      },
    };
  }

  /** persist the result, account usage, publish events, chain error workflows */
  private async finish(
    tenant: TenantRow,
    row: ExecutionRow,
    definition: WorkflowDefinition,
    staticBefore: string,
    result: ExecutionResult,
    delivery: Delivery,
  ): Promise<void> {
    const { repos, push, metrics, logger } = this.deps;
    const { status, state } = result;
    const settings = definition.settings ?? {};
    const error = state.resultData.error;
    const durationMs = Math.max(0, result.stoppedAt - result.startedAt);

    let keep = true;
    if (status === 'waiting') keep = true;
    else if (row.mode === 'manual') keep = settings.saveManualExecutions !== false;
    else if (status === 'success') keep = settings.saveDataSuccessExecution !== 'none';
    else keep = settings.saveDataErrorExecution !== 'none';

    if (keep) {
      await repos.executions.saveState(tenant.id, row.id, state);
      await repos.executions.update(tenant.id, row.id, {
        status,
        stoppedAt: status === 'waiting' ? null : new Date(result.stoppedAt),
        waitTill: state.waitTill ? new Date(state.waitTill) : null,
        errorMessage: error?.message?.slice(0, 2000) ?? null,
        errorNode: error?.node ?? null,
        customData: state.resultData.customData ?? {},
      });
    } else {
      await repos.executions.delete(tenant.id, row.id);
      await this.removeBinaryData(tenant.id, row.id);
    }

    if (status !== 'waiting') {
      await repos.usage.increment(tenant.id, currentPeriod(), 0, durationMs);
      metrics.recordExecution(status, row.mode, durationMs);
    }

    // static data written by nodes (poll cursors, counters) is persisted for production runs
    if (row.mode !== 'manual' && row.workflowId) {
      const after = JSON.stringify(definition.staticData ?? {});
      if (after !== staticBefore) {
        await repos.workflows.setStaticData(tenant.id, row.workflowId, definition.staticData ?? {});
      }
    }

    push.send(tenant.id, 'executionFinished', {
      executionId: row.id,
      workflowId: row.workflowId,
      status,
      ...(error ? { error: { message: error.message, node: error.node } } : {}),
    });

    if (status === 'success' && row.retryOf) {
      await repos.executions.update(tenant.id, row.retryOf, { retrySuccessId: row.id });
    }

    if (status === 'error' || status === 'crashed') {
      await this.startErrorWorkflow(tenant.id, row, definition, state).catch((e) =>
        logger.warn({ err: e, tenantId: tenant.id, executionId: row.id }, 'Error workflow could not start'),
      );
    }

    this.emitFinished(
      {
        executionId: row.id,
        status,
        error,
        lastNodeExecuted: state.resultData.lastNodeExecuted,
        lastNodeOutput: result.lastNodeOutput ?? null,
      },
      delivery,
    );
  }

  async removeBinaryData(tenantId: string, executionId: string): Promise<void> {
    if (this.deps.config.binaryData.mode !== 'filesystem') return;
    await rm(binaryDirOf(this.deps.config, tenantId, executionId), { recursive: true, force: true }).catch(
      () => {},
    );
  }

  // -------------------------------------------------------------------------------------------
  // services for the engine

  binaryStore(tenantId: string): BinaryDataStore {
    const { config } = this.deps;
    return config.binaryData.mode === 'filesystem'
      ? new FileSystemBinaryDataStore(config.binaryData.dir, tenantId)
      : new InlineBinaryDataStore();
  }

  async buildServices(input: {
    tenant: TenantRow;
    executionId: string;
    mode: ExecutionMode;
    workflowId?: string;
    depth?: number;
    hooks?: ExecutionHooks;
  }): Promise<ExecutionServices> {
    const { config, repos, nodeTypes, credentials, http, codeRunner, logger } = this.deps;
    const { tenant, executionId } = input;
    const settings = tenant.settings as TenantSettings;
    const depth = input.depth ?? 0;
    return {
      tenantId: tenant.id,
      executionId,
      mode: input.mode,
      timezone: settings.timezone ?? config.defaultTimezone,
      variables: await repos.variables.map(tenant.id),
      instanceBaseUrl: config.baseUrl,
      resumeUrl: executionId ? `${config.baseUrl}/webhook-waiting/${executionId}` : undefined,
      nodeTypes,
      credentialTypes: credentials.types,
      credentials: credentials.provider(tenant.id),
      binaryData: this.binaryStore(tenant.id),
      codeRunner,
      http,
      logger: toWorkflowLogger(
        logger.child({
          tenantId: tenant.id,
          workflowId: input.workflowId,
          executionId: executionId || undefined,
        }),
      ),
      hooks: input.hooks,
      limits: { maxTries: 5 },
      executeSubWorkflow: (request) => this.executeSubWorkflow(request, depth),
    };
  }

  // -------------------------------------------------------------------------------------------
  // sub-workflows and error workflows

  private async executeSubWorkflow(
    request: SubWorkflowRequest,
    depth: number,
  ): Promise<{ executionId: string; data: Item[][] | null }> {
    if (depth >= MAX_SUB_WORKFLOW_DEPTH) {
      throw new Error(`Sub-workflows can be nested at most ${MAX_SUB_WORKFLOW_DEPTH} levels deep`);
    }
    const { repos, nodeTypes } = this.deps;
    const tenantId = request.parent.tenantId;
    let definition: WorkflowDefinition;
    let workflowId: string | undefined;
    if (request.source.source === 'database') {
      const row = await repos.workflows.get(tenantId, request.source.workflowId ?? '');
      if (!row) throw new Error(`Workflow "${request.source.workflowId ?? ''}" was not found`);
      assertCallerAllowed(
        row.name,
        row.settings as WorkflowDefinition['settings'],
        request.parent.workflowId,
      );
      definition = toDefinition(row);
      workflowId = row.id;
    } else {
      if (!request.source.workflow) throw new Error('No workflow definition was given');
      definition = { ...cloneDefinition(request.source.workflow), id: undefined };
    }
    const workflow = new Workflow(definition, nodeTypes);
    const start = findStartNode(workflow, EXECUTE_WORKFLOW_TRIGGER);
    if (!start) throw new Error(`Workflow "${definition.name}" has no node to start from`);

    const detached = Boolean(request.options?.doNotWaitToFinish);
    const items = request.items.length ? request.items : [{ json: {} }];
    const { executionId, finished } = await this.start({
      tenantId,
      workflow: definition,
      workflowId,
      mode: 'integrated',
      startNode: start.name,
      triggerItems: JSON.parse(JSON.stringify(items)),
      parentExecutionId: request.parent.executionId || undefined,
      depth: depth + 1,
      inline: !detached,
      wait: !detached,
    });
    if (detached || !finished) return { executionId, data: [request.items] };
    const outcome = await finished;
    if (outcome.status === 'error' || outcome.status === 'crashed' || outcome.status === 'canceled') {
      throw new Error(outcome.error?.message ?? `Sub-workflow execution ${executionId} failed`);
    }
    return { executionId, data: outcome.lastNodeOutput ?? null };
  }

  private async startErrorWorkflow(
    tenantId: string,
    row: ExecutionRow,
    definition: WorkflowDefinition,
    state: ExecutionState,
  ): Promise<void> {
    const errorWorkflowId = definition.settings?.errorWorkflow;
    if (!errorWorkflowId || row.mode === 'manual') return;
    // an error workflow that fails must not trigger itself forever
    if (row.mode === 'error' && (errorWorkflowId === row.workflowId || errorWorkflowId === definition.id))
      return;
    const target = await this.deps.repos.workflows.get(tenantId, errorWorkflowId);
    if (!target) {
      this.deps.logger.warn({ tenantId, errorWorkflowId }, 'Error workflow not found');
      return;
    }
    const targetDefinition = toDefinition(target);
    const start = findStartNode(new Workflow(targetDefinition, this.deps.nodeTypes), ERROR_TRIGGER);
    if (!start) return;
    const error = state.resultData.error;
    const workflowId = row.workflowId ?? definition.id ?? null;
    const item: Item = {
      json: {
        execution: {
          id: row.id,
          url: `${this.deps.config.baseUrl}/workflow/${workflowId ?? ''}/executions/${row.id}`,
          error: error ? { ...error, stack: undefined } : { message: 'Unknown error', name: 'Error' },
          lastNodeExecuted: state.resultData.lastNodeExecuted ?? null,
          mode: row.mode,
        },
        workflow: { id: workflowId, name: definition.name },
      },
    };
    await this.start({
      tenantId,
      workflow: targetDefinition,
      workflowId: target.id,
      mode: 'error',
      startNode: start.name,
      triggerItems: [JSON.parse(JSON.stringify(item))],
    });
  }

  // -------------------------------------------------------------------------------------------
  // wait / resume, stop, retry

  /**
   * Resume a waiting execution. Claims it atomically (waiting -> running) so that concurrent
   * resume calls and the wait tracker cannot resume it twice.
   */
  async resume(
    tenantId: string,
    executionId: string,
    output?: Item[][],
    opts: { wait?: boolean; observer?: ExecutionObserver } = {},
  ): Promise<StartedExecution | undefined> {
    const { repos, queue } = this.deps;
    const data = await repos.executions.getData(tenantId, executionId);
    if (!data) return undefined;
    const claimed = await repos.executions.transition(tenantId, executionId, ['waiting'], {
      status: 'running',
      waitTill: null,
    });
    if (!claimed) return undefined;
    await repos.executions.updateRunOptions(tenantId, executionId, {
      ...(data.runOptions ?? {}),
      resumeOutput: output ? JSON.parse(JSON.stringify(output)) : null,
    });
    const finished = opts.wait || opts.observer ? this.addWaiter(executionId, opts.observer) : undefined;
    if (queue) await queue.enqueue({ executionId, tenantId, kind: 'resume', notify: Boolean(finished) });
    else this.runInBackground(tenantId, executionId, 'resume', 'local');
    return { executionId, finished };
  }

  async stop(tenantId: string, executionId: string): Promise<ExecutionStatus> {
    const { repos, bus } = this.deps;
    const row = await repos.executions.get(tenantId, executionId);
    if (!row) throw ApiError.notFound('Execution');
    if (['new', 'waiting'].includes(row.status)) {
      const done = await repos.executions.transition(tenantId, executionId, ['new', 'waiting'], {
        status: 'canceled',
        stoppedAt: new Date(),
        waitTill: null,
      });
      if (done) {
        this.deps.push.send(tenantId, 'executionFinished', {
          executionId,
          workflowId: row.workflowId,
          status: 'canceled',
        });
        return 'canceled';
      }
    }
    if (row.status === 'running' || row.status === 'new') {
      const local = this.running.get(executionId);
      if (local) {
        local.engine.cancel('Execution was stopped');
        await local.done;
      } else {
        await bus.publish('control', { type: 'cancel', executionId });
        // give the worker a moment to observe the cancellation
        for (let i = 0; i < 50; i++) {
          const current = await repos.executions.get(tenantId, executionId);
          if (!current || !['running', 'new'].includes(current.status)) break;
          await new Promise((r) => setTimeout(r, 100));
        }
      }
    }
    const current = await repos.executions.get(tenantId, executionId);
    return (current?.status ?? 'canceled') as ExecutionStatus;
  }

  async retry(
    tenantId: string,
    executionId: string,
    options: { useCurrentWorkflow?: boolean; userId?: string },
  ): Promise<StartedExecution> {
    const { repos } = this.deps;
    const row = await repos.executions.get(tenantId, executionId);
    const data = await repos.executions.getData(tenantId, executionId);
    if (!row || !data) throw ApiError.notFound('Execution');
    if (!['error', 'crashed', 'canceled'].includes(row.status)) {
      throw ApiError.conflict('Only failed or stopped executions can be retried');
    }
    let definition = data.workflowData as unknown as WorkflowDefinition;
    let workflowId = row.workflowId ?? undefined;
    if (options.useCurrentWorkflow && row.workflowId) {
      const current = await repos.workflows.get(tenantId, row.workflowId);
      if (!current) throw ApiError.notFound('Workflow');
      definition = toDefinition(current);
      workflowId = current.id;
    }
    const runOptions = (data.runOptions ?? {}) as StoredRunOptions;
    const state = data.state as unknown as ExecutionState | null;
    // nodes that already succeeded are pinned so the retry continues at the failed node without
    // repeating side effects; multi-output and looping nodes re-run to keep routing correct
    const pinData: Record<string, Item[]> = { ...(runOptions.pinData ?? {}) };
    const names = new Set(definition.nodes.map((n) => n.name));
    const failedNode = state?.resultData.error?.node ?? state?.resultData.lastNodeExecuted;
    for (const [name, runs] of Object.entries(state?.resultData.runData ?? {})) {
      const task = runs[0];
      if (
        runs.length === 1 &&
        name !== failedNode &&
        names.has(name) &&
        task.executionStatus === 'success' &&
        task.data?.main?.length === 1 &&
        Object.keys(task.data).length === 1
      ) {
        pinData[name] = (task.data.main[0] ?? []) as Item[];
      }
    }
    return this.start({
      tenantId,
      workflow: definition,
      workflowId,
      mode: 'retry',
      startNode: runOptions.startNode,
      triggerItems: runOptions.triggerItems,
      pinData,
      retryOf: row.id,
      userId: options.userId,
    });
  }
}

// ---------------------------------------------------------------------------------------------

interface ExecEventResponse {
  type: 'response';
  executionId: string;
  response: EncodedResponse;
}
interface ExecEventFinished {
  type: 'finished';
  executionId: string;
  outcome: ExecutionOutcome;
}
type ExecEvent = ExecEventResponse | ExecEventFinished;

type EncodedResponse = Omit<WebhookResponse, 'binary'> & {
  binary?: { data: string; mimeType: string; fileName?: string };
};

function encodeResponse(response: WebhookResponse): EncodedResponse {
  if (!response.binary) return response as EncodedResponse;
  return {
    ...response,
    binary: { ...response.binary, data: Buffer.from(response.binary.data).toString('base64') },
  };
}

function decodeResponse(response: EncodedResponse): WebhookResponse {
  if (!response?.binary) return response as WebhookResponse;
  return { ...response, binary: { ...response.binary, data: Buffer.from(response.binary.data, 'base64') } };
}

function failedResult(state: ExecutionState): ExecutionResult {
  const now = Date.now();
  return { status: 'error', state, startedAt: now, stoppedAt: now, lastNodeOutput: null };
}

/** the node of `preferredType`, otherwise the first trigger, otherwise the engine's choice */
export function findStartNode(workflow: Workflow, preferredType: string): WorkflowNode | undefined {
  const nodes = Object.values(workflow.nodes).filter((n) => !n.disabled);
  const preferred = sortByPosition(nodes.filter((n) => n.type === preferredType))[0];
  return preferred ?? workflow.getStartNode();
}

export function assertCallerAllowed(
  name: string,
  settings: WorkflowDefinition['settings'],
  callerWorkflowId: string | undefined,
): void {
  const policy = settings?.callerPolicy ?? 'any';
  if (policy === 'none') {
    throw new Error(`Workflow "${name}" does not allow being called by other workflows`);
  }
  if (
    policy === 'allowList' &&
    (!callerWorkflowId || !(settings?.callerIds ?? []).includes(callerWorkflowId))
  ) {
    throw new Error(`Workflow "${name}" does not allow being called by this workflow`);
  }
}
