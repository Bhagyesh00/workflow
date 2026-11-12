/**
 * P6-66 (S5 L10): tracing as a `LifecycleObserver`: `workflow.execute` and `node.execute` spans per run (n8n's
 * names and attributes less `n8n.`), continued across processes through `executions.tracing_context`;
 * `headersFor` gives a node's outbound trace headers (`ExecutionServices.traceHeaders`, wired by C0d).
 *
 * A run is traced when its workspace has tracing on (`forTenant`), unless `productionExecutionsOnly` is on and the
 * run's mode is `manual` (as n8n: every editor run is manual; evaluations, sub-workflows, error workflows and every
 * production mode are traced). Its `workflow.execute` span takes as parent, in this order: the previous segment
 * (a resume, with a link and `continuation.reason`), the inbound `traceparent` of the request that started it,
 * the parent execution (a sub-workflow: the parent's open node span, the Execute Workflow node, else the parent's
 * workflow span), the failed run of an error workflow (its workflow span), else a new root. Each segment stores its
 * context once, so any process continues it.
 *
 * A span holds names, ids, counts and status only: never node input or output, a credential, a header value or a
 * stack. A failure's exception event keeps the error type and its message (through `redactSecrets`, cut to 1000
 * characters); a redacted run keeps the type only, and its node tags stay out of the custom attributes.
 */
import {
  type ExecutionErrorShape,
  type Item,
  type RedactionChannels,
  type RunData,
  redactSecrets,
  type TaskData,
  type TaskDataConnections,
  telemetryTagsOf,
  type WorkflowDefinition,
  type WorkflowNode,
} from '@workflow/workflow';
import type { ServiceDeps } from '../../context';
import type { TracingContextRow } from '../../db/schema';
import type {
  CancelContext,
  CrashContext,
  LifecycleObserver,
  NodeEndContext,
  NodeStartContext,
  RunEndContext,
  RunStartContext,
} from '../observability/lifecycle';
import { loadTracingContext, saveTracingContext } from './context-store';
import { customAttributes } from './custom-attributes';
import { genAiAttributes } from './gen-ai';
import { inboundBaggage, outboundTraceHeaders } from './propagation';
import type { EffectiveOtelSettings } from './settings';
import {
  nowUnixNano,
  type SpanAttributes,
  type SpanContext,
  type SpanData,
  type SpanLink,
  type SpanStatus,
} from './span';
import { formatTraceparent, parseTraceparent, parseTracestate } from './w3c';

export type TracingObserver = LifecycleObserver & {
  /** the open node span's `traceparent`, `tracestate` and `baggage` when `injectOutbound`; undefined otherwise */
  headersFor(executionId: string, nodeName: string): Record<string, string> | undefined;
  /** tests: this process forgets every run it traces (as a restart does); the stored contexts stay */
  forget(): void;
};

export const WORKFLOW_SPAN = 'workflow.execute';
export const NODE_SPAN = 'node.execute';
export const WORKFLOW_START_MARKER = 'workflow.execute.started';
export const NODE_START_MARKER = 'node.execute.started';
/** why a resumed segment continues an earlier one (`continuation.reason`) */
export const CONTINUATION_RESUME = 'resume';
const EXCEPTION_MESSAGE_MAX_LENGTH = 1000;
/** ended runs whose workflow span a resume, a sub-workflow or an error workflow may still continue in this process */
const RECENT_MAX = 1000;

interface OpenNode {
  nodeName: string;
  span: SpanData;
}

interface RunTrace {
  tenantId: string;
  executionId: string;
  settings: EffectiveOtelSettings;
  definition: WorkflowDefinition;
  /** `execution.id`, `workflow.id`, `project.id`: on every span of the run */
  identity: Record<string, string>;
  baggage?: string;
  workflowSpan: SpanData;
  /** open node spans by `<node>\0<run index>`, in start order */
  open: Map<string, OpenNode>;
  /** the last closed span of each node (a late sub-node run's parent) */
  closed: Map<string, SpanContext>;
  /** the node runs seen (references, for item counts and the GenAI attributes) */
  runData: RunData;
}

interface RecentRun {
  tenantId: string;
  context: SpanContext;
  baggage?: string;
}

interface Origin {
  parent?: SpanContext;
  baggage?: string;
  links?: SpanLink[];
  continuation?: boolean;
}

const nodeKey = (nodeName: string, runIndex: number) => `${nodeName}\u0000${runIndex}`;

const nanosOf = (date: Date) => BigInt(date.getTime()) * 1_000_000n;

/** whether a run of this mode is traced under these settings (n8n: production only skips `manual`) */
function traced(settings: EffectiveOtelSettings, mode: string): boolean {
  return !(settings.productionExecutionsOnly && mode === 'manual');
}

/** the items of every connection type of a task's inputs or outputs */
function countItems(connections: TaskDataConnections | undefined): number {
  let count = 0;
  for (const outputs of Object.values(connections ?? {})) {
    for (const items of outputs ?? []) count += items?.length ?? 0;
  }
  return count;
}

/** the items a node run got: its recorded inputs (a sub-node), else what its sources gave it */
function inputCount(taskData: TaskData, runData: RunData): number {
  if (taskData.inputOverride) return countItems(taskData.inputOverride);
  let count = 0;
  for (const source of taskData.source ?? []) {
    if (!source) continue;
    const task = runData[source.previousNode]?.[source.previousNodeRun ?? 0];
    count += task?.data?.main?.[source.previousNodeOutput ?? 0]?.length ?? 0;
  }
  return count;
}

/** the node a sub-node feeds (its first non-main connection), if any */
function rootOfSubNode(definition: WorkflowDefinition, nodeName: string): string | undefined {
  const outputs = definition.connections?.[nodeName];
  if (!outputs) return undefined;
  for (const [type, groups] of Object.entries(outputs)) {
    if (type === 'main') continue;
    for (const group of groups ?? []) {
      const target = group?.[0]?.node;
      if (target) return target;
    }
  }
  return undefined;
}

/** a node's id, name, type and version */
function nodeAttributes(
  definition: WorkflowDefinition,
  nodeName: string,
  nodeType: string,
): { node?: WorkflowNode; attributes: SpanAttributes } {
  const node = definition.nodes?.find((n) => n.name === nodeName);
  const attributes: SpanAttributes = { 'node.name': nodeName, 'node.type': nodeType || node?.type || '' };
  if (node?.id) attributes['node.id'] = node.id;
  if (typeof node?.typeVersion === 'number') attributes['node.type_version'] = node.typeVersion;
  return { node, attributes };
}

/** the exception event of a failure: its type always, its message (redacted, cut) only for a run not redacted */
function exceptionEvent(type: string, message: string | undefined, redacted: boolean) {
  const attributes: SpanAttributes = { 'exception.type': type || 'Error' };
  if (!redacted && message) {
    attributes['exception.message'] = redactSecrets(message).slice(0, EXCEPTION_MESSAGE_MAX_LENGTH);
  }
  return { name: 'exception', timeUnixNano: nowUnixNano(), attributes };
}

function errorStatus(message: string | undefined, redacted: boolean): SpanStatus {
  return !redacted && message ? { code: 'error', message } : { code: 'error' };
}

/** the failed run of an error workflow: the trigger item's `execution.id` */
function failedRunOf(c: RunStartContext): string | undefined {
  if (c.row.mode !== 'error') return undefined;
  const item = c.options.triggerItems?.[0] as Item | undefined;
  const execution = (item?.json as { execution?: { id?: unknown } } | undefined)?.execution;
  return typeof execution?.id === 'string' ? execution.id : undefined;
}

function storedContextOf(stored: TracingContextRow | null): SpanContext | undefined {
  if (!stored) return undefined;
  const context = parseTraceparent(stored.traceparent);
  if (!context) return undefined;
  const state = parseTracestate(stored.tracestate);
  if (state) context.traceState = state;
  return context;
}

export function createTracingObserver(deps: ServiceDeps): TracingObserver {
  const runs = new Map<string, RunTrace>();
  const recent = new Map<string, RecentRun>();

  const tracing = () => deps.context().tracing;

  const live = (tenantId: string, executionId: string): RunTrace | undefined => {
    const run = runs.get(executionId);
    return run && run.tenantId === tenantId ? run : undefined;
  };

  /** keeps the tenant's processor (the tracer drops spans of a tenant without one) */
  const touch = (run: Pick<RunTrace, 'tenantId' | 'settings'>) =>
    tracing().processorFor(run.tenantId, run.settings);

  const remember = (run: RunTrace) => {
    recent.delete(run.executionId);
    recent.set(run.executionId, {
      tenantId: run.tenantId,
      context: run.workflowSpan.context,
      baggage: run.baggage,
    });
    while (recent.size > RECENT_MAX) {
      const oldest = recent.keys().next().value;
      if (oldest === undefined) break;
      recent.delete(oldest);
    }
  };

  /** zero-length marker spans (`*.started`), when the settings ask for them */
  const marker = (run: RunTrace, name: string, parent: SpanContext) => {
    const span = tracing().startSpan({
      tenantId: run.tenantId,
      name,
      parent,
      attributes: { ...run.identity },
    });
    tracing().endSpan(span, { endTimeUnixNano: span.startTimeUnixNano });
  };

  /** an earlier execution's span to continue: open in this process, ended here lately, else stored */
  const contextOfExecution = async (
    tenantId: string,
    executionId: string,
    preferNode: boolean,
  ): Promise<{ context?: SpanContext; baggage?: string }> => {
    const running = live(tenantId, executionId);
    if (running) {
      const open = [...running.open.values()];
      const span = preferNode && open.length ? open[open.length - 1].span : running.workflowSpan;
      return { context: span.context, baggage: running.baggage };
    }
    const ended = recent.get(executionId);
    if (ended && ended.tenantId === tenantId) return { context: ended.context, baggage: ended.baggage };
    const stored = await loadTracingContext(deps, tenantId, executionId);
    return { context: storedContextOf(stored), baggage: stored?.baggage };
  };

  const originOf = async (c: RunStartContext): Promise<Origin> => {
    if (c.kind === 'resume') {
      const previous = await contextOfExecution(c.tenantId, c.executionId, false);
      if (previous.context) {
        return {
          parent: previous.context,
          baggage: previous.baggage,
          links: [{ context: previous.context, attributes: { 'continuation.reason': CONTINUATION_RESUME } }],
          continuation: true,
        };
      }
    }
    const inbound = c.options.traceContext;
    const remote = parseTraceparent(inbound?.traceparent);
    if (remote) {
      const state = parseTracestate(inbound?.tracestate);
      if (state) remote.traceState = state;
      return { parent: remote, baggage: inboundBaggage(inbound?.baggage) };
    }
    if (c.row.parentExecutionId) {
      const parent = await contextOfExecution(c.tenantId, c.row.parentExecutionId, true);
      if (parent.context) return { parent: parent.context, baggage: parent.baggage };
    }
    const failed = failedRunOf(c);
    if (failed) {
      const parent = await contextOfExecution(c.tenantId, failed, false);
      if (parent.context) return { parent: parent.context, baggage: parent.baggage };
    }
    return {};
  };

  /** the run's project (its workflow's, else the stored one): id, team name and tags */
  const projectOf = async (c: RunStartContext) => {
    const { repos } = deps;
    const workflow = c.row.workflowId ? await repos.workflows.get(c.tenantId, c.row.workflowId) : undefined;
    const projectId = workflow?.projectId ?? c.options.projectId;
    return projectId ? repos.projects.get(c.tenantId, projectId) : undefined;
  };

  /** ends every open node span of a run that ends while they run */
  const endOpenNodes = (run: RunTrace, reason: string) => {
    for (const { span } of run.open.values()) {
      tracing().endSpan(span, { attributes: { 'node.termination_reason': reason } });
    }
    run.open.clear();
  };

  const endRun = (
    run: RunTrace,
    status: string,
    failure: { type: string; message?: string; redacted: boolean } | undefined,
    attributes: SpanAttributes = {},
  ) => {
    runs.delete(run.executionId);
    touch(run);
    endOpenNodes(run, status);
    const span = run.workflowSpan;
    const end: SpanAttributes = { ...attributes, 'execution.status': status };
    let spanStatus: SpanStatus | undefined;
    if (failure) {
      end['execution.error_type'] = failure.type;
      span.events.push(exceptionEvent(failure.type, failure.message, failure.redacted));
      spanStatus = errorStatus(failure.message, failure.redacted);
    }
    tracing().endSpan(span, { attributes: end, status: spanStatus });
    remember(run);
  };

  const observer: TracingObserver = {
    async runStart(c: RunStartContext) {
      const settings = await deps.context().otelSettings.forTenant(c.tenantId);
      if (!settings || !traced(settings, String(c.row.mode))) return;
      tracing().processorFor(c.tenantId, settings);
      const origin = await originOf(c);
      const project = await projectOf(c);
      const definition = c.definition;
      const identity: Record<string, string> = { 'execution.id': c.executionId };
      const workflowId = c.row.workflowId ?? definition.id;
      if (workflowId) identity['workflow.id'] = workflowId;
      if (project) identity['project.id'] = project.id;
      const attributes: SpanAttributes = {
        ...customAttributes({
          ...(project ? { project: { tags: telemetryTagsOf(project.customTelemetryTags) } } : {}),
          workflow: { tags: telemetryTagsOf(definition.settings?.customTelemetryTags) },
        }),
        ...identity,
        'workflow.name': definition.name ?? '',
        'workflow.node_count': definition.nodes?.length ?? 0,
        'execution.mode': String(c.row.mode),
        'execution.is_retry': Boolean(c.row.retryOf),
      };
      if (definition.versionId) attributes['workflow.version_id'] = definition.versionId;
      // the personal project's name holds its owner's name: only a team project's name goes out, as n8n
      if (project?.type === 'team') attributes['project.name'] = project.name;
      if (c.row.retryOf) attributes['execution.retry_of'] = c.row.retryOf;
      if (origin.continuation) attributes['continuation.reason'] = CONTINUATION_RESUME;
      const span = tracing().startSpan({
        tenantId: c.tenantId,
        name: WORKFLOW_SPAN,
        parent: origin.parent,
        links: origin.links,
        attributes,
      });
      const run: RunTrace = {
        tenantId: c.tenantId,
        executionId: c.executionId,
        settings,
        definition,
        identity,
        baggage: origin.baggage,
        workflowSpan: span,
        open: new Map(),
        closed: new Map(),
        runData: {},
      };
      runs.set(c.executionId, run);
      if (c.kind === 'resume') {
        // the nodes that ran before the wait: the item counts of the next nodes read them
        const stored = await deps.repos.executions.getData(c.tenantId, c.executionId).catch(() => undefined);
        const before = (stored?.state as { resultData?: { runData?: RunData } } | null | undefined)
          ?.resultData?.runData;
        if (before && typeof before === 'object') run.runData = { ...before };
      }
      const context: TracingContextRow = { traceparent: formatTraceparent(span.context), identity };
      if (span.context.traceState) context.tracestate = span.context.traceState;
      if (origin.baggage) context.baggage = origin.baggage;
      await saveTracingContext(deps, c.tenantId, c.executionId, context);
      if (settings.emitWorkflowStartSpan) marker(run, WORKFLOW_START_MARKER, span.context);
    },

    nodeStart(c: NodeStartContext) {
      const run = live(c.tenantId, c.executionId);
      if (!run?.settings.includeNodeSpans) return;
      touch(run);
      const { attributes } = nodeAttributes(run.definition, c.nodeName, c.nodeType);
      const span = tracing().startSpan({
        tenantId: run.tenantId,
        name: NODE_SPAN,
        parent: run.workflowSpan.context,
        attributes: { ...run.identity, ...attributes },
      });
      run.open.set(nodeKey(c.nodeName, c.runIndex), { nodeName: c.nodeName, span });
      if (run.settings.emitNodeStartSpan) marker(run, NODE_START_MARKER, span.context);
    },

    nodeEnd(c: NodeEndContext) {
      const run = live(c.tenantId, c.executionId);
      if (!run) return;
      const task = c.taskData;
      const taskRuns = (run.runData[c.nodeName] ??= []);
      taskRuns[c.runIndex] = task;
      if (!run.settings.includeNodeSpans) return;
      touch(run);
      const key = nodeKey(c.nodeName, c.runIndex);
      const { node, attributes } = nodeAttributes(run.definition, c.nodeName, c.nodeType);
      let span = run.open.get(key)?.span;
      let endTime: bigint | undefined;
      if (span) run.open.delete(key);
      else {
        // a sub-node run has no start: a zero-length child of the node it serves
        const parentName = task.source?.find((s) => s?.previousNode)?.previousNode;
        const served = parentName ? openSpanOf(run, parentName)?.context : undefined;
        const parent: SpanContext =
          served ?? (parentName ? run.closed.get(parentName) : undefined) ?? run.workflowSpan.context;
        const now = nowUnixNano();
        span = tracing().startSpan({
          tenantId: run.tenantId,
          name: NODE_SPAN,
          parent,
          startTimeUnixNano: now,
          attributes: { ...run.identity, ...attributes },
        });
        endTime = now;
      }
      const end: SpanAttributes = {
        ...(c.redacted ? {} : customAttributes({ node: { tracing: task.metadata?.tracing } })),
        'node.items.input': inputCount(task, run.runData),
        'node.items.output': countItems(task.data),
      };
      if (node) {
        const genAi = genAiAttributes(node, task, run.runData, run.definition.connections ?? {});
        if (genAi) Object.assign(end, genAi);
      }
      Object.assign(end, run.identity, attributes);
      const error: ExecutionErrorShape | undefined = task.error;
      let status: SpanStatus | undefined;
      if (error || task.executionStatus === 'error') {
        span.events.push(exceptionEvent(error?.name ?? 'Error', error?.message, c.redacted));
        status = errorStatus(error?.message, c.redacted);
      }
      tracing().endSpan(span, { attributes: end, status, endTimeUnixNano: endTime });
      run.closed.set(c.nodeName, span.context);
    },

    runEnd(c: RunEndContext) {
      const run = live(c.tenantId, c.executionId);
      if (!run) return;
      const failed = c.status === 'error' || c.status === 'crashed';
      endRun(
        run,
        c.status,
        failed
          ? { type: c.error?.name || 'Error', message: c.error?.message, redacted: c.redacted }
          : undefined,
      );
    },

    runCancelled(c: CancelContext) {
      const run = live(c.tenantId, c.executionId);
      if (run) endRun(run, 'canceled', undefined);
    },

    async crash(c: CrashContext) {
      const channels = c.options?.redaction as RedactionChannels | undefined;
      const redacted =
        String(c.row.mode) === 'manual' ? channels?.manual === true : channels?.production === true;
      const type = c.state?.resultData?.error?.name || 'Error';
      const failure = { type, message: c.error, redacted };
      const crashAttributes: SpanAttributes = { 'execution.crash.detector': c.detector };
      const run = live(c.tenantId, c.executionId);
      if (run) {
        endRun(run, 'crashed', failure, crashAttributes);
        return;
      }
      // another process ran it: one span rebuilt from the row's start and stop, in the stored trace
      const settings = await deps.context().otelSettings.forTenant(c.tenantId);
      if (!settings || !traced(settings, String(c.row.mode))) return;
      tracing().processorFor(c.tenantId, settings);
      const stored = await loadTracingContext(deps, c.tenantId, c.executionId);
      const context = storedContextOf(stored);
      const identity: Record<string, string> = { ...stored?.identity, 'execution.id': c.executionId };
      const workflowId = c.row.workflowId ?? c.definition?.id;
      if (workflowId) identity['workflow.id'] = workflowId;
      const attributes: SpanAttributes = {
        ...identity,
        ...crashAttributes,
        'execution.reconstructed': true,
        'execution.mode': String(c.row.mode),
        'execution.status': 'crashed',
        'execution.is_retry': Boolean(c.row.retryOf),
        'execution.error_type': type,
      };
      if (c.row.retryOf) attributes['execution.retry_of'] = c.row.retryOf;
      if (c.definition) {
        attributes['workflow.name'] = c.definition.name ?? '';
        attributes['workflow.node_count'] = c.definition.nodes?.length ?? 0;
        if (c.definition.versionId) attributes['workflow.version_id'] = c.definition.versionId;
      }
      const stoppedAt = c.row.stoppedAt ?? new Date();
      const startedAt = c.row.startedAt ?? stoppedAt;
      const span = tracing().startSpan({
        tenantId: c.tenantId,
        name: WORKFLOW_SPAN,
        parent: context,
        startTimeUnixNano: nanosOf(startedAt),
        attributes,
      });
      if (context) {
        // the lost segment's own span id, so the node spans it already sent find their parent
        span.context = { ...context };
        delete span.parentSpanId;
      }
      span.events.push(exceptionEvent(type, c.error, redacted));
      tracing().endSpan(span, {
        endTimeUnixNano: nanosOf(stoppedAt),
        status: errorStatus(c.error, redacted),
      });
      recent.set(c.executionId, { tenantId: c.tenantId, context: span.context, baggage: stored?.baggage });
    },

    headersFor(executionId: string, nodeName: string) {
      const run = runs.get(executionId);
      if (!run?.settings.injectOutbound) return undefined;
      const root = rootOfSubNode(run.definition, nodeName);
      const span =
        openSpanOf(run, nodeName) ?? (root ? openSpanOf(run, root) : undefined) ?? run.workflowSpan;
      return outboundTraceHeaders(span.context, run.baggage);
    },

    forget() {
      runs.clear();
      recent.clear();
    },
  };
  return observer;
}

/** the latest open span of a node */
function openSpanOf(run: RunTrace, nodeName: string): SpanData | undefined {
  let found: SpanData | undefined;
  for (const open of run.open.values()) if (open.nodeName === nodeName) found = open.span;
  return found;
}
