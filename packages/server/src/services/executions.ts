/**
 * Runs workflows: creates execution rows, builds `ExecutionServices` for the engine, persists
 * results according to workflow settings, publishes push events, and implements sub-workflows,
 * error workflows, retry, stop and wait/resume.
 *
 * Regular mode runs executions in this process. Queue mode enqueues them; a worker process calls
 * `runQueued`. Sub-workflows always run inline in the process running their parent.
 */
import { createHmac, hkdfSync, randomUUID, timingSafeEqual } from 'node:crypto';
import { copyFile, mkdir, rm } from 'node:fs/promises';
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
  type RunOptions,
  type SubWorkflowRequest,
  WorkflowExecute,
} from '@workflow/core';
import {
  type BinaryData,
  type CallerPolicy,
  type ChatChunkMeta,
  ExecutionCancelledError,
  type ExecutionErrorShape,
  type ExecutionMode,
  type ExecutionResult,
  type ExecutionState,
  type ExecutionStatus,
  ExecutionTimeoutError,
  type FormAuthHelper,
  type Item,
  type RunData,
  serializeError,
  sortByPosition,
  type WebhookResponse,
  Workflow,
  type WorkflowDefinition,
  type WorkflowNode,
  WorkflowOperationError,
} from '@workflow/workflow';
import type { Config } from '../config';
import type { ServiceDeps } from '../context';
import type { ExecutionRow, TenantRow } from '../db/schema';
import { ApiError } from '../http/errors';
import type { PinoLogger } from '../logger';
import { toWorkflowLogger } from '../logger';
import { currentPeriod, effectiveLimits, executionTimeoutMs, type TenantSettings } from '../plans';
import type { Repositories } from '../repositories';
import { isUuid } from '../repositories/util';
import type { MessageBus, PushService } from './bus';
import { assertCredentialsUsable } from './credential-usable';
import type { CredentialService } from './credentials';
import type { DataTableService } from './data-tables';
import { maybeSendFirstFailure } from './first-failure-mail';
import type { Metrics } from './metrics';
import { runtimeDefinition } from './published-workflow';
import type { ExecutionJob, ExecutionQueue } from './queue';
import { cloneDefinition } from './workflow-model';
import { assertNotArchived } from './workflow-rules';

export const EXECUTE_WORKFLOW_TRIGGER = 'core.executeWorkflowTrigger';
export const ERROR_TRIGGER = 'core.errorTrigger';
const MAX_SUB_WORKFLOW_DEPTH = 20;
/** modes that consume the monthly execution quota */
const BILLABLE_MODES = new Set<ExecutionMode>(['webhook', 'trigger', 'retry', 'internal', 'cli', 'chat']);
const TOOL_TEST_AFTER_WAIT =
  'A tool test cannot continue after a wait. Pin the output of the node that waits, then test the tool again';

export interface StoredRunOptions {
  startNode?: string;
  triggerItems?: Item[];
  /** partial run: the run data of an earlier execution (the engine drops the start node's and later nodes') */
  runData?: RunData;
  destinationNode?: string;
  pinData?: Record<string, Item[]>;
  /** P3-06 partial run: nodes changed since `runData` was produced */
  dirtyNodeNames?: string[];
  /** P5-76 test a tool: `destinationNode` is the tool, and its root does not run */
  agentRequest?: RunOptions['agentRequest'];
  /** P3-10: mode of the root execution, carried through nested sub-workflow calls */
  rootMode?: ExecutionMode;
  /** output of the waiting node for the next resume (null = keep its own output) */
  resumeOutput?: Item[][] | null;
  /** custom data the next resume adds (a chat reply's highlighted data; null = none) */
  resumeCustomData?: Record<string, string> | null;
  depth?: number;
  userId?: string;
  /**
   * P6-15, P6-87 (C0): the person the run acts for (a manual run's user, a signed-in trigger's user); a
   * sub-run inherits it, a retry keeps it. Private credentials resolve for this user (L14).
   */
  endUserId?: string;
  /** the execution is an error workflow or runs below one: its failure never starts another error workflow */
  errorChain?: boolean;
  /** the execution continues at the node that failed, from the state it was started with */
  retryFromFailure?: boolean;
  /** P5-61: custom execution data the run starts with (a webhook response's `customData`) */
  customData?: Record<string, string>;
  /** P5-02: the start node runs `customOperations[forceOperation]` of its type in place of `execute` */
  forceOperation?: string;
  /**
   * P6 S1: the project a run with no workflow row runs in (`StartExecutionInput.projectId`). A run with a
   * row reads the row's project first, so a move while queued wins; a run with neither fails.
   */
  projectId?: string;
  /**
   * P6-25: an inline (Workflow JSON) sub-run. Its row names the calling workflow, but its definition is not
   * that workflow's: the static data of the caller is not written from it, and a retry "with the current
   * workflow" keeps this definition.
   */
  inlineSource?: boolean;
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
  /** `ctx.sendChunk()` output (streaming response mode); `meta` names the node run and item that sent it */
  onChunk?(chunk: unknown, meta?: ChatChunkMeta): void;
  /** P5-56: a node run that sent at least one chunk has ended (chat `end` frames); `meta` is its last chunk's */
  onNodeRunEnd?(meta: ChatChunkMeta): void;
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
  /** partial run: the run data of an earlier execution that the nodes before the start node keep */
  runData?: RunData;
  destinationNode?: string;
  pinData?: Record<string, Item[]>;
  /** P3-06 partial run: nodes changed since `runData` was produced */
  dirtyNodeNames?: string[];
  /** P5-76 test a tool: `destinationNode` is the tool, and its root does not run */
  agentRequest?: RunOptions['agentRequest'];
  /** P3-10: mode of the root execution (absent = this execution is the root) */
  rootMode?: ExecutionMode;
  /** P5-61: custom execution data the run starts with (caps of `setCustomData`: 10 keys, 50, 255) */
  customData?: Record<string, string>;
  /** P5-02: the start node runs `customOperations[forceOperation]` of its type in place of `execute` */
  forceOperation?: string;
  /**
   * P6 S1: the project the run belongs to when it has no workflow row (an unsaved draft, a node test, an
   * inline sub-workflow: the parent's). Stored in `StoredRunOptions.projectId`; the row's project wins.
   */
  projectId?: string;
  /** P6-25: an inline sub-run (`StoredRunOptions.inlineSource`); `workflowId` is the calling workflow's */
  inlineSource?: boolean;
  executionId?: string;
  retryOf?: string;
  /** retry only: the state of the failed execution; the run continues at its `failedExecuteData` */
  retryState?: ExecutionState;
  parentExecutionId?: string;
  depth?: number;
  userId?: string;
  /** P6-15, P6-87 (C0): stored as `StoredRunOptions.endUserId` */
  endUserId?: string;
  /** set for sub-workflows started below an error workflow (error executions always carry it) */
  errorChain?: boolean;
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
  /** absent when PYTHON_ENABLED is off: the engine answers with the disabled text */
  pythonRunner?: CodeRunner;
  dataTables: DataTableService;
  formTokens: NonNullable<ExecutionServices['formTokens']>;
  formAuth: FormAuthHelper;
  logger: PinoLogger;
  push: PushService;
  bus: MessageBus;
  metrics: Metrics;
  queue?: ExecutionQueue;
  /**
   * P6 S2 (C0): the whole context, read lazily, for the credential gate (L16), the OAuth JWE hook (L15) and
   * the first production failure mail (L1). Absent in a hand-built service: none of the three runs.
   */
  serviceDeps?: ServiceDeps;
}

/** binary data of one execution lives in `<dir>/<tenantId>/<executionId>` */
export function binaryDirOf(config: Config, tenantId: string, executionId: string): string {
  return path.join(config.binaryData.dir, tenantId, executionId);
}

export class ExecutionService {
  /** `controller` aborts the run: a stop, a shutdown or the execution timeout */
  private readonly running = new Map<string, { controller: AbortController; done: Promise<void> }>();
  private readonly waiters = new Map<string, Waiter>();
  /** stop requests that arrived before the execution's engine was registered */
  private readonly cancelRequests = new Set<string>();
  private readonly unsubscribers: Array<() => void> = [];

  /** one key per master key, the current one first: resume URLs signed before a key rotation stay valid */
  private readonly resumeKeys: Buffer[];

  constructor(private readonly deps: ExecutionServiceDeps) {
    this.resumeKeys = deps.config.encryptionKeys.map(({ key }) =>
      Buffer.from(hkdfSync('sha256', key, Buffer.alloc(0), Buffer.from('resume-url:v1'), 32)),
    );
  }

  /**
   * `/webhook-waiting/<executionId>/<signature>`: the signature is the capability to resume the
   * execution, so knowing its id (webhook replies, logs, the editor) is not enough.
   */
  resumeUrl(executionId: string): string {
    return `${this.deps.config.baseUrl}/webhook-waiting/${executionId}/${this.resumeSignature(executionId)}`;
  }

  /**
   * `/form-waiting/<executionId>/<signature>`: the form page of a waiting execution. Signed apart from
   * resumeUrl: a public form's submitter holds this one, and it must not open /webhook-waiting.
   */
  resumeFormUrl(executionId: string): string {
    return `${this.deps.config.baseUrl}/form-waiting/${executionId}/${this.resumeSignature(executionId, 'form')}`;
  }

  /**
   * What a human review's link holds after its key, signed for this execution. `linkKey` is the key part of a link:
   * its signature comes back when a key of this instance made it, so a key rotated since the link went out still counts.
   */
  signReviewKey(executionId: string, key: string, linkKey?: string): string {
    const signatures = this.resumeKeys.map((secret) =>
      createHmac('sha256', secret).update(`review:${executionId}:${key}`).digest('base64url'),
    );
    const given = Buffer.from(linkKey?.slice(key.length + 1) ?? '');
    const held = signatures.find((signature) => {
      const expected = Buffer.from(signature);
      return given.length === expected.length && timingSafeEqual(given, expected);
    });
    return held ?? signatures[0];
  }

  private resumeSignature(executionId: string, kind: 'webhook' | 'form' = 'webhook'): string {
    return createHmac('sha256', this.resumeKeys[0]).update(`${kind}:${executionId}`).digest('base64url');
  }

  verifyResumeSignature(
    executionId: string,
    signature: string,
    kind: 'webhook' | 'form' = 'webhook',
  ): boolean {
    const given = Buffer.from(signature, 'base64url');
    return this.resumeKeys.some((key) => {
      const expected = createHmac('sha256', key).update(`${kind}:${executionId}`).digest();
      return given.length === expected.length && timingSafeEqual(given, expected);
    });
  }

  /** wire cross-process events; call once per process */
  async init(): Promise<void> {
    const { bus } = this.deps;
    this.unsubscribers.push(
      await bus.subscribe('control', (message: { type: string; executionId?: string }) => {
        if (message?.type === 'cancel' && message.executionId) {
          this.cancel(message.executionId);
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
    for (const { controller } of this.running.values()) {
      controller.abort(new ExecutionCancelledError('The server is shutting down'));
    }
  }

  private cancel(executionId: string, reason = 'Execution was stopped'): void {
    const local = this.running.get(executionId);
    if (local) {
      local.controller.abort(new ExecutionCancelledError(reason));
      return;
    }
    this.cancelRequests.add(executionId);
    setTimeout(() => this.cancelRequests.delete(executionId), 60_000).unref();
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
    // sub-workflows run inside a parent that already holds a slot; error workflows only skip the monthly quota.
    // Evaluation cases skip the plan limits: the workspace's evaluation pool (CONCURRENCY_EVALUATION_LIMIT)
    // bounds them and they are not billable, so a plan's concurrent limit never blocks a test run (P5-02)
    if (input.mode !== 'integrated' && input.mode !== 'evaluation')
      await this.checkLimits(tenant, input.mode);
    // P6 S1: the credentials must be usable in the run's project (the row's, else the given one)
    const runProject = await this.runProjectOf(tenant.id, input.workflowId, input.projectId);
    if (runProject) await assertCredentialsUsable(this.deps, tenant.id, runProject, input.workflow);

    const executionId = input.executionId ?? randomUUID();
    const workflowData = cloneDefinition(input.workflow);
    const runOptions: StoredRunOptions = {
      startNode: input.startNode,
      triggerItems: input.triggerItems,
      runData: input.runData,
      destinationNode: input.destinationNode,
      pinData: input.pinData,
      dirtyNodeNames: input.dirtyNodeNames,
      agentRequest: input.agentRequest,
      rootMode: input.rootMode,
      depth: input.depth ?? 0,
      userId: input.userId,
      endUserId: input.endUserId,
      errorChain: input.mode === 'error' || input.errorChain === true ? true : undefined,
      retryFromFailure: input.retryState ? true : undefined,
      customData: input.customData,
      forceOperation: input.forceOperation,
      projectId: input.projectId,
      inlineSource: input.inlineSource ? true : undefined,
    };
    const workflowId = input.workflowId ?? input.workflow.id ?? null;
    try {
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
          workflowVersionId: input.workflow.versionId ?? null,
        },
        {
          workflowData: workflowData as unknown as Record<string, unknown>,
          runOptions: JSON.parse(JSON.stringify(runOptions)),
        },
      );
    } catch (error) {
      // files a trigger stored for this execution (webhook uploads) have no row to be pruned with
      await this.removeBinaryData(tenant.id, executionId);
      throw error;
    }
    this.deps.push.send(
      tenant.id,
      'executionStarted',
      { executionId, workflowId, mode: input.mode },
      { workflowId: workflowId ?? undefined },
    );

    // start() rejects only while the execution cannot run, so callers may clean up after a rejection
    const finished = input.wait || input.observer ? this.addWaiter(executionId, input.observer) : undefined;
    try {
      // saved before the run is scheduled so that a worker never starts without it
      if (input.retryState) await repos.executions.saveState(tenant.id, executionId, input.retryState);
      // only production executions count towards the monthly quota
      if (BILLABLE_MODES.has(input.mode)) await repos.usage.increment(tenant.id, currentPeriod(), 1, 0);
      if (this.deps.queue && !input.inline) {
        await this.deps.queue.enqueue({
          executionId,
          tenantId: tenant.id,
          kind: 'run',
          notify: Boolean(finished),
        });
      }
    } catch (error) {
      await this.abandon(tenant.id, executionId, workflowId);
      throw error;
    }
    if (!this.deps.queue || input.inline) this.runInBackground(tenant.id, executionId, 'run', 'local');
    return { executionId, finished };
  }

  /**
   * P6 S1: the project a context outside a run belongs to (a trigger, a webhook, a resume page): the workflow
   * row's, else `fallbackProjectId` (a run's stored project); 404 `Workflow` when there is neither.
   */
  async projectFor(
    tenantId: string,
    workflowId: string | null | undefined,
    fallbackProjectId?: string,
  ): Promise<string> {
    const projectId = await this.runProjectOf(tenantId, workflowId, fallbackProjectId);
    if (!projectId) throw ApiError.notFound('Workflow');
    return projectId;
  }

  /**
   * P6 S1: the project a run belongs to: its workflow row's (read at run time, so a move while queued wins),
   * else the stored one (`StoredRunOptions.projectId`); undefined when there is neither.
   */
  private async runProjectOf(
    tenantId: string,
    workflowId: string | null | undefined,
    storedProjectId: string | undefined,
  ): Promise<string | undefined> {
    if (workflowId) {
      const row = await this.deps.repos.workflows.get(tenantId, workflowId);
      if (row) return row.projectId;
    }
    return storedProjectId;
  }

  /** an execution row exists but the run could not be scheduled: close it so it holds no concurrency slot */
  private async abandon(tenantId: string, executionId: string, workflowId: string | null): Promise<void> {
    const message = 'The execution could not be scheduled';
    this.waiters.delete(executionId);
    await this.deps.repos.executions
      .update(tenantId, executionId, { status: 'crashed', stoppedAt: new Date(), errorMessage: message })
      .catch((e) =>
        this.deps.logger.warn({ err: e, tenantId, executionId }, 'Execution could not be closed'),
      );
    await this.removeBinaryData(tenantId, executionId);
    this.deps.push.send(
      tenantId,
      'executionFinished',
      { executionId, workflowId, status: 'crashed', error: { message } },
      { workflowId: workflowId ?? undefined },
    );
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

  private deliverChunk(executionId: string, chunk: unknown, meta?: ChatChunkMeta): void {
    for (const o of this.waiters.get(executionId)?.observers ?? []) o.onChunk?.(chunk, meta);
  }

  private deliverNodeRunEnd(executionId: string, meta: ChatChunkMeta): void {
    for (const o of this.waiters.get(executionId)?.observers ?? []) o.onNodeRunEnd?.(meta);
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
    else if (message.type === 'chunk') this.deliverChunk(message.executionId, message.chunk, message.meta);
    else if (message.type === 'nodeEnd') this.deliverNodeRunEnd(message.executionId, message.meta);
    else if (message.type === 'finished') this.deliverFinished(message.outcome);
  }

  // -------------------------------------------------------------------------------------------
  // running

  /** queue worker entry point */
  async runQueued(job: ExecutionJob, meta: { redelivered?: boolean } = {}): Promise<void> {
    const delivery: Delivery = job.notify ? 'bus' : 'none';
    if (meta.redelivered) {
      // the worker that ran this job died mid-execution: do not run it a second time
      const row = await this.deps.repos.executions.get(job.tenantId, job.executionId);
      const message = 'The worker running this execution stopped unexpectedly';
      const stoppedAt = new Date();
      const closed =
        row &&
        (await this.deps.repos.executions.transition(job.tenantId, job.executionId, ['new', 'running'], {
          status: 'crashed',
          stoppedAt,
          errorMessage: message,
        }));
      if (row && closed) {
        const durationMs = row.startedAt ? stoppedAt.getTime() - row.startedAt.getTime() : 0;
        await this.afterCrash(job.tenantId, row, message, { durationMs }).catch((e) =>
          this.deps.logger.warn(
            { err: e, tenantId: job.tenantId, executionId: job.executionId },
            'Crashed execution could not be closed',
          ),
        );
        this.emitFinished(
          { executionId: job.executionId, status: 'crashed', error: { name: 'Error', message } },
          delivery,
        );
        return;
      }
    }
    await this.run(job.tenantId, job.executionId, job.kind, delivery);
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
    // claim atomically: a stop request may have canceled the execution in the meantime
    const claimed =
      kind === 'run'
        ? await repos.executions.transition(tenantId, executionId, ['new'], {
            status: 'running',
            startedAt: new Date(),
          })
        : row.status === 'running';
    const tenant = await repos.tenants.get(tenantId);
    if (!claimed || !tenant) {
      const current = await repos.executions.get(tenantId, executionId);
      emit({ executionId, status: (current?.status ?? row.status) as ExecutionStatus });
      return;
    }

    const definition = data.workflowData as unknown as WorkflowDefinition;
    const options = (data.runOptions ?? {}) as StoredRunOptions;
    const staticBefore = JSON.stringify(definition.staticData ?? {});
    const limits = effectiveLimits(tenant.plan, tenant.settings as TenantSettings);
    const timeoutMs = executionTimeoutMs(this.deps.config, limits, definition.settings?.executionTimeout);

    const controller = new AbortController();
    const { signal } = controller;
    let workflow: Workflow;
    let engine: WorkflowExecute;
    try {
      workflow = new Workflow(definition, nodeTypes);
      const projectId = await this.runProjectOf(tenant.id, row.workflowId, options.projectId);
      if (!projectId) throw new WorkflowOperationError('The project of this execution could not be found');
      const services = await this.buildServices({
        tenant,
        executionId,
        projectId,
        mode: row.mode as ExecutionMode,
        workflowId: row.workflowId ?? undefined,
        depth: options.depth ?? 0,
        errorChain: options.errorChain,
        rootMode: options.rootMode,
        endUserId: options.endUserId,
        startNode: options.startNode,
        workflow: definition,
        hooks: this.hooks(tenant.id, row, definition, delivery),
        signal,
      });
      engine = new WorkflowExecute(
        workflow,
        services,
        kind === 'resume' || options.retryFromFailure
          ? ((data.state as unknown as ExecutionState) ?? undefined)
          : undefined,
      );
    } catch (error) {
      const state = createInitialState();
      state.resultData.error = serializeError(error);
      await this.finish(tenant, row, definition, staticBefore, failedResult(state), delivery, options);
      return;
    }

    let release!: () => void;
    const done = new Promise<void>((r) => {
      release = r;
    });
    this.running.set(executionId, { controller, done });
    if (this.cancelRequests.delete(executionId)) {
      controller.abort(new ExecutionCancelledError('Execution was stopped'));
    }
    // the engine enforces the timeout too; this one also reaches the sub-workflows the execution waits for
    const timer = timeoutMs
      ? setTimeout(() => controller.abort(new ExecutionTimeoutError(timeoutMs / 1000)), timeoutMs)
      : undefined;
    // set by finish() once the run is counted in usage and metrics: a crash after that is not counted again
    const tally = { counted: false };
    try {
      let result: ExecutionResult;
      try {
        if (kind === 'run' && options.retryFromFailure) {
          result = await engine.retryFromFailure({ timeoutMs, signal });
        } else if (kind === 'run') {
          result = await engine.run({
            startNode: options.startNode,
            triggerItems: options.triggerItems,
            runData: options.runData,
            destinationNode: options.destinationNode,
            pinData: options.pinData,
            dirtyNodeNames: options.dirtyNodeNames,
            agentRequest: options.agentRequest,
            customData: options.customData,
            forceOperation: options.forceOperation,
            timeoutMs,
            signal,
          });
        } else if (options.agentRequest) {
          // the engine holds the request in the run that started it: resumed, the root would run as a node
          throw new WorkflowOperationError(TOOL_TEST_AFTER_WAIT);
        } else {
          result = await engine.resume({
            output: options.resumeOutput ?? undefined,
            customData: options.resumeCustomData ?? undefined,
            timeoutMs,
            signal,
          });
        }
      } catch (error) {
        // run()/resume() reject only before processing starts (no start node, not waiting...)
        engine.state.resultData.error = serializeError(error);
        result = failedResult(engine.state);
      }
      await this.finish(tenant, row, definition, staticBefore, result, delivery, options, tally);
    } catch (error) {
      logger.error({ err: error, tenantId, executionId }, 'Could not persist execution result');
      // the row must not stay 'running': it would hold a concurrency slot and never alert anyone
      const message = `Could not store the execution result: ${(error as Error).message}`.slice(0, 2000);
      const stoppedAt = new Date();
      const closed = await repos.executions
        .transition(tenantId, executionId, ['new', 'running'], {
          status: 'crashed',
          stoppedAt,
          errorMessage: message,
        })
        .catch(() => false);
      if (closed) {
        const durationMs = row.startedAt ? stoppedAt.getTime() - row.startedAt.getTime() : 0;
        await this.afterCrash(tenantId, row, message, {
          durationMs: tally.counted ? undefined : durationMs,
          state: engine.state,
        }).catch((e) =>
          logger.warn({ err: e, tenantId, executionId }, 'Crashed execution could not be closed'),
        );
      }
      emit({ executionId, status: 'crashed', error: serializeError(error) });
    } finally {
      clearTimeout(timer);
      this.running.delete(executionId);
      release();
    }
  }

  /**
   * An execution was closed as crashed outside finish() (its worker or process died, or its result could not
   * be stored): announce it, account for it and start its error workflow. `durationMs` is left out when the
   * time it ran is unknown.
   */
  private async afterCrash(
    tenantId: string,
    row: ExecutionRow,
    message: string,
    opts: { durationMs?: number; state?: ExecutionState } = {},
  ): Promise<void> {
    const { repos, push, metrics, logger } = this.deps;
    push.send(
      tenantId,
      'executionFinished',
      { executionId: row.id, workflowId: row.workflowId, status: 'crashed', error: { message } },
      { workflowId: row.workflowId ?? undefined },
    );
    if (opts.durationMs !== undefined) {
      const durationMs = Math.max(0, opts.durationMs);
      await repos.usage.increment(tenantId, currentPeriod(), 0, durationMs);
      metrics.recordExecution('crashed', row.mode, durationMs);
    }
    const data = await repos.executions.getData(tenantId, row.id);
    if (!data) return;
    const definition = data.workflowData as unknown as WorkflowDefinition;
    const options = (data.runOptions ?? {}) as StoredRunOptions;
    const state = opts.state ?? (data.state as unknown as ExecutionState | null) ?? createInitialState();
    state.resultData.error = serializeError(new Error(message));
    await this.startErrorWorkflow(tenantId, row, definition, state, options).catch((e) =>
      logger.warn({ err: e, tenantId, executionId: row.id }, 'Error workflow could not start'),
    );
  }

  /** regular-mode startup: close the executions a previous process left running and alert about them */
  async markCrashed(): Promise<number> {
    const rows = await this.deps.repos.executions.markCrashed();
    for (const row of rows) {
      await this.afterCrash(row.tenantId, row, row.errorMessage ?? 'The process stopped').catch((e) =>
        this.deps.logger.warn(
          { err: e, tenantId: row.tenantId, executionId: row.id },
          'Crashed execution could not be closed',
        ),
      );
    }
    return rows.length;
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
    // P6 S1: the push envelope names the workflow, so the stream can leave it out for users who cannot read it
    const about = { workflowId: row.workflowId ?? definition.id ?? undefined };
    // node runs that sent a chunk, by `<node>:<run>`, with the meta of their last chunk: their end is announced
    const chunked = new Map<string, ChatChunkMeta>();
    return {
      nodeExecuteBefore: (nodeName) => {
        if (manual) push.send(tenantId, 'nodeExecuteBefore', { executionId, nodeName }, about);
      },
      nodeExecuteAfter: async (nodeName, runIndex, taskData, state) => {
        const ended = chunked.get(`${nodeName}:${runIndex}`);
        if (ended) {
          chunked.delete(`${nodeName}:${runIndex}`);
          if (delivery === 'local') this.deliverNodeRunEnd(executionId, ended);
          else if (delivery === 'bus') {
            void this.deps.bus
              .publish('exec-events', { type: 'nodeEnd', executionId, meta: ended })
              .catch(() => {});
          }
        }
        if (manual)
          push.send(tenantId, 'nodeExecuteAfter', { executionId, nodeName, runIndex, taskData }, about);
        if (definition.settings?.saveExecutionProgress) {
          // progress is best effort: a failed write must not fail the node that just ran
          await repos.executions.saveState(tenantId, executionId, state).catch((e) => {
            this.deps.logger.warn({ err: e, tenantId, executionId, nodeName }, 'Progress could not be saved');
          });
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
      sendChunk: (chunk, meta) => {
        if (meta) chunked.set(`${meta.nodeName}:${meta.runIndex}`, meta);
        if (delivery === 'local') this.deliverChunk(executionId, chunk, meta);
        else if (delivery === 'bus') {
          void this.deps.bus
            .publish('exec-events', { type: 'chunk', executionId, chunk, meta })
            .catch(() => {});
        }
      },
      sendMessageToUI: (nodeName, args) => {
        push.send(tenantId, 'consoleMessage', { executionId, nodeName, args }, about);
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
    /** the stored run options: error chain, inline source, stored project */
    run: Pick<StoredRunOptions, 'errorChain' | 'inlineSource' | 'projectId'>,
    tally?: { counted: boolean },
  ): Promise<void> {
    const { repos, push, metrics, logger } = this.deps;
    const { status, state } = result;
    const settings = definition.settings ?? {};
    const error = state.resultData.error;
    const durationMs = Math.max(0, result.stoppedAt - result.startedAt);
    let lastNodeOutput = result.lastNodeOutput ?? null;

    let keep = true;
    if (status === 'waiting') keep = true;
    // an evaluation case is always saved: its test case row links the execution (n8n does the same)
    else if (row.mode === 'evaluation') keep = true;
    else if (row.mode === 'manual') keep = settings.saveManualExecutions !== false;
    else if (status === 'success') keep = settings.saveDataSuccessExecution !== 'none';
    else keep = settings.saveDataErrorExecution !== 'none';

    // static data written by nodes (poll cursors, counters) is persisted for production runs, BEFORE the
    // final status: a client or trigger that sees the run finished must not start from the old data. A
    // failed write is logged and never leaves the row in 'running'. An inline sub-run's static data is not
    // its row's workflow's (P6-25): it is never merged into the caller's.
    if (row.mode !== 'manual' && row.workflowId && !run.inlineSource) {
      const after = definition.staticData ?? {};
      if (JSON.stringify(after) !== staticBefore) {
        await repos.staticData
          .merge(tenant.id, row.workflowId, JSON.parse(staticBefore), after)
          .catch((e) =>
            logger.warn(
              { err: e, tenantId: tenant.id, executionId: row.id, workflowId: row.workflowId },
              'Static data could not be saved',
            ),
          );
      }
    }

    // linked before the final status is written: whoever sees the retry finished also sees the link
    if (status === 'success' && row.retryOf) {
      await repos.executions.update(tenant.id, row.retryOf, { retrySuccessId: row.id });
    }
    // counted before the final status is written: whoever sees the run finished also sees it in the usage
    // and the metrics (a client polling the status, then reading /metrics)
    if (status !== 'waiting') {
      await repos.usage.increment(tenant.id, currentPeriod(), 0, durationMs);
      metrics.recordExecution(status, row.mode, durationMs);
      if (tally) tally.counted = true;
    }
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
      if (lastNodeOutput)
        lastNodeOutput = await this.handOverBinaryData(
          tenant.id,
          row,
          lastNodeOutput,
          delivery,
          run.projectId,
        );
      await repos.executions.delete(tenant.id, row.id);
      await this.removeBinaryData(tenant.id, row.id);
    }

    push.send(
      tenant.id,
      'executionFinished',
      {
        executionId: row.id,
        workflowId: row.workflowId,
        status,
        ...(error ? { error: { message: error.message, node: error.node } } : {}),
      },
      { workflowId: row.workflowId ?? undefined },
    );

    if (status === 'error' || status === 'crashed') {
      await this.startErrorWorkflow(tenant.id, row, definition, state, run).catch((e) =>
        logger.warn({ err: e, tenantId: tenant.id, executionId: row.id }, 'Error workflow could not start'),
      );
      // P6-17: the workspace's first production failure mail (sent once)
      const { serviceDeps } = this.deps;
      if (serviceDeps && row.workflowId && row.mode !== 'manual' && row.mode !== 'evaluation') {
        const workflowId = row.workflowId;
        void maybeSendFirstFailure(serviceDeps, tenant.id, workflowId).catch((e) =>
          logger.warn(
            { err: e, tenantId: tenant.id, executionId: row.id, workflowId },
            'First failure mail could not be sent',
          ),
        );
      }
    }

    this.emitFinished(
      {
        executionId: row.id,
        status,
        error,
        lastNodeExecuted: state.resultData.lastNodeExecuted,
        lastNodeOutput,
      },
      delivery,
    );
  }

  /**
   * The binary files of an execution that is not saved are removed when it finishes, but whoever waits for it
   * (a parent execution, a webhook answering with the output) still reads them: a parent gets copies in its
   * own directory, anyone else gets the content inline. Returns the output with the references rewritten.
   */
  private async handOverBinaryData(
    tenantId: string,
    row: ExecutionRow,
    output: Item[][],
    delivery: Delivery,
    /** the stored project of a run with no workflow row */
    storedProjectId: string | undefined,
  ): Promise<Item[][]> {
    if (this.deps.config.binaryData.mode !== 'filesystem') return output;
    const waited = delivery === 'bus' || (delivery === 'local' && this.waiters.has(row.id));
    if (!waited) return output;
    // node outputs are frozen
    const copy = JSON.parse(JSON.stringify(output)) as Item[][];
    // P6-25: only the files this run may reach are handed over
    const reach = this.binaryReach(tenantId, {
      executionId: row.id,
      projectId: await this.runProjectOf(tenantId, row.workflowId, storedProjectId),
      workflowId: row.workflowId ?? undefined,
    });
    if (row.parentExecutionId) {
      await this.adoptBinaryData(tenantId, row.parentExecutionId, copy, reach);
      return copy;
    }
    const store = this.reachableStore(tenantId, reach);
    for (const item of copy.flat()) {
      for (const [key, binary] of Object.entries(item?.binary ?? {})) {
        const { id, ...inline } = binary;
        if (!id) continue;
        // a file that cannot be read keeps its reference, and the consumer reports it
        const data = await store.getBuffer(binary).catch(() => undefined);
        if (data && item.binary) item.binary[key] = { ...inline, data: Buffer.from(data).toString('base64') };
      }
    }
    return copy;
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

  /**
   * P6-25: whether a run may reach a stored file by its id, so that a run never reaches another project's
   * files. `fs:<tenant>/<executionId>/<file>` resolves when that execution is this run, one of its parent
   * runs, or a run of a workflow owned by or shared into this run's project; `fs:<tenant>/activation/
   * <workflowId>/<file>` when that workflow is this run's or is in its project. A folder run with no
   * workflow row, `activation/<file>` and any other id do not resolve (the route serves those to owner
   * and admin only). Answers are kept for the life of the returned check.
   */
  binaryReach(
    tenantId: string,
    run: { executionId: string; projectId?: string; workflowId?: string },
  ): (id: string) => Promise<boolean> {
    const { repos } = this.deps;
    let parents: Promise<Set<string>> | undefined;
    const parentRuns = async () => {
      const ids = new Set<string>();
      let id = run.executionId;
      // the bound stops a loop in bad data
      while (isUuid(id) && ids.size < 100) {
        const parent = (await repos.executions.get(tenantId, id))?.parentExecutionId;
        if (!parent || ids.has(parent)) break;
        ids.add(parent);
        id = parent;
      }
      return ids;
    };
    const inProject = async (workflowId: string) => {
      if (workflowId === run.workflowId) return true;
      if (!run.projectId) return false;
      const workflow = await repos.workflows.get(tenantId, workflowId);
      if (!workflow) return false;
      if (workflow.projectId === run.projectId) return true;
      return (await repos.shares.projectsSharingWorkflow(tenantId, workflowId)).includes(run.projectId);
    };
    const reachFolder = async (folder: string) => {
      if (!isUuid(folder)) return false;
      parents ??= parentRuns();
      if ((await parents).has(folder)) return true;
      const workflowId = (await repos.executions.get(tenantId, folder))?.workflowId;
      return workflowId ? inProject(workflowId) : false;
    };
    const known = new Map<string, Promise<boolean>>();
    const cached = (key: string, answer: () => Promise<boolean>) => {
      let found = known.get(key);
      if (!found) {
        found = answer();
        known.set(key, found);
      }
      return found;
    };
    return async (id) => {
      const parts = id.startsWith('fs:') ? id.slice(3).split('/') : [];
      if (parts[0] !== tenantId) return false;
      if (parts.length === 3 && run.executionId && parts[1] === run.executionId) return true;
      if (parts.length === 3) return cached(parts[1], () => reachFolder(parts[1]));
      if (parts.length === 4 && parts[1] === 'activation' && isUuid(parts[2])) {
        return cached(`activation/${parts[2]}`, () => inProject(parts[2]));
      }
      return false;
    };
  }

  /**
   * P6-25: the filesystem store with `getBuffer` limited to the files `reach` allows and the files this
   * store wrote (a context with no execution writes to `activation/`)
   */
  private reachableStore(tenantId: string, reach: (id: string) => Promise<boolean>): BinaryDataStore {
    const store = this.binaryStore(tenantId);
    if (this.deps.config.binaryData.mode !== 'filesystem') return store;
    const written = new Set<string>();
    return {
      store: async (data, meta) => {
        const stored = await store.store(data, meta);
        if (stored.id) written.add(stored.id);
        return stored;
      },
      getBuffer: async (binary) => {
        if (binary.id && !written.has(binary.id) && !(await reach(binary.id))) {
          throw new Error('Binary data not found');
        }
        return store.getBuffer(binary);
      },
    };
  }

  /**
   * P6-25: the bytes of a stored file that a finished run hands out (a webhook answering with the last
   * node's file), read with that run's reach: never another project's file
   */
  async runBinaryBuffer(tenantId: string, executionId: string, binary: BinaryData): Promise<Uint8Array> {
    const row = await this.deps.repos.executions.get(tenantId, executionId);
    const reach = this.binaryReach(tenantId, {
      executionId,
      projectId: await this.runProjectOf(tenantId, row?.workflowId, undefined),
      workflowId: row?.workflowId ?? undefined,
    });
    return this.reachableStore(tenantId, reach).getBuffer(binary);
  }

  async buildServices(input: {
    tenant: TenantRow;
    executionId: string;
    /** P6 S1: the project the run belongs to (its workflow row's); variables, credentials and data tables come from it */
    projectId: string;
    /** P6 S1: credential ids a server path allows beyond the project's own (`options.allow`, never from a node or a body) */
    allowCredentials?: string[];
    mode: ExecutionMode;
    workflowId?: string;
    depth?: number;
    errorChain?: boolean;
    /** P3-10: mode of the root execution; absent = `mode` (this execution is the root) */
    rootMode?: ExecutionMode;
    /** P6-15, P6-87 (C0): the person the run acts for (`StoredRunOptions.endUserId`) */
    endUserId?: string;
    /** P6-87 (C0): the node the run starts at (the trigger the credential gate walks from) */
    startNode?: string;
    /** P6-87 (C0): the definition that runs; with it the services carry the credential gate */
    workflow?: WorkflowDefinition;
    hooks?: ExecutionHooks;
    /** aborts when the execution is stopped or times out; sub-workflows it waits for are canceled then */
    signal?: AbortSignal;
  }): Promise<ExecutionServices> {
    const { config, repos, nodeTypes, credentials, http, codeRunner, pythonRunner, logger } = this.deps;
    const { dataTables, formTokens, formAuth } = this.deps;
    const { tenant, executionId } = input;
    const settings = tenant.settings as TenantSettings;
    const depth = input.depth ?? 0;
    // P6 S2 (C0): the gate (L16) and the OAuth JWE hook (L15); both stubs PASS (ready, token unchanged)
    const shared = this.deps.serviceDeps?.context();
    return {
      tenantId: tenant.id,
      projectId: input.projectId,
      executionId,
      mode: input.mode,
      timezone: settings.timezone ?? config.defaultTimezone,
      variables: await repos.variables.map(tenant.id, input.projectId),
      instanceBaseUrl: config.baseUrl,
      resumeUrl: executionId ? this.resumeUrl(executionId) : undefined,
      resumeFormUrl: executionId ? this.resumeFormUrl(executionId) : undefined,
      signReviewKey: executionId ? (key) => this.signReviewKey(executionId, key) : undefined,
      nodeTypes,
      credentialTypes: credentials.types,
      credentials: credentials.provider(tenant.id, input.projectId, {
        allow: input.allowCredentials,
        endUserId: input.endUserId,
        executionId: executionId || undefined,
        startNode: input.startNode,
      }),
      credentialGate:
        shared && input.workflow
          ? shared.credentialGate.forRun(tenant.id, input.workflow, input.projectId, input.startNode)
          : undefined,
      oauthTokenDecrypt: shared
        ? (token, data) => shared.oauthJwe.decryptResponse(tenant.id, token, data)
        : undefined,
      // P6-25: a node reads only the stored files of this run, its parent runs and its project
      binaryData: this.reachableStore(
        tenant.id,
        this.binaryReach(tenant.id, {
          executionId,
          projectId: input.projectId,
          workflowId: input.workflowId,
        }),
      ),
      codeRunner,
      pythonRunner,
      dataTables: dataTables.forProject(tenant.id, input.projectId, { workflowId: input.workflowId }),
      formTokens,
      formAuth,
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
      nodeLimits: config.nodeLimits,
      disablePublicChatTrigger: config.disablePublicChatTrigger,
      executeSubWorkflow: (request) =>
        this.executeSubWorkflow(
          request,
          input.projectId,
          depth,
          input.errorChain === true,
          input.signal,
          input.rootMode ?? input.mode,
          input.endUserId,
        ),
    };
  }

  /**
   * P5-02: run one node's custom operation (`customOperations[operation]` of its type, e.g. the Evaluation
   * Trigger's `dataset.getRows`) and return its first output. No execution row, no usage, no events: the
   * caller (the evaluation runner) only needs the items. Runs as `manual` with the workflow's timeout, and
   * throws the run's error.
   */
  async runNodeOperation(
    tenantId: string,
    definition: WorkflowDefinition,
    nodeName: string,
    operation: string,
    signal?: AbortSignal,
  ): Promise<Item[]> {
    const { repos, nodeTypes } = this.deps;
    const tenant = await repos.tenants.get(tenantId);
    if (!tenant) throw ApiError.notFound('Tenant');
    const limits = effectiveLimits(tenant.plan, tenant.settings as TenantSettings);
    const timeoutMs = executionTimeoutMs(this.deps.config, limits, definition.settings?.executionTimeout);
    const workflow = new Workflow(cloneDefinition(definition), nodeTypes);
    // P6 S1: the operation runs in the project of the workflow row the definition was loaded from
    const projectId = await this.runProjectOf(tenant.id, definition.id, undefined);
    if (!projectId) throw ApiError.notFound('Workflow');
    const services = await this.buildServices({
      tenant,
      executionId: '',
      projectId,
      mode: 'manual',
      workflowId: definition.id ?? undefined,
      signal,
    });
    const result = await new WorkflowExecute(workflow, services).run({
      startNode: nodeName,
      destinationNode: nodeName,
      forceOperation: operation,
      signal,
      timeoutMs,
    });
    const error = result.state.resultData.error;
    if (result.status !== 'success' || error) {
      throw new WorkflowOperationError(error?.message ?? `Node "${nodeName}" did not finish`);
    }
    const runs = result.state.resultData.runData[nodeName] ?? [];
    const output = runs[runs.length - 1]?.data?.main?.[0] ?? result.lastNodeOutput?.[0] ?? [];
    return JSON.parse(JSON.stringify(output)) as Item[];
  }

  // -------------------------------------------------------------------------------------------
  // sub-workflows and error workflows

  private async executeSubWorkflow(
    request: SubWorkflowRequest,
    /** P6 S1: the parent's project; an inline (parameter) sub-workflow has no row and runs in it */
    parentProjectId: string,
    depth: number,
    errorChain: boolean,
    signal?: AbortSignal,
    rootMode?: ExecutionMode,
    /** P6-15 (C0): a sub-run acts for the parent's person */
    endUserId?: string,
  ): Promise<{ executionId: string; data: Item[][] | null }> {
    if (depth >= MAX_SUB_WORKFLOW_DEPTH) {
      throw new Error(`Sub-workflows can be nested at most ${MAX_SUB_WORKFLOW_DEPTH} levels deep`);
    }
    const { repos, nodeTypes } = this.deps;
    const tenantId = request.parent.tenantId;
    let definition: WorkflowDefinition;
    let workflowId: string | undefined;
    // a database callee runs in its own row's project (read again at run time); an inline one in the parent's
    let projectId: string | undefined;
    let inlineSource = false;
    if (request.source.source === 'database') {
      const row = await repos.workflows.get(tenantId, request.source.workflowId ?? '');
      if (!row) throw new Error(`Workflow "${request.source.workflowId ?? ''}" was not found`);
      assertNotArchived(row, 'call');
      // P6-25: the caller policy compares the caller's project with the callee's (workflow tools share this door)
      assertCallerAllowed(
        row.name,
        row.settings as WorkflowDefinition['settings'],
        { workflowId: request.parent.workflowId, projectId: parentProjectId },
        row.projectId,
        this.deps.config.workflowCallerPolicyDefault,
      );
      // the callee version follows the root run's mode, through nested calls too (P3-10)
      definition = await runtimeDefinition(repos, tenantId, row, rootMode);
      workflowId = row.id;
    } else {
      if (!request.source.workflow) throw new Error('No workflow definition was given');
      // P6-25, as n8n: an inline sub-run belongs to the workflow that called it (its id on the row and the
      // definition, any id in the JSON ignored), so the caller's project reads it; it runs in that project
      const parentRow = request.parent.workflowId
        ? await repos.workflows.get(tenantId, request.parent.workflowId)
        : undefined;
      definition = { ...cloneDefinition(request.source.workflow), id: parentRow?.id };
      workflowId = parentRow?.id;
      projectId = parentProjectId;
      inlineSource = true;
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
      projectId,
      inlineSource,
      rootMode,
      depth: depth + 1,
      errorChain,
      endUserId,
      inline: !detached,
      wait: !detached,
    });
    if (detached || !finished) return { executionId, data: [request.items] };
    const outcome = await this.awaitSubWorkflow(executionId, finished, signal);
    if (outcome.status === 'error' || outcome.status === 'crashed' || outcome.status === 'canceled') {
      throw new Error(outcome.error?.message ?? `Sub-workflow execution ${executionId} failed`);
    }
    return { executionId, data: outcome.lastNodeOutput ?? null };
  }

  /** the outcome of a sub-workflow; when the parent is stopped or times out first, the child is canceled */
  private async awaitSubWorkflow(
    executionId: string,
    finished: Promise<ExecutionOutcome>,
    signal?: AbortSignal,
  ): Promise<ExecutionOutcome> {
    if (!signal) return finished;
    let onAbort!: () => void;
    const aborted = new Promise<never>((_, reject) => {
      onAbort = () => {
        const timedOut = signal.reason instanceof ExecutionTimeoutError;
        this.cancel(
          executionId,
          timedOut ? 'The parent execution timed out' : 'The parent execution was stopped',
        );
        reject(signal.reason);
      };
    });
    if (signal.aborted) onAbort();
    else signal.addEventListener('abort', onAbort, { once: true });
    try {
      return await Promise.race([finished, aborted]);
    } finally {
      signal.removeEventListener('abort', onAbort);
    }
  }

  /** an activation failure has no execution row, so it cannot go through startErrorWorkflow (L12) */
  async runActivationErrorWorkflow(
    tenantId: string,
    workflowId: string,
    error: { message: string; node?: string },
  ): Promise<void> {
    const { repos, nodeTypes, logger } = this.deps;
    const row = await repos.workflows.get(tenantId, workflowId);
    const errorWorkflowId = (row?.settings as { errorWorkflow?: string } | null | undefined)?.errorWorkflow;
    if (!row || !errorWorkflowId) return;
    const target = await repos.workflows.get(tenantId, errorWorkflowId);
    if (!target) {
      logger.warn({ tenantId, errorWorkflowId }, 'Error workflow not found');
      return;
    }
    // the error workflow runs its published version, or its draft when it was never published (P3-10)
    const targetDefinition = await runtimeDefinition(repos, tenantId, target, 'error');
    const start = findStartNode(new Workflow(targetDefinition, nodeTypes), ERROR_TRIGGER);
    if (!start) return;
    // P6-25, as n8n: the error workflow passes the caller policy of the failed workflow's project
    assertCallerAllowed(
      target.name,
      target.settings as WorkflowDefinition['settings'],
      { workflowId: row.id, projectId: row.projectId },
      target.projectId,
      this.deps.config.workflowCallerPolicyDefault,
    );
    await this.start({
      tenantId,
      workflow: targetDefinition,
      workflowId: target.id,
      mode: 'error',
      startNode: start.name,
      triggerItems: [
        {
          json: {
            trigger: {
              error: {
                name: 'WorkflowActivationError',
                message: error.message,
                ...(error.node ? { node: { name: error.node } } : {}),
              },
              mode: 'trigger',
            },
            workflow: { id: row.id, name: row.name },
          },
        },
      ],
    });
  }

  private async startErrorWorkflow(
    tenantId: string,
    row: ExecutionRow,
    definition: WorkflowDefinition,
    state: ExecutionState,
    run: Pick<StoredRunOptions, 'errorChain' | 'projectId'> = {},
  ): Promise<void> {
    const errorWorkflowId = definition.settings?.errorWorkflow;
    // a failing error workflow, or a sub-workflow it called, never starts another one: error workflows
    // naming each other (directly or through Execute Workflow) would loop
    if (!errorWorkflowId || row.mode === 'manual' || row.mode === 'error' || run.errorChain) return;
    const target = await this.deps.repos.workflows.get(tenantId, errorWorkflowId);
    if (!target) {
      this.deps.logger.warn({ tenantId, errorWorkflowId }, 'Error workflow not found');
      return;
    }
    // the error workflow runs its published version, or its draft when it was never published (P3-10)
    const targetDefinition = await runtimeDefinition(this.deps.repos, tenantId, target, 'error');
    const start = findStartNode(new Workflow(targetDefinition, this.deps.nodeTypes), ERROR_TRIGGER);
    if (!start) return;
    // P6-25, as n8n (workflow-execution.service.ts): the error workflow passes the caller policy, the failed
    // run's project against the error workflow's; refused, it does not start (the callers log it)
    const callerProjectId = await this.runProjectOf(tenantId, row.workflowId, run.projectId);
    assertCallerAllowed(
      target.name,
      target.settings as WorkflowDefinition['settings'],
      { workflowId: row.workflowId ?? undefined, projectId: callerProjectId },
      target.projectId,
      this.deps.config.workflowCallerPolicyDefault,
    );
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
   * resume calls and the wait tracker cannot resume it twice. `atWait` is the tool's wait the caller checked its
   * answer against: the claim fails when the run has moved on to another.
   */
  async resume(
    tenantId: string,
    executionId: string,
    output?: Item[][],
    opts: {
      wait?: boolean;
      observer?: ExecutionObserver;
      atWait?: { toolNode: string; toolRunIndex: number };
      /** custom data the resume adds (a chat reply's highlighted data) */
      customData?: Record<string, string>;
    } = {},
  ): Promise<StartedExecution | undefined> {
    const { repos, queue } = this.deps;
    const data = await repos.executions.getData(tenantId, executionId);
    if (!data) return undefined;
    const claim = { status: 'running', waitTill: null };
    const claimed = opts.atWait
      ? await repos.executions.claimToolWait(tenantId, executionId, opts.atWait, claim)
      : await repos.executions.transition(tenantId, executionId, ['waiting'], claim);
    if (!claimed) return undefined;
    await repos.executions.updateRunOptions(tenantId, executionId, {
      ...(data.runOptions ?? {}),
      resumeOutput: output ? JSON.parse(JSON.stringify(output)) : null,
      resumeCustomData: opts.customData ?? null,
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
        this.deps.push.send(
          tenantId,
          'executionFinished',
          { executionId, workflowId: row.workflowId, status: 'canceled' },
          { workflowId: row.workflowId ?? undefined },
        );
        return 'canceled';
      }
    }
    if (row.status === 'running' || row.status === 'new') {
      const local = this.running.get(executionId);
      if (local) {
        this.cancel(executionId);
        await local.done;
      } else {
        this.cancel(executionId);
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
    const runOptions = (data.runOptions ?? {}) as StoredRunOptions;
    // the mode of the run this retry chain started from (a retry keeps it for its sub-workflows)
    const rootMode = runOptions.rootMode ?? (row.mode as ExecutionMode);
    // an inline sub-run's row names its caller: "the current workflow" would run the caller in its place
    if (options.useCurrentWorkflow && row.workflowId && !runOptions.inlineSource) {
      const current = await repos.workflows.get(tenantId, row.workflowId);
      if (!current) throw ApiError.notFound('Workflow');
      // a retry of an editor run takes the draft, any other the published version (P3-10)
      definition = await runtimeDefinition(repos, tenantId, current, rootMode);
      workflowId = current.id;
    }
    const state = data.state as unknown as ExecutionState | null;
    const names = new Set(definition.nodes.map((n) => n.name));
    // the retry owns copies of every binary file it references: the original may be pruned or deleted
    const retryId = randomUUID();
    // P6-25: the retry copies only the files the original run may reach (never another project's)
    const reach = this.binaryReach(tenantId, {
      executionId: row.id,
      projectId: await this.runProjectOf(tenantId, row.workflowId, runOptions.projectId),
      workflowId: row.workflowId ?? undefined,
    });
    const clone = <T>(value: T): T => (value === undefined ? value : JSON.parse(JSON.stringify(value)));
    const launch = async (
      input: Partial<StartExecutionInput>,
      ...owned: unknown[]
    ): Promise<StartedExecution> => {
      try {
        for (const value of owned) await this.adoptBinaryData(tenantId, retryId, value, reach);
        return await this.start({
          tenantId,
          workflow: definition,
          workflowId,
          mode: 'retry',
          executionId: retryId,
          retryOf: row.id,
          userId: options.userId,
          // P6-15 (C0): a run that acted for a person is retried for the person who asks for the retry, never
          // for the original one (their private connections stay theirs); a run with no person stays without
          endUserId: runOptions.endUserId === undefined ? undefined : options.userId,
          // P6 S1: a run with no workflow row keeps the project it was started in
          projectId: runOptions.projectId,
          inlineSource: runOptions.inlineSource,
          ...input,
        });
      } catch (error) {
        await this.removeBinaryData(tenantId, retryId);
        throw error;
      }
    };
    // the start node, its items and the pinned data of the original run, so that a retry of this
    // retry starts from the same trigger
    const origin = {
      startNode: runOptions.startNode,
      triggerItems: clone(runOptions.triggerItems),
      runData: clone(runOptions.runData),
      destinationNode: runOptions.destinationNode,
      dirtyNodeNames: clone(runOptions.dirtyNodeNames),
      agentRequest: clone(runOptions.agentRequest),
      rootMode,
      customData: clone(runOptions.customData),
    };
    // a node failed: the engine re-runs that node with its saved input and everything after it
    // not for a tool test: its request is not part of the state, so the root would run as a node
    const failed = runOptions.agentRequest ? undefined : state?.executionData?.failedExecuteData;
    if (state && failed) {
      if (!names.has(failed.node)) {
        throw ApiError.conflict(`Node "${failed.node}" no longer exists in the workflow`);
      }
      const retryState = clone(state);
      const pinData = clone(runOptions.pinData);
      return launch(
        { ...origin, pinData, retryState },
        retryState,
        origin.triggerItems,
        origin.runData,
        pinData,
      );
    }
    // a timeout, a stop or a crash names no failed node: the nodes that already succeeded are
    // pinned so the retry continues after them without repeating side effects; multi-output and
    // looping nodes re-run to keep routing correct. A node that failed and then succeeded in an
    // earlier retry (errors first, success last) counts as succeeded.
    const pinData: Record<string, Item[]> = clone(runOptions.pinData ?? {});
    const failedNode = state?.resultData.error?.node;
    for (const [name, runs] of Object.entries(state?.resultData.runData ?? {})) {
      const task = runs[runs.length - 1];
      if (
        task &&
        runs.slice(0, -1).every((run) => run.executionStatus === 'error') &&
        name !== failedNode &&
        names.has(name) &&
        task.executionStatus === 'success' &&
        task.data?.main?.length === 1 &&
        Object.keys(task.data).length === 1
      ) {
        pinData[name] = clone((task.data.main[0] ?? []) as Item[]);
      }
    }
    return launch({ ...origin, pinData }, origin.triggerItems, origin.runData, pinData);
  }

  /**
   * Copy the filesystem binary files that `value` references into the directory of `executionId`
   * and point the references (mutated in place) at the copies. A file that is already gone, or that
   * `reach` refuses (P6-25: another project's), keeps its reference and is not copied.
   */
  private async adoptBinaryData(
    tenantId: string,
    executionId: string,
    value: unknown,
    reach: (id: string) => Promise<boolean>,
  ): Promise<void> {
    const { config } = this.deps;
    if (config.binaryData.mode !== 'filesystem') return;
    const prefix = `fs:${tenantId}/`;
    const unsafe = (part: string) => !part || part === '.' || part === '..' || /[:]/.test(part);
    const walk = async (node: unknown): Promise<void> => {
      if (!node || typeof node !== 'object') return;
      const ref = node as { id?: unknown; mimeType?: unknown };
      if (typeof ref.id === 'string' && ref.id.startsWith(prefix) && typeof ref.mimeType === 'string') {
        const parts = ref.id.slice(3).split('/');
        if (parts.length !== 3 || parts.some(unsafe) || !(await reach(ref.id))) return;
        const target = binaryDirOf(config, tenantId, executionId);
        await mkdir(target, { recursive: true });
        try {
          await copyFile(path.join(config.binaryData.dir, ...parts), path.join(target, parts[2]));
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code === 'ENOENT') return;
          throw error;
        }
        ref.id = `${prefix}${executionId}/${parts[2]}`;
        return;
      }
      for (const child of Object.values(node)) await walk(child);
    };
    await walk(value);
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
interface ExecEventChunk {
  type: 'chunk';
  executionId: string;
  chunk: unknown;
  /** the node run and item that sent the chunk (absent when the host gave none) */
  meta?: ChatChunkMeta;
}
/** P5-56: a node run that sent chunks has ended */
interface ExecEventNodeEnd {
  type: 'nodeEnd';
  executionId: string;
  meta: ChatChunkMeta;
}
type ExecEvent = ExecEventResponse | ExecEventChunk | ExecEventNodeEnd | ExecEventFinished;

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

/** P6-25: who calls a workflow (a sub-workflow call, a workflow tool or an error workflow start) */
export interface WorkflowCaller {
  /** the calling workflow's id (none: an unsaved run) */
  workflowId?: string;
  /** the project the calling run belongs to (none: it has neither a workflow row nor a stored project) */
  projectId?: string;
}

/**
 * The callee's caller policy (n8n's sub-workflow policy check). P6-25: a workflow with no `callerPolicy`
 * takes `defaultPolicy` (`WORKFLOW_CALLER_POLICY_DEFAULT_OPTION`, `sameProject` unless set); an explicit `any`
 * stays open; `sameProject` compares the caller's project with the callee's.
 */
export function assertCallerAllowed(
  name: string,
  settings: WorkflowDefinition['settings'],
  caller: WorkflowCaller,
  calleeProjectId: string,
  defaultPolicy: CallerPolicy = 'sameProject',
): void {
  const policy = settings?.callerPolicy ?? defaultPolicy;
  if (policy === 'any') return;
  if (policy === 'none') {
    throw new Error(`Workflow "${name}" does not allow being called by other workflows`);
  }
  if (policy === 'allowList') {
    if (caller.workflowId && (settings?.callerIds ?? []).includes(caller.workflowId)) return;
    throw new Error(`Workflow "${name}" does not allow being called by this workflow`);
  }
  if (!caller.projectId || caller.projectId !== calleeProjectId) {
    throw new Error(`Workflow "${name}" can only be called by workflows of its own project`);
  }
}
